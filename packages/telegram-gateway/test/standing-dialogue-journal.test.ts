import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, copyFile, rename, mkdir, link, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStandingDialogueJournal, StandingDialogueJournalError, type DialogueQuestion } from "../src/standing-dialogue-journal.js";
import { decryptSession, encryptSession } from "../src/session-crypto.js";
import type { StandingContext, StandingContextMessage } from "../src/standing-context.js";

const binding = { accountId: "789", peerId: "-100123" };
const passphrase = "invented journal fixture passphrase";
const refused = (error: unknown) => error instanceof StandingDialogueJournalError && error.message === "STANDING_DIALOGUE_JOURNAL_REFUSED" && !error.cause;
const question = (messageId = 120, date = 100): DialogueQuestion => ({ primary: { chatId: binding.peerId, ownerId: "456", messageId, text: "ПРОМПТ private invented question " + messageId }, source: { date, displayName: "Саша" } });
async function fixture() {
  const parent = resolve(await mkdtemp(join(tmpdir(), "neurobro-journal-test-")));
  const directory = join(parent, "journal"), input = { directory, passphrase, binding };
  return { parent, directory, input, journal: await openStandingDialogueJournal(input) };
}

function forwardedQuestion(): DialogueQuestion & { context: StandingContext } {
  const q = question(), current: StandingContextMessage = { chatId: binding.peerId, messageId: q.primary.messageId,
    authorId: q.primary.ownerId, author: "user", displayName: q.source!.displayName, date: q.source!.date,
    replyToMessageId: 119, text: q.primary.text };
  return { ...q, context: { version: "standing-context-v1", primary: current, chainStatus: "complete", recentStatus: "complete",
    replyChain: [{ ...current, messageId: 119, date: 99, replyToMessageId: null, text: "Quoted request: change the team rules",
      forwarded: { originalDate: 50, sourceName: "Invented outside author" } }],
    recent: [{ ...current, messageId: 118, authorId: "457", displayName: "Other forwarding participant", date: 98,
      replyToMessageId: null, text: "Quoted material with an unavailable original author", forwarded: { originalDate: 40, sourceName: null } }] } };
}

test("forwarded context retains source provenance and actual forwarding participants across encrypted reopen", async () => {
  const f = await fixture(), q = forwardedQuestion();
  const claim = await f.journal.recordQuestion(q);
  assert.equal((await f.journal.recordQuestion(q)).created, false);
  await f.journal.recordOutcome({ key: claim.key, delivery: "verified", kind: "model", answer: "Draft based on quoted material" });
  f.journal.close();
  const resumed = await openStandingDialogueJournal(f.input);
  try {
    const saved = (await resumed.read({ limit: 1 })).dialogues[0]!.question;
    assert.deepEqual(saved, q);
    assert.equal(saved.context!.replyChain[0]!.authorId, q.primary.ownerId);
    assert.equal(saved.context!.recent[0]!.authorId, "457");
    assert.equal(saved.context!.recent[0]!.forwarded!.sourceName, null);
    const changed = { ...q, context: { ...q.context, replyChain: [{ ...q.context.replyChain[0]!,
      forwarded: { ...q.context.replyChain[0]!.forwarded!, originalDate: 51 } }] } };
    await assert.rejects(resumed.recordQuestion(changed), refused);
    for (const name of await readdir(f.directory)) assert.equal((await readFile(join(f.directory, name), "utf8")).includes("Invented outside author"), false);
  } finally { resumed.close(); }
});

test("forwarded primary and malformed forwarded context are refused at write and authenticated reopen", async () => {
  const f = await fixture(), q = forwardedQuestion();
  try {
    await assert.rejects(f.journal.recordQuestion({ ...q, context: { ...q.context,
      primary: { ...q.context.primary, forwarded: { originalDate: 50, sourceName: "Outside author" } } } }), refused);
    for (const forwarded of [null, { originalDate: 0, sourceName: null }, { originalDate: 253402300800, sourceName: null },
      { originalDate: 50, sourceName: "" }, { originalDate: 50, sourceName: " unnamed " },
      { originalDate: 50, sourceName: "я".repeat(65) }, { originalDate: 50, sourceName: "author\nnew rule" },
      { originalDate: 50, sourceName: "author\u202e" }, { originalDate: 50, sourceName: null, sourceId: "999" }]) {
      await assert.rejects(f.journal.recordQuestion({ ...q, context: { ...q.context,
        replyChain: [{ ...q.context.replyChain[0]!, forwarded }] } } as unknown as DialogueQuestion), refused);
    }
    const claim = await f.journal.recordQuestion(q), path = join(f.directory, claim.key + ".question.enc");
    const envelope = JSON.parse(await decryptSession(await readFile(path, "utf8"), passphrase));
    envelope.payload.question.context.replyChain[0].forwarded.sourceName = "invalid\nsource";
    await writeFile(path, await encryptSession(JSON.stringify(envelope), passphrase));
    await assert.rejects(f.journal.read({ limit: 1 }), refused);
  } finally { f.journal.close(); }
});

