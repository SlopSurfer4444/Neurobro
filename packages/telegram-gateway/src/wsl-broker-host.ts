import { createHash } from "node:crypto";
import { BrokerError, BrokerFramer, boundedText, canonicalJson, decodeFrame, encodeFrame, exactKeys, requireBroker, sessionOptions, type BrokerSession, type ContextMethod, type FrameCore, type Json } from "./wsl-broker-contract.js";

export interface SnapshotFile { path: string; text: string; sha256: string; mode: "100644" | "100755" }
export interface AcceptedSnapshot { repository: "DecadansNeurobro"; commit: string; tree: string; files: readonly SnapshotFile[] }
export interface PrimaryPage { items: { kind: "primary" | "media-derivative"; anchor: string; text: string }[]; nextCursor: string | null }
/** Supplied only by the existing sole session owner; this capability opens no client. */
export interface SoleGatewayContextOwner { read(method: ContextMethod, args: Readonly<Record<string, Json>>, signal: AbortSignal): Promise<PrimaryPage> }
export interface ReturnProposal { kind: "reply"; chat: string; anchor: string; text: string; idempotencyKey: string }
export interface GuardedProposalOwner { enqueue(proposal: Readonly<ReturnProposal>, signal: AbortSignal): Promise<"queued" | "refused" | "unknown"> }
export interface HostOptions extends BrokerSession {
  snapshot: AcceptedSnapshot;
  acceptsSnapshot: (identity: Readonly<{ repository: string; commit: string; tree: string }>) => boolean;
  chat: string;
  gateway: SoleGatewayContextOwner;
  proposals: GuardedProposalOwner;
  killSwitchEngaged: () => boolean;
}
export interface BrokerReceipt { version: 1; calls: number; requestBytes: number; responseBytes: number; outcome: "ok" | "refused" | "unknown" }
function relativePath(value: unknown): asserts value is string {
  boundedText(value, 240);
  requireBroker(/^[A-Za-z0-9_./-]+$/.test(value) && !value.startsWith("/") && !value.endsWith("/"));
  requireBroker(value.split("/").every(part => part !== "" && part !== "." && part !== ".." && !/^\.(git|env)(\.|$)/i.test(part) && !/^(credentials?|sessions?)(\.|$)/i.test(part)), "path-refused");
}
function finiteLimit(value: unknown, max: number): asserts value is number { requireBroker(Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max); }
export function createWslBrokerHost(input: HostOptions) {
  const session = sessionOptions(input); const limit = session.limits;
  boundedText(input.chat, 64); requireBroker(input.chat.length > 0);
  const chat = input.chat;
  const readPrimary = input.gateway.read.bind(input.gateway);
  const enqueueProposal = input.proposals.enqueue.bind(input.proposals);
  const killSwitchEngaged = input.killSwitchEngaged;
  const identity = Object.freeze({ repository: input.snapshot.repository, commit: input.snapshot.commit, tree: input.snapshot.tree });
  requireBroker(identity.repository === "DecadansNeurobro" && /^[a-f0-9]{40}$/.test(identity.commit) && /^[a-f0-9]{40}$/.test(identity.tree), "snapshot-refused");
  requireBroker(input.acceptsSnapshot(identity) === true, "snapshot-not-accepted");
  requireBroker(input.snapshot.files.length <= 256, "snapshot-budget");
  const files = new Map<string, Readonly<SnapshotFile>>(); let snapshotBytes = 0;
  for (const entry of input.snapshot.files) {
    exactKeys(entry, ["path", "text", "sha256", "mode"]); relativePath(entry.path); boundedText(entry.text, limit.maxTextBytes);
    requireBroker(entry.mode === "100644" || entry.mode === "100755", "snapshot-file-kind");
    requireBroker(!files.has(entry.path) && createHash("sha256").update(entry.text).digest("hex") === entry.sha256, "snapshot-integrity");
    snapshotBytes += Buffer.byteLength(entry.text); requireBroker(snapshotBytes <= 1048576, "snapshot-budget");
    files.set(entry.path, Object.freeze({ ...entry }));
  }
  const receipts: BrokerReceipt[] = []; const proposals = new Set<string>();
  let lastSequence = 0; let calls = 0; let usedBytes = 0; let busy = false; let closed = false; let lastNow = 0;
  let activeController: AbortController | undefined;
  async function dispatch(body: Json, signal: AbortSignal): Promise<Json> {
    exactKeys(body, ["method", "args"]); requireBroker(typeof body.method === "string");
    const args = body.args; requireBroker(args !== null && typeof args === "object" && !Array.isArray(args));
    if (body.method === "snapshot.list") {
      exactKeys(args, ["prefix", "limit"]); boundedText(args.prefix, 240); finiteLimit(args.limit, limit.maxItems);
      if (args.prefix !== "") relativePath(args.prefix);
      const paths = [...files.keys()].filter(p => p.startsWith(args.prefix as string)).sort();
      return { ...identity, paths: paths.slice(0, args.limit), truncated: paths.length > args.limit };
    }
    if (body.method === "snapshot.read") {
      exactKeys(args, ["path"]); relativePath(args.path); const file = files.get(args.path); requireBroker(file, "not-found");
      return { ...identity, path: file.path, text: file.text, sha256: file.sha256 };
    }
    if (body.method === "snapshot.search") {
      exactKeys(args, ["query", "limit"]); boundedText(args.query, 256); requireBroker(args.query.length > 0); finiteLimit(args.limit, limit.maxItems);
      const matches = [...files.values()].filter(f => f.text.includes(args.query as string)).map(f => f.path).sort();
      return { ...identity, paths: matches.slice(0, args.limit), truncated: matches.length > args.limit };
    }
    if (["telegram.anchor.read", "telegram.range.read", "telegram.reply_chain.read", "telegram.search", "telegram.media_derivative.read"].includes(body.method)) {
      const method = body.method as ContextMethod;
      const fields = method === "telegram.range.read" ? ["chat", "from", "to", "cursor", "limit"] : method === "telegram.search" ? ["chat", "query", "cursor", "limit"] : ["chat", "anchor", "limit"];
      exactKeys(args, fields); requireBroker(args.chat === chat, "chat-refused"); finiteLimit(args.limit, limit.maxItems);
      for (const key of ["anchor", "query"]) if (key in args) { boundedText(args[key], key === "query" ? 256 : 128); requireBroker((args[key] as string).length > 0); }
      if ("cursor" in args) { requireBroker(args.cursor === null || typeof args.cursor === "string"); if (args.cursor !== null) boundedText(args.cursor, 256); }
      if ("from" in args) requireBroker(Number.isSafeInteger(args.from) && Number.isSafeInteger(args.to) && (args.from as number) >= 0 && (args.to as number) > (args.from as number));
      let page: PrimaryPage;
      try { page = await readPrimary(method, Object.freeze({ ...args }) as Record<string, Json>, signal); }
      catch { throw new BrokerError("owner-outcome-unknown"); }
      exactKeys(page, ["items", "nextCursor"]); requireBroker(Array.isArray(page.items) && page.items.length <= args.limit, "response-budget");
      requireBroker(page.nextCursor === null || typeof page.nextCursor === "string"); if (page.nextCursor !== null) boundedText(page.nextCursor, 256);
      for (const item of page.items) { exactKeys(item, ["kind", "anchor", "text"]); requireBroker(item.kind === (method === "telegram.media_derivative.read" ? "media-derivative" : "primary")); boundedText(item.anchor, 128); boundedText(item.text, limit.maxTextBytes); }
      return JSON.parse(canonicalJson(page)) as Json;
    }
    if (body.method === "proposal.submit") {
      exactKeys(args, ["kind", "chat", "anchor", "text", "idempotencyKey"]);
      requireBroker(args.kind === "reply" && args.chat === chat, "proposal-refused"); boundedText(args.anchor, 128); boundedText(args.text, limit.maxTextBytes); boundedText(args.idempotencyKey, 64);
      requireBroker(typeof args.idempotencyKey === "string" && /^[a-f0-9]{32}$/.test(args.idempotencyKey) && (args.text as string).length > 0 && (args.anchor as string).length > 0);
      requireBroker(!proposals.has(args.idempotencyKey), "duplicate-proposal"); proposals.add(args.idempotencyKey);
      let outcome: "queued" | "refused" | "unknown";
      try { outcome = await enqueueProposal(Object.freeze({ ...args }) as unknown as ReturnProposal, signal); }
      catch { throw new BrokerError("owner-outcome-unknown"); }
      requireBroker(["queued", "refused", "unknown"].includes(outcome), "owner-outcome-unknown");
      if (outcome === "unknown") { closed = true; throw new BrokerError("owner-outcome-unknown"); }
      return { outcome }; // queued is never a delivery or read-after-write receipt.
    }
    throw new BrokerError("method-refused");
  }
  return Object.freeze({
    async handle(bytes: Uint8Array): Promise<Buffer> {
      requireBroker(!closed && !busy, "session-unavailable");
      const request = decodeFrame(bytes, session, "request"); const now = session.now();
      requireBroker(Number.isSafeInteger(now) && now >= lastNow, "clock-refused"); lastNow = now;
      requireBroker(request.sequence === lastSequence + 1, "replay-or-sequence-gap");
      requireBroker(request.deadlineMs > now && request.deadlineMs - now <= limit.maxDeadlineMs, "deadline-refused");
      requireBroker(calls < limit.maxCalls && usedBytes + bytes.length + 1024 <= limit.maxSessionBytes, "session-budget");
      lastSequence = request.sequence; calls++; usedBytes += bytes.length; busy = true;
      let outcome: BrokerReceipt["outcome"] = "ok"; let value: Json = null; let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = new AbortController();
      activeController = abort;
      try {
        requireBroker(!killSwitchEngaged(), "kill-switch");
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { closed = true; abort.abort(); reject(new BrokerError("deadline-unknown")); }, Math.max(1, request.deadlineMs - session.now())); });
        value = await Promise.race([dispatch(request.body, abort.signal), timeout]);
        requireBroker(!closed && !abort.signal.aborted, "owner-outcome-unknown");
        const completedAt = session.now();
        requireBroker(Number.isSafeInteger(completedAt) && completedAt >= now && completedAt < request.deadlineMs, "deadline-unknown"); lastNow = completedAt;
        requireBroker(Buffer.byteLength(canonicalJson(value)) <= limit.maxBodyBytes, "response-budget");
      } catch (error) {
        const known = error instanceof BrokerError;
        const code = known ? error.code : "owner-outcome-unknown";
        outcome = code.endsWith("unknown") || !known ? "unknown" : "refused";
        if (outcome === "unknown") { closed = true; abort.abort(); }
        value = { code: known ? code : "owner-outcome-unknown" };
      } finally { if (timer !== undefined) clearTimeout(timer); busy = false; activeController = undefined; }
      const core: FrameCore = { version: 1, kind: "response", keyId: request.keyId, sessionId: request.sessionId, id: request.id, sequence: request.sequence, deadlineMs: request.deadlineMs, body: { outcome, value } };
      let response = encodeFrame(core, session);
      if (usedBytes + response.length > limit.maxSessionBytes) { outcome = "refused"; core.body = { outcome, value: { code: "session-budget" } }; response = encodeFrame(core, session); closed = true; }
      usedBytes += response.length; receipts.push(Object.freeze({ version: 1, calls, requestBytes: bytes.length, responseBytes: response.length, outcome })); return response;
    },
    receipts: (): readonly BrokerReceipt[] => receipts.map(r => ({ ...r })),
    close: (): void => { closed = true; activeController?.abort(); },
  });
}
/** Attach only to already-owned pipes. This module cannot spawn WSL or open a port. */
export async function serveBrokerFrames(input: AsyncIterable<Uint8Array>, write: (frame: Uint8Array) => Promise<void>, host: ReturnType<typeof createWslBrokerHost>): Promise<void> {
  const framer = new BrokerFramer();
  try { for await (const chunk of input) for (const frame of framer.push(chunk)) await write(await host.handle(frame)); framer.end(); }
  finally { host.close(); }
}
