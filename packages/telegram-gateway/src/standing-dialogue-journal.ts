import { createHash } from "node:crypto";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertPilotPrivateDirectory, isPilotDeliveryDiagnostic, type PilotDeliveryDiagnostic } from "./pilot-outbox.js";
import { copyTelegramTextEntities, type TelegramTextEntity } from "./telegram-text-format.js";
import { encryptSession, decryptSession } from "./session-crypto.js";
import type { PilotBinding, PilotPrimary } from "./pilot-telegram-adapter.js";
import type { StandingContext, StandingContextMessage } from "./standing-context.js";

export class StandingDialogueJournalError extends Error {
  constructor() { super("STANDING_DIALOGUE_JOURNAL_REFUSED"); }
}
const fail = (): never => { throw new StandingDialogueJournalError(); };
const validId = (id: unknown): id is number => Number.isSafeInteger(id) && (id as number) > 0 && (id as number) <= 2147483647;
const text = (value: unknown, cap: number): value is string => typeof value === "string" && value.length > 0 &&
  !value.includes("\0") && Buffer.byteLength(value, "utf8") <= cap && Buffer.from(value, "utf8").toString("utf8") === value;
const keys = (value: object, expected: string[]) => Object.keys(value).sort().join("|") === expected.sort().join("|");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const MAX_FILE = 1_048_576;
const VERSION = "standing-dialogue-journal-v1";
export type DialogueQuestion = Readonly<{ primary: PilotPrimary; source?: Readonly<{ date: number; displayName: string }>; context?: StandingContext }>;
export type DialogueOutcome = Readonly<{ key: string; delivery: "verified" | "unknown" | "not-sent"; kind: "model" | "deferred"; answer: string | null;
  /** Submitted text formatting. Only verified delivery proves exact readback;
   * this is not a screenshot or evidence of a client's visual rendering. */
  entities?: readonly TelegramTextEntity[];
  deliveryDiagnostic?: PilotDeliveryDiagnostic;
  /** Added only by the validated image branch, never inferred from answer text.
   * This proves generation, not delivery or current availability of image bytes. */
  image?: Readonly<{generation:"completed"}> }>;
export type DialogueModelAdmission = Readonly<{ key: string; attemptRef: string }>;
export type JournalDialogue = Readonly<{ key: string; question: DialogueQuestion; recordedAt: number; modelAdmission: DialogueModelAdmission | null; outcome: DialogueOutcome | null; status: "pending" | DialogueOutcome["delivery"] }>;
export interface StandingDialogueJournal {
  recordQuestion(question: DialogueQuestion): Promise<{ key: string; created: boolean }>;
  recordModelAdmission(admission: DialogueModelAdmission): Promise<{ created: boolean }>;
  recordOutcome(outcome: DialogueOutcome): Promise<void>;
  read(options: { limit: number; fromDate?: number; toDate?: number; scanLimit?: number }): Promise<{ dialogues: JournalDialogue[]; scanned: number; hasOlder: boolean }>;
  close(): void;
}

