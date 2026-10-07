import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { ArtifactRecord, Effect, Json, Route, ToolContext } from './contracts.ts';
import type { ArtifactPort } from './artifacts/index.ts';
import { boundedRead, contained, fileName, safePath } from './artifacts/paths.ts';
import { canonicalJson, type PersonalAgent } from './core/index.ts';
import { deliveryParts } from './core/controller.ts';

export interface ScheduleOutputManifest {
  job_id: string; execution_id: string; task_id: string;
  outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
  output_file: string | null; output_sha256: string | null;
  [key: string]: Json;
}
type DeliveryAgent = Pick<PersonalAgent, 'store' | 'status' | 'resolveToolContext' | 'validateExecutionContext' | 'authorizeTool' | 'executeEffect'>;
export interface ScheduleDeliveryOptions {
  agent: DeliveryAgent; artifacts: Pick<ArtifactPort, 'put' | 'get' | 'read' | 'list'>;
  /** Explicit isolated Hermes home with locally accessible cron/output; never a model path. */
  hermesHome: string; privateRoute: Route;
  /** Trusted host stages the archived artifact, e.g. owner.toolArtifacts().resolveForSend. */
  artifactSend?: (context: ToolContext, artifactId: string) => Promise<{ path: string; mimeType: string; name: string; size?: number }>;
  maxOutputBytes?: number; maxInlineCharacters?: number; excerptCharacters?: number;
}
interface PreparedSend { id: string; capability: string; resource: string; payload: Json }
export interface ScheduleDeliveryRecord {
  jobId: string; executionId: string; context: ToolContext; manifestHash: string; manifest: ScheduleOutputManifest;
  state: 'prepared' | 'verified' | 'failed' | 'unknown'; artifactId?: string; reason?: string;
  preparedSends: PreparedSend[]; effectIds: string[]; createdAt: string; updatedAt: string;
}
export class ScheduleDeliveryError extends Error {
  constructor(message: string) { super(message); this.name = 'ScheduleDeliveryError'; }
}
const namespace = 'scheduleDeliveries';
const keyFor = (job: string, execution: string) => JSON.stringify([job, execution]);
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function sameContext(a: ToolContext, b: ToolContext): boolean {
  return a.taskId === b.taskId && a.intentRevision === b.intentRevision && a.grantId === b.grantId &&
    a.grantRevision === b.grantRevision && a.runId === b.runId;
}
function identity(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,255}$/u.test(value)) throw new ScheduleDeliveryError('Invalid native schedule identity');
}
function excerpt(text: string, limit: number): string { return deliveryParts(text, limit)[0] ?? ''; }

/** Callback evidence can remain UNKNOWN while the broker later independently verifies the send. */
export function getScheduleDelivery(agent: DeliveryAgent, jobId: string, executionId: string): ScheduleDeliveryRecord | undefined {
  identity(jobId); identity(executionId);
  return agent.store.get<ScheduleDeliveryRecord>(namespace, keyFor(jobId, executionId));
}

/** Native Hermes callback only: the coordinator authenticates its exact terminal manifest.
 * No output pathname, route, task/grant identity or execution token is taken from model arguments.
 */
