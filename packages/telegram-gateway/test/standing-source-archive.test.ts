import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtemp, readdir, readFile, writeFile, lstat, rm, open, link, rename } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { decryptSession, encryptSession } from "../src/session-crypto.js";
import { openStandingSourceArchive, StandingSourceArchiveError, SOURCE_ARCHIVE_LIMITS,
  type SourceObservationCapture, type SourceObservationMessage, type StandingSourceArchive } from "../src/standing-source-archive.js";

const passphrase = "fixture-only-observation-passphrase";
const binding = { accountId: "123", peerId: "-100456" };
const signal = () => new AbortController().signal;
const message = (edits: Partial<SourceObservationMessage> = {}): SourceObservationMessage => ({
  messageId: 900, authorId: "321", authorKind: "user", contentKind: "text", authorName: "Автор",
  date: 100, editedAt: null, replyToMessageId: null, text: "исходная реплика", ...edits,
});
const capture = (messages = [message()]): SourceObservationCapture => ({ captureId: randomUUID(), observedAt: 200, messages });
const period = { fromDate: 1, toDate: 1000 };
const refused = (code?: StandingSourceArchiveError["code"]) => (e: unknown) => e instanceof StandingSourceArchiveError && (!code || e.code === code);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "neurobro-observation-test-")), directory = join(parent, "archive");
  const handles: StandingSourceArchive[] = [];
  const reopen = async () => { const a = await openStandingSourceArchive({ directory, passphrase, binding }); handles.push(a); return a; };
  t.after(async () => {
    mock.restoreAll(); syncBuiltinESMExports();
    for (const a of handles) await a.close();
    assert.equal(dirname(resolve(parent)), resolve(tmpdir())); assert.ok(basename(parent).startsWith("neurobro-observation-test-"));
    await rm(parent, { recursive: true, force: true });
  });
  return { parent, directory, archive: await reopen(), reopen };
}
async function batchPaths(directory: string) { return (await readdir(directory)).filter(n => n !== "archive.enc").sort().map(n => join(directory, n)); }

test("ciphertext reopens with stable original identities, older IDs and edited observations", async t => {
  const f = await fixture(t), one = capture(), older = capture([message({ messageId: 3, date: 50, authorKind: "channel", authorId: "456" })]);
  const edited = capture([message({ editedAt: 150, text: "отредактировано", replyToMessageId: 3 })]);
  for (const [i, value] of [one, older, edited].entries()) assert.equal((await f.archive.append(value, signal())).sequence, i + 1);
  const paths = await batchPaths(f.directory);
  for (const path of paths) { const encrypted = await readFile(path, "utf8"); assert.ok(!encrypted.includes("исходная")); assert.ok(!encrypted.includes(passphrase)); assert.ok(!encrypted.includes('"authorId"')); }
  const plain = JSON.parse(await decryptSession(await readFile(paths[0]!, "utf8"), passphrase));
  assert.equal(plain.capture.messages[0].authorId, "321"); assert.equal(plain.capture.messages[0].messageId, 900);
  await f.archive.close(); const reopened = await f.reopen(); const page = await reopened.query(period, signal());
  assert.deepEqual(page.rows.map(r => [r.sequence, r.message.messageId, r.message.editedAt]), [[1, 900, null], [2, 3, null], [3, 900, 150]]);
  assert.equal(page.coverage.kind, "observations-only"); assert.equal(page.coverage.completeChat, false);
  assert.equal(page.coverage.throughSequence, 3); assert.equal(page.cursor, null);
  assert.equal(page.quota.encryptedBytes, (await Promise.all((await readdir(f.directory)).map(async n => Number((await lstat(join(f.directory, n))).size)))).reduce((a, b) => a + b, 0));
});

test("same capture is duplicate after reopen; conflicting reuse refuses; new capture preserves repeated observations", async t => {
  const f = await fixture(t), value = capture();
  const first = await f.archive.append(value, signal()), original = await readFile((await batchPaths(f.directory))[0]!);
  await f.archive.close(); const a = await f.reopen();
  assert.deepEqual(await a.append(value, signal()), { ...first, status: "duplicate" });
  await assert.rejects(a.append({ ...value, observedAt: 201 }, signal()), refused());
  assert.equal((await a.append(capture(), signal())).sequence, 2);
  assert.deepEqual(await readFile((await batchPaths(f.directory))[0]!), original);
});