function validateQuestion(value: DialogueQuestion, binding: PilotBinding): void {
  if (!value || !keys(value, ["primary", ...(value.source ? ["source"] : []), ...(value.context ? ["context"] : [])])) fail();
  const p = value.primary;
  if (!p || !keys(p, ["chatId", "ownerId", "messageId", "text"]) || p.chatId !== binding.peerId || !validId(p.messageId) ||
      !/^[1-9]\d{0,19}$/.test(p.ownerId) || p.ownerId === binding.accountId || !text(p.text, 4096)) fail();
  if (value.source && (!keys(value.source, ["date", "displayName"]) || !Number.isSafeInteger(value.source.date) || value.source.date <= 0 || !text(value.source.displayName, 512))) fail();
  if (!value.context) return;
  const c = value.context;
  if (Buffer.byteLength(JSON.stringify(c), "utf8") > 65_536) fail();
  if (!keys(c, ["version", "primary", "replyChain", "recent", "chainStatus", "recentStatus"]) || c.version !== "standing-context-v1" ||
      !Array.isArray(c.replyChain) || c.replyChain.length > 8 || !Array.isArray(c.recent) || c.recent.length > 20 ||
      !["complete", "partial", "missing", "truncated", "unavailable"].includes(c.chainStatus) ||
      !["complete", "partial", "truncated", "unavailable"].includes(c.recentStatus)) fail();
  const checkMessage = (m: StandingContextMessage) => {
    if (!m || !keys(m, ["chatId", "messageId", "authorId", "author", "displayName", "date", "replyToMessageId", "text"]) ||
        m.chatId !== binding.peerId || !validId(m.messageId) || !/^[1-9]\d{0,19}$/.test(m.authorId) ||
        m.author !== (m.authorId === binding.accountId ? "self" : "user") || !text(m.displayName, 512) || !text(m.text, 4096) ||
        !Number.isSafeInteger(m.date) || m.date <= 0 || !(m.replyToMessageId === null || validId(m.replyToMessageId) && m.replyToMessageId < m.messageId)) fail();
  };
  checkMessage(c.primary);
  if (c.primary.messageId !== p.messageId || c.primary.authorId !== p.ownerId || c.primary.text !== p.text || c.primary.author !== "user") fail();
  if (value.source && (value.source.date !== c.primary.date || value.source.displayName !== c.primary.displayName)) fail();
  const seen = new Set([p.messageId]); let next = c.primary.replyToMessageId;
  for (const m of c.replyChain) { checkMessage(m); if (m.messageId !== next || seen.has(m.messageId) || m.date > c.primary.date) fail(); seen.add(m.messageId); next = m.replyToMessageId; }
  let previous = 0;
  for (const m of c.recent) { checkMessage(m); if (seen.has(m.messageId) || m.messageId <= previous || m.messageId >= p.messageId || m.date > c.primary.date) fail(); seen.add(m.messageId); previous = m.messageId; }
}
function validateOutcome(value: DialogueOutcome): void {
  if (!value || !keys(value, ["key", "delivery", "kind", "answer", ...["image", "entities", "deliveryDiagnostic"].filter(key => Object.hasOwn(value, key))]) || !/^\d{10}$/.test(value.key) || !validId(Number(value.key)) ||
      !["verified", "unknown", "not-sent"].includes(value.delivery) || !["model", "deferred"].includes(value.kind) ||
      !(value.answer === null || text(value.answer, 4096)) || (value.delivery === "verified" && value.answer === null)) fail();
  if(Object.hasOwn(value,"image") && (!value.image || !keys(value.image,["generation"]) || value.image.generation!=="completed" ||
      value.kind!=="model" || value.answer===null)) fail();
  if (Object.hasOwn(value, "entities")) {
    if (value.answer === null || Object.hasOwn(value, "image")) fail();
    try { copyTelegramTextEntities(value.answer!, value.entities!); } catch { fail(); }
  }
  if (Object.hasOwn(value, "deliveryDiagnostic") && (value.delivery !== (value.deliveryDiagnostic === "pre-dispatch-refused" ? "not-sent" : "unknown") || Object.hasOwn(value, "image") ||
      !isPilotDeliveryDiagnostic(value.deliveryDiagnostic))) fail();
}
function validateAdmission(value: DialogueModelAdmission): void {
  if (!value || !keys(value, ["key", "attemptRef"]) || !/^\d{10}$/.test(value.key) || !validId(Number(value.key)) ||
      typeof value.attemptRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.attemptRef)) fail();
}

/** Caller proves parent ACL and holds the existing sole gateway owner lock.
 * Files are encrypted, immutable, exclusive and synced. Only created=true from
 * recordModelAdmission admits a model invocation. Question logging is idempotent;
 * an existing question without admission may be claimed after restart.
 * Pending alone never proves whether a model started; an admission without an
 * outcome is ambiguous and must not be replayed. The module invokes no model.
 * This journals selected requests only, not all Telegram history. It does not
 * prove filesystem power-loss durability or detect deletion of complete pairs.
 * Existing session encryption is reused per event (fresh salt/key/nonce); no
 * new resident master secret or key file is introduced. */
