import test from "node:test";
import assert from "node:assert/strict";
import { Api } from "telegram";
import { projectStandingObservedSourcePage, type StandingObservedSourceLease } from "../src/standing-observed-source-reader.js";
import { createStandingObservedSourceTools, StandingObservedSourceUnavailableError } from "../src/standing-observed-source-tools.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";

const status = { action: "status", beforeMessageId: null, limit: null }, readArgs = { ...status, action: "read" };
const info = { sourceRef: "community" as const, title: "Synthetic community", readOnly: true as const, telegramSendRestriction: "not-confirmed" as const };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function page(input: Readonly<{ beforeMessageId?: number; limit?: number }> = {}) {
  return projectStandingObservedSourcePage(new Api.messages.Messages({ messages: [], users: [], chats: [] }),
    { sourceRef: "community", title: info.title, peerId: "-1234567", ...input, limit: input.limit ?? 30 });
}
function fixture(openOverride?: () => Promise<StandingObservedSourceLease>) {
  const controller = new AbortController(); let opens = 0, closes = 0;
  const windows: Array<Readonly<{ beforeMessageId?: number; limit?: number }>> = [];
  const tools = createStandingObservedSourceTools({ requestRef: "request-1", signal: controller.signal, open: async () => {
    opens++; if (openOverride) return openOverride();
    return { info, async readHistory(input = {}) { windows.push(input); return page(input); }, async close() { closes++; } };
  } });
  const scope = { requestRef: "request-1", callRef: "call-1", signal: controller.signal };
  const call = async (args: unknown = readArgs, scopeValue = scope) => await tools.handlers[0]!.call(args, scopeValue) as EpochToolResult;
  return { tools, controller, scope, call, windows, opens: () => opens, closes: () => closes };
}
function body(result: EpochToolResult): Record<string, unknown> { return JSON.parse((result.contentItems[0] as { text: string }).text); }

test("every valid call lazily borrows then joins release, leaving the internal tool lane free", async () => {
  const f = fixture(); assert.equal(f.opens(), 0);
  const available = await f.call(status); assert.equal(available.success, true);
  assert.equal(body(available).telegramSendRestriction, "not-confirmed"); assert.equal(body(available).applicationAuthority, "none");
  assert.equal(f.opens(), 1); assert.equal(f.closes(), 1); assert.equal(f.windows.length, 0);
  assert.equal((await f.call()).success, true); assert.deepEqual(f.windows, [{ limit: 30 }]);
  assert.equal((await f.call({ action: "read", beforeMessageId: 321, limit: 7 })).success, true);
  assert.deepEqual(f.windows[1], { limit: 7, beforeMessageId: 321 }); assert.equal(f.opens(), 3); assert.equal(f.closes(), 3);
  await f.tools.close(); assert.equal(f.closes(), 3);
  assert.equal(body(await f.call()).code, "stopped");
});

test("exact arguments, selection scope and cancellation refuse before acquisition", async () => {
  const f = fixture();
  for (const args of [{ action: "read" }, { ...status, limit: 1 }, { ...readArgs, beforeMessageId: 0 }, { ...readArgs, beforeMessageId: 2147483648 },
    { ...readArgs, limit: 31 }, { ...readArgs, limit: 1.5 }, { ...readArgs, limit: true }, { ...readArgs, peerId: "other" }, new Proxy(readArgs, {})])
    assert.equal(body(await f.call(args)).code, "invalid-arguments");
  const getter = { ...readArgs }; Object.defineProperty(getter, "limit", { enumerable: true, get() { assert.fail("getter executed"); } });
  assert.equal(body(await f.call(getter)).code, "invalid-arguments");
  assert.equal(body(await f.call(readArgs, { ...f.scope, requestRef: "other-primary" })).code, "invalid-scope");
  f.controller.abort(); assert.equal(body(await f.call()).code, "stopped"); assert.equal(f.opens(), 0); await f.tools.close();
});

