import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { AcceptedSnapshot, SnapshotFile } from "./wsl-broker-host.js";

interface RequiredSnapshotLoadBudgets {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxMetadataBytes: number;
  maxStderrBytes: number;
  timeoutMs: number;
}

const DEFAULT_BUDGETS: Readonly<RequiredSnapshotLoadBudgets> = Object.freeze({
  maxFiles: 256,
  maxFileBytes: 16_384,
  maxTotalBytes: 1_048_576,
  maxMetadataBytes: 1_048_576,
  maxStderrBytes: 4_096,
  timeoutMs: 15_000,
});

export interface SnapshotLoadBudgets {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxMetadataBytes?: number;
  maxStderrBytes?: number;
  timeoutMs?: number;
}

export interface AcceptedGitSnapshotOptions {
  /** Absolute path selected by the trusted host, never by a broker request. */
  gitExecutable: string;
  /** Absolute root of an ordinary clone whose .git entry is a directory. */
  repositoryRoot: string;
  expectedCommit: string;
  expectedTree: string;
  /** Exact repository-relative file paths. Directories and pathspecs are refused. */
  paths: readonly string[];
  budgets?: SnapshotLoadBudgets;
}

export class SnapshotLoadError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "SnapshotLoadError";
  }
}

interface GitContext {
  executable: string;
  gitDirectory: string;
  cwd: string;
  deadline: number;
  stderrLimit: number;
  env: NodeJS.ProcessEnv;
}

interface TreeEntry {
  mode: string;
  oid: string;
  name: string;
}

function refuse(code: string, ok: unknown): asserts ok {
  if (!ok) throw new SnapshotLoadError(code);
}

function safePath(value: unknown): asserts value is string {
  refuse("path-refused", typeof value === "string" && Buffer.byteLength(value, "utf8") <= 240);
  refuse("path-refused", /^[A-Za-z0-9_./-]+$/.test(value) && !value.startsWith("/") && !value.endsWith("/"));
  refuse("path-refused", value.split("/").every(part => part !== "" && part !== "." && part !== ".." && !/^\.(git|env)(\.|$)/i.test(part) && !/^(credentials?|sessions?)(\.|$)/i.test(part)));
}

function boundedHostPath(value: unknown, code: string): asserts value is string {
  refuse(code, typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 1_024);
  refuse(code, isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value));
}

function budgets(input: SnapshotLoadBudgets | undefined): Readonly<RequiredSnapshotLoadBudgets> {
  const supplied = input ?? {};
  const names = Object.keys(supplied);
  refuse("invalid-budgets", names.every(name => Object.hasOwn(DEFAULT_BUDGETS, name)));
  const result = { ...DEFAULT_BUDGETS, ...supplied };
  for (const name of Object.keys(DEFAULT_BUDGETS) as (keyof typeof DEFAULT_BUDGETS)[]) {
    refuse("invalid-budgets", Number.isSafeInteger(result[name]) && result[name] > 0 && result[name] <= DEFAULT_BUDGETS[name]);
  }
  refuse("invalid-budgets", result.maxFileBytes <= result.maxTotalBytes);
  return Object.freeze(result);
}

function minimalGitEnvironment(repositoryRoot: string): NodeJS.ProcessEnv {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    HOME: repositoryRoot,
    LANG: "C",
    LC_ALL: "C",
  };
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