export function createScheduleDelivery(options: ScheduleDeliveryOptions):
  (context: ToolContext, manifest: ScheduleOutputManifest, executionToken: string) => Promise<void> {
  if (!options.hermesHome || !isAbsolute(options.hermesHome) || !options.privateRoute.peerId) throw new Error('Schedule delivery requires an absolute isolated Hermes home and private route');
  const home = resolve(options.hermesHome);
  const outputRoot = join(home, 'cron', 'output');
  const maximum = options.maxOutputBytes ?? 64 * 1024 * 1024;
  const inlineLimit = options.maxInlineCharacters ?? 7000;
  const excerptLimit = options.excerptCharacters ?? 1200;
  for (const [value, maximumAllowed] of [[maximum, 1024 * 1024 * 1024], [inlineLimit, 32768], [excerptLimit, 3500]]) {
    if (!Number.isSafeInteger(value) || value! < 1 || value! > maximumAllowed!) throw new Error('Invalid schedule output limit');
  }
  const locks = new Map<string, Promise<void>>();
  return async (context, manifest, executionToken) => {
    identity(manifest.job_id); identity(manifest.execution_id);
    const key = keyFor(manifest.job_id, manifest.execution_id);
    const prior = locks.get(key) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(async () => {
      const validate = () => {
        if (manifest.task_id !== `cron:${manifest.job_id}:${manifest.execution_id}` || context.runId !== manifest.task_id ||
          !sameContext(options.agent.resolveToolContext(executionToken), context)) throw new ScheduleDeliveryError('Native result does not match its trusted execution context');
        options.agent.validateExecutionContext(context);
        options.agent.authorizeTool(executionToken, 'telegram.send', options.privateRoute.peerId);
      };
      validate();
      if (!['completed', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(manifest.outcome) ||
          !((manifest.output_file === null && manifest.output_sha256 === null) || (typeof manifest.output_file === 'string' && /^[a-f0-9]{64}$/u.test(manifest.output_sha256 ?? '')))) {
        throw new ScheduleDeliveryError('Invalid native terminal manifest');
      }
      const manifestHash = digest(canonicalJson(manifest));
      let record = options.agent.store.get<ScheduleDeliveryRecord>(namespace, key);
      if (record && (!sameContext(record.context, context) || record.manifestHash !== manifestHash)) throw new ScheduleDeliveryError('Saved schedule result identity changed');
      const now = new Date().toISOString();
      record ??= { jobId: manifest.job_id, executionId: manifest.execution_id, context: { ...context },
        manifestHash, manifest: structuredClone(manifest), state: 'prepared', preparedSends: [], effectIds: [], createdAt: now, updatedAt: now };
      const save = () => { record!.updatedAt = new Date().toISOString(); options.agent.store.put(namespace, key, record); };
      save();
      if (record.state === 'verified') return;
      if (manifest.outcome === 'unknown') { record.state = 'unknown'; record.reason = 'Native execution outcome is unknown; no result delivery'; save(); throw new ScheduleDeliveryError(record.reason); }

      if (!record.preparedSends.length) {
        const intent = options.agent.status(context.taskId)?.intent;
        if (!intent || intent.revision !== context.intentRevision) throw new ScheduleDeliveryError('Owner task is absent or revised');
        let artifact: ArtifactRecord | undefined;
        let outputText: string | undefined;
        if (record.artifactId) {
          artifact = options.artifacts.get({ ownerId: intent.ownerId, taskId: intent.id }, record.artifactId);
          if (artifact.sha256 !== manifest.output_sha256) throw new ScheduleDeliveryError('Archived result differs from its native manifest');
          if (artifact.mimeType.startsWith('text/')) outputText = new TextDecoder('utf-8', { fatal: true }).decode(options.artifacts.read({ ownerId: intent.ownerId, taskId: intent.id }, artifact.id));
        } else if (manifest.output_file !== null) {
          // Recheck every ancestor and the leaf before and after reading; no symlink/junction/hardlink aliases.
          safePath(home, 'directory'); safePath(outputRoot, 'directory');
          if (!isAbsolute(manifest.output_file)) throw new ScheduleDeliveryError('Native output path must be absolute');
          const source = contained(outputRoot, manifest.output_file);
          if (source === outputRoot) throw new ScheduleDeliveryError('Native output is not a file');
          const bytes = boundedRead(source, maximum);
          if (digest(bytes) !== manifest.output_sha256) throw new ScheduleDeliveryError('Native output SHA256 mismatch');
          validate();
          const sourceRef = `hermes-cron:${manifest.job_id}:${manifest.execution_id}:${manifest.output_sha256}`;
          artifact = options.artifacts.list({ ownerId: intent.ownerId, taskId: intent.id }).find(item => item.sourceRef === sourceRef && item.sha256 === manifest.output_sha256 && !item.revokedAt);
          if (!artifact) {
            let name = basename(source);
            try { fileName(name); } catch { name = 'schedule-output-' + manifest.output_sha256!.slice(0, 12) + '.bin'; }
            artifact = options.artifacts.put({ ownerId: intent.ownerId, taskId: intent.id, name, bytes, sourceRef });
          }
          record.artifactId = artifact.id; save();
          if (artifact.mimeType.startsWith('text/')) outputText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        const successful = manifest.outcome === 'completed';
        const label = successful ? 'Результат по расписанию' : manifest.outcome === 'failed' ? 'Выполнение по расписанию завершилось ошибкой' :
          manifest.outcome === 'cancelled' ? 'Выполнение по расписанию отменено' : 'Выполнение по расписанию прервано';
        const header = `🤖 Нейробратик · ${label}`;
        let notice: string;
        const upload = !!artifact && successful && (outputText === undefined || outputText.length > inlineLimit);
        if (successful && !artifact) notice = header + '\nГотовый файл результата отсутствует; успешная доставка результата не подтверждена.';
        else if (successful && outputText !== undefined) notice = header + '\n' + (upload ? excerpt(outputText, excerptLimit) + '\n\nПолный оригинал — в приложенном файле.' : outputText);
        else if (successful && artifact) notice = header + '\nОригинал результата — в приложенном файле.';
        else notice = header + (artifact ? '\nДиагностика сохранена; готовым результатом она не считается.' : '.');

        const sends: PreparedSend[] = [];
        if (upload && artifact) {
          if (!options.artifactSend) throw new ScheduleDeliveryError('Binary/long result archived, but trusted artifact upload adapter is unavailable');
          options.agent.authorizeTool(executionToken, 'telegram.media.send', options.privateRoute.peerId);
          const staged = await options.artifactSend(context, artifact.id);
          validate(); options.agent.authorizeTool(executionToken, 'telegram.media.send', options.privateRoute.peerId);
          if (staged.mimeType !== artifact.mimeType || staged.name !== artifact.name || (staged.size !== undefined && staged.size !== artifact.size)) throw new ScheduleDeliveryError('Trusted artifact staging metadata changed');
          const stagedBytes = boundedRead(staged.path, maximum);
          if (digest(stagedBytes) !== artifact.sha256) throw new ScheduleDeliveryError('Trusted artifact staging bytes changed');
          sends.push({ id: `schedule:${manifest.job_id}:${manifest.execution_id}:document`, capability: 'telegram.media.send', resource: options.privateRoute.peerId,
            payload: { peerId: options.privateRoute.peerId, ...(options.privateRoute.threadId ? { threadId: options.privateRoute.threadId } : {}),
              artifactId: artifact.id, profile: 'file', mediaType: 'document', path: staged.path, caption: header } });
        }
        for (const [index, part] of deliveryParts(notice).entries()) sends.push({ id: `schedule:${manifest.job_id}:${manifest.execution_id}:text:${index}`,
          capability: 'telegram.send', resource: options.privateRoute.peerId, payload: { peerId: options.privateRoute.peerId,
            ...(options.privateRoute.threadId ? { threadId: options.privateRoute.threadId } : {}), text: part } });
        record.preparedSends = sends; save();
      }
      for (const send of record.preparedSends) {
        validate(); options.agent.authorizeTool(executionToken, send.capability, send.resource);
        const effect: Effect = await options.agent.executeEffect(executionToken, send);
        if (!record.effectIds.includes(effect.id)) record.effectIds.push(effect.id);
        if (effect.state !== 'verified') { record.state = effect.state === 'failed' || effect.state === 'cancelled' ? 'failed' : 'unknown';
          record.reason = effect.reason ?? 'Schedule delivery settlement is ' + effect.state; save(); throw new ScheduleDeliveryError(record.reason); }
        save();
      }
      record.state = 'verified'; delete record.reason; save();
    }).catch(error => {
      const record = options.agent.store.get<ScheduleDeliveryRecord>(namespace, key);
      if (record && record.state !== 'verified') {
        const unknown = record.effectIds.some(id => ['unknown', 'dispatching'].includes(options.agent.store.get<Effect>('effects', id)?.state ?? ''));
        record.state = record.state === 'unknown' || unknown ? 'unknown' : 'failed';
        record.reason = error instanceof Error ? error.message : String(error); record.updatedAt = new Date().toISOString();
        options.agent.store.put(namespace, key, record);
      }
      throw error;
    });
    locks.set(key, current);
    try { await current; } finally { if (locks.get(key) === current) locks.delete(key); }
  };
}
