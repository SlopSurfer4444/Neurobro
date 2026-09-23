import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";

const VERSION = "standing-observed-source-binding-v1" as const;
const SLOT = "observed-source-binding.json";
const CAP = 2_048;

export type StandingObservedSourceBindingInput = Readonly<{
  directory: string;
  workspaceId: string;
  accountId: string;
  internalPeerId: string;
  title: string;
}>;
export type StandingObservedSourceCandidate = Readonly<{ accountId: string; peerId: string; title: string }>;
export type StandingObservedSourceBinding = Readonly<{
  expectedPeerId?: string;
  bind(candidate: StandingObservedSourceCandidate): Promise<void>;
}>;

type RecordV1 = Readonly<{
  version: typeof VERSION;
  workspaceId: string;
  accountId: string;
  internalPeerId: string;
  title: string;
  peerId: string;
}>;
type ReadRecord = Readonly<{ record: RecordV1; bytes: Buffer; stat: BigIntStats }>;

export class StandingObservedSourceBindingError extends Error {
  constructor() { super("STANDING_OBSERVED_SOURCE_BINDING_REFUSED"); }
}
const fail = (): never => { throw new StandingObservedSourceBindingError(); };
const missing = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const accountId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,19}$/u.test(value);
const peerId = (value: unknown): value is string => typeof value === "string" && /^-[1-9]\d{0,19}$/u.test(value);
const title = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value === value.trim() &&
  Buffer.byteLength(value, "utf8") <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
  Buffer.from(value, "utf8").toString("utf8") === value;
const workspaceId = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(value);

function data(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || !fields.includes(key) ||
      !("value" in descriptors[key]!) || !descriptors[key]!.enumerable) ||
      Object.keys(descriptors).sort().join("\0") !== [...fields].sort().join("\0")) return fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) result[key] = descriptor.value;
  return result;
}

function namespace(value: StandingObservedSourceBindingInput): StandingObservedSourceBindingInput {
  const input = data(value, ["directory", "workspaceId", "accountId", "internalPeerId", "title"]);
  if (typeof input.directory !== "string" || !isAbsolute(input.directory) || resolve(input.directory) !== input.directory ||
      !workspaceId(input.workspaceId) || !accountId(input.accountId) || !peerId(input.internalPeerId) || !title(input.title)) return fail();
  return Object.freeze({ directory: input.directory, workspaceId: input.workspaceId, accountId: input.accountId,
    internalPeerId: input.internalPeerId, title: input.title });
}

function parse(raw: Buffer, expected: StandingObservedSourceBindingInput): RecordV1 {
  if (raw.length < 1 || raw.length > CAP || !Buffer.from(raw.toString("utf8"), "utf8").equals(raw)) return fail();
  let decoded: unknown;
  try { decoded = JSON.parse(raw.toString("utf8")); } catch { return fail(); }
  const record = data(decoded, ["version", "workspaceId", "accountId", "internalPeerId", "title", "peerId"]);
  if (record.version !== VERSION || record.workspaceId !== expected.workspaceId || record.accountId !== expected.accountId ||
      record.internalPeerId !== expected.internalPeerId || record.title !== expected.title || !peerId(record.peerId) ||
      record.peerId === expected.internalPeerId) return fail();
  const result: RecordV1 = Object.freeze({ version: VERSION, workspaceId: expected.workspaceId, accountId: expected.accountId,
    internalPeerId: expected.internalPeerId, title: expected.title, peerId: record.peerId });
  if (JSON.stringify(result) !== raw.toString("utf8")) return fail();
  return result;
}

function regular(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.dev <= 0n || stat.ino <= 0n ||
      stat.size < 1n || stat.size > BigInt(CAP)) return fail();
}
function sameFile(left: BigIntStats, right: BigIntStats): void {
  if (left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size) return fail();
}

