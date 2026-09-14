import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, rename, link, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { encryptSession, decryptSession } from "../src/session-crypto.js";
import { readStandingHistoryTaskDisposition as read, recordStandingHistoryTaskDisposition as record, StandingHistoryTaskDispositionError } from "../src/standing-history-task-disposition.js";
import type { StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-disposition-")), directory = join(root, "dispositions"); await mkdir(directory);
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-disposition-"))); await rm(root, { recursive: true, force: true }); });
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "4".repeat(48), accountId: "123", chatId: "-100456",
    requesterId: "456", primaryMessageId: 999, fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective: "Личная выжимка разговора" };
  const args = { directory, passphrase: "synthetic-disposition-passphrase", intent, sourceHead: "1".repeat(64), analysisHead: "2".repeat(64) };
  const slot = join(directory, intent.taskId), filename = "heads-" + createHash("sha256").update(JSON.stringify([args.sourceHead, args.analysisHead])).digest("hex") + ".enc";
  return { root, args, slot, path: join(slot, filename) };
}
test("noncreating reads distinguish absent from unavailable parent and never write", async t => {
  const f = await fixture(t); assert.deepEqual(await read(f.args), { storage: "absent" }); assert.deepEqual(await readdir(f.args.directory), []);
  assert.deepEqual(await read({ ...f.args, directory: join(f.root, "missing") }), { storage: "unavailable" });
  assert.deepEqual((await readdir(f.root)).sort(), ["dispositions"]);
});
test("encrypted immutable reason survives reopen; identical retry preserves exact bytes and differing reason conflicts", async t => {
  const f = await fixture(t), written = await record({ ...f.args, reason: "coverage" });
  assert.equal(written.storage, "ready"); assert.equal(written.disposition.reason, "coverage"); assert.ok(Object.isFrozen(written.disposition));
  const bytes = await readFile(f.path, "utf8"), header = await readFile(join(f.slot, "intent.enc"), "utf8");
  for (const text of ["coverage", f.args.sourceHead, f.args.analysisHead, "Личная", "requesterId"]) assert.equal((bytes + header).includes(text), false);
  assert.ok((await decryptSession(bytes, f.args.passphrase)).includes("coverage"));
  assert.deepEqual(await read(f.args), written); assert.deepEqual(await record({ ...f.args, reason: "coverage" }), written);
  await assert.rejects(record({ ...f.args, reason: "stale" }), (e: unknown) => e instanceof StandingHistoryTaskDispositionError && e.code === "conflict");
  assert.equal(await readFile(f.path, "utf8"), bytes); assert.equal(await readFile(join(f.slot, "intent.enc"), "utf8"), header);
});
test("new head pairs inspect independently and do not mutate previous disposition", async t => {
  const f = await fixture(t); await record({ ...f.args, reason: "consumed-without-prepared" }); const bytes = await readFile(f.path);
  const next = { ...f.args, analysisHead: "3".repeat(64) }; assert.deepEqual(await read(next), { storage: "absent" });
  assert.equal((await record({ ...next, reason: "source-page-quota" })).disposition.reason, "source-page-quota");
  assert.deepEqual(await readFile(f.path), bytes); assert.equal((await readdir(f.slot)).length, 3);
  const old = await read(f.args); assert.equal(old.storage, "ready"); if (old.storage === "ready") assert.equal(old.disposition.reason, "consumed-without-prepared");
});
test("wrong intent or password remains unavailable even when requested head record is absent", async t => {
  const f = await fixture(t); await record({ ...f.args, reason: "stale" }); const bytes = await readFile(f.path);
  for (const changed of [{ ...f.args, intent: { ...f.args.intent, objective: "Другая задача" }, sourceHead: "3".repeat(64) },
    { ...f.args, passphrase: "different-disposition-passphrase", sourceHead: "3".repeat(64) }]) {
    assert.deepEqual(await read(changed), { storage: "unavailable" }); await assert.rejects(record({ ...changed, reason: "stale" }));
  }
  assert.deepEqual(await readFile(f.path), bytes); assert.equal((await readdir(f.slot)).length, 2);
});
test("partial header or damaged/authenticated malformed selected record never grants absence or gets overwritten", async t => {
  const f = await fixture(t); await mkdir(f.slot); const headerPath = join(f.slot, "intent.enc");
  assert.deepEqual(await read(f.args), { storage: "unavailable" }); await assert.rejects(record({ ...f.args, reason: "coverage" })); assert.deepEqual(await readdir(f.slot), []);
  await writeFile(headerPath, "partial"); assert.deepEqual(await read(f.args), { storage: "unavailable" }); await assert.rejects(record({ ...f.args, reason: "coverage" })); assert.equal(await readFile(headerPath, "utf8"), "partial");
  const g = await fixture(t); await record({ ...g.args, reason: "coverage" });
  for (const text of ["partial", await encryptSession(JSON.stringify({ arbitrary: "authenticated but not a disposition" }), g.args.passphrase), "x".repeat(65537)]) {
    await writeFile(g.path, text); assert.deepEqual(await read(g.args), { storage: "unavailable" });
    await assert.rejects(record({ ...g.args, reason: "coverage" })); assert.equal(await readFile(g.path, "utf8"), text);
  }
});
test("head record transplant and header intent tampering are rejected", async t => {
  const f = await fixture(t); await record({ ...f.args, reason: "coverage" });
  const next = { ...f.args, sourceHead: "3".repeat(64) }; await record({ ...next, reason: "stale" });
  const files = (await readdir(f.slot)).filter(x => x !== "intent.enc"); const other = files.find(x => join(f.slot, x) !== f.path)!;
  await writeFile(join(f.slot, other), await readFile(f.path)); assert.deepEqual(await read(next), { storage: "unavailable" });
  const header = JSON.parse(await decryptSession(await readFile(join(f.slot, "intent.enc"), "utf8"), f.args.passphrase)); header.intent.requesterId = "789";
  await writeFile(join(f.slot, "intent.enc"), await encryptSession(JSON.stringify(header), f.args.passphrase));
  assert.deepEqual(await read(f.args), { storage: "unavailable" }); await assert.rejects(record({ ...f.args, reason: "coverage" }));
});
test("hardlinked record and symlinked task slot refuse custody", async t => {
  const f = await fixture(t); await record({ ...f.args, reason: "coverage" }); await link(f.path, join(f.root, "linked.enc"));
  assert.deepEqual(await read(f.args), { storage: "unavailable" }); await assert.rejects(record({ ...f.args, reason: "coverage" }));
  const g = await fixture(t); await record({ ...g.args, reason: "coverage" }); const moved = join(g.root, "moved"); await rename(g.slot, moved);
  await symlink(moved, g.slot, process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(await read(g.args), { storage: "unavailable" }); await assert.rejects(record({ ...g.args, reason: "coverage" }));
});
test("pre-abort and invalid/getter input admit no write", async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(read({ ...f.args, signal: controller.signal }), (e: unknown) => e instanceof StandingHistoryTaskDispositionError && e.code === "aborted");
  await assert.rejects(record({ ...f.args, reason: "overflow", signal: controller.signal }));
  let traps = 0; const input = { ...f.args, reason: "coverage" }; Object.defineProperty(input, "reason", { enumerable: true, get() { traps++; return "coverage"; } });
  await assert.rejects(record(input as never)); assert.equal(traps, 0);
  for (const extra of [{ reason: "raw arbitrary error" }, { sourceHead: "../escape" }, { extra: true }]) await assert.rejects(record({ ...f.args, reason: "coverage", ...extra } as never));
  assert.deepEqual(await readdir(f.args.directory), []);
});
