import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ArtifactRecord, ToolContext } from '../contracts.ts';
import type { ArtifactPort, ArtifactScope } from '../artifacts/index.ts';
import { sniffMime } from '../artifacts/mime.ts';
import type { PersonalStore } from '../core/store.ts';
import type { RegisteredTool, ToolBroker } from './types.ts';
import { id, obj, str } from './schema.ts';

export interface ImageSource { artifactId: string; name: string; mimeType: string; bytes: Uint8Array }
export interface ImageOutput { bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }
export interface ImageProviderInput { prompt: string; size: string; sources: ImageSource[]; requestKey: string; signal: AbortSignal }
/** Trusted provider receives bytes only after scope/grant validation, never model credentials/URLs. */
export interface ImageProviderPort { generate(input: ImageProviderInput): Promise<ImageOutput[]> }
/** Only validation known to precede any network dispatch may use this classification. */
export class ImagePrewireError extends Error { constructor() { super('image request rejected before dispatch'); } }
export interface OpenAiImageProviderOptions {
  baseUrl: string; apiKey: string; model: string;
  /** Explicit only: older compatible providers can require response_format=b64_json. */
  responseFormat?: 'b64_json'; allowHttpLoopback?: boolean;
  timeoutMs?: number; maxRequestBytes?: number; maxResponseBytes?: number; maxImageBytes?: number;
}
const sizes = ['1024x1024', '1024x1536', '1536x1024', '512x512', '256x256'];
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ext = (mime: string) => mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
function bound(value: number | undefined, fallback: number, maximum: number): number {
  const n = value ?? fallback; if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new ImagePrewireError(); return n;
}
function validateImage(bytes: Uint8Array, mime: string, maximum: number): ImageOutput {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > maximum || !imageTypes.has(mime)) throw new ImagePrewireError();
  try { if (sniffMime(Buffer.from(bytes), mime) !== mime) throw new ImagePrewireError(); }
  catch { throw new ImagePrewireError(); }
  return { bytes: Buffer.from(bytes), mimeType: mime as ImageOutput['mimeType'] };
}

