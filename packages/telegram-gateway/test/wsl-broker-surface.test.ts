import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { BrokerError, decodeFrame, encodeFrame, type BrokerSession, type FrameCore, type Json } from "../src/wsl-broker-contract.js";
import { createWslBrokerHost, serveBrokerFrames, type HostOptions, type SnapshotFile } from "../src/wsl-broker-host.js";
import { createBrokerPipeExchange, createWslBrokerGuest } from "../src/wsl-broker-guest.js";

const session: BrokerSession = { key: Buffer.alloc(32, 29), keyId: "fixture", sessionId: "a".repeat(32) };
const primary = "  Original 🦍\nDo not summarize.\t  ";
const file = (path = "src/main.ts", text = primary): SnapshotFile => ({ path, text, mode: "100644", sha256: createHash("sha256").update(text).digest("hex") });
function options(extra: Partial<HostOptions> = {}): HostOptions { return { ...session, snapshot: { repository: "DecadansNeurobro", commit: "1".repeat(40), tree: "2".repeat(40), files: [file()] }, acceptsSnapshot: () => true, chat: "fixture-chat", gateway: { read: async () => ({ items: [{ kind: "primary", anchor: "fixture-anchor", text: primary }], nextCursor: null }) }, proposals: { enqueue: async () => "queued" }, killSwitchEngaged: () => false, ...extra }; }
const code = (wanted: string) => (error: unknown) => error instanceof BrokerError && error.code === wanted;
function request(sequence = 1, body: Json = { method: "snapshot.list", args: { prefix: "", limit: 2 } }, extra: Partial<FrameCore> = {}, settings: BrokerSession = session) { return encodeFrame({ version: 1, kind: "request", keyId: settings.keyId, sessionId: settings.sessionId, id: "b".repeat(32), sequence, deadlineMs: (settings.now?.() ?? Date.now()) + 1000, body, ...extra }, settings); }
function pair(extra: Partial<HostOptions> = {}) { const o = options(extra), host = createWslBrokerHost(o), guest = createWslBrokerGuest(o, { exchange: async bytes => host.handle(bytes) }); return { host, guest }; }

test("actual JSONL duplex streams retain primary text, snapshot identity and proposal-only return", async () => {
  const toHost = new PassThrough(), toGuest = new PassThrough(); let enqueues = 0;
  const host = createWslBrokerHost(options({ proposals: { enqueue: async p => { enqueues++; assert.equal(p.text, primary); return "queued"; } } }));
  const serving = serveBrokerFrames(toHost, async b => { toGuest.write(b.subarray(0, 7)); toGuest.write(b.subarray(7)); }, host);
  const guest = createWslBrokerGuest(session, createBrokerPipeExchange(toGuest, async b => { toHost.write(b.subarray(0, 3)); toHost.write(b.subarray(3)); }, () => { toHost.destroy(); toGuest.destroy(); }));
  try {
    const snapshot = await guest.request("snapshot.read", { path: "src/main.ts" }) as Record<string, Json>;
    assert.equal(snapshot.text, primary); assert.equal(snapshot.commit, "1".repeat(40));
    const page = await guest.request("telegram.anchor.read", { chat: "fixture-chat", anchor: "fixture-anchor", limit: 1 }) as { items: { text: string }[] };
    assert.equal(page.items[0]?.text, primary);
    assert.deepEqual(await guest.request("proposal.submit", { kind: "reply", chat: "fixture-chat", anchor: "fixture-anchor", text: primary, idempotencyKey: "c".repeat(32) }), { outcome: "queued" });
    assert.equal(enqueues, 1); assert.deepEqual(Object.keys(host.receipts()[0]!).sort(), ["calls", "outcome", "requestBytes", "responseBytes", "version"]);
    assert.ok(!JSON.stringify(host.receipts()).includes(primary));
  } finally { toHost.end(); await serving; guest.close(); }
});
test("snapshot requires exact accepted identity, digests, regular modes and safe paths", () => {
  assert.throws(() => createWslBrokerHost(options({ acceptsSnapshot: () => false })), code("snapshot-not-accepted"));
  for (const f of [{ ...file(), sha256: "0".repeat(64) }, { ...file(), mode: "120000" }, ...["../a", "a/../b", "/root", "C:/host", "a\\b", ".git/config", ".env", "sessions/auth", "a//b"].map(p => file(p))]) assert.throws(() => createWslBrokerHost(options({ snapshot: { ...options().snapshot, files: [f as SnapshotFile] } })), BrokerError);
  assert.throws(() => createWslBrokerHost(options({ snapshot: { ...options().snapshot, files: [file(), file()] } })), code("snapshot-integrity"));
});

