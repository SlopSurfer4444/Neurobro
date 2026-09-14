import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRepositoryTools, REPOSITORY_TOOL_SPECS } from "../src/standing-repository-tools.js";
import { createStandingToolDispatcher, type EpochToolResult, type EpochToolScope } from "../src/standing-tool-dispatcher.js";

const COMMIT = "e66c333bac2312cc8966aad66fb68cdbfdab740b";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const decode = (result: EpochToolResult) => JSON.parse(result.contentItems[0].text) as Record<string, any>;
function fixture(extraFiles: readonly { path: string; text: string }[] = []) {
  const controller = new AbortController(), files = [
    { path: "src/example.ts", text: "export const greeting = 'Привет';\n// fixed release source\n" },
    { path: "project/roadmap.md", text: "# Neurobro roadmap\nRead-only repository knowledge.\n" },
    ...extraFiles,
  ].map(file => ({ ...file, sha256: sha(file.text) }));
  const snapshot = { schema: "neurobro-repository-snapshot-v1", sourceCommit: COMMIT, files,
    excluded: [{ path: ".env", reason: "private-path" }, { path: "asset.bin", reason: "not-text" }] };
  const tools = createRepositoryTools({ snapshot, signal: controller.signal });
  const scope: EpochToolScope = Object.freeze({ requestRef: "request", callRef: "call", signal: controller.signal });
  return { controller, snapshot, tools, scope };
}

test("exact frozen specs and dispatcher expose release snapshot identity without workspace-current claims", async () => {
  const f = fixture();
  assert.deepEqual(REPOSITORY_TOOL_SPECS.map(spec => spec.name), ["neurobro_repo_info", "neurobro_repo_search", "neurobro_repo_read"]);
  assert.deepEqual(f.tools.handlers.map(handler => handler.name), REPOSITORY_TOOL_SPECS.map(spec => spec.name));
  for (const spec of REPOSITORY_TOOL_SPECS) { assert.ok(Object.isFrozen(spec)); assert.ok(Object.isFrozen(spec.inputSchema)); assert.equal(spec.inputSchema.additionalProperties, false); }
  const dispatcher = createStandingToolDispatcher({ call: async () => { throw Error("unused"); } }, f.tools.handlers);
  const info = decode(await dispatcher.call("neurobro_repo_info", {}, f.scope));
  assert.deepEqual(info, { schema: "neurobro-repository-info-v1", sourceCommit: COMMIT,
    counts: { files: 2, excluded: 2, textBytes: Buffer.byteLength(f.snapshot.files[0]!.text) + Buffer.byteLength(f.snapshot.files[1]!.text) },
    readonly: true, knowledgeMode: "release-source-snapshot" });
  assert.equal(JSON.stringify(info).includes("current"), false); await dispatcher.close(); await f.tools.close();
});

test("literal case-insensitive path and text search paginates without gaps and reports provenance", async () => {
  const repeated = Array.from({ length: 40 }, (_, index) => `Needle ${index}`).join("\n");
  const f = fixture([{ path: "src/Needle-list.ts", text: repeated }]);
  let cursor: number | null = null; const seen: Record<string, any>[] = [];
  do {
    const page = decode(await f.tools.handlers[1]!.call({ query: "needle", pathPrefix: "src/", cursor }, f.scope));
    assert.equal(page.sourceCommit, COMMIT); assert.equal(page.coverage.files, 3); assert.equal(page.coverage.excluded, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32 * 1024); seen.push(...page.hits); cursor = page.nextCursor;
    assert.equal(page.coverage.complete, cursor === null);
  } while (cursor !== null);
  assert.equal(seen.length, 41); assert.equal(seen[0]!.match, "path");
  assert.deepEqual(seen.slice(1).map(hit => hit.line), Array.from({ length: 40 }, (_, index) => index + 1));
  assert.ok(seen.every(hit => hit.sha256 === sha(repeated))); assert.equal(new Set(seen.map(hit => `${hit.match}:${hit.line}:${hit.column}`)).size, 41);
  const none = decode(await f.tools.handlers[1]!.call({ query: "needle", pathPrefix: "project/", cursor: null }, f.scope));
  assert.deepEqual(none.hits, []); assert.equal(none.nextCursor, null); await f.tools.close();
});

test("read continues on UTF-8 byte boundaries and reports stable lines, hash and EOF", async () => {
  const text = "line one\n" + "я".repeat(4_100) + "🙂tail\nlast";
  const f = fixture([{ path: "src/unicode.txt", text }]), expectedHash = sha(text);
  const first = decode(await f.tools.handlers[2]!.call({ path: "src/unicode.txt", offset: 0 }, f.scope));
  assert.equal(first.sourceCommit, COMMIT); assert.equal(first.sha256, expectedHash); assert.equal(first.offset, 0); assert.equal(first.startLine, 1);
  assert.ok(Buffer.byteLength(first.text, "utf8") <= 8192); assert.equal(Buffer.from(first.text).toString("utf8"), first.text);
  assert.equal(typeof first.nextOffset, "number");
  const second = decode(await f.tools.handlers[2]!.call({ path: "src/unicode.txt", offset: first.nextOffset }, f.scope));
  assert.equal(second.startLine, 2); assert.equal(second.eof, true); assert.equal(second.nextOffset, null);
  assert.equal(first.text + second.text, text);
  const split = decode(await f.tools.handlers[2]!.call({ path: "src/unicode.txt", offset: 10 }, f.scope));
  assert.equal(split.code, "invalid-arguments"); await f.tools.close();
});

