import { Api, TelegramClient } from "telegram";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import type {
  AppConfig,
  ExportedMessage,
  ResolvedSource,
  SourceConfig,
} from "./types.js";
import { GuardedExecutor } from "./guardrails.js";
import { StateStore } from "./state-store.js";
import { JsonlSink } from "./jsonl-sink.js";
import { getStablePeerId } from "./telegram-client.js";

function optionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return String(value);
  } catch {
    return undefined;
  }
}

export function toIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

export function normalizeMessage(message: Api.Message, source: SourceConfig): ExportedMessage {
  const senderId = optionalString(message.senderId ?? message.fromId);
  const editDate = message.editDate ? toIsoDate(message.editDate) : undefined;
  const mediaType = message.media?.className;
  const replyToMessageId = optionalNumber(message.replyTo?.replyToMsgId);
  const groupedId = optionalString(message.groupedId);
  return {
    schemaVersion: 1,
    sourceId: source.id,
    peerId: source.peerId,
    messageId: message.id,
    date: toIsoDate(message.date),
    ...(editDate ? { editDate } : {}),
    ...(senderId ? { senderId } : {}),
    ...(source.includeText ? { text: message.message ?? "" } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    ...(groupedId ? { groupedId } : {}),
    untrustedInput: true,
  };
}

async function collectMessages(
  client: TelegramClient,
  resolved: ResolvedSource,
  options: { limit: number; minId?: number; reverse?: boolean },
): Promise<Api.Message[]> {
  const messages: Api.Message[] = [];
  for await (const message of client.iterMessages(resolved.peer, {
    limit: options.limit,
    minId: options.minId ?? 0,
    reverse: options.reverse ?? false,
    waitTime: 0,
  })) {
    if (message instanceof Api.Message) messages.push(message);
  }
  return messages;
}

export class TelegramIngestor {
  private readonly sink: JsonlSink;

  constructor(
    private readonly config: AppConfig,
    private readonly client: TelegramClient,
    private readonly guard: GuardedExecutor,
    private readonly store: StateStore,
    private readonly sources: ResolvedSource[],
  ) {
    this.sink = new JsonlSink(config.output.directory);
  }

  private async persistBatch(resolved: ResolvedSource, messages: Api.Message[]): Promise<number> {
    if (messages.length === 0) return 0;
    const ordered = [...messages].sort((left, right) => left.id - right.id);
    const cutoff = Date.now() - this.config.limits.lookbackDays * 24 * 60 * 60 * 1000;
    const exportable = ordered.filter((message) => Date.parse(toIsoDate(message.date)) >= cutoff);
    await this.sink.append(exportable.map((message) => normalizeMessage(message, resolved.source)));
    const state = await this.store.load();
    const maximum = Math.max(...ordered.map((message) => message.id));
    state.cursors[resolved.source.id] = {
      lastMessageId: maximum,
      lastSyncedAt: new Date().toISOString(),
    };
    await this.store.save();
    return ordered.length;
  }

  private async initialSync(resolved: ResolvedSource): Promise<number> {
    const limit = Math.max(1, resolved.source.initialBackfillMessages);
    const messages = await this.guard.execute(`messages.getHistory.initial:${resolved.source.id}`, () =>
      collectMessages(this.client, resolved, { limit }),
    );
    if (resolved.source.initialBackfillMessages === 0 && messages.length > 0) {
      const state = await this.store.load();
      state.cursors[resolved.source.id] = {
        lastMessageId: Math.max(...messages.map((message) => message.id)),
        lastSyncedAt: new Date().toISOString(),
      };
      await this.store.save();
      return 0;
    }
    return this.persistBatch(resolved, messages);
  }

  async syncSource(resolved: ResolvedSource): Promise<number> {
    const state = await this.store.load();
    let cursor = state.cursors[resolved.source.id]?.lastMessageId ?? 0;
    if (cursor === 0) return this.initialSync(resolved);

    let total = 0;
    for (let page = 0; page < this.config.limits.maxPagesPerSourcePerRun; page += 1) {
      const remaining = this.config.limits.maxMessagesPerSourcePerRun - total;
      if (remaining <= 0) break;
      const limit = Math.min(this.config.limits.historyPageSize, remaining);
      const messages = await this.guard.execute(`messages.getHistory.incremental:${resolved.source.id}`, () =>
        collectMessages(this.client, resolved, { limit, minId: cursor, reverse: true }),
      );
      if (messages.length === 0) break;
      total += await this.persistBatch(resolved, messages);
      cursor = Math.max(cursor, ...messages.map((message) => message.id));
      if (messages.length < limit) break;
    }
    return total;
  }

  async syncAll(): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const resolved of this.sources) {
      result[resolved.source.id] = await this.syncSource(resolved);
    }
    await this.sink.flush();
    return result;
  }

  private async ingestLiveMessage(message: Api.Message): Promise<void> {
    const peerId = getStablePeerId(message);
    const resolved = this.sources.find((entry) => entry.source.peerId === peerId);
    if (!resolved) return;
    const state = await this.store.load();
    const cursor = state.cursors[resolved.source.id]?.lastMessageId ?? 0;
    if (message.id <= cursor) return;
    await this.persistBatch(resolved, [message]);
  }

  async watch(signal: AbortSignal): Promise<void> {
    const buffer: Api.Message[] = [];
    let buffering = true;
    let chain = Promise.resolve();
    let fatalError: unknown;
    let signalFatal: () => void = () => undefined;
    const fatal = new Promise<void>((resolve) => {
      signalFatal = resolve;
    });
    const rejectFatal = (error: unknown) => {
      fatalError = error;
      signalFatal();
    };
    const eventBuilder = new NewMessage({ incoming: true });
    const handler = (event: NewMessageEvent) => {
      const message = event.message;
      if (!(message instanceof Api.Message)) return;
      if (buffering) {
        if (buffer.length >= this.config.limits.liveBufferSize) {
          rejectFatal(new Error("Live update buffer overflowed; stopping without dropping messages silently."));
          return;
        }
        buffer.push(message);
        return;
      }
      chain = chain.then(() => this.ingestLiveMessage(message));
      chain.catch(rejectFatal);
    };

    this.client.addEventHandler(handler, eventBuilder);
    try {
      await this.syncAll();
      while (buffer.length > 0) {
        const message = buffer.shift();
        if (message) await this.ingestLiveMessage(message);
      }
      buffering = false;
      const aborted = new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.race([aborted, fatal]);
      if (fatalError) throw fatalError;
      await chain;
      await this.sink.flush();
    } finally {
      this.client.removeEventHandler(handler, eventBuilder);
    }
  }
}
