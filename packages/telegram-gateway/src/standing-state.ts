import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { encryptSession, decryptSession } from "./session-crypto.js";
import type { PilotBinding } from "./pilot-telegram-adapter.js";

export class StandingStateError extends Error {
  constructor() { super("STANDING_STATE_REFUSED"); }
}
const fail = (): never => { throw new StandingStateError(); };
const validCursor = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2147483647;
export interface StandingState {
  cursor(): number | undefined;
  checkpointCursor(cursor: number): Promise<void>;
  newOutbox(): string;
}

/** Single owner only. The cursor is synced before admitting its primary to a model.
 * Atomic replacement protects process-crash recovery; this is not a power-loss guarantee.
 * No message bodies are retained, including in the encrypted checkpoint. */
export async function openStandingState(directory: string, passphrase: string, binding: PilotBinding): Promise<StandingState> {
  try {
    await assertPilotPrivateDirectory(dirname(directory));
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await assertPilotPrivateDirectory(directory);
    const outbox = join(directory, "outbox");
    try { await mkdir(outbox, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await assertPilotPrivateDirectory(outbox);
    const file = join(directory, "checkpoint.enc");
    let cursor: number | undefined;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 8192) fail();
      const handle = await open(file, "r");
      let bytes: Buffer;
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size) fail();
        bytes = await handle.readFile();
        if (bytes.length !== stat.size) fail();
      } finally { await handle.close(); }
      const state: unknown = JSON.parse(await decryptSession(bytes.toString("utf8"), passphrase));
      if (!state || typeof state !== "object") fail();
      const r = state as Record<string, unknown>;
      if (Object.keys(r).sort().join("|") !== "accountId|cursor|peerId|version" || r.version !== "standing-cursor-v1" ||
          r.accountId !== binding.accountId || r.peerId !== binding.peerId || !validCursor(r.cursor)) fail();
      cursor = r.cursor as number;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let busy = false, broken = false;
    return Object.freeze({
      cursor: () => cursor,
      newOutbox: () => join(outbox, randomUUID()),
      async checkpointCursor(next: number) {
        if (broken || busy || !validCursor(next) || (cursor !== undefined && next < cursor)) fail();
        if (next === cursor) return;
        busy = true;
        const temporary = join(directory, `checkpoint-${randomUUID()}.tmp`);
        try {
          const encrypted = await encryptSession(JSON.stringify({ version: "standing-cursor-v1", accountId: binding.accountId, peerId: binding.peerId, cursor: next }), passphrase);
          const handle = await open(temporary, "wx", 0o600);
          try { await handle.writeFile(encrypted, "utf8"); await handle.sync(); }
          finally { await handle.close(); }
          try {
            const stat = await lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink()) fail();
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          await rename(temporary, file);
          cursor = next;
        } catch { broken = true; throw new StandingStateError(); }
        finally { busy = false; await unlink(temporary).catch(() => undefined); }
      },
    });
  } catch { throw new StandingStateError(); }
}