test("inclusive period pages retain observations and exclude later appends from an existing continuation", async t => {
  const f = await fixture(t);
  await f.archive.append(capture([message({ messageId: 1, date: 99 }), message({ messageId: 2, date: 100 }), message({ messageId: 3, date: 101 })]), signal());
  await f.archive.append(capture([message({ messageId: 4, date: 102 })]), signal());
  const first = await f.archive.query({ fromDate: 100, toDate: 102, limit: 1 }, signal()); assert.ok(first.cursor);
  await f.archive.append(capture([message({ messageId: 5, date: 101 })]), signal());
  const second = await f.archive.query({ fromDate: 100, toDate: 102, cursor: first.cursor }, signal());
  assert.deepEqual([...first.rows, ...second.rows].map(r => r.message.messageId), [2, 3, 4]);
  assert.equal(second.coverage.throughSequence, 2); assert.equal(second.coverage.inventoryBatches, 3);
  assert.equal(second.cursor, null); await assert.rejects(f.archive.query({ fromDate: 100, toDate: 102, cursor: first.cursor }, signal()), refused("cursor"));
  assert.deepEqual((await f.archive.query({ fromDate: 100, toDate: 102 }, signal())).rows.map(r => r.message.messageId), [2, 3, 4, 5]);
});

test("scan exhaustion is explicit even for empty period matches and progresses to completion", async t => {
  const f = await fixture(t); for (let i = 0; i < 3; i++) await f.archive.append(capture([message({ date: i + 1 })]), signal());
  const first = await f.archive.query({ fromDate: 3, toDate: 3, scanLimit: 1 }, signal());
  assert.equal(first.rows.length, 0); assert.equal(first.coverage.scannedBatches, 1); assert.equal(first.coverage.scannedMessages, 1);
  assert.equal(first.coverage.exhausted, "scan"); assert.ok(first.cursor);
  const next = await f.archive.query({ fromDate: 3, toDate: 3, cursor: first.cursor }, signal());
  assert.equal(next.rows.length, 1); assert.equal(next.coverage.exhausted, "observations"); assert.equal(next.cursor, null);
});

test("output byte ceiling preserves a mid-batch continuation without truncating source text", async t => {
  const f = await fixture(t), messages = Array.from({ length: 8 }, (_, i) => message({ messageId: i + 1, text: "я".repeat(7000) }));
  await f.archive.append(capture(messages), signal()); const ids: number[] = []; let cursor: string | undefined;
  do { const page = await f.archive.query({ ...period, ...(cursor ? { cursor } : {}) }, signal());
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= SOURCE_ARCHIVE_LIMITS.outputBytes);
    assert.ok(page.rows.length > 0); for (const row of page.rows) { ids.push(row.message.messageId); assert.equal(row.message.text, messages[0]!.text); }
    cursor = page.cursor ?? undefined;
  } while (cursor);
  assert.deepEqual(ids, messages.map(m => m.messageId));
});

test("captions retain explicit content kind including empty text and no media-byte claims", async t => {
  const f = await fixture(t); const kinds = ["text", "photo-caption", "document-caption", "other-caption"] as const;
  await f.archive.append(capture(kinds.map((contentKind, i) => message({ messageId: i + 1, contentKind, text: "" }))), signal());
  assert.deepEqual((await f.archive.query(period, signal())).rows.map(r => [r.message.contentKind, r.message.text]), kinds.map(k => [k, ""]));
});

test("wrong key or account/peer binding refuses reopen without modifying ciphertext", async t => {
  const f = await fixture(t); await f.archive.append(capture(), signal()); const before = await readFile(join(f.directory, "archive.enc"));
  await f.archive.close();
  for (const edits of [{ passphrase: "another-fixture-only-password" }, { binding: { ...binding, accountId: "999" } }, { binding: { ...binding, peerId: "-999" } }])
    await assert.rejects(openStandingSourceArchive({ directory: f.directory, passphrase, binding, ...edits }), refused());
  assert.deepEqual(await readFile(join(f.directory, "archive.enc")), before);
});

test("batch/file/message limits refuse before append and allow later valid input", async t => {
  const f = await fixture(t);
  for (const value of [capture([]), capture(Array.from({ length: 101 }, (_, i) => message({ messageId: i + 1 }))),
    capture([message({ text: "a".repeat(16385) })]), capture([message({ text: "\u0001".repeat(16384) })]),
    capture(Array.from({ length: 20 }, (_, i) => message({ messageId: i + 1, text: "a".repeat(16000) }))),
    capture([message(), message()]), capture([message({ editedAt: 99 })])]) await assert.rejects(f.archive.append(value, signal()), refused("input"));
  assert.equal((await batchPaths(f.directory)).length, 0); assert.equal((await f.archive.append(capture(), signal())).sequence, 1);
  const path = (await batchPaths(f.directory))[0]!; const handle = await open(path, "r+"); await handle.truncate(SOURCE_ARCHIVE_LIMITS.fileBytes + 1); await handle.close();
  await assert.rejects(f.archive.query(period, signal()), refused("storage")); assert.equal(Number((await lstat(path)).size), SOURCE_ARCHIVE_LIMITS.fileBytes + 1);
});

