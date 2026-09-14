import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { deflateSync, inflateSync } from "node:zlib";
import { createWslBrokerHost } from "../src/wsl-broker-host.js";
import { loadAcceptedGitSnapshot, SnapshotLoadError, type AcceptedGitSnapshotOptions } from "../src/wsl-broker-snapshot.js";

let fixtureRoot: string;
let repositoryRoot: string;
let gitExecutable: string;
let acceptedCommit: string;
let acceptedTree: string;

const identityEnvironment = {
  GIT_AUTHOR_NAME: "Snapshot Fixture",
  GIT_AUTHOR_EMAIL: "snapshot@example.invalid",
  GIT_COMMITTER_NAME: "Snapshot Fixture",
  GIT_COMMITTER_EMAIL: "snapshot@example.invalid",
  GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z",
};

function fixtureEnvironment(): NodeJS.ProcessEnv {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const env: NodeJS.ProcessEnv = {
    ...identityEnvironment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_TERMINAL_PROMPT: "0",
    HOME: fixtureRoot,
    LANG: "C",
    LC_ALL: "C",
  };
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function git(args: readonly string[], input?: Uint8Array): Buffer {
  return execFileSync(gitExecutable, ["-c", "core.hooksPath=", "-c", "credential.helper=", ...args], {
    cwd: repositoryRoot,
    env: fixtureEnvironment(),
    input,
    maxBuffer: 2_500_000,
    windowsHide: true,
  });
}

function oid(bytes: Uint8Array): string {
  return git(["hash-object", "-w", "--stdin"], bytes).toString("ascii").trim();
}

function commitWith(entries: readonly { mode: string; kind?: "blob" | "commit"; oid: string; path: string }[]): { commit: string; tree: string } {
  const treeInput = Buffer.from(entries.map(entry => `${entry.mode} ${entry.kind ?? "blob"} ${entry.oid}\t${entry.path}\0`).join(""), "utf8");
  const tree = git(["mktree", "-z"], treeInput).toString("ascii").trim();
  const commit = git(["commit-tree", tree, "-m", "synthetic fixture"]).toString("ascii").trim();
  return { commit, tree };
}

function options(extra: Partial<AcceptedGitSnapshotOptions> = {}): AcceptedGitSnapshotOptions {
  return {
    gitExecutable,
    repositoryRoot,
    expectedCommit: acceptedCommit,
    expectedTree: acceptedTree,
    paths: ["docs/accepted.txt"],
    ...extra,
  };
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, error => error instanceof SnapshotLoadError && error.code === code);
}

before(async () => {
  const located = process.platform === "win32"
    ? execFileSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/u).find(Boolean)
    : execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  assert.ok(located);
  gitExecutable = await realpath(located);
  fixtureRoot = await mkdtemp(join(tmpdir(), "decadans-snapshot-loader-"));
  repositoryRoot = join(fixtureRoot, "repository");
  await mkdir(repositoryRoot);
  git(["init", "--initial-branch=main", "--template="]);
  await mkdir(join(repositoryRoot, "docs"));
  await writeFile(join(repositoryRoot, "docs", "accepted.txt"), "accepted\n", "utf8");
  git(["add", "--", "docs/accepted.txt"]);
  git(["commit", "-m", "accepted"]);
  acceptedCommit = git(["rev-parse", "HEAD"]).toString("ascii").trim();
  acceptedTree = git(["rev-parse", "HEAD^{tree}"]).toString("ascii").trim();
});

after(async () => {
  const canonicalTemp = await realpath(tmpdir());
  const canonicalFixture = await realpath(fixtureRoot);
  assert.ok(canonicalFixture.startsWith(canonicalTemp.endsWith(sep) ? canonicalTemp : `${canonicalTemp}${sep}`));
  assert.match(basename(canonicalFixture), /^decadans-snapshot-loader-/u);
  await rm(canonicalFixture, { recursive: true, force: true });
});