async function runGit(context: GitContext, args: readonly string[], stdoutLimit: number, outputCode = "git-output-budget"): Promise<Buffer> {
  const remaining = Math.floor(context.deadline - performance.now());
  refuse("git-timeout", remaining > 0);
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(context.executable, [
      "--no-replace-objects",
      "--literal-pathspecs",
      `--git-dir=${context.gitDirectory}`,
      "-c", "core.fsmonitor=false",
      "-c", "core.commitGraph=false",
      "-c", "core.hooksPath=",
      "-c", "credential.helper=",
      "-c", "credential.interactive=never",
      "-c", "protocol.allow=never",
      "-c", "protocol.file.allow=never",
      ...args,
    ], {
      cwd: context.cwd,
      env: context.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: SnapshotLoadError | undefined;
    let settled = false;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: SnapshotLoadError, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reapTimer !== undefined) clearTimeout(reapTimer);
      if (error !== undefined) reject(error);
      else resolve(value ?? Buffer.alloc(0));
    };
    const stop = (code: string): void => {
      failure ??= new SnapshotLoadError(code);
      child.kill("SIGKILL");
      reapTimer ??= setTimeout(() => finish(new SnapshotLoadError("git-cleanup-unknown")), 1_000);
    };
    const timer = setTimeout(() => stop("git-timeout"), remaining);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > stdoutLimit) stop(outputCode);
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > context.stderrLimit) stop("git-stderr-budget");
    });
    child.once("error", () => {
      // A failed kill can emit error while the child is still live. Keep the
      // close/reap outcome instead of reporting it as a failed process start.
      if (failure === undefined) finish(new SnapshotLoadError("git-exec-failed"));
    });
    child.once("close", code => {
      if (failure !== undefined) return finish(failure);
      // Diagnostics are intentionally consumed but never exposed: they may
      // contain host paths or values from repository-local configuration.
      if (code !== 0) return finish(new SnapshotLoadError("git-object-refused"));
      finish(undefined, Buffer.concat(stdout));
    });
  });
}

function decodeUtf8(bytes: Buffer, code: string): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new SnapshotLoadError(code); }
  return text;
}

function strictText(bytes: Buffer): string {
  const text = decodeUtf8(bytes, "non-text-blob");
  refuse("non-text-blob", !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text));
  return text;
}

function gitObjectOid(kind: "commit" | "tree" | "blob", bytes: Buffer): string {
  return createHash("sha1").update(`${kind} ${bytes.length}\0`, "ascii").update(bytes).digest("hex");
}

function parseTree(bytes: Buffer): ReadonlyMap<string, TreeEntry> {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    const nul = bytes.indexOf(0, space + 1);
    refuse("tree-output-refused", space > offset && nul > space + 1 && nul + 21 <= bytes.length);
    const mode = bytes.subarray(offset, space).toString("ascii");
    refuse("tree-output-refused", /^(?:100644|100755|120000|160000|40000)$/.test(mode));
    const nameBytes = bytes.subarray(space + 1, nul);
    const name = decodeUtf8(nameBytes, "tree-output-refused");
    refuse("tree-output-refused", name !== "." && name !== ".." && !name.includes("/") && !/[\u0000-\u001f\u007f]/u.test(name));
    const oid = bytes.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, oid, name });
    offset = nul + 21;
  }
  const result = new Map<string, TreeEntry>();
  for (const entry of entries) { refuse("tree-output-refused", !result.has(entry.name)); result.set(entry.name, entry); }
  return result;
}

async function lstatIfPresent(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SnapshotLoadError("repository-refused");
  }
}

async function preflightObjectDirectories(gitDirectory: string): Promise<void> {
  const objects = join(gitDirectory, "objects");
  const objectsEntry = await lstat(objects);
  refuse("repository-refused", objectsEntry.isDirectory() && !objectsEntry.isSymbolicLink());
  for (const directory of [join(objects, "info"), join(objects, "pack")]) {
    const entry = await lstatIfPresent(directory);
    if (entry === undefined) continue;
    refuse("object-indirection-refused", entry.isDirectory() && !entry.isSymbolicLink());
    const children = await readdir(directory);
    refuse("metadata-budget", children.length <= 1_024);
    for (const name of children) {
      refuse("object-indirection-refused", !name.includes("/") && !name.includes("\\") && name !== "." && name !== "..");
      const child = await lstat(join(directory, name));
      if (directory === join(objects, "info") && name === "commit-graphs") {
        refuse("object-indirection-refused", child.isDirectory() && !child.isSymbolicLink());
        const graphs = await readdir(join(directory, name));
        refuse("metadata-budget", graphs.length <= 1_024);
        for (const graph of graphs) {
          const graphEntry = await lstat(join(directory, name, graph));
          refuse("object-indirection-refused", graphEntry.isFile() && !graphEntry.isSymbolicLink());
        }
        continue; // Ordinary split commit-graph metadata; Git use is explicitly disabled.
      }
      refuse("object-indirection-refused", child.isFile() && !child.isSymbolicLink());
      if (directory.endsWith(`${join("objects", "info")}`)) refuse("object-indirection-refused", !/^(?:alternates|http-alternates)$/i.test(name));
    }
  }
}