test("ciphertext corruption, substituted sequence and partial tail are refused and preserved", async t => {
  const f = await fixture(t); await f.archive.append(capture(), signal()); const path = (await batchPaths(f.directory))[0]!;
  const original = await readFile(path, "utf8"); const value = JSON.parse(original); value.ciphertext = "AAAA" + value.ciphertext.slice(4);
  await writeFile(path, JSON.stringify(value)); await assert.rejects(f.archive.query(period, signal()), refused());
  await assert.rejects(f.archive.append(capture(), signal()), refused()); await f.archive.close();
  await writeFile(path, original.slice(0, 100)); await assert.rejects(f.reopen(), refused()); assert.equal((await readFile(path)).length, 100);
  const payload = JSON.parse(await decryptSession(original, passphrase)); payload.sequence = 2;
  await writeFile(path, await encryptSession(JSON.stringify(payload), passphrase)); await assert.rejects(f.reopen(), refused());
});

test("hard links and orphan/missing sequence cannot masquerade as a valid archive", async t => {
  const f = await fixture(t); await f.archive.append(capture(), signal()); const path = (await batchPaths(f.directory))[0]!;
  const external = join(f.parent, "linked.enc"); await link(path, external); await assert.rejects(f.archive.query(period, signal()), refused());
  await rm(external); await f.archive.close();
  await rename(path, join(f.directory, `00000002.${randomUUID()}.enc`)); await assert.rejects(f.reopen(), refused());
  assert.equal((await batchPaths(f.directory)).length, 1);
});

test("continuation refuses query change, replaced file identity and reopen reuse", async t => {
  const f = await fixture(t); await f.archive.append(capture([message(), message({ messageId: 2 })]), signal());
  const page = await f.archive.query({ ...period, limit: 1 }, signal()); assert.ok(page.cursor);
  await assert.rejects(f.archive.query({ ...period, fromDate: 2, cursor: page.cursor }, signal()), refused("cursor"));
  const path = (await batchPaths(f.directory))[0]!, original = await readFile(path); const parked = join(f.parent, "parked.enc");
  await rename(path, parked); await writeFile(path, original);
  await assert.rejects(f.archive.query({ ...period, cursor: page.cursor }, signal()), refused("cursor"));
  await f.archive.close(); const reopened = await f.reopen(); await assert.rejects(reopened.query({ ...period, cursor: page.cursor }, signal()), refused("cursor"));
});

test("cursor quota is bounded and completion frees a cursor slot", async t => {
  const f = await fixture(t); await f.archive.append(capture([message(), message({ messageId: 2 })]), signal());
  const cursors: string[] = [];
  for (let i = 0; i < 16; i++) { const p = await f.archive.query({ ...period, limit: 1 }, signal()); assert.ok(p.cursor); cursors.push(p.cursor); }
  await assert.rejects(f.archive.query({ ...period, limit: 1 }, signal()), refused("quota"));
  assert.equal((await f.archive.query({ ...period, cursor: cursors[0]! }, signal())).cursor, null);
  assert.ok((await f.archive.query({ ...period, limit: 1 }, signal())).cursor);
});

test("encrypted byte quota counts actual file sizes and preserves the over-quota store", async t => {
  const f = await fixture(t);
  // Real sparse fixture files test metadata accounting; quota must refuse before
  // decrypting these intentionally invalid bodies. No production cap override.
  for (let i = 1; i <= 256; i++) { const file = await open(join(f.directory, `${String(i).padStart(8, "0")}.${randomUUID()}.enc`), "wx");
    await file.truncate(SOURCE_ARCHIVE_LIMITS.fileBytes); await file.close(); }
  await assert.rejects(f.archive.query(period, signal()), refused("quota"));
  await assert.rejects(f.archive.append(capture(), signal()), refused("quota")); assert.equal((await batchPaths(f.directory)).length, 256);
});

test("batch count quota bounds directory inventory independently of plaintext scans", async t => {
  const f = await fixture(t);
  for (let start = 1; start <= 8193; start += 64) await Promise.all(Array.from({ length: Math.min(64, 8194 - start) }, (_, n) => {
    const sequence = start + n; return writeFile(join(f.directory, `${String(sequence).padStart(8, "0")}.${randomUUID()}.enc`), "x", { flag: "wx" });
  }));
  await assert.rejects(f.archive.query({ ...period, scanLimit: 1 }, signal()), refused("quota"));
  assert.equal((await batchPaths(f.directory)).length, 8193);
});

test("pre-aborted work and closed handles admit no writes", async t => {
  const f = await fixture(t), stop = new AbortController(); stop.abort();
  await assert.rejects(f.archive.append(capture(), stop.signal), refused("aborted"));
  await assert.rejects(f.archive.query(period, stop.signal), refused("aborted"));
  await f.archive.close(); await assert.rejects(f.archive.append(capture(), signal()), refused("closed"));
  assert.equal((await batchPaths(f.directory)).length, 0);
});

