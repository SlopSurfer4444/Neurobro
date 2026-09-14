import { createHmac, timingSafeEqual } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const BROKER_METHODS = ["snapshot.list", "snapshot.read", "snapshot.search", "telegram.anchor.read", "telegram.range.read", "telegram.reply_chain.read", "telegram.search", "telegram.media_derivative.read", "proposal.submit"] as const;
export type BrokerMethod = typeof BROKER_METHODS[number];
export type ContextMethod = Extract<BrokerMethod, `telegram.${string}`>;
export interface BrokerLimits { maxFrameBytes: number; maxBodyBytes: number; maxCalls: number; maxSessionBytes: number; maxItems: number; maxTextBytes: number; maxDeadlineMs: number }
export const DEFAULT_BROKER_LIMITS: Readonly<BrokerLimits> = Object.freeze({ maxFrameBytes: 32768, maxBodyBytes: 24000, maxCalls: 32, maxSessionBytes: 262144, maxItems: 64, maxTextBytes: 16384, maxDeadlineMs: 5000 });
export interface BrokerSession { key: Uint8Array; keyId: string; sessionId: string; now?: () => number; limits?: Partial<BrokerLimits> }
export interface FrameCore { version: 1; kind: "request" | "response"; keyId: string; sessionId: string; id: string; sequence: number; deadlineMs: number; body: Json }
export interface BrokerFrame extends FrameCore { mac: string }
export class BrokerError extends Error { constructor(public readonly code: string) { super(code); this.name = "BrokerError"; } }
export function requireBroker(ok: unknown, code = "invalid-request"): asserts ok { if (!ok) throw new BrokerError(code); }
export function exactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireBroker(value !== null && typeof value === "object" && !Array.isArray(value));
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  requireBroker(actual.length === expected.length && actual.every((key, index) => key === expected[index]));
}
export function boundedText(value: unknown, maxBytes: number): asserts value is string {
  requireBroker(typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes);
  requireBroker(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const next = value.charCodeAt(++i); requireBroker(next >= 0xdc00 && next <= 0xdfff); }
    else requireBroker(c < 0xdc00 || c > 0xdfff);
  }
}
function canonicalValue(value: unknown, depth: number, count: { n: number }): string {
  requireBroker(depth <= 12 && ++count.n <= 4096, "json-budget");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { requireBroker(Number.isSafeInteger(value)); return JSON.stringify(value); }
  if (typeof value === "string") { boundedText(value, DEFAULT_BROKER_LIMITS.maxFrameBytes); return JSON.stringify(value); }
  requireBroker(typeof value === "object" && value !== null);
  if (Array.isArray(value)) return `[${value.map(v => canonicalValue(v, depth + 1, count)).join(",")}]`;
  requireBroker(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(k => { boundedText(k, 128); requireBroker(!["__proto__", "constructor", "prototype"].includes(k)); return `${JSON.stringify(k)}:${canonicalValue(record[k], depth + 1, count)}`; }).join(",")}}`;
}
export function canonicalJson(value: unknown): string { return canonicalValue(value, 0, { n: 0 }); }
export function sessionOptions(input: BrokerSession): Required<BrokerSession> & { limits: BrokerLimits } {
  requireBroker(input.key instanceof Uint8Array && input.key.length >= 32 && input.key.length <= 64, "invalid-session");
  requireBroker(/^[A-Za-z0-9_-]{1,48}$/.test(input.keyId) && /^[a-f0-9]{32}$/.test(input.sessionId), "invalid-session");
  const limits = { ...DEFAULT_BROKER_LIMITS, ...input.limits };
  requireBroker(Object.keys(limits).length === Object.keys(DEFAULT_BROKER_LIMITS).length, "invalid-limits");
  for (const key of Object.keys(DEFAULT_BROKER_LIMITS) as (keyof BrokerLimits)[]) requireBroker(Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= DEFAULT_BROKER_LIMITS[key], "invalid-limits");
  return { key: Buffer.from(input.key), keyId: input.keyId, sessionId: input.sessionId, limits, now: input.now ?? (() => Math.floor(performance.timeOrigin + performance.now())) };
}
function mac(core: FrameCore, key: Uint8Array): string { return createHmac("sha256", key).update("decadans-wsl-broker/v1\n" + canonicalJson(core)).digest("hex"); }
export function encodeFrame(core: FrameCore, session: BrokerSession): Buffer {
  const options = sessionOptions(session);
  requireBroker(Buffer.byteLength(canonicalJson(core.body)) <= options.limits.maxBodyBytes, "body-budget");
  const frame = Buffer.from(canonicalJson({ ...core, mac: mac(core, options.key) }) + "\n", "utf8");
  requireBroker(frame.length <= options.limits.maxFrameBytes, "frame-budget"); return frame;
}
export function decodeFrame(bytes: Uint8Array, session: BrokerSession, kind: FrameCore["kind"]): BrokerFrame {
  const options = sessionOptions(session);
  requireBroker(bytes.length > 1 && bytes.length <= options.limits.maxFrameBytes, "frame-budget");
  let text: string; let value: unknown;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); value = JSON.parse(text); } catch { throw new BrokerError("invalid-frame"); }
  requireBroker(text === canonicalJson(value) + "\n", "noncanonical-frame");
  exactKeys(value, ["version", "kind", "keyId", "sessionId", "id", "sequence", "deadlineMs", "body", "mac"]);
  requireBroker(value.version === 1 && value.kind === kind && value.keyId === options.keyId && value.sessionId === options.sessionId, "wrong-session");
  requireBroker(typeof value.id === "string" && /^[a-f0-9]{32}$/.test(value.id));
  requireBroker(Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0 && Number.isSafeInteger(value.deadlineMs));
  requireBroker(typeof value.mac === "string" && /^[a-f0-9]{64}$/.test(value.mac), "authentication-failed");
  const { mac: actual, ...core } = value;
  requireBroker(timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(mac(core as unknown as FrameCore, options.key), "hex")), "authentication-failed");
  requireBroker(Buffer.byteLength(canonicalJson(core.body)) <= options.limits.maxBodyBytes, "body-budget");
  return value as unknown as BrokerFrame;
}
/** Bounded JSONL framing; partial frames stay private in memory. */
export class BrokerFramer {
  private pending = Buffer.alloc(0);
  private failed = false;
  constructor(private readonly maxBytes = DEFAULT_BROKER_LIMITS.maxFrameBytes) { requireBroker(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= DEFAULT_BROKER_LIMITS.maxFrameBytes); }
  push(chunk: Uint8Array): Buffer[] {
    requireBroker(!this.failed, "framer-closed");
    const frames: Buffer[] = [];
    try {
      for (let offset = 0; offset < chunk.length;) {
        const index = chunk.indexOf(10, offset); const end = index < 0 ? chunk.length : index + 1;
        requireBroker(this.pending.length + end - offset <= this.maxBytes, "frame-budget");
        this.pending = Buffer.concat([this.pending, chunk.subarray(offset, end)]); offset = end;
        if (index >= 0) { requireBroker(this.pending.length > 1, "empty-frame"); frames.push(this.pending); this.pending = Buffer.alloc(0); }
        requireBroker(frames.length <= DEFAULT_BROKER_LIMITS.maxCalls, "frame-budget");
      }
      return frames;
    } catch (error) { this.failed = true; this.pending = Buffer.alloc(0); throw error; }
  }
  end(): void { this.failed = true; requireBroker(this.pending.length === 0, "truncated-frame"); }
  hasPending(): boolean { return this.pending.length !== 0; }
}