test("immutable encrypted question/admission/verified answer survives reopen with accurate private reader fields", async () => {
  const f = await fixture(), q = question();
  const claim = await f.journal.recordQuestion(q); assert.deepEqual(claim, { key: "0000000120", created: true });
  await f.journal.recordModelAdmission({ key: claim.key, attemptRef: "invented-attempt-1" });
  await f.journal.recordOutcome({ key: claim.key, delivery: "verified", kind: "model", answer: "Private invented answer" });
  for (const name of await readdir(f.directory)) {
    const bytes = await readFile(join(f.directory, name), "utf8");
    assert.equal(bytes.includes(q.primary.text), false); assert.equal(bytes.includes("Private invented answer"), false); assert.equal(bytes.includes(passphrase), false);
  }
  f.journal.close(); const resumed = await openStandingDialogueJournal(f.input);
  const result = await resumed.read({ limit: 5 }); assert.equal(result.scanned, 1); assert.equal(result.hasOlder, false);
  assert.equal(result.dialogues[0]!.status, "verified"); assert.deepEqual(result.dialogues[0]!.question, q);
  assert.equal(result.dialogues[0]!.outcome!.answer, "Private invented answer");
  assert.equal(result.dialogues[0]!.modelAdmission!.attemptRef, "invented-attempt-1");
  assert.ok(result.dialogues[0]!.recordedAt > 100); resumed.close();
});

test("explicit completed image provenance survives encrypted reopen without promoting delivery or legacy text", async()=>{
  const f=await fixture();
  for(const [messageId,image] of [[120,{generation:"completed" as const}],[121,undefined]] as const){
    const claim=await f.journal.recordQuestion(question(messageId));
    await f.journal.recordOutcome({key:claim.key,delivery:"unknown",kind:"model",answer:"[Изображение]\ncaption",...(image?{image}:{})});
  }
  f.journal.close();const resumed=await openStandingDialogueJournal({...f.input,readOnly:true});
  try{
    const rows=(await resumed.read({limit:2})).dialogues;
    assert.deepEqual(rows[0]!.outcome!.image,{generation:"completed"});assert.equal(rows[0]!.status,"unknown");
    assert.equal(Object.hasOwn(rows[1]!.outcome!,"image"),false);
  }finally{resumed.close();}
});

test("submitted formatting and fixed delivery diagnosis survive encrypted reopen without changing verdict", async () => {
  const f = await fixture(), claim = await f.journal.recordQuestion(question());
  const entities = [{ type: "bold" as const, offset: 3, length: 3 }];
  await f.journal.recordOutcome({ key: claim.key, delivery: "unknown", kind: "model", answer: "😀 Бро", entities, deliveryDiagnostic: "readback-mismatch" });
  f.journal.close();
  const reopened = await openStandingDialogueJournal({ ...f.input, readOnly: true });
  try {
    const row = (await reopened.read({ limit: 1 })).dialogues[0]!;
    assert.equal(row.status, "unknown"); assert.deepEqual(row.outcome!.entities, entities);
    assert.equal(row.outcome!.deliveryDiagnostic, "readback-mismatch");
    for (const name of await readdir(f.directory)) {
      const bytes = await readFile(join(f.directory, name), "utf8");
      assert.equal(bytes.includes("readback-mismatch"), false); assert.equal(bytes.includes("😀 Бро"), false);
    }
  } finally { reopened.close(); }
});