export async function openStandingDialogueJournal(input: { directory: string; passphrase: string; binding: PilotBinding; readOnly?: boolean }): Promise<StandingDialogueJournal> {
  let passphrase = input.passphrase;
  const directory = input.directory, binding = Object.freeze({ ...input.binding });
  const readOnly = input.readOnly === true;
  let closed = false, busy = false;
  const claims = new Map<string, string>();
  const keyFor = (id: number) => String(id).padStart(10, "0");
  try {
    if (!text(passphrase, 4096) || passphrase.length < 16 || !/^[1-9]\d{0,19}$/.test(binding.accountId) || !/^-[1-9]\d{0,19}$/.test(binding.peerId)) fail();
    await assertPilotPrivateDirectory(dirname(directory));
    if (!readOnly) try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    await assertPilotPrivateDirectory(directory);
    const identity = await lstat(directory, { bigint: true });
    const check = async () => {
      if (closed) fail();
      await assertPilotPrivateDirectory(dirname(directory)); await assertPilotPrivateDirectory(directory);
      const current = await lstat(directory, { bigint: true });
      if (current.dev !== identity.dev || current.ino !== identity.ino) fail();
    };
    const wrap = (type: string, key: string, payload: unknown) => ({ version: VERSION, accountId: binding.accountId, peerId: binding.peerId, type, key, payload });
    async function readFile(name: string, type: string, key: string): Promise<unknown> {
      await check(); const path = join(directory, name), before = await lstat(path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_FILE)) fail();
      const file = await open(path, "r");
      let bytes: Buffer;
      try {
        const stat = await file.stat({ bigint: true });
        if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size || stat.nlink !== 1n) fail();
        bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
        while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
        if (length !== Number(before.size)) fail(); bytes = bytes.subarray(0, length);
        const after = await lstat(path, { bigint: true });
        if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs) fail();
      } finally { await file.close(); }
      const record = JSON.parse(await decryptSession(bytes.toString("utf8"), passphrase)) as Record<string, unknown>;
      if (!record || !keys(record, ["version", "accountId", "peerId", "type", "key", "payload"]) || record.version !== VERSION ||
          record.accountId !== binding.accountId || record.peerId !== binding.peerId || record.type !== type || record.key !== key) fail();
      return record.payload;
    }
    async function writeFile(name: string, type: string, key: string, payload: unknown): Promise<boolean> {
      if (readOnly) fail();
      const bytes = await encryptSession(JSON.stringify(wrap(type, key, payload)), passphrase);
      if (Buffer.byteLength(bytes, "utf8") > MAX_FILE) fail();
      await check(); let file;
      try { file = await open(join(directory, name), "wx", 0o600); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
      try { await file.writeFile(bytes, "utf8"); await file.sync(); }
      finally { await file.close(); }
      await check(); return true;
    }
    const marker = { format: "immutable-source-events-v1" };
    if ((readOnly || !await writeFile("journal.enc", "journal", "binding", marker)) && hash(await readFile("journal.enc", "journal", "binding")) !== hash(marker)) fail();
    async function readQuestion(key: string): Promise<{ question: DialogueQuestion; recordedAt: number }> {
      const stored = await readFile(key + ".question.enc", "question", key) as { question: DialogueQuestion; recordedAt: number };
      if (!stored || !keys(stored, ["question", "recordedAt"]) || !Number.isSafeInteger(stored.recordedAt) || stored.recordedAt <= 0) fail();
      validateQuestion(stored.question, binding); if (keyFor(stored.question.primary.messageId) !== key) fail(); return stored;
    }
    async function operation<T>(work: () => Promise<T>): Promise<T> {
      if (closed || busy) fail(); busy = true;
      try { await check(); return await work(); }
      catch { throw new StandingDialogueJournalError(); }
      finally { busy = false; }
    }
    return Object.freeze({
      close() { closed = true; passphrase = ""; claims.clear(); },
      async recordQuestion(question: DialogueQuestion) {
        return operation(async () => {
          if (readOnly) fail();
          const copy = JSON.parse(JSON.stringify(question)) as DialogueQuestion; validateQuestion(copy, binding);
          const key = keyFor(copy.primary.messageId), name = key + ".question.enc";
          if (await writeFile(name, "question", key, { question: copy, recordedAt: Math.floor(Date.now() / 1000) })) { claims.set(key, hash(copy)); return { key, created: true }; }
          const existing = (await readQuestion(key)).question;
          if (hash(existing) !== hash(copy)) fail();
          return { key, created: false };
        });
      },
      async recordModelAdmission(admission: DialogueModelAdmission) {
        return operation(async () => {
          if (readOnly) fail();
          const copy = JSON.parse(JSON.stringify(admission)) as DialogueModelAdmission; validateAdmission(copy);
          const question = (await readQuestion(copy.key)).question;
          try {
            const outcome = await readFile(copy.key + ".outcome.enc", "outcome", copy.key) as DialogueOutcome;
            validateOutcome(outcome); if (outcome.key !== copy.key) fail(); claims.delete(copy.key); return { created: false };
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          if (!await writeFile(copy.key + ".admission.enc", "admission", copy.key, copy)) {
            const existing = await readFile(copy.key + ".admission.enc", "admission", copy.key) as DialogueModelAdmission;
            validateAdmission(existing); if (existing.key !== copy.key) fail(); claims.delete(copy.key); return { created: false };
          }
          claims.set(copy.key, hash(question)); return { created: true };
        });
      },
      async recordOutcome(outcome: DialogueOutcome) {
        return operation(async () => {
          if (readOnly) fail();
          const copy = JSON.parse(JSON.stringify(outcome)) as DialogueOutcome; validateOutcome(copy);
          const proof = claims.get(copy.key); if (!proof) fail();
          const question = (await readQuestion(copy.key)).question;
          validateQuestion(question, binding); if (hash(question) !== proof) fail();
          // Consume before write: uncertain persistence must never be retried here.
          claims.delete(copy.key);
          if (!await writeFile(copy.key + ".outcome.enc", "outcome", copy.key, copy)) fail();
        });
      },
      async read(options: { limit: number; fromDate?: number; toDate?: number; scanLimit?: number }) {
        return operation(async () => {
          const { limit, fromDate, toDate, scanLimit = Math.max(limit, 100) } = options;
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(scanLimit) || scanLimit < limit || scanLimit > 200 ||
              (fromDate !== undefined && (!Number.isSafeInteger(fromDate) || fromDate <= 0)) ||
              (toDate !== undefined && (!Number.isSafeInteger(toDate) || toDate <= 0)) || (fromDate !== undefined && toDate !== undefined && fromDate > toDate)) fail();
          const found = new Set<string>(), outcomes = new Set<string>(), admissions = new Set<string>(); let count = 0;
          const listing = await opendir(directory);
          for await (const entry of listing) {
            if (++count > 30001 || !entry.isFile() || entry.isSymbolicLink()) fail();
            if (entry.name === "journal.enc") continue;
            const match = /^(\d{10})\.(question|outcome|admission)\.enc$/.exec(entry.name);
            if (!match || !validId(Number(match[1]))) return fail();
            (match[2] === "question" ? found : match[2] === "outcome" ? outcomes : admissions).add(match[1]!);
          }
          for (const key of [...outcomes, ...admissions]) if (!found.has(key)) fail();
          const ordered = [...found].sort().reverse(), dialogues: JournalDialogue[] = []; let scanned = 0;
          for (const key of ordered.slice(0, scanLimit)) {
            if (dialogues.length === limit) break; scanned++;
            const { question, recordedAt } = await readQuestion(key);
            const date = question.source?.date ?? question.context?.primary.date;
            if ((fromDate !== undefined || toDate !== undefined) && (date === undefined || (fromDate !== undefined && date < fromDate) || (toDate !== undefined && date > toDate))) continue;
            let outcome: DialogueOutcome | null = null;
            let modelAdmission: DialogueModelAdmission | null = null;
            if (admissions.has(key)) { modelAdmission = await readFile(key + ".admission.enc", "admission", key) as DialogueModelAdmission; validateAdmission(modelAdmission); if (modelAdmission.key !== key) fail(); }
            if (outcomes.has(key)) { outcome = await readFile(key + ".outcome.enc", "outcome", key) as DialogueOutcome; validateOutcome(outcome); if (outcome.key !== key) fail(); }
            dialogues.push({ key, question, recordedAt, modelAdmission, outcome, status: outcome?.delivery ?? "pending" });
          }
          return { dialogues: dialogues.reverse(), scanned, hasOlder: ordered.length > scanned };
        });
      },
    });
  } catch { passphrase = ""; throw new StandingDialogueJournalError(); }
}