test("close during lazy acquisition waits for the late lease and closes it exactly once without reading", async () => {
  const acquired = deferred<StandingObservedSourceLease>(), entered = deferred<void>(), released = deferred<void>();
  let reads = 0, closes = 0;
  const f = fixture(async () => { entered.resolve(); return acquired.promise; });
  const pending = f.call(); await entered.promise;
  let finished = false; const closing = f.tools.close().then(() => { finished = true; });
  acquired.resolve({ info, async readHistory() { reads++; return page(); }, async close() { closes++; await released.promise; } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closes, 1); assert.equal(finished, false); assert.equal(reads, 0);
  released.resolve(); await closing; assert.equal(body(await pending).code, "stopped"); assert.equal(closes, 1);
});

test("close cancels an active source read before joining it; parallel calls do not acquire another lease", async () => {
  const entered = deferred<void>(), endRead = deferred<void>(), endClose = deferred<void>(); let closes = 0;
  const f = fixture(async () => ({ info, async readHistory(input) { entered.resolve(); await endRead.promise; return page(input); },
    async close() { closes++; endRead.resolve(); await endClose.promise; } }));
  const pending = f.call(); await entered.promise;
  assert.equal(body(await f.call(status)).code, "busy"); assert.equal(f.opens(), 1);
  let finished = false; const closing = f.tools.close().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closes, 1); assert.equal(finished, false);
  endClose.resolve(); await closing; assert.equal(body(await pending).code, "stopped");
});

test("successful read is withheld until lease release completes and a late abort discards it", async () => {
  const releaseStarted = deferred<void>(), releaseEnd = deferred<void>();
  const f = fixture(async () => ({ info, async readHistory(input) { return page(input); },
    async close() { releaseStarted.resolve(); await releaseEnd.promise; } }));
  let returned = false; const pending = f.call().then(value => { returned = true; return value; });
  await releaseStarted.promise; assert.equal(returned, false); f.controller.abort(); releaseEnd.resolve();
  assert.equal(body(await pending).code, "stopped"); await f.tools.close();
});

test("typed unavailable reasons are projected without private exception text", async () => {
  const f = fixture(async () => { throw new StandingObservedSourceUnavailableError("binding-mismatch"); });
  const result = await f.call(status); assert.equal(result.success, false);
  assert.equal(body(result).code, "binding-mismatch"); assert.equal(body(result).status, "unavailable"); await f.tools.close();
  const secret = fixture(async () => { throw Error("secret-access-hash-and-chat-text"); });
  assert.equal(body(await secret.call()).code, "unavailable"); assert.equal(JSON.stringify(await secret.call()).includes("secret"), false); await secret.tools.close();
});

test("unbranded, wrong-window or mismatched-title pages are refused and source lease is still closed", async () => {
  for (const value of [JSON.parse(JSON.stringify(page())), page({ limit: 4 }),
    projectStandingObservedSourcePage(new Api.messages.Messages({ messages: [], users: [], chats: [] }),
      { sourceRef: "community", title: "Other community", peerId: "-99", limit: 30 })]) {
    let closed = 0; const f = fixture(async () => ({ info, async readHistory() { return value; }, async close() { closed++; } }));
    assert.equal(body(await f.call()).code, "unavailable"); assert.equal(closed, 1); await f.tools.close();
  }
});

test("malformed acquired info releases the lease; release failure is preserved for selection close", async () => {
  let released = 0;
  const bad = fixture(async () => ({ info: { ...info, readOnly: false } as unknown as typeof info, async readHistory() { return page(); }, async close() { released++; } }));
  assert.equal(body(await bad.call()).code, "unavailable"); assert.equal(released, 1); await bad.tools.close();
  const f = fixture(async () => ({ info, async readHistory() { return page(); }, async close() { throw Error("private-close-failure"); } }));
  assert.equal(body(await f.call()).code, "unavailable"); assert.equal(body(await f.call()).code, "stopped");
  await assert.rejects(f.tools.close(), /private-close-failure/u);
});