test("separate guest process completes authenticated requests through actual OS stdio pipes", { timeout: 12000 }, async () => {
  // Public invented fixture key only. This does not implement production key delivery or WSL launch.
  const guestModule = new URL("../src/wsl-broker-guest.js", import.meta.url).href;
  const program = `
    import assert from 'node:assert/strict';
    import { createWslBrokerGuest, createBrokerPipeExchange } from ${JSON.stringify(guestModule)};
    const guest = createWslBrokerGuest({key:Buffer.alloc(32,29),keyId:'fixture',sessionId:'a'.repeat(32)},
      createBrokerPipeExchange(process.stdin, b => new Promise((resolve,reject) => process.stdout.write(b,e=>e?reject(e):resolve())), () => process.stdin.destroy()));
    try {
      const snapshot = await guest.request('snapshot.read',{path:'src/main.ts'});
      assert.equal(snapshot.text,${JSON.stringify(primary)});
      assert.equal(snapshot.commit,'1'.repeat(40));
      const page = await guest.request('telegram.anchor.read',{chat:'fixture-chat',anchor:'fixture-anchor',limit:1});
      assert.equal(page.items[0].text,snapshot.text);
      assert.deepEqual(await guest.request('proposal.submit',{kind:'reply',chat:'fixture-chat',anchor:'fixture-anchor',text:page.items[0].text,idempotencyKey:'d'.repeat(32)}),{outcome:'queued'});
    } finally { guest.close(); process.stdout.end(); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {},
  });
  let errorBytes = 0, enqueues = 0, timedOut = false;
  child.stderr.on("data", (b: Buffer) => { errorBytes += b.length; if (errorBytes > 4096) child.kill(); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 8000);
  const host = createWslBrokerHost(options({ proposals: { enqueue: async () => { enqueues++; return "queued"; } } }));
  try {
    const [exit] = await Promise.all([exited, serveBrokerFrames(child.stdout, b => new Promise<void>((resolve, reject) => child.stdin.write(b, e => e ? reject(e) : resolve())), host)]);
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(timedOut, false); assert.equal(errorBytes, 0); assert.equal(enqueues, 1);
    assert.equal(host.receipts().length, 3); assert.ok(host.receipts().every(r => r.outcome === "ok"));
  } finally {
    clearTimeout(timer); host.close(); child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
});
test("snapshot is copied; bounded list/search and read do not read ambient files", async () => {
  const entry = file(), o = options({ snapshot: { ...options().snapshot, files: [entry, file("docs/a.md", "other")] } }); const host = createWslBrokerHost(o); entry.text = "mutated";
  const guest = createWslBrokerGuest(o, { exchange: async b => host.handle(b) });
  assert.equal((await guest.request("snapshot.read", { path: entry.path }) as Record<string, Json>).text, primary);
  assert.deepEqual((await guest.request("snapshot.search", { query: "Original", limit: 1 }) as Record<string, Json>).paths, ["src/main.ts"]);
  assert.equal((await guest.request("snapshot.list", { prefix: "", limit: 1 }) as Record<string, Json>).truncated, true);
  await assert.rejects(guest.request("snapshot.read", { path: "../secret" }), code("request-refused"));
});
test("all primary gateway methods pass exact chat and arguments without summary", async () => {
  const seen: string[] = []; const { guest } = pair({ gateway: { read: async (method, args) => { seen.push(method); assert.equal(args.chat, "fixture-chat"); return { items: [{ kind: method === "telegram.media_derivative.read" ? "media-derivative" : "primary", anchor: "a", text: primary }], nextCursor: null }; } } });
  for (const method of ["telegram.anchor.read", "telegram.reply_chain.read", "telegram.media_derivative.read"] as const) await guest.request(method, { chat: "fixture-chat", anchor: "a", limit: 1 });
  await guest.request("telegram.range.read", { chat: "fixture-chat", from: 1, to: 3, cursor: null, limit: 1 });
  await guest.request("telegram.search", { chat: "fixture-chat", query: "hello", cursor: null, limit: 1 });
  assert.equal(seen.length, 5); await assert.rejects(guest.request("telegram.anchor.read", { chat: "other", anchor: "a", limit: 1 }), code("request-refused")); assert.equal(seen.length, 5);
});
test("kill switch denies callbacks and guarded proposal idempotency never sends", async () => {
  let stopped = true, calls = 0; const { guest } = pair({ killSwitchEngaged: () => stopped, gateway: { read: async () => { throw Error("must not read"); } }, proposals: { enqueue: async () => { calls++; return "queued"; } } });
  const args = { kind: "reply", chat: "fixture-chat", anchor: "a", text: "fixture", idempotencyKey: "c".repeat(32) };
  await assert.rejects(guest.request("proposal.submit", args), code("request-refused")); assert.equal(calls, 0); stopped = false;
  assert.deepEqual(await guest.request("proposal.submit", args), { outcome: "queued" }); await assert.rejects(guest.request("proposal.submit", args), code("request-refused")); assert.equal(calls, 1);
});
test("unknown proposal result closes both endpoints and never retries", async () => {
  let calls = 0; const { guest, host } = pair({ proposals: { enqueue: async () => { calls++; return "unknown"; } } });
  await assert.rejects(guest.request("proposal.submit", { kind: "reply", chat: "fixture-chat", anchor: "a", text: "fixture", idempotencyKey: "c".repeat(32) }), code("transport-unknown"));
  await assert.rejects(guest.request("snapshot.list", { prefix: "", limit: 1 }), code("session-unavailable")); await assert.rejects(host.handle(request(2)), code("session-unavailable")); assert.equal(calls, 1);
});
test("invalid outbox result is unknown rather than retryable refusal", async () => {
  let calls = 0;
  const { guest, host } = pair({ proposals: { enqueue: async () => { calls++; return "unexpected" as "queued"; } } });
  await assert.rejects(guest.request("proposal.submit", { kind: "reply", chat: "fixture-chat", anchor: "a", text: "fixture", idempotencyKey: "d".repeat(32) }), code("transport-unknown"));
  await assert.rejects(host.handle(request(2)), code("session-unavailable")); assert.equal(calls, 1);
});
test("close during owner work aborts and cannot report late success", async () => {
  let release!: () => void; let entered!: () => void; let signal: AbortSignal | undefined;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { guest, host } = pair({ gateway: { read: async (_method, _args, s) => { signal = s; entered(); await gate; return { items: [], nextCursor: null }; } } });
  const pending = guest.request("telegram.anchor.read", { chat: "fixture-chat", anchor: "a", limit: 1 });
  const rejected = assert.rejects(pending, code("transport-unknown"));
  await ready; host.close(); assert.equal(signal?.aborted, true); release(); await rejected;
  await assert.rejects(host.handle(request(2)), code("session-unavailable"));
});
test("closed guest cannot accept an already pending successful response", async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const host = createWslBrokerHost(options());
  const guest = createWslBrokerGuest(session, { exchange: async bytes => { const response = await host.handle(bytes); await wait; return response; } });
  const pending = guest.request("snapshot.list", { prefix: "", limit: 1 });
  const rejected = assert.rejects(pending, code("transport-unknown")); guest.close(); release(); await rejected;
});
test("method widening and extra path operands never reach owner capabilities", async () => {
  let calls = 0;
  const { guest } = pair({ gateway: { read: async () => { calls++; return { items: [], nextCursor: null }; } }, proposals: { enqueue: async () => { calls++; return "queued"; } } });
  for (const method of ["shell.exec", "process.spawn", "telegram.send", "telegram.admin", "snapshot.write"]) await assert.rejects(guest.request(method as never, {}), code("request-refused"));
  await assert.rejects(guest.request("snapshot.read", { path: "src/main.ts", hostPath: "C:/fixture" }), code("request-refused")); assert.equal(calls, 0);
});
test("gateway owner exceptions never expose dynamic messages", async () => {
  for (const thrown of [new Error("FIXTURE_PRIVATE_EXCEPTION"), new BrokerError("FIXTURE_PRIVATE_EXCEPTION")]) {
    const host = createWslBrokerHost(options({ gateway: { read: async () => { throw thrown; } } }));
    const response = await host.handle(request(1, { method: "telegram.anchor.read", args: { chat: "fixture-chat", anchor: "a", limit: 1 } }));
    assert.ok(!response.toString().includes("FIXTURE_PRIVATE_EXCEPTION")); assert.equal((decodeFrame(response, session, "response").body as Record<string, Json>).outcome, "unknown");
  }
});
test("sequence replay/gaps, reflected frames and invalid deadlines refuse before callbacks", async () => {
  const settings = { ...session, now: () => 1000 }, host = createWslBrokerHost(options(settings)); const first = request(1, undefined, {}, settings);
  await assert.rejects(host.handle(request(2, undefined, {}, settings)), code("replay-or-sequence-gap"));
  await assert.rejects(host.handle(request(1, undefined, { deadlineMs: 1000 }, settings)), code("deadline-refused"));
  await assert.rejects(host.handle(request(1, undefined, { deadlineMs: 6001 }, settings)), code("deadline-refused"));
  await assert.rejects(host.handle(request(1, undefined, { kind: "response" }, settings)), code("wrong-session"));
  await host.handle(first); await assert.rejects(host.handle(first), code("replay-or-sequence-gap"));
});
test("guest detects response reflection and closes without retry", async () => {
  let calls = 0; const guest = createWslBrokerGuest(session, { exchange: async b => { calls++; return b; } });
  await assert.rejects(guest.request("snapshot.list", { prefix: "", limit: 1 }), BrokerError); await assert.rejects(guest.request("snapshot.list", { prefix: "", limit: 1 }), code("session-unavailable")); assert.equal(calls, 1);
});
test("concurrent guest and host calls refuse while one owner is pending", async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  const { guest, host } = pair({ gateway: { read: async () => { entered(); await gate; return { items: [], nextCursor: null }; } } });
  const pending = guest.request("telegram.anchor.read", { chat: "fixture-chat", anchor: "a", limit: 1 }); await ready;
  await assert.rejects(guest.request("snapshot.list", { prefix: "", limit: 1 }), code("session-unavailable")); await assert.rejects(host.handle(request(2)), code("session-unavailable")); release(); await pending;
});
test("deadline abort is sticky even when owner ignores cancellation", async () => {
  let signal: AbortSignal | undefined, calls = 0; const { guest, host } = pair({ limits: { maxDeadlineMs: 25 }, gateway: { read: async (_m, _a, s) => { signal = s; calls++; return new Promise(() => {}); } } });
  await assert.rejects(guest.request("telegram.anchor.read", { chat: "fixture-chat", anchor: "a", limit: 1 }), BrokerError); await new Promise(r => setTimeout(r, 10)); assert.equal(signal?.aborted, true);
  await assert.rejects(guest.request("snapshot.list", { prefix: "", limit: 1 }), code("session-unavailable")); await assert.rejects(host.handle(request(2)), code("session-unavailable")); assert.equal(calls, 1);
});
test("response item/body budgets and primary-kind contract are enforced", async () => {
  for (const page of [{ items: [{ kind: "media-derivative", anchor: "a", text: "x" }], nextCursor: null }, { items: [{ kind: "primary", anchor: "a", text: "x" }, { kind: "primary", anchor: "b", text: "y" }], nextCursor: null }, { items: [{ kind: "primary", anchor: "a", text: "x".repeat(16385) }], nextCursor: null }]) {
    const { guest } = pair({ gateway: { read: async () => page as Awaited<ReturnType<HostOptions["gateway"]["read"]>> } }); await assert.rejects(guest.request("telegram.anchor.read", { chat: "fixture-chat", anchor: "a", limit: 1 }), code("request-refused"));
  }
});
test("call/session budgets refuse before another dispatch", async () => {
  const { guest } = pair({ limits: { maxCalls: 1 } }); await guest.request("snapshot.list", { prefix: "", limit: 1 }); await assert.rejects(guest.request("snapshot.list", { prefix: "", limit: 1 }), code("session-unavailable"));
  const { guest: tiny } = pair({ limits: { maxSessionBytes: 100 } }); await assert.rejects(tiny.request("snapshot.list", { prefix: "", limit: 1 }), code("session-budget"));
});
test("response-side session budget closes guest before another doomed request", async () => {
  const settings = options({ limits: { maxSessionBytes: 1600 }, snapshot: { ...options().snapshot, files: [file("src/main.ts", "x".repeat(1000))] } });
  const host = createWslBrokerHost(settings);
  const guest = createWslBrokerGuest(settings, { exchange: bytes => host.handle(bytes), close: () => { throw new Error("fixture cleanup failure"); } });
  await assert.rejects(guest.request("snapshot.read", { path: "src/main.ts" }), code("request-refused"));
  await assert.rejects(guest.request("snapshot.list", { prefix: "", limit: 1 }), code("session-unavailable"));
});
test("pipe exchange rejects coalesced unsolicited extra response", async () => {
  const input = new PassThrough(); const exchange = createBrokerPipeExchange(input, async () => { input.write("{}\n{}\n"); }, () => input.destroy());
  await assert.rejects(exchange.exchange(Buffer.from("{}\n"), new AbortController().signal), code("transport-unknown")); input.end();
});
test("pipe exchange enforces its one-outstanding-frame promise directly", async () => {
  const input = new PassThrough(); let writes = 0, closes = 0;
  const exchange = createBrokerPipeExchange(input, async () => { writes++; }, () => { closes++; input.destroy(); });
  const first = exchange.exchange(Buffer.from("{}\n"), new AbortController().signal);
  const second = exchange.exchange(Buffer.from("{}\n"), new AbortController().signal);
  const settled = Promise.allSettled([first, second]);
  try { await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(writes, 1, "second exchange must refuse before writing another request"); }
  finally { exchange.close?.(); await settled; assert.equal(closes, 1); }
});
test("pipe timeout closes the owned stream and pending reader", async () => {
  const input = new PassThrough(); let writes = 0, closes = 0;
  const exchange = createBrokerPipeExchange(input, async () => { writes++; }, () => { closes++; input.destroy(); });
  const guest = createWslBrokerGuest({ ...session, limits: { maxDeadlineMs: 20 } }, exchange);
  await assert.rejects(guest.request("snapshot.list", { prefix: "", limit: 1 }), code("transport-unknown"));
  assert.equal(writes, 1); assert.equal(closes, 1); assert.equal(input.destroyed, true);
  await assert.rejects(guest.request("snapshot.list", { prefix: "", limit: 1 }), code("session-unavailable"));
});
test("signed response nonce mismatch and unsolicited partial trailing frame are terminal", async () => {
  let closes = 0; const guest = createWslBrokerGuest(session, { exchange: async bytes => {
    const { mac: _mac, ...parsed } = decodeFrame(bytes, session, "request"); return encodeFrame({ ...parsed, kind: "response", id: "f".repeat(32), body: { outcome: "ok", value: null } }, session);
  }, close: () => { closes++; } });
  await assert.rejects(guest.request("snapshot.list", { prefix: "", limit: 1 }), code("response-mismatch")); assert.equal(closes, 1);
  const input = new PassThrough(); const exchange = createBrokerPipeExchange(input, async () => { input.write("{}\n{"); }, () => input.destroy());
  await assert.rejects(exchange.exchange(Buffer.from("{}\n"), new AbortController().signal), code("transport-unknown"));
});
