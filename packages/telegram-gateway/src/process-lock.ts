import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

const LOCK_VERSION = "telegram-gateway-process-lock-v1" as const;
const PROCESS_BOOT_NONCE = randomBytes(32).toString("hex");
const PROCESS_START_IDENTITY = new Date(Date.now() - Math.floor(process.uptime() * 1_000)).toISOString();

interface LockRecord {
  version: typeof LOCK_VERSION;
  pid: number;
  processStartIdentity: string;
  bootNonce: string;
  ownershipNonce: string;
}

export class ProcessLockAdmissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessLockAdmissionDeniedError";
  }
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isHexNonce(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function parseExactLockRecord(bytes: string): LockRecord {
  let candidate: unknown;
  try {
    candidate = JSON.parse(bytes);
  } catch {
    throw new ProcessLockAdmissionDeniedError("Malformed process lock is preserved and blocks admission.");
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ProcessLockAdmissionDeniedError("Malformed process lock is preserved and blocks admission.");
  }
  const record = candidate as Partial<LockRecord> & Record<string, unknown>;
  const exactKeys = Object.keys(record).sort();
  if (JSON.stringify(exactKeys) !== JSON.stringify([
    "bootNonce",
    "ownershipNonce",
    "pid",
    "processStartIdentity",
    "version",
  ]) || record.version !== LOCK_VERSION || !Number.isInteger(record.pid) || (record.pid as number) <= 0 ||
      typeof record.processStartIdentity !== "string" || !Number.isFinite(Date.parse(record.processStartIdentity)) ||
      !isHexNonce(record.bootNonce) || !isHexNonce(record.ownershipNonce)) {
    throw new ProcessLockAdmissionDeniedError("Malformed process lock is preserved and blocks admission.");
  }
  return record as LockRecord;
}

async function refuseExistingLock(lockPath: string): Promise<never> {
  const bytes = await readFile(lockPath, "utf8");
  const record = parseExactLockRecord(bytes);
  if (processExists(record.pid)) {
    throw new ProcessLockAdmissionDeniedError("Another ingestor process is active.");
  }
  throw new ProcessLockAdmissionDeniedError(
    "Stale process lock is preserved until separately authorized OS-absence reconciliation.",
  );
}

export async function acquireProcessLock(lockPath: string): Promise<() => Promise<void>> {
  if (!path.isAbsolute(lockPath)) {
    throw new ProcessLockAdmissionDeniedError("Relative process lock path is ambiguous and blocks admission.");
  }
  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    await readFile(`${lockPath}.sticky`, "utf8");
    throw new ProcessLockAdmissionDeniedError(
      "Sticky owner admission block requires separately authorized OS-absence proof.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const record: LockRecord = {
    version: LOCK_VERSION,
    pid: process.pid,
    processStartIdentity: PROCESS_START_IDENTITY,
    bootNonce: PROCESS_BOOT_NONCE,
    ownershipNonce: randomBytes(32).toString("hex"),
  };
  const ownedBytes = `${JSON.stringify(record)}\n`;
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return refuseExistingLock(lockPath);
    throw error;
  }
  try {
    await handle.writeFile(ownedBytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (await readFile(lockPath, "utf8") !== ownedBytes) {
    throw new ProcessLockAdmissionDeniedError("Process lock ownership readback failed; lock is preserved.");
  }

  let releaseAttempted = false;
  return async () => {
    if (releaseAttempted) return;
    releaseAttempted = true;
    let currentBytes: string;
    try {
      currentBytes = await readFile(lockPath, "utf8");
    } catch {
      throw new ProcessLockAdmissionDeniedError("Process lock ownership readback failed; lock is preserved.");
    }
    if (currentBytes !== ownedBytes) {
      throw new ProcessLockAdmissionDeniedError("Process lock ownership changed; replacement lock is preserved.");
    }
    await unlink(lockPath);
  };
}
