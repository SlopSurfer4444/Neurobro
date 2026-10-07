import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/** Local, single-owner store. Every access rechecks ancestors, not only the leaf. */
export function safePath(path: string, kind?: 'directory' | 'file'): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('artifact path contains a symbolic link or junction');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('artifact ancestor is not a directory');
    if (index === parts.length - 1) {
      if (kind === 'directory' && !stat.isDirectory()) throw new Error('artifact path is not a directory');
      if (kind === 'file' && !stat.isFile()) throw new Error('artifact path is not a regular file');
      if (stat.isFile() && stat.nlink !== 1) throw new Error('artifact file has hard links');
    }
  }
  // Also catches junction aliases on platforms that report them inconsistently.
  const actual = realpathSync.native(absolute);
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(actual) !== normalize(absolute)) throw new Error('artifact path resolves through an alias');
}

export function directory(path: string): void {
  safePath(path, 'directory');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  safePath(path, 'directory');
}

export function contained(root: string, path: string): string {
  const target = resolve(path);
  const rel = relative(resolve(root), target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('artifact path escapes its root');
  return target;
}

export function fileName(name: string): string {
  if (typeof name !== 'string' || !name || name.length > 180 || name !== name.trim() ||
      /[\x00-\x1f\x7f/\\:<>"|?*]/u.test(name) || name === '.' || name === '..' || /[. ]$/u.test(name) ||
      /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)) {
    throw new Error('invalid artifact file name');
  }
  return name;
}

export function immutableWrite(path: string, bytes: Uint8Array, mode = 0o400): void {
  safePath(dirname(path), 'directory');
  safePath(path, 'file');
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  safePath(path, 'file');
}

export function boundedRead(path: string, maxBytes: number): Buffer {
  safePath(path, 'file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error('artifact file exceeds limits or is not a private regular file');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    safePath(path, 'file');
    const leaf = lstatSync(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        leaf.ino !== after.ino || leaf.dev !== after.dev || bytes.length !== before.size || bytes.length > maxBytes) {
      throw new Error('artifact changed while reading');
    }
    return bytes;
  } finally { closeSync(fd); }
}