async function preflightLooseObject(context: GitContext, oid: string): Promise<void> {
  const fanout = join(context.gitDirectory, "objects", oid.slice(0, 2));
  const fanoutEntry = await lstatIfPresent(fanout);
  if (fanoutEntry === undefined) return;
  refuse("object-indirection-refused", fanoutEntry.isDirectory() && !fanoutEntry.isSymbolicLink());
  const objectEntry = await lstatIfPresent(join(fanout, oid.slice(2)));
  if (objectEntry !== undefined) refuse("object-indirection-refused", objectEntry.isFile() && !objectEntry.isSymbolicLink());
}

async function readObject(context: GitContext, kind: "commit" | "tree" | "blob", oid: string, limit: number, outputCode?: string): Promise<Buffer> {
  await preflightLooseObject(context, oid);
  return await runGit(context, ["cat-file", kind, oid], limit, outputCode);
}

/**
 * Materialize only explicitly allowed text blobs from an accepted Git commit.
 * This host-only function never reads the index or worktree and exports no
 * process, repository, path, or network capability to broker methods. Its
 * trusted host must keep .git metadata free of concurrent untrusted mutation;
 * filesystem preflights do not claim an atomic OS sandbox.
 */
export async function loadAcceptedGitSnapshot(input: AcceptedGitSnapshotOptions): Promise<AcceptedSnapshot> {
  const gitExecutableInput = input.gitExecutable;
  const repositoryRootInput = input.repositoryRoot;
  const expectedCommit = input.expectedCommit;
  const expectedTree = input.expectedTree;
  const requestedPaths = Array.isArray(input.paths) ? [...input.paths] : [];
  const limits = budgets(input.budgets === undefined ? undefined : { ...input.budgets });
  boundedHostPath(gitExecutableInput, "git-executable-refused");
  boundedHostPath(repositoryRootInput, "repository-refused");
  refuse("commit-refused", /^[a-f0-9]{40}$/.test(expectedCommit));
  refuse("tree-refused", /^[a-f0-9]{40}$/.test(expectedTree));
  refuse("path-refused", requestedPaths.length > 0 && requestedPaths.length <= limits.maxFiles);
  const allowed = new Set<string>();
  for (const path of requestedPaths) { safePath(path); refuse("duplicate-path", !allowed.has(path)); allowed.add(path); }

  let executable: string;
  let repositoryRoot: string;
  try {
    [executable, repositoryRoot] = await Promise.all([realpath(gitExecutableInput), realpath(repositoryRootInput)]);
    const [executableEntry, rootEntry] = await Promise.all([lstat(executable), lstat(repositoryRoot)]);
    refuse("git-executable-refused", executableEntry.isFile());
    refuse("repository-refused", rootEntry.isDirectory());
  } catch (error) {
    if (error instanceof SnapshotLoadError) throw error;
    throw new SnapshotLoadError("repository-refused");
  }
  const gitDirectory = join(repositoryRoot, ".git");
  try {
    const entry = await lstat(gitDirectory);
    refuse("worktree-refused", entry.isDirectory() && !entry.isSymbolicLink());
    await preflightObjectDirectories(gitDirectory);
    const configPath = join(gitDirectory, "config");
    const configEntry = await lstat(configPath);
    refuse("repository-config-refused", configEntry.isFile() && !configEntry.isSymbolicLink() && configEntry.size <= 65_536);
    const config = decodeUtf8(await readFile(configPath), "repository-config-refused");
    refuse("repository-config-refused", !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(config));
    refuse("repository-config-refused", !/^\s*\[\s*include(?:if)?\b/imu.test(config));
    refuse("repository-config-refused", !/^\s*include(?:if)?\./imu.test(config));
    refuse("repository-config-refused", !/^\s*(?:worktree|worktreeconfig|promisor|partialclone|alternaterefscommand)\s*=/imu.test(config));
    for (const name of ["commondir", "objects/info/alternates", "objects/info/http-alternates"]) {
      try { await lstat(join(gitDirectory, ...name.split("/"))); throw new SnapshotLoadError("object-indirection-refused"); }
      catch (nestedError) {
        if (nestedError instanceof SnapshotLoadError) throw nestedError;
        const code = (nestedError as NodeJS.ErrnoException).code;
        refuse("repository-refused", code === "ENOENT");
      }
    }
  } catch (error) {
    if (error instanceof SnapshotLoadError) throw error;
    throw new SnapshotLoadError("worktree-refused");
  }

  const context: GitContext = {
    executable,
    gitDirectory,
    cwd: dirname(repositoryRoot),
    deadline: performance.now() + limits.timeoutMs,
    stderrLimit: limits.maxStderrBytes,
    env: minimalGitEnvironment(repositoryRoot),
  };
  const commitBytes = await readObject(context, "commit", expectedCommit, Math.min(65_536, limits.maxMetadataBytes) + 1, "metadata-budget");
  refuse("metadata-budget", commitBytes.length <= limits.maxMetadataBytes);
  refuse("commit-refused", gitObjectOid("commit", commitBytes) === expectedCommit);
  const commit = decodeUtf8(commitBytes, "commit-refused");
  const treeLine = commit.split("\n", 1)[0];
  refuse("commit-refused", treeLine !== undefined && /^tree [a-f0-9]{40}$/.test(treeLine));
  refuse("tree-mismatch", treeLine.slice(5) === expectedTree);
  const treeCache = new Map<string, ReadonlyMap<string, TreeEntry>>();
  let metadataBytes = commitBytes.length;
  const readTree = async (treeOid: string): Promise<ReadonlyMap<string, TreeEntry>> => {
    const cached = treeCache.get(treeOid);
    if (cached !== undefined) return cached;
    refuse("metadata-budget", metadataBytes < limits.maxMetadataBytes);
    const bytes = await readObject(context, "tree", treeOid, limits.maxMetadataBytes - metadataBytes + 1, "metadata-budget");
    refuse("tree-integrity", gitObjectOid("tree", bytes) === treeOid);
    metadataBytes += bytes.length;
    refuse("metadata-budget", metadataBytes <= limits.maxMetadataBytes);
    const parsed = parseTree(bytes);
    treeCache.set(treeOid, parsed);
    return parsed;
  };
  const entries: { mode: SnapshotFile["mode"]; oid: string; path: string }[] = [];
  for (const path of [...allowed].sort()) {
    const segments = path.split("/");
    let treeOid = expectedTree;
    for (let index = 0; index < segments.length; index++) {
      const entry = (await readTree(treeOid)).get(segments[index]!);
      refuse("path-not-found", entry !== undefined);
      if (index < segments.length - 1) {
        refuse("snapshot-file-kind", entry.mode === "40000");
        treeOid = entry.oid;
      } else {
        refuse("snapshot-file-kind", entry.mode === "100644" || entry.mode === "100755");
        entries.push({ mode: entry.mode, oid: entry.oid, path });
      }
    }
  }
  const files: SnapshotFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const bytes = await readObject(context, "blob", entry.oid, limits.maxFileBytes + 1, "snapshot-budget");
    refuse("snapshot-budget", bytes.length <= limits.maxFileBytes);
    totalBytes += bytes.length;
    refuse("snapshot-budget", totalBytes <= limits.maxTotalBytes);
    refuse("blob-integrity", gitObjectOid("blob", bytes) === entry.oid);
    const text = strictText(bytes);
    files.push(Object.freeze({ path: entry.path, text, sha256: createHash("sha256").update(bytes).digest("hex"), mode: entry.mode }));
  }
  return Object.freeze({
    repository: "DecadansNeurobro",
    commit: expectedCommit,
    tree: expectedTree,
    files: Object.freeze(files),
  });
}