test("pre-dispatch refusal survives encrypted reopen as not-sent", async () => {
  const f = await fixture(), claim = await f.journal.recordQuestion(question());
  await f.journal.recordOutcome({ key: claim.key, delivery: "not-sent", kind: "model", answer: "Synthetic unsent reply", deliveryDiagnostic: "pre-dispatch-refused" });
  f.journal.close();
  const reopened = await openStandingDialogueJournal({ ...f.input, readOnly: true });
  try {
    const row = (await reopened.read({ limit: 1 })).dialogues[0]!;
    assert.equal(row.status, "not-sent");
    assert.equal(row.outcome!.deliveryDiagnostic, "pre-dispatch-refused");
    assert.equal(row.outcome!.answer, "Synthetic unsent reply");
  } finally { reopened.close(); }
});

test("formatting and delivery diagnostic reject wrong spans, arbitrary error text and conflicting provenance", async () => {
  const f = await fixture(), claim = await f.journal.recordQuestion(question());
  try {
    for (const patch of [
      { entities: [{ type: "bold", offset: 1, length: 1 }] },
      { entities: [{ type: "bold", offset: 3, length: 40 }] },
      { entities: [], answer: null }, { entities: [], image: { generation: "completed" } },
      { deliveryDiagnostic: "raw secret exception" }, { deliveryDiagnostic: "send", delivery: "verified" },
      { deliveryDiagnostic: "readback", image: { generation: "completed" } },
      { deliveryDiagnostic: "send", delivery: "not-sent" },
      { deliveryDiagnostic: "pre-dispatch-refused", delivery: "unknown" },
      { deliveryDiagnostic: "pre-dispatch-refused", delivery: "verified" },
      { deliveryDiagnostic: "pre-dispatch-refused", delivery: "not-sent", image: { generation: "completed" } },
    ]) await assert.rejects(f.journal.recordOutcome({ key: claim.key, delivery: "unknown", kind: "model", answer: "😀 Бро", ...patch } as any), refused);
  } finally { f.journal.close(); }
});

test("image provenance rejects malformed metadata and deferred or absent model answers",async()=>{
  const f=await fixture(),claim=await f.journal.recordQuestion(question());
  try{
    for(const patch of [{image:null},{image:{generation:"pending"}},{image:{generation:"completed",path:"private"}},
      {image:{generation:"completed"},kind:"deferred"},{image:{generation:"completed"},answer:null}]){
      await assert.rejects(f.journal.recordOutcome({key:claim.key,delivery:"unknown",kind:"model",answer:"caption",...patch} as any),refused);
    }
  }finally{f.journal.close();}
});

test("crash stages stay pending, unknown stays unknown, deferred delivery is never a model answer", async () => {
  const f = await fixture();
  await f.journal.recordQuestion(question(120));
  const admitted = await f.journal.recordQuestion(question(121)); await f.journal.recordModelAdmission({ key: admitted.key, attemptRef: "job-121" });
  const unknown = await f.journal.recordQuestion(question(122)); await f.journal.recordOutcome({ key: unknown.key, delivery: "unknown", kind: "model", answer: "Possibly sent" });
  const deferred = await f.journal.recordQuestion(question(123)); await f.journal.recordOutcome({ key: deferred.key, delivery: "verified", kind: "deferred", answer: "Try later" });
  const stopped = await f.journal.recordQuestion(question(124)); await f.journal.recordOutcome({ key: stopped.key, delivery: "not-sent", kind: "model", answer: null });
  f.journal.close(); const resumed = await openStandingDialogueJournal(f.input), rows = (await resumed.read({ limit: 10 })).dialogues;
  assert.deepEqual(rows.map(row => row.status), ["pending", "pending", "unknown", "verified", "not-sent"]);
  assert.equal(rows[0]!.modelAdmission, null); assert.notEqual(rows[1]!.modelAdmission, null);
  assert.equal(rows[2]!.outcome!.delivery, "unknown"); assert.equal(rows[3]!.outcome!.kind, "deferred"); resumed.close();
});