test("close during an actual read revokes its result and waits for the file operation", async t => {
  const f = await fixture(t); await f.archive.append(capture(), signal()); const target = (await batchPaths(f.directory))[0]!;
  const started = deferred(), gate = deferred(), realOpen = fs.open;
  mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await realOpen(...args);
    if (String(args[0]) === target && args[1] === "r") {
      const original = file.read;
      mock.method(file, "read", async (...readArgs: unknown[]) => { started.resolve(); await gate.promise; return Reflect.apply(original, file, readArgs); });
    }
    return file;
  }); syncBuiltinESMExports();
  const reading = f.archive.query(period, signal()); const rejection = assert.rejects(reading, refused("closed")); await started.promise;
  let closed = false; const closing = f.archive.close().then(() => { closed = true; });
  await new Promise(done => setImmediate(done)); assert.equal(closed, false); gate.resolve(); await rejection; await closing; assert.equal(closed, true);
});

test("aborted partial write is joined, retained and never repaired on reopen", async t => {
  const f = await fixture(t), started = deferred(), gate = deferred(), realOpen = fs.open, stop = new AbortController();
  mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await realOpen(...args);
    if (String(args[0]).endsWith(".enc") && args[1] === "wx") {
      mock.method(file, "writeFile", async () => { await file.write(Buffer.from("partial")); started.resolve(); await gate.promise; throw new Error("fixture interrupted write"); });
    }
    return file;
  }); syncBuiltinESMExports();
  const writing = f.archive.append(capture(), stop.signal), rejection = assert.rejects(writing, refused()); await started.promise; stop.abort();
  let closed = false; const closing = f.archive.close().then(() => { closed = true; }); await new Promise(done => setImmediate(done)); assert.equal(closed, false);
  gate.resolve(); await rejection; await closing; mock.restoreAll(); syncBuiltinESMExports();
  const paths = await batchPaths(f.directory); assert.equal(paths.length, 1); assert.equal(await readFile(paths[0]!, "utf8"), "partial");
  await assert.rejects(f.reopen(), refused()); assert.equal(await readFile(paths[0]!, "utf8"), "partial");
});

test("aborted read does not consume continuation and concurrent work does not overlap it", async t => {
  const f = await fixture(t); await f.archive.append(capture([message(), message({ messageId: 2 })]), signal());
  const page = await f.archive.query({ ...period, limit: 1 }, signal()); assert.ok(page.cursor);
  const target = (await batchPaths(f.directory))[0]!, stop = new AbortController(), started = deferred(), gate = deferred(), realOpen = fs.open;
  mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await realOpen(...args);
    if (String(args[0]) === target && args[1] === "r") {
      const original = file.read;
      mock.method(file, "read", async (...readArgs: unknown[]) => { started.resolve(); await gate.promise; return Reflect.apply(original, file, readArgs); });
    }
    return file;
  }); syncBuiltinESMExports();
  const reading = f.archive.query({ ...period, cursor: page.cursor }, stop.signal), rejected = assert.rejects(reading, refused("aborted"));
  await started.promise; await assert.rejects(f.archive.append(capture(), signal()), refused("busy"));
  stop.abort(); gate.resolve(); await rejected; mock.restoreAll(); syncBuiltinESMExports();
  const next = await f.archive.query({ ...period, cursor: page.cursor }, signal());
  assert.deepEqual(next.rows.map(r => r.message.messageId), [2]); assert.equal(next.cursor, null);
});

test("authenticated batch binding is checked independently of the valid archive header", async t => {
  const f = await fixture(t); await f.archive.append(capture(), signal()); const path = (await batchPaths(f.directory))[0]!;
  const payload = JSON.parse(await decryptSession(await readFile(path, "utf8"), passphrase)); payload.peerId = "-999";
  await writeFile(path, await encryptSession(JSON.stringify(payload), passphrase));
  await assert.rejects(f.archive.query(period, signal()), refused()); await f.archive.close();
  await assert.rejects(f.reopen(), refused());
});

test("append takes an owned value snapshot and rejects accessor-backed primary fields", async t => {
  const f = await fixture(t), original = message(), value = capture([original]);
  const pending = f.archive.append(value, signal());
  Object.assign(original, { text: "mutated after admission" }); await pending;
  assert.equal((await f.archive.query(period, signal())).rows[0]!.message.text, "исходная реплика");
  let accessed = false; const hostile = { ...message() };
  Object.defineProperty(hostile, "text", { get() { accessed = true; return "side effect"; }, enumerable: true });
  await assert.rejects(f.archive.append(capture([hostile]), signal()), refused("input")); assert.equal(accessed, false);
});
