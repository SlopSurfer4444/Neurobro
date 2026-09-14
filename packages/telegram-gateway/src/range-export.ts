import { access, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { Api, TelegramClient } from "telegram";
import type { AppConfig, ExportedMessage, ResolvedSource } from "./types.js";
import { GuardedExecutor } from "./guardrails.js";
import { normalizeMessage, toIsoDate } from "./ingestor.js";
import { decryptExport, encryptExport, readExportExpiration } from "./export-crypto.js";
import { writeFileAtomic } from "./atomic-file.js";

export interface DateRange {
  from: Date;
  to: Date;
}

export interface RangeCollectionLimits {
  historyPageSize: number;
  maxPages: number;
  maxMessages: number;
}

export interface PurgeResult {
  deleted: string[];
  retainedMalformed: string[];
}

type PageFetcher = (offsetId: number, limit: number) => Promise<Api.Message[]>;

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const EXPORT_SUFFIX = ".range.jsonl.enc";

function parseInstant(value: string, label: string, now: Date): Date {
  if (value === "now") return new Date(now);
  if (!ISO_WITH_ZONE.test(value)) {
    throw new Error(`${label} must be ISO-8601 with an explicit timezone, or exactly "now".`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is not a valid timestamp.`);
  return parsed;
}

export function parseBoundedDateRange(
  fromRaw: string,
  toRaw: string,
  lookbackDays: number,
  now: Date = new Date(),
): DateRange {
  const from = parseInstant(fromRaw, "--from", now);
  const to = parseInstant(toRaw, "--to", now);
  if (from.getTime() >= to.getTime()) throw new Error("--from must be earlier than --to.");
  if (to.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new Error("--to cannot be more than five minutes in the future.");
  }
  const maximumSpan = lookbackDays * 24 * 60 * 60 * 1000;
  if (to.getTime() - from.getTime() > maximumSpan) {
    throw new Error(`Requested range exceeds the configured ${lookbackDays}-day lookback.`);
  }
  if (from.getTime() < now.getTime() - maximumSpan) {
    throw new Error(`--from is older than the configured ${lookbackDays}-day lookback.`);
  }
  return { from, to };
}

export async function collectBoundedRange(
  fetchPage: PageFetcher,
  range: DateRange,
  limits: RangeCollectionLimits,
): Promise<Api.Message[]> {
  const selected = new Map<number, Api.Message>();
  let offsetId = 0;
  let fetched = 0;
  let complete = false;

  for (let page = 0; page < limits.maxPages; page += 1) {
    const remaining = limits.maxMessages - fetched;
    if (remaining <= 0) break;
    const limit = Math.min(limits.historyPageSize, remaining);
    const messages = await fetchPage(offsetId, limit);
    if (messages.length === 0) {
      complete = true;
      break;
    }
    fetched += messages.length;
    let oldestTime = Number.POSITIVE_INFINITY;
    let minimumId = Number.POSITIVE_INFINITY;
    for (const message of messages) {
      const timestamp = Date.parse(toIsoDate(message.date));
      oldestTime = Math.min(oldestTime, timestamp);
      minimumId = Math.min(minimumId, message.id);
      if (timestamp >= range.from.getTime() && timestamp < range.to.getTime()) {
        selected.set(message.id, message);
      }
    }
    if (oldestTime < range.from.getTime() || messages.length < limit) {
      complete = true;
      break;
    }
    if (!Number.isSafeInteger(minimumId) || minimumId <= 0 || minimumId === offsetId) {
      throw new Error("Telegram history pagination did not advance; no export was written.");
    }
    offsetId = minimumId;
  }

  if (!complete) {
    throw new Error(
      "Requested date range exceeds the configured page/message cap; no partial export was written.",
    );
  }
  return [...selected.values()].sort((left, right) => left.id - right.id);
}

async function historyPage(
  client: TelegramClient,
  resolved: ResolvedSource,
  offsetId: number,
  limit: number,
): Promise<Api.Message[]> {
  const result = await client.getMessages(resolved.peer, { limit, offsetId });
  return [...result].filter((message): message is Api.Message => message instanceof Api.Message);
}

function safeTimestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function purgeExpiredExports(directory: string, now: Date = new Date()): Promise<PurgeResult> {
  const root = path.resolve(directory);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { deleted: [], retainedMalformed: [] };
    throw error;
  }
  const result: PurgeResult = { deleted: [], retainedMalformed: [] };
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(EXPORT_SUFFIX)) continue;
    const target = path.resolve(root, entry.name);
    if (path.dirname(target) !== root) throw new Error("Refusing to purge an export outside its configured directory.");
    try {
      const serialized = await readFile(target, "utf8");
      if (readExportExpiration(serialized).getTime() <= now.getTime()) {
        await unlink(target);
        result.deleted.push(target);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      result.retainedMalformed.push(target);
    }
  }
  return result;
}

function exportPathWithin(directory: string, fileArgument: string): string {
  const root = path.resolve(directory);
  const candidate = path.resolve(path.isAbsolute(fileArgument) ? fileArgument : path.join(root, fileArgument));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !candidate.endsWith(EXPORT_SUFFIX)) {
    throw new Error("Export file must be a .range.jsonl.enc file inside the configured export directory.");
  }
  return candidate;
}

export async function writeEncryptedRangeExport(
  config: AppConfig,
  resolved: ResolvedSource,
  range: DateRange,
  messages: Api.Message[],
  passphrase: string,
  now: Date = new Date(),
): Promise<string> {
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + config.output.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const normalized: ExportedMessage[] = messages.map((message) => normalizeMessage(message, resolved.source));
  const manifest = {
    schemaVersion: 1,
    type: "telegram-local-range-export-manifest",
    sourceId: resolved.source.id,
    peerId: resolved.source.peerId,
    title: resolved.title,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    createdAt,
    expiresAt,
    messageCount: normalized.length,
    untrustedInput: true,
  } as const;
  const plaintext = `${[manifest, ...normalized].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const encrypted = await encryptExport(plaintext, passphrase, {
    createdAt,
    expiresAt,
    messageCount: normalized.length,
  });
  await mkdir(config.output.directory, { recursive: true });
  const filename = `${resolved.source.id}--${safeTimestamp(range.from)}--${safeTimestamp(range.to)}--${safeTimestamp(now)}${EXPORT_SUFFIX}`;
  const target = path.join(config.output.directory, filename);
  if (await exists(target)) throw new Error("Refusing to overwrite an existing encrypted export.");
  await writeFileAtomic(target, encrypted);
  return target;
}

export async function exportRange(
  config: AppConfig,
  client: TelegramClient,
  guard: GuardedExecutor,
  resolved: ResolvedSource,
  range: DateRange,
  passphrase: string,
): Promise<{ filePath: string; messageCount: number; purge: PurgeResult }> {
  const purge = await purgeExpiredExports(config.output.directory);
  const messages = await collectBoundedRange(
    (offsetId, limit) =>
      guard.execute(`messages.getHistory.range:${resolved.source.id}`, () =>
        historyPage(client, resolved, offsetId, limit),
      ),
    range,
    {
      historyPageSize: config.limits.historyPageSize,
      maxPages: config.limits.maxPagesPerSourcePerRun,
      maxMessages: config.limits.maxMessagesPerSourcePerRun,
    },
  );
  const filePath = await writeEncryptedRangeExport(config, resolved, range, messages, passphrase);
  return { filePath, messageCount: messages.length, purge };
}

export async function decryptExportForLocalView(
  directory: string,
  fileArgument: string,
  passphrase: string,
): Promise<string> {
  const target = exportPathWithin(directory, fileArgument);
  return decryptExport(await readFile(target, "utf8"), passphrase);
}