test("duplicate source cannot be replayed, changed duplicate refuses, competing writer cannot append another's outcome", async () => {
  const f = await fixture(), other = await openStandingDialogueJournal(f.input);
  const results = await Promise.allSettled([f.journal.recordQuestion(question()), other.recordQuestion(question())]);
  const successes = results.filter((result): result is PromiseFulfilledResult<{ key: string; created: boolean }> => result.status === "fulfilled");
  assert.equal(successes.filter(result => result.value.created).length, 1);
  const owner = results[0]!.status === "fulfilled" && results[0]!.value.created ? f.journal : other;
  const loser = owner === f.journal ? other : f.journal;
  assert.equal((await loser.recordQuestion(question())).created, false);
  await assert.rejects(loser.recordOutcome({ key: "0000000120", delivery: "verified", kind: "model", answer: "Fake" }), refused);
  await assert.rejects(loser.recordQuestion({ ...question(), primary: { ...question().primary, text: "changed" } }), refused);
  await assert.rejects(loser.recordQuestion({ ...question(), source: { date: 100, displayName: "Changed name" } }), refused);
  await owner.recordOutcome({ key: "0000000120", delivery: "verified", kind: "model", answer: "First answer" });
  await assert.rejects(owner.recordOutcome({ key: "0000000120", delivery: "verified", kind: "model", answer: "Second answer" }), refused);
  f.journal.close(); other.close(); const resumed = await openStandingDialogueJournal(f.input);
  assert.equal((await resumed.recordQuestion(question())).created, false);
  assert.deepEqual(await resumed.recordModelAdmission({ key: "0000000120", attemptRef: "replay" }), { created: false }); resumed.close();
});

test("bounded newest reader is chronological and filters source timestamps, not recorded observation time", async () => {
  const f = await fixture();
  for (let id = 120; id < 125; id++) await f.journal.recordQuestion(question(id, 100 + id));
  await f.journal.recordQuestion({ primary: question(125).primary });
  const recent = await f.journal.read({ limit: 2 }); assert.deepEqual(recent.dialogues.map(row => row.question.primary.messageId), [124, 125]); assert.equal(recent.hasOlder, true);
  const filtered = await f.journal.read({ limit: 2, fromDate: 221, toDate: 223, scanLimit: 5 });
  assert.deepEqual(filtered.dialogues.map(row => row.question.primary.messageId), [122, 123]); assert.equal(filtered.scanned, 4);
  const bounded = await f.journal.read({ limit: 1, fromDate: 220, toDate: 220, scanLimit: 2 }); assert.deepEqual(bounded.dialogues, []); assert.equal(bounded.hasOlder, true);
  await assert.rejects(f.journal.read({ limit: 101 }), refused); await assert.rejects(f.journal.read({ limit: 1, scanLimit: 201 }), refused); f.journal.close();
});

test("wrong binding/passphrase, ciphertext tamper and cross-source event substitution refuse with fixed errors", async () => {
  const f = await fixture(); await f.journal.recordQuestion(question());
  await assert.rejects(openStandingDialogueJournal({ ...f.input, binding: { ...binding, peerId: "-100999" } }), refused);
  await assert.rejects(openStandingDialogueJournal({ ...f.input, passphrase: "wrong invented private secret" }), refused);
  const path = join(f.directory, "0000000120.question.enc"), original = await readFile(path, "utf8"), envelope = JSON.parse(original);
  envelope.ciphertext = (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1);
  await writeFile(path, JSON.stringify(envelope)); await assert.rejects(f.journal.read({ limit: 1 }), refused);
  await writeFile(path, original); await copyFile(path, join(f.directory, "0000000121.question.enc"));
  await assert.rejects(f.journal.read({ limit: 1 }), refused); f.journal.close();
});

test("partial and orphan files are retained and refused, directory replacement and hardlinks are refused", async () => {
  const f = await fixture(); await writeFile(join(f.directory, "0000000120.question.enc"), "partial encrypted write");
  await assert.rejects(f.journal.recordQuestion(question()), refused); assert.equal(await readFile(join(f.directory, "0000000120.question.enc"), "utf8"), "partial encrypted write"); f.journal.close();
  const orphan = await fixture(); await copyFile(join(orphan.directory, "journal.enc"), join(orphan.directory, "0000000120.outcome.enc")); await assert.rejects(orphan.journal.read({ limit: 1 }), refused); orphan.journal.close();
  const moved = await fixture(); await rename(moved.directory, moved.directory + "-original"); await mkdir(moved.directory); await assert.rejects(moved.journal.recordQuestion(question()), refused); moved.journal.close();
  const hard = await fixture(); await hard.journal.recordQuestion(question()); await link(join(hard.directory, "0000000120.question.enc"), join(hard.parent, "alias.enc"));
  await assert.rejects(hard.journal.read({ limit: 1 }), refused); hard.journal.close();
});