/** Fixed configured provider endpoint; redirects/remote result URLs are never followed. */
export class OpenAiImageProvider implements ImageProviderPort {
  readonly #base: URL; readonly #key: string; readonly #model: string;
  readonly #options: OpenAiImageProviderOptions;
  constructor(options: OpenAiImageProviderOptions) {
    let base: URL; try { base = new URL(options.baseUrl); } catch { throw new ImagePrewireError(); }
    const loopback = ['127.0.0.1', '[::1]', '::1'].includes(base.hostname);
    if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(options.allowHttpLoopback && base.protocol === 'http:' && loopback))) throw new ImagePrewireError();
    if (typeof options.apiKey !== 'string' || !options.apiKey || options.apiKey.length > 4096 || /[\r\n]/u.test(options.apiKey) || typeof options.model !== 'string' || !options.model || options.model.length > 128 || /[\r\n]/u.test(options.model)) throw new ImagePrewireError();
    this.#base = base; this.#key = options.apiKey; this.#model = options.model;
    this.#options = { ...options, timeoutMs: bound(options.timeoutMs, 120000, 300000),
      maxRequestBytes: bound(options.maxRequestBytes, 20 * 1024 * 1024, 64 * 1024 * 1024),
      maxResponseBytes: bound(options.maxResponseBytes, 16 * 1024 * 1024, 64 * 1024 * 1024),
      maxImageBytes: bound(options.maxImageBytes, 8 * 1024 * 1024, 32 * 1024 * 1024) };
  }
  async generate(input: ImageProviderInput): Promise<ImageOutput[]> {
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000 || !sizes.includes(input.size) || !Array.isArray(input.sources) || input.sources.length > 4 || !/^[a-f0-9]{64}$/u.test(input.requestKey) || input.signal.aborted) throw new ImagePrewireError();
    for (const source of input.sources) validateImage(source.bytes, source.mimeType, this.#options.maxImageBytes!);
    let body: Buffer, contentType: string;
    const common: Record<string, string | number> = { model: this.#model, prompt: input.prompt, size: input.size, n: 1,
      ...(this.#options.responseFormat ? { response_format: this.#options.responseFormat } : {}) };
    if (!input.sources.length) { body = Buffer.from(JSON.stringify(common)); contentType = 'application/json'; }
    else {
      const boundary = 'neurobro_' + input.requestKey;
      const parts: Buffer[] = [];
      for (const [name, value] of Object.entries(common)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
      input.sources.forEach((source, index) => {
        // Original filenames are untrusted; deterministic provider filenames cannot inject multipart headers.
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${input.sources.length > 1 ? 'image[]' : 'image'}"; filename="source-${index}.${ext(source.mimeType)}"\r\nContent-Type: ${source.mimeType}\r\n\r\n`));
        parts.push(Buffer.from(source.bytes), Buffer.from('\r\n'));
      });
      parts.push(Buffer.from(`--${boundary}--\r\n`)); body = Buffer.concat(parts); contentType = 'multipart/form-data; boundary=' + boundary;
    }
    if (body.byteLength > this.#options.maxRequestBytes!) throw new ImagePrewireError();
    const endpoint = new URL(this.#base.href.replace(/\/$/u, '') + (input.sources.length ? '/images/edits' : '/images/generations'));
    const combined = AbortSignal.any([input.signal, AbortSignal.timeout(this.#options.timeoutMs!)]);
    const response = await new Promise<Buffer>((resolve, reject) => {
      let req: ClientRequest | undefined;
      const fail = () => { req?.destroy(); reject(new Error('image provider outcome unknown')); };
      req = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(endpoint, {
        method: 'POST', agent: false, signal: combined, maxHeaderSize: 16384,
        headers: { authorization: 'Bearer ' + this.#key, 'content-type': contentType, 'content-length': body.byteLength,
          'accept-encoding': 'identity', 'x-client-request-id': input.requestKey },
      }, res => {
        if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || !String(res.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { res.resume(); fail(); return; }
        const declared = res.headers['content-length'];
        if (declared && (!/^\d+$/u.test(declared) || Number(declared) > this.#options.maxResponseBytes!)) { res.destroy(); fail(); return; }
        const chunks: Buffer[] = []; let count = 0;
        res.on('data', (chunk: Buffer) => { count += chunk.length; if (count > this.#options.maxResponseBytes!) { res.destroy(); fail(); } else chunks.push(chunk); });
        res.on('error', fail); res.on('aborted', fail); res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', fail); req.end(body);
    });
    try {
      const parsed = JSON.parse(response.toString('utf8')) as { data?: { b64_json?: string }[] };
      if (!Array.isArray(parsed.data) || parsed.data.length !== 1) throw new Error();
      return parsed.data.map(item => {
        const b64 = item.b64_json;
        if (typeof b64 !== 'string' || !b64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(b64)) throw new Error();
        const bytes = Buffer.from(b64, 'base64');
        return validateImage(bytes, sniffMime(bytes), this.#options.maxImageBytes!);
      });
    } catch { throw new Error('image provider outcome unknown'); }
  }
}

export interface ImageAttempt {
  id: string; taskId: string; intentRevision: number; grantId: string; grantRevision: number;
  inputHash: string; sourceArtifactIds: string[];
  state: 'prepared' | 'dispatching' | 'verified' | 'failed' | 'unknown'; artifactIds: string[];
  createdAt: string; updatedAt: string;
}
export interface ImageToolsOptions {
  broker: ToolBroker; store: Pick<PersonalStore, 'get' | 'put' | 'insert' | 'transaction'>;
  artifacts: ArtifactPort; scope(context: ToolContext): ArtifactScope;
  provider: ImageProviderPort; timeoutMs?: number; maxImageBytes?: number;
}
export function imageTools(options: ImageToolsOptions): RegisteredTool[] {
  const timeout = bound(options.timeoutMs, 120000, 300000), maximum = bound(options.maxImageBytes, 8 * 1024 * 1024, 32 * 1024 * 1024);
  return [{ name: 'images.generate', capability: 'images.generate', mutates: true,
    description: 'Generate or edit an image using the configured paid provider and task-owned references. Returns artifact IDs only. Unknown attempts are not replayed. A distinct requestKey intentionally starts a different operation.',
    inputSchema: obj({ prompt: str(8000), sourceArtifactIds: { type: 'array', items: id, maxItems: 4 },
      size: { type: 'string', enum: sizes }, requestKey: id }, ['prompt']), resources: (_args, context) => [context.taskId],
    execute: async ({ token, context, args }) => {
      await options.broker.authorizeTool(token, 'images.generate', context.taskId);
      const scope = options.scope(context);
      if (scope.taskId !== context.taskId || !scope.ownerId) throw new Error('image artifact scope denied');
      const inputIds = (args.sourceArtifactIds ?? []) as string[];
      if (new Set(inputIds).size !== inputIds.length) throw new Error('duplicate image references');
      const sources: ImageSource[] = inputIds.map(artifactId => {
        const record = options.artifacts.get(scope, artifactId), bytes = options.artifacts.read(scope, artifactId);
        validateImage(bytes, record.mimeType, maximum);
        return { artifactId, bytes, name: record.name, mimeType: record.mimeType };
      });
      const inputHash = hash([String(args.prompt), String(args.size ?? '1024x1024'), sources.map(source => [source.artifactId, createHash('sha256').update(source.bytes).digest('hex')]), args.requestKey ?? null]);
      const key = hash(context.runId.startsWith('cron:')
        ? [context.taskId, context.intentRevision, context.runId, inputHash]
        : [context.taskId, context.intentRevision, inputHash]);
      const collection = 'image-attempts-v1';
      const now = new Date().toISOString();
      const attempt: ImageAttempt = { id: key, taskId: context.taskId, intentRevision: context.intentRevision, grantId: context.grantId,
        grantRevision: context.grantRevision, inputHash, sourceArtifactIds: inputIds, state: 'prepared', artifactIds: [], createdAt: now, updatedAt: now };
      // Durably claim before the network. Concurrent calls and process restarts cannot dispatch a second attempt.
      const claimed = options.store.transaction(() => options.store.insert(collection, key, attempt));
      if (!claimed) {
        const existing = options.store.get<ImageAttempt>(collection, key)!;
        if (existing.state === 'verified') for (const artifactId of existing.artifactIds) options.artifacts.get(scope, artifactId);
        return { attemptId: existing.id, state: existing.state === 'prepared' || existing.state === 'dispatching' ? 'unknown' : existing.state, artifactIds: existing.state === 'verified' ? existing.artifactIds : [] };
      }
      const save = (state: ImageAttempt['state'], artifactIds: string[] = []) => {
        attempt.state = state; attempt.artifactIds = artifactIds; attempt.updatedAt = new Date().toISOString(); options.store.put(collection, key, attempt);
      };
      let stage: ReturnType<ArtifactPort['stageTask']> | undefined;
      let providerStarted = false, providerReturned = false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        await options.broker.authorizeTool(token, 'images.generate', context.taskId);
        save('dispatching');
        providerStarted = true;
        const pending = options.provider.generate({ prompt: String(args.prompt), size: String(args.size ?? '1024x1024'), sources, requestKey: key, signal: controller.signal });
        const outputs = await new Promise<ImageOutput[]>((resolve, reject) => {
          const abort = () => reject(new Error('image provider outcome unknown'));
          controller.signal.addEventListener('abort', abort, { once: true });
          pending.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
        });
        providerReturned = true;
        await options.broker.authorizeTool(token, 'images.generate', context.taskId);
        for (const source of sources) options.artifacts.get(scope, source.artifactId);
        if (!Array.isArray(outputs) || outputs.length !== 1) throw new Error('invalid provider outputs');
        const checked = outputs.map(output => validateImage(output.bytes, output.mimeType, maximum));
        stage = options.artifacts.stageTask(scope, inputIds);
        const records: ArtifactRecord[] = checked.map((output, index) => {
          const name = `image-${key.slice(0, 12)}-${index}.${ext(output.mimeType)}`;
          writeFileSync(join(stage!.outputsPath, name), output.bytes, { flag: 'wx', mode: 0o600 });
          return options.artifacts.putOutput(scope, stage!.id, name, { mimeType: output.mimeType,
            ...(inputIds[0] ? { parentId: inputIds[0] } : {}), sourceRef: 'images:' + key });
        });
        await options.broker.authorizeTool(token, 'images.generate', context.taskId);
        save('verified', records.map(record => record.id));
        return { attemptId: key, state: 'verified', artifactIds: attempt.artifactIds };
      } catch (error) {
        // Only a port's guaranteed prewire validation can prove no provider effect occurred.
        const state = !providerStarted || (error instanceof ImagePrewireError && !providerReturned) ? 'failed' : 'unknown'; save(state);
        return { attemptId: key, state, artifactIds: [] };
      } finally {
        clearTimeout(timer); controller.abort();
        if (stage) { try { options.artifacts.releaseStage(scope, stage.id); } catch { /* Receipt remains durable if cleanup is separately needed. */ } }
      }
    } }];
}
