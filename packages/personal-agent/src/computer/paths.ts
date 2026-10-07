import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function key(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path; }
export function within(root: string, candidate: string): boolean {
  const part = relative(key(root), key(candidate));
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part));
}
export async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('COMPUTER_ABSOLUTE_ROOT_REQUIRED');
  const actual = await realpath(path);
  if (!(await stat(actual)).isDirectory()) throw new Error('COMPUTER_ROOT_NOT_DIRECTORY');
  return actual;
}
export async function scopedPath(root: string, candidate: string): Promise<string> {
  const lexical = resolve(root, candidate);
  if (!within(root, lexical)) throw new Error('COMPUTER_OUTSIDE_ROOT');
  const actual = await realpath(lexical);
  if (!within(root, actual)) throw new Error('COMPUTER_REPARSE_ESCAPE');
  return actual;
}