async function readRecord(path: string, expected: StandingObservedSourceBindingInput): Promise<ReadRecord | undefined> {
  let before: BigIntStats;
  try { before = await lstat(path, { bigint: true }); }
  catch (error) { if (missing(error)) return; throw error; }
  regular(before);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true }); regular(opened); sameFile(before, opened);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true }); const named = await lstat(path, { bigint: true });
    regular(after); regular(named); sameFile(opened, after); sameFile(opened, named);
    if (bytes.length !== Number(opened.size)) return fail();
    return Object.freeze({ record: parse(bytes, expected), bytes, stat: opened });
  } finally { await handle.close(); }
}

/** Create a complete temporary inode, then atomically claim the absent fixed slot
 * with a hard link. Unlike rename, link never replaces an existing binding. */
async function persistExclusive(path: string, record: RecordV1, input: StandingObservedSourceBindingInput): Promise<ReadRecord> {
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  if (bytes.length < 1 || bytes.length > CAP) return fail();
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let linked = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes); await file.sync();
      const created = await file.stat({ bigint: true });
      if (!created.isFile() || created.isSymbolicLink() || created.nlink !== 1n || created.size !== BigInt(bytes.length)) return fail();
    } finally { await file.close(); }
    await link(temporary, path); linked = true;
  } finally {
    try { await unlink(temporary); }
    catch (error) { if (!missing(error)) return fail(); }
  }
  if (!linked) return fail();
  const saved = await readRecord(path, input);
  if (!saved || !saved.bytes.equals(bytes)) return fail();
  return saved;
}

/**
 * Opens the one metadata-only observed-source binding in an existing private
 * workspace state directory. The caller remains responsible for verifying the
 * inherited ACL before opening; this function verifies directory/file identity.
 */
export async function openStandingObservedSourceBinding(raw: StandingObservedSourceBindingInput): Promise<StandingObservedSourceBinding> {
  try {
    const input = namespace(raw);
    await assertPilotPrivateDirectory(input.directory);
    const directory = await lstat(input.directory, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink()) return fail();
    const path = join(input.directory, SLOT);
    let saved = await readRecord(path, input);
    let expected = saved?.record.peerId;
    let busy = false, broken = false;
    const result: StandingObservedSourceBinding = {
      ...(expected === undefined ? {} : { expectedPeerId: expected }),
      async bind(value: StandingObservedSourceCandidate): Promise<void> {
        if (busy || broken) return fail();
        busy = true;
        try {
          const candidate = data(value, ["accountId", "peerId", "title"]);
          if (candidate.accountId !== input.accountId || !peerId(candidate.peerId) || candidate.peerId === input.internalPeerId ||
              candidate.title !== input.title) return fail();
          const currentDirectory = await lstat(input.directory, { bigint: true });
          if (!currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() || currentDirectory.dev !== directory.dev ||
              currentDirectory.ino !== directory.ino) return fail();
          if (saved) {
            const current = await readRecord(path, input);
            if (!current || current.record.peerId !== expected || current.record.peerId !== candidate.peerId ||
                current.stat.dev !== saved.stat.dev || current.stat.ino !== saved.stat.ino || !current.bytes.equals(saved.bytes)) return fail();
            return;
          }
          if (await readRecord(path, input)) return fail();
          const record: RecordV1 = Object.freeze({ version: VERSION, workspaceId: input.workspaceId, accountId: input.accountId,
            internalPeerId: input.internalPeerId, title: input.title, peerId: candidate.peerId });
          saved = await persistExclusive(path, record, input);
          const finalDirectory = await lstat(input.directory, { bigint: true });
          if (!finalDirectory.isDirectory() || finalDirectory.isSymbolicLink() || finalDirectory.dev !== directory.dev ||
              finalDirectory.ino !== directory.ino) return fail();
          expected = candidate.peerId;
        } catch { broken = true; throw new StandingObservedSourceBindingError(); }
        finally { busy = false; }
      },
    };
    return Object.freeze(result);
  } catch { throw new StandingObservedSourceBindingError(); }
}