test("search cursor resumes directly, is repeatable, and gives a usable Unicode byte offset", async () => {
  const f = fixture([{ path: "src/dense.txt", text: "🙂" + "a".repeat(200_000) }]);
  const search = f.tools.handlers[1]!, read = f.tools.handlers[2]!;
  const impossible = await search.call({ query: "a", pathPrefix: null, cursor: Number.MAX_SAFE_INTEGER }, f.scope);
  assert.equal(impossible.success, false); assert.equal(decode(impossible).code, "invalid-arguments");
  // File2, path already checked, then jump near the end of its text. No replay
  // of the preceding 199936 matches is necessary to obtain this page.
  const cursor = 2 * (2 * 1024 * 1024 + 2) + 1 + 199_938;
  const args = { query: "a", pathPrefix: "src/dense.txt", cursor };
  const first = decode(await search.call(args, f.scope)), again = decode(await search.call(args, f.scope));
  assert.deepEqual(again, first); assert.equal(first.hits.length, 32);
  assert.equal(first.hits[0].column, 199_939); assert.equal(first.hits[0].offset, 199_940);
  const content = decode(await read.call({ path: "src/dense.txt", offset: first.hits[0].offset }, f.scope));
  assert.equal(content.text, "a".repeat(64));
  const second = decode(await search.call({ ...args, cursor: first.nextCursor }, f.scope));
  assert.equal(second.hits.length, 32); assert.equal(second.nextCursor, null);
  const split = await search.call({ query: "a", pathPrefix: null, cursor: 2 * (2 * 1024 * 1024 + 2) + 2 }, f.scope);
  assert.equal(split.success, false); await f.tools.close();
});

test("snapshot is detached, deeply copied, hash checked and rejects hostile shapes and paths", async () => {
  const text = "safe", file = { path: "src/safe.ts", text, sha256: sha(text) }, files = [file];
  const snapshot = { schema: "neurobro-repository-snapshot-v1", sourceCommit: COMMIT, files, excluded: [] };
  const controller = new AbortController(), tools = createRepositoryTools({ snapshot, signal: controller.signal });
  file.text = "mutated"; files.push({ path: "src/other.ts", text, sha256: sha(text) });
  const scope = { requestRef: "r", callRef: "c", signal: controller.signal };
  assert.equal(decode(await tools.handlers[2]!.call({ path: "src/safe.ts", offset: 0 }, scope)).text, "safe");
  assert.equal(decode(await tools.handlers[2]!.call({ path: "src/other.ts", offset: 0 }, scope)).code, "unavailable"); await tools.close();
  const badSnapshots: unknown[] = [
    { ...snapshot, files: [{ ...file, path: "../secret" }] }, { ...snapshot, files: [{ ...file, path: "C:/secret" }] },
    { ...snapshot, files: [{ ...file, path: "/absolute" }] }, { ...snapshot, files: [{ ...file, path: "src\\safe.ts" }] },
    { ...snapshot, files: [{ ...file, path: "src/\u0000safe" }] }, { ...snapshot, files: [{ ...file }, { ...file }] },
    { ...snapshot, files: [{ ...file, sha256: "0".repeat(64) }] }, { ...snapshot, sourceCommit: COMMIT.toUpperCase() },
  ];
  for (const bad of badSnapshots) assert.throws(() => createRepositoryTools({ snapshot: bad, signal: controller.signal }), /STANDING_REPOSITORY_INVALID/);
  let getters = 0;
  const getterSnapshot = { schema: "neurobro-repository-snapshot-v1", sourceCommit: COMMIT,
    get files() { getters++; return []; }, excluded: [] };
  assert.throws(() => createRepositoryTools({ snapshot: getterSnapshot, signal: controller.signal }), /STANDING_REPOSITORY_INVALID/);
  const proxy = new Proxy(snapshot, { ownKeys() { getters++; throw Error("private payload"); } });
  assert.throws(() => createRepositoryTools({ snapshot: proxy, signal: controller.signal }), /STANDING_REPOSITORY_INVALID/); assert.equal(getters, 0);
});

test("hostile arguments invoke no getters and cannot select paths outside the snapshot", async () => {
  const f = fixture(); let getters = 0;
  const hostile = { query: "x", pathPrefix: null, get cursor() { getters++; return null; } };
  assert.equal(decode(await f.tools.handlers[1]!.call(hostile, f.scope)).code, "invalid-arguments");
  const proxy = new Proxy({ path: "src/example.ts", offset: 0 }, { ownKeys() { getters++; throw Error("secret"); } });
  assert.equal(decode(await f.tools.handlers[2]!.call(proxy, f.scope)).code, "invalid-arguments");
  for (const args of [{ path: "../src/example.ts", offset: 0 }, { path: "C:/src/example.ts", offset: 0 },
    { path: "src/example.ts", offset: -1 }, { path: "src/example.ts", offset: 0, command: "git status" }])
    assert.equal(decode(await f.tools.handlers[2]!.call(args, f.scope)).code, "invalid-arguments");
  assert.equal(getters, 0); await f.tools.close();
});

test("STOP before dispatch, during the async boundary, and after close returns only stopped", async () => {
  const before = fixture(); before.controller.abort();
  assert.equal(decode(await before.tools.handlers[0]!.call({}, before.scope)).code, "stopped");
  const during = fixture(), call = during.tools.handlers[2]!.call({ path: "src/example.ts", offset: 0 }, during.scope);
  during.controller.abort(); assert.equal(decode(await call).code, "stopped");
  const closed = fixture(); await closed.tools.close();
  assert.equal(decode(await closed.tools.handlers[1]!.call({ query: "x", pathPrefix: null, cursor: null }, closed.scope)).code, "stopped");
});
