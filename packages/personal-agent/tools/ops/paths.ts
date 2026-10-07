import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, dirname, relative, sep } from 'node:path';

export class OpsError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'OpsError'; this.code = code; }
}
export function absolute(value: string): string {
  if (!isAbsolute(value)) throw new OpsError('absolute_path_required');
  return resolve(value);
}
export function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
export function samePath(a: string, b: string): boolean {
  const left = resolve(a), right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
export function assertFreshStatePath(value: string): string {
  const path = absolute(value);
  // Old auth/profile roots are never source material for the new composition root.
  if (/(?:^|[\\/])(?:\.hermes|\.codex|\.ssh)(?:[\\/]|$)|hermes-likeavto-pilot|(?:^|[\\/])Neurobro(?:[\\/]|$)|telegram-standing-build/i.test(path)) {
    throw new OpsError('historical_profile_forbidden');
  }
  if (dirname(path) === path) throw new OpsError('filesystem_root_forbidden');
  return path;
}
export async function noLinks(path: string): Promise<void> {
  let cursor = absolute(path);
  for (;;) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new OpsError('symlink_or_junction_forbidden'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(cursor); if (parent === cursor) return; cursor = parent;
  }
}
export async function hashFile(path: string): Promise<string> {
  await noLinks(path);
  if (!(await lstat(path)).isFile()) throw new OpsError('regular_file_required');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function walkFiles(root: string, maxFiles = 100_000): Promise<string[]> {
  await noLinks(root);
  const canonical = await realpath(root);
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new OpsError('symlink_or_junction_forbidden');
      if (!within(canonical, await realpath(path))) throw new OpsError('path_escape');
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) { files.push(path); if (files.length > maxFiles) throw new OpsError('file_limit'); }
      else throw new OpsError('special_file_forbidden');
    }
  };
  await visit(canonical);
  return files.sort();
}