test("loads the accepted commit while HEAD and the worktree change", async () => {
  const replacementBlob = oid(Buffer.from("replacement\n"));
  const replacement = commitWith([{ mode: "100644", oid: replacementBlob, path: "replacement.txt" }]);
  git(["replace", acceptedCommit, replacement.commit]);
  await writeFile(join(repositoryRoot, "docs", "accepted.txt"), "new head\n", "utf8");
  git(["add", "--", "docs/accepted.txt"]);
  git(["commit", "-m", "new head"]);
  await writeFile(join(repositoryRoot, "docs", "accepted.txt"), "dirty worktree\n", "utf8");

  const previousObjectDirectory = process.env.GIT_OBJECT_DIRECTORY;
  const previousReplaceBase = process.env.GIT_REPLACE_REF_BASE;
  process.env.GIT_OBJECT_DIRECTORY = join(fixtureRoot, "injected-missing-objects");
  process.env.GIT_REPLACE_REF_BASE = "refs/injected-replacements/";
  try {
    const request = options();
    const pending = loadAcceptedGitSnapshot(request);
    request.expectedCommit = replacement.commit;
    request.expectedTree = replacement.tree;
    (request.paths as string[])[0] = "replacement.txt";
    const snapshot = await pending;
    assert.deepEqual(snapshot, {
      repository: "DecadansNeurobro",
      commit: acceptedCommit,
      tree: acceptedTree,
      files: [{
        path: "docs/accepted.txt",
        text: "accepted\n",
        sha256: createHash("sha256").update("accepted\n").digest("hex"),
        mode: "100644",
      }],
    });
    const host = createWslBrokerHost({
      key: Buffer.alloc(32, 7), keyId: "fixture", sessionId: "a".repeat(32), snapshot,
      acceptsSnapshot: identity => identity.commit === acceptedCommit && identity.tree === acceptedTree,
      chat: "invented-fixture-chat",
      gateway: { read: async () => { throw new Error("not called"); } },
      proposals: { enqueue: async () => { throw new Error("not called"); } },
      killSwitchEngaged: () => true,
    });
    assert.deepEqual(host.receipts(), []);
  } finally {
    if (previousObjectDirectory === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
    else process.env.GIT_OBJECT_DIRECTORY = previousObjectDirectory;
    if (previousReplaceBase === undefined) delete process.env.GIT_REPLACE_REF_BASE;
    else process.env.GIT_REPLACE_REF_BASE = previousReplaceBase;
  }
});

test("rejects an accepted-commit tree mismatch", async () => {
  await rejectsCode(loadAcceptedGitSnapshot(options({ expectedTree: "0".repeat(40) })), "tree-mismatch");
});

test("rejects symlinks and worktree-style git indirection", async () => {
  const symlink = commitWith([{ mode: "120000", oid: oid(Buffer.from("target")), path: "link" }]);
  await rejectsCode(loadAcceptedGitSnapshot(options({ expectedCommit: symlink.commit, expectedTree: symlink.tree, paths: ["link"] })), "snapshot-file-kind");

  const linkedRoot = join(fixtureRoot, "linked-worktree");
  await mkdir(linkedRoot);
  await writeFile(join(linkedRoot, ".git"), `gitdir: ${join(repositoryRoot, ".git")}\n`, "utf8");
  await rejectsCode(loadAcceptedGitSnapshot(options({ repositoryRoot: linkedRoot })), "worktree-refused");
});

test("rejects unsafe, duplicate, and missing allowlist paths before reading blobs", async () => {
  for (const path of ["../outside", "a/../b", "/absolute", "C:/host", "a\\b", ".git/config", ".env", "sessions/auth", "a//b"]) {
    await rejectsCode(loadAcceptedGitSnapshot(options({ paths: [path] })), "path-refused");
  }
  await rejectsCode(loadAcceptedGitSnapshot(options({ paths: ["docs/accepted.txt", "docs/accepted.txt"] })), "duplicate-path");
  await rejectsCode(loadAcceptedGitSnapshot(options({ paths: ["docs/missing.txt"] })), "path-not-found");
});

test("rejects repository config includes and object alternates", async () => {
  const configPath = join(repositoryRoot, ".git", "config");
  const originalConfig = await readFile(configPath);
  await writeFile(configPath, Buffer.concat([originalConfig, Buffer.from("\n[include]\n\tpath = outside.config\n")]));
  try { await rejectsCode(loadAcceptedGitSnapshot(options()), "repository-config-refused"); }
  finally { await writeFile(configPath, originalConfig); }

  const alternatesPath = join(repositoryRoot, ".git", "objects", "info", "alternates");
  await writeFile(alternatesPath, `${join(fixtureRoot, "outside-objects")}\n`, "utf8");
  try { await rejectsCode(loadAcceptedGitSnapshot(options()), "object-indirection-refused"); }
  finally { await rm(alternatesPath); }
});

test("rejects oversized, invalid UTF-8, and control-bearing blobs", async () => {
  const oversized = commitWith([{ mode: "100644", oid: oid(Buffer.alloc(16_385, 65)), path: "large.txt" }]);
  await rejectsCode(loadAcceptedGitSnapshot(options({ expectedCommit: oversized.commit, expectedTree: oversized.tree, paths: ["large.txt"] })), "snapshot-budget");

  const invalid = commitWith([
    { mode: "100644", oid: oid(Buffer.from([0xc3, 0x28])), path: "invalid.txt" },
    { mode: "100644", oid: oid(Buffer.from([0x61, 0x00, 0x62])), path: "control.txt" },
  ]);
  await rejectsCode(loadAcceptedGitSnapshot(options({ expectedCommit: invalid.commit, expectedTree: invalid.tree, paths: ["invalid.txt"] })), "non-text-blob");
  await rejectsCode(loadAcceptedGitSnapshot(options({ expectedCommit: invalid.commit, expectedTree: invalid.tree, paths: ["control.txt"] })), "non-text-blob");
});

test("rejects an actual pack-directory junction before object lookup", async () => {
  const pack = join(repositoryRoot, ".git", "objects", "pack");
  const outside = join(fixtureRoot, "outside-pack-store");
  await mkdir(outside);
  await rmdir(pack); // Known empty task-private Git fixture directory; no recursive removal.
  try {
    await symlink(outside, pack, process.platform === "win32" ? "junction" : "dir");
    try { await rejectsCode(loadAcceptedGitSnapshot(options()), "object-indirection-refused"); }
    finally { await unlink(pack); }
  } finally { await mkdir(pack); }
});

test("accepts regular split commit-graph metadata without using it", async () => {
  const graphs = join(repositoryRoot, ".git", "objects", "info", "commit-graphs");
  await mkdir(graphs);
  await writeFile(join(graphs, "commit-graph-chain"), "");
  const snapshot = await loadAcceptedGitSnapshot(options());
  assert.equal(snapshot.commit, acceptedCommit);
  assert.equal(snapshot.files[0]?.text, "accepted\n");
});

test("refuses a corrupt traversed tree object", async () => {
  const corrupt = commitWith([{ mode: "100644", oid: oid(Buffer.from("corrupt fixture\n")), path: "corrupt.txt" }]);
  const objectPath = join(repositoryRoot, ".git", "objects", corrupt.tree.slice(0, 2), corrupt.tree.slice(2));
  const original = await readFile(objectPath);
  const originalMode = (await stat(objectPath)).mode;
  const inflated = inflateSync(original);
  const marker = Buffer.from("100644 corrupt.txt\0", "ascii");
  const markerAt = inflated.indexOf(marker);
  assert.notEqual(markerAt, -1);
  inflated[markerAt + 5] = 53;
  await chmod(objectPath, 0o666);
  await writeFile(objectPath, deflateSync(inflated));
  try {
    await assert.rejects(
      loadAcceptedGitSnapshot(options({ expectedCommit: corrupt.commit, expectedTree: corrupt.tree, paths: ["corrupt.txt"] })),
      error => error instanceof SnapshotLoadError && ["tree-integrity", "git-object-refused"].includes(error.code),
    );
  } finally {
    await writeFile(objectPath, original);
    await chmod(objectPath, originalMode);
  }
});

test("accepts only finite budget decreases", async () => {
  await rejectsCode(loadAcceptedGitSnapshot(options({ budgets: { maxFiles: 257 } })), "invalid-budgets");
  await rejectsCode(loadAcceptedGitSnapshot(options({ budgets: { maxFileBytes: 2, maxTotalBytes: 1 } })), "invalid-budgets");
  await rejectsCode(loadAcceptedGitSnapshot(options({ budgets: { timeoutMs: 0 } })), "invalid-budgets");
});
