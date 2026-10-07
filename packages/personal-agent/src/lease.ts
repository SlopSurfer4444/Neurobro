import { openSync, writeFileSync, fsyncSync, closeSync, readFileSync, existsSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Lease { id: string; close(): void }
/** Single broker custody. Stale process absence permits reconciliation, not replay of uncertain effects. */
export function acquireLease(directory: string, options: { allowStopped?: boolean } = {}): Lease {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const transition = join(directory, '.lease-transition');
  const guard = openSync(transition, 'wx', 0o600);
  try {
  for (const name of [...(options.allowStopped ? [] : ['STOP']), '.ops.lock', '.neurobro-reconciliation-required.json']) {
    if (existsSync(join(directory, name))) throw new Error(`Start blocked by ${name}`);
  }
  const path = join(directory, 'service.lock');
  if (existsSync(path)) {
    const previous = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number; id?: string };
    if (!Number.isSafeInteger(previous.pid) || !previous.id || !/^[a-f0-9-]{36}$/.test(previous.id)) throw new Error('Unrecognized service lease; reconcile ownership first');
    let absent = false;
    try { process.kill(previous.pid!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') absent = true; }
    if (!absent) throw new Error('Another broker may own this profile');
    renameSync(path, join(directory, `service-abandoned-${previous.id}.json`));
  }
  const id = randomUUID(); const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify({ schemaVersion: 1, id, pid: process.pid, createdAt: new Date().toISOString() })); fsyncSync(fd); }
  finally { closeSync(fd); }
  let closed = false;
  return { id, close() {
    if (closed) return;
    const current = JSON.parse(readFileSync(path, 'utf8')) as { id: string };
    if (current.id !== id) throw new Error('Service lease ownership changed');
    unlinkSync(path); closed = true;
  } };
  } finally { closeSync(guard); unlinkSync(transition); }
}
