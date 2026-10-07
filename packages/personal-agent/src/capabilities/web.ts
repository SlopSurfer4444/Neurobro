import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { ArtifactRecord, ToolContext } from '../contracts.ts';

export interface PublicAddress { address: string; family: 4 | 6 }
export type WebResolver = (hostname: string) => Promise<PublicAddress[]>;
export interface WebResponse { status: number; headers: Record<string, string>; bytes: Uint8Array }
/** Trusted transport must use the supplied address, never resolve the hostname again. */
export type WebTransport = (url: URL, address: PublicAddress, options: { signal: AbortSignal; maxBytes: number }) => Promise<WebResponse>;
export interface SearchResult { title: string; url: string; snippet?: string }
export interface WebSearchProvider { search(query: string, options: { limit: number; signal: AbortSignal }): Promise<SearchResult[]> }
export interface WebArtifactSink {
  stage(context: ToolContext, input: { name: string; mimeType: string; bytes: Uint8Array; sourceUrl: string }): Promise<ArtifactRecord>;
}
export interface WebLimits { maxFetchBytes: number; maxDownloadBytes: number; timeoutMs: number; maxRedirects: number }
export interface WebServiceOptions {
  searchProvider?: WebSearchProvider; artifactSink?: WebArtifactSink; transport?: WebTransport; resolver?: WebResolver;
  /** Host revalidates task/grant before network access and again before artifact persistence. */
  authority?: (context: ToolContext, capability: 'web.search' | 'web.fetch' | 'web.download', resource: string) => Promise<void>;
  limits?: Partial<WebLimits>;
}
const defaults: WebLimits = { maxFetchBytes: 512 * 1024, maxDownloadBytes: 8 * 1024 * 1024, timeoutMs: 20_000, maxRedirects: 5 };
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function ipv6Parts(address: string): number[] {
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const start = value.lastIndexOf(':');
    const v4 = value.slice(start + 1).split('.').map(Number);
    value = `${value.slice(0, start)}:${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':').map(n => parseInt(n, 16)) : [];
  const right = halves[1] ? halves[1].split(':').map(n => parseInt(n, 16)) : [];
  return halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left;
}
/** Reject private, loopback, link-local, multicast, documentation and transition addresses. */
export function assertPublicAddress(address: string): PublicAddress {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a! >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
      throw new Error('Web address is not public');
    return { address, family: 4 };
  }
  if (family === 6) {
    const parts = ipv6Parts(address);
    if (parts.slice(0, 5).every(n => n === 0) && parts[5] === 0xffff) {
      const p = parts[6]!; const q = parts[7]!;
      assertPublicAddress(`${p >> 8}.${p & 255}.${q >> 8}.${q & 255}`);
      return { address, family: 6 };
    }
    if ((parts[0]! & 0xe000) !== 0x2000 || parts[0] === 0x2002 || parts[0] === 0x3fff ||
      (parts[0] === 0x2001 && (parts[1] === 0 || parts[1] === 0xdb8 || parts[1]! < 0x200)))
      throw new Error('Web address is not public');
    return { address, family: 6 };
  }
  throw new Error('Invalid IP address');
}

export function validatePublicUrl(input: string): URL {
  if (typeof input !== 'string' || input.length > 4096 || /[\u0000-\u0020\u007f]/u.test(input)) throw new Error('Invalid web URL');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Invalid web URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    (url.port && url.port !== '80' && url.port !== '443')) throw new Error('Web URL scheme, credentials or port denied');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) assertPublicAddress(host);
  else if (!host.includes('.') || host.endsWith('.') || !/^[a-z0-9.-]+$/u.test(host) ||
    host.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-')) ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/u.test(host)) throw new Error('Web hostname denied');
  url.hash = '';
  return url;
}

export const systemWebResolver: WebResolver = async hostname => (await lookup(hostname, { all: true })).map(value => {
  if (value.family !== 4 && value.family !== 6) throw new Error('Invalid DNS family');
  return { address: value.address, family: value.family };
});

export interface NodeWebRequestOptions extends RequestOptions { servername?: string; autoSelectFamily: boolean }
export type NodeWebRequest = (url: URL, options: NodeWebRequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
/** Factory exposes only a trusted request seam for offline socket/stream contract tests. */
export function createNodePinnedFetch(requester?: NodeWebRequest): WebTransport {
return (url, address, options) => new Promise((resolve, reject) => {
  validatePublicUrl(url.href);
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 32 * 1024 * 1024) throw new Error('Invalid web byte limit');
  if (assertPublicAddress(address.address).family !== address.family) throw new Error('Invalid address family');
  const request: NodeWebRequest = requester ?? ((target, config, callback) => target.protocol === 'https:'
    ? httpsRequest(target, config, callback) : httpRequest(target, config, callback));
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && hostname !== address.address) throw new Error('Literal address does not match pinned address');
  const req = request(url, {
    method: 'GET', agent: false, signal: options.signal, family: address.family,
    autoSelectFamily: false, maxHeaderSize: 16 * 1024,
    lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    ...(url.protocol === 'https:' && !isIP(hostname) ? { servername: hostname } : {}),
    headers: { 'user-agent': 'Neurobro/1.0', accept: '*/*', 'accept-encoding': 'identity' },
  }, response => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) if (typeof value === 'string') headers[key] = value;
    if (redirectStatuses.has(response.statusCode ?? 0)) {
      response.destroy(); resolve({ status: response.statusCode!, headers, bytes: new Uint8Array() }); return;
    }
    const length = headers['content-length'];
    if (length && (!/^\d+$/u.test(length) || Number(length) > options.maxBytes)) {
      const error = new Error('Web response byte limit exceeded'); response.destroy(error); reject(error); return;
    }
    if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
      const error = new Error('Encoded web responses are unsupported'); response.destroy(error); reject(error); return;
    }
    const chunks: Buffer[] = []; let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBytes) response.destroy(new Error('Web response byte limit exceeded'));
      else chunks.push(chunk);
    });
    response.on('error', reject);
    response.on('end', () => resolve({ status: response.statusCode ?? 0, headers, bytes: Buffer.concat(chunks) }));
    response.on('aborted', () => reject(new Error('Web response interrupted')));
  });
  req.on('error', reject); req.end();
});
}
/** Core Node HTTP(S) fetch: pinned DNS address, original Host/TLS identity, no cookies or environment proxy agent. */
export const nodePinnedFetch: WebTransport = createNodePinnedFetch();

function checkContext(context: ToolContext): void {
  if (!context || [context.taskId, context.grantId, context.runId].some(value => typeof value !== 'string' || !value || value.length > 256) ||
    !Number.isSafeInteger(context.intentRevision) || context.intentRevision < 0 || !Number.isSafeInteger(context.grantRevision) || context.grantRevision < 0)
    throw new Error('Invalid trusted tool context');
}
function filename(input: string): string {
  if (!input || input.length > 160 || input === '.' || input === '..' || /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(input) ||
    /[. ]$/u.test(input) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/iu.test(input)) throw new Error('Invalid artifact name');
  return input;
}
function mime(headers: Record<string, string>): string {
  const value = (headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  return value.length <= 128 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(value) ? value : 'application/octet-stream';
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Web operation aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class WebService {
  readonly limits: WebLimits;
  private options: WebServiceOptions;
  constructor(options: WebServiceOptions = {}) {
    this.options = options; this.limits = { ...defaults, ...options.limits };
    for (const [name, max] of Object.entries({ maxFetchBytes: 2 * 1024 * 1024, maxDownloadBytes: 32 * 1024 * 1024, timeoutMs: 60_000, maxRedirects: 10 })) {
      const value = this.limits[name as keyof WebLimits];
      if (!Number.isSafeInteger(value) || value < (name === 'maxRedirects' ? 0 : 1) || value > max) throw new Error('Invalid web limits');
    }
    Object.freeze(this.limits);
  }
  private async authorize(context: ToolContext, capability: 'web.search' | 'web.fetch' | 'web.download', resource: string): Promise<void> {
    checkContext(context);
    if (!this.options.authority) throw new Error('Web authority unavailable');
    await this.options.authority(context, capability, resource);
  }
  private async bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Web operation timed out')), this.limits.timeoutMs);
    try { return await abortable(work(controller.signal), controller.signal); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async search(context: ToolContext, input: { query: string; limit?: number }): Promise<SearchResult[]> {
    const limit = input.limit ?? 10;
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 2048 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid search request');
    await this.authorize(context, 'web.search', 'web');
    if (!this.options.searchProvider) throw new Error('Web search provider unavailable');
    return this.bounded(async signal => {
      const results = await this.options.searchProvider!.search(input.query, { limit, signal });
      if (!Array.isArray(results) || results.length > 100) throw new Error('Invalid search provider result');
      const output: SearchResult[] = [];
      for (const result of results) {
        if (!result || typeof result.title !== 'string' || typeof result.url !== 'string') continue;
        try {
          output.push({ title: result.title.slice(0, 512), url: validatePublicUrl(result.url).href,
            ...(typeof result.snippet === 'string' ? { snippet: result.snippet.slice(0, 2048) } : {}) });
        } catch { continue; }
        if (output.length === limit) break;
      }
      return output;
    });
  }
  private async read(context: ToolContext, input: string, capability: 'web.fetch' | 'web.download', maxBytes: number): Promise<WebResponse & { url: string }> {
    return this.bounded(async signal => {
      let url = validatePublicUrl(input);
      for (let redirects = 0; ; redirects++) {
        await this.authorize(context, capability, url.origin);
        signal.throwIfAborted();
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const addresses = isIP(host) ? [assertPublicAddress(host)] : await abortable((this.options.resolver ?? systemWebResolver)(host), signal);
        if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32) throw new Error('Invalid DNS response');
        for (const item of addresses) {
          const parsed = assertPublicAddress(item.address);
          if (parsed.family !== item.family) throw new Error('Invalid DNS address family');
        }
        signal.throwIfAborted();
        const response = await abortable((this.options.transport ?? nodePinnedFetch)(url, addresses[0]!, { signal, maxBytes }), signal);
        if (!(response.bytes instanceof Uint8Array) || response.bytes.byteLength > maxBytes || !Number.isInteger(response.status)) throw new Error('Invalid or oversized web response');
        if (redirectStatuses.has(response.status)) {
          if (redirects >= this.limits.maxRedirects || !response.headers.location) throw new Error('Web redirect limit or missing location');
          url = validatePublicUrl(new URL(response.headers.location, url).href); continue;
        }
        if (response.status < 200 || response.status >= 300) throw new Error(`Web request failed (${response.status})`);
        return { ...response, url: url.href };
      }
    });
  }
  async fetch(context: ToolContext, input: { url: string }): Promise<{ url: string; status: number; mimeType: string; text: string; size: number }> {
    const response = await this.read(context, input.url, 'web.fetch', this.limits.maxFetchBytes);
    const mimeType = mime(response.headers);
    if (!mimeType.startsWith('text/') && !['application/json', 'application/xml', 'application/xhtml+xml'].includes(mimeType)) throw new Error('Web fetch requires textual content; use download');
    return { url: response.url, status: response.status, mimeType, text: Buffer.from(response.bytes).toString('utf8'), size: response.bytes.byteLength };
  }
  async download(context: ToolContext, input: { url: string; name?: string }): Promise<ArtifactRecord> {
    if (!this.options.artifactSink) throw new Error('Web artifact sink unavailable');
    const url = validatePublicUrl(input.url);
    const name = filename(input.name ?? decodeURIComponent(url.pathname.split('/').at(-1) || 'download'));
    const response = await this.read(context, url.href, 'web.download', this.limits.maxDownloadBytes);
    await this.authorize(context, 'web.download', new URL(response.url).origin);
    const artifact = await this.options.artifactSink.stage(context, { name, mimeType: mime(response.headers), bytes: response.bytes, sourceUrl: response.url });
    if (artifact.taskId !== context.taskId) throw new Error('Artifact sink returned a mismatched task');
    return artifact;
  }
}