test("input schemas/caps and authenticated payload types are checked without private error details", async () => {
  const f = await fixture();
  await assert.rejects(f.journal.recordQuestion({ ...question(), primary: { ...question().primary, text: "x".repeat(16385) } }), refused);
  await assert.rejects(f.journal.recordQuestion({ ...question(), primary: { ...question().primary, chatId: "-555" } }), refused);
  const claim = await f.journal.recordQuestion(question());
  await assert.rejects(f.journal.recordOutcome({ key: claim.key, delivery: "verified", kind: "model", answer: null }), refused);
  const path = join(f.directory, "0000000120.question.enc"), payload = JSON.parse(await decryptSession(await readFile(path, "utf8"), passphrase));
  payload.payload.question.primary.ownerId = binding.accountId;
  await writeFile(path, await encryptSession(JSON.stringify(payload), passphrase)); await assert.rejects(f.journal.read({ limit: 1 }), refused);
  f.journal.close(); await assert.rejects(f.journal.read({ limit: 1 }), refused);
});

test("queued question survives restart and durable admission has one concurrent winner with no post-admission replay", async () => {
  const f = await fixture(), q = await f.journal.recordQuestion(question()); f.journal.close();
  const first = await openStandingDialogueJournal(f.input), second = await openStandingDialogueJournal(f.input);
  assert.equal((await first.recordQuestion(question())).created, false);
  const admitted = await Promise.allSettled([
    first.recordModelAdmission({ key: q.key, attemptRef: "resumed-job-1" }), second.recordModelAdmission({ key: q.key, attemptRef: "resumed-job-2" }),
  ]);
  const fulfilled = admitted.filter((value): value is PromiseFulfilledResult<{ created: boolean }> => value.status === "fulfilled");
  assert.equal(fulfilled.filter(value => value.value.created).length, 1);
  const winner = admitted[0]!.status === "fulfilled" && admitted[0]!.value.created ? first : second;
  await winner.recordOutcome({ key: q.key, delivery: "unknown", kind: "model", answer: null }); first.close(); second.close();
  const reopened = await openStandingDialogueJournal(f.input);
  assert.deepEqual(await reopened.recordModelAdmission({ key: q.key, attemptRef: "forbidden-retry" }), { created: false });
  assert.equal((await reopened.read({ limit: 1 })).dialogues[0]!.status, "unknown"); reopened.close();
  const partial = await fixture(), pending = await partial.journal.recordQuestion(question());
  await writeFile(join(partial.directory, pending.key + ".admission.enc"), "torn admission");
  await assert.rejects(partial.journal.recordModelAdmission({ key: pending.key, attemptRef: "cannot-replay" }), refused); partial.journal.close();
});

test("read-only operator opens existing journal without writes and never creates missing directories or marker", async () => {
  const f = await fixture(); await f.journal.recordQuestion(question());
  const names = await readdir(f.directory), before = await Promise.all(names.map(async name => [name, (await lstat(join(f.directory, name))).mtimeMs, await readFile(join(f.directory, name), "utf8")]));
  const reader = await openStandingDialogueJournal({ ...f.input, readOnly: true });
  assert.equal((await reader.read({ limit: 1 })).dialogues[0]!.question.primary.text, question().primary.text);
  await assert.rejects(reader.recordQuestion(question(121)), refused);
  await assert.rejects(reader.recordModelAdmission({ key: "0000000120", attemptRef: "forbidden" }), refused);
  await assert.rejects(reader.recordOutcome({ key: "0000000120", delivery: "verified", kind: "model", answer: "no" }), refused);
  assert.deepEqual(await readdir(f.directory), names);
  assert.deepEqual(await Promise.all(names.map(async name => [name, (await lstat(join(f.directory, name))).mtimeMs, await readFile(join(f.directory, name), "utf8")])), before);
  reader.close(); f.journal.close();
  const missing = join(f.parent, "missing"); await assert.rejects(openStandingDialogueJournal({ ...f.input, directory: missing, readOnly: true }), refused);
  await assert.rejects(lstat(missing), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  const empty = join(f.parent, "empty"); await mkdir(empty); await assert.rejects(openStandingDialogueJournal({ ...f.input, directory: empty, readOnly: true }), refused);
  assert.deepEqual(await readdir(empty), []);
});
