import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  PROCESS_REQUEST_SCHEMA,
  PROCESS_EVIDENCE_SCHEMA,
  ContractError,
  canonicalizeJson,
  encodeCanonicalProcessRequest,
  parseCanonicalProcessEvidenceBytes,
  parseCanonicalProcessRequestBytes,
  parseProcessEvidence,
  parseProcessRequest,
  sha256Hex,
} from "../src/contract.ts";

const fixtureUrl = new URL("../fixtures/process-boundary-v1.json", import.meta.url);

test("tracer: canonical v1 request is stable and accepted", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const request = fixture.vectors[0].request;

  const parsed = parseProcessRequest(request);
  const canonical = canonicalizeJson(request);

  assert.equal(parsed.schema, PROCESS_REQUEST_SCHEMA);
  assert.equal(canonical, canonicalizeJson(JSON.parse(canonical)));
  assert.match(sha256Hex(Buffer.from(canonical, "utf8")), /^[0-9a-f]{64}$/u);
});

test("request environments preserve generic fixtures and admit only the exact direct-WSL Windows pair", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const original = fixture.vectors[0].request;
  const windows = structuredClone(original);
  windows.executable.path = "C:\\Program Files\\WSL\\wsl.exe";
  windows.environment = {
    inherit: false,
    allowlist: ["SystemRoot", "WINDIR"],
    values: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
  };
  assert.deepEqual(parseProcessRequest(windows).environment, windows.environment);
  assert.deepEqual(parseCanonicalProcessRequestBytes(encodeCanonicalProcessRequest(windows)), parseProcessRequest(windows));

  for (const executable of [original.executable.path, windows.executable.path]) {
    for (const environment of [
      { inherit: false, allowlist: [], values: {} },
      { inherit: false, allowlist: ["LANG", "LC_ALL", "NO_COLOR", "RM0032_FIXTURE_MODE"],
        values: { LANG: "C", LC_ALL: "C", NO_COLOR: "1", RM0032_FIXTURE_MODE: "tracer" } },
    ]) {
      const generic = structuredClone(original);
      generic.executable.path = executable;
      generic.environment = environment;
      assert.deepEqual(parseProcessRequest(generic).environment, environment);
    }
  }
  assert.deepEqual(JSON.parse(await readFile(fixtureUrl, "utf8")), fixture, "historical canonical vector remains unchanged");
});

test("direct-WSL Windows environment rejects target, pair, casing, inheritance and key drift", async (context) => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const original = structuredClone(fixture.vectors[0].request);
  original.executable.path = "C:\\Program Files\\WSL\\wsl.exe";
  original.environment = { inherit: false, allowlist: ["SystemRoot", "WINDIR"],
    values: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" } };
  parseProcessRequest(original);
  const cases: Array<[string, (candidate: any) => void]> = [
    ["missing SystemRoot", c => { c.environment.allowlist = ["WINDIR"]; delete c.environment.values.SystemRoot; }],
    ["missing WINDIR", c => { c.environment.allowlist = ["SystemRoot"]; delete c.environment.values.WINDIR; }],
    ["missing values key", c => { delete c.environment.values.WINDIR; }],
    ["values without allowlist", c => { c.environment.allowlist = []; }],
    ["allowlist without values", c => { c.environment.values = {}; }],
    ["inherited environment", c => { c.environment.inherit = true; }],
    ["duplicate name", c => { c.environment.allowlist = ["SystemRoot", "SystemRoot", "WINDIR"]; }],
    ["unsorted names", c => { c.environment.allowlist.reverse(); }],
    ["name casing", c => { c.environment.allowlist = ["WINDIR", "systemroot"]; c.environment.values.systemroot = c.environment.values.SystemRoot; delete c.environment.values.SystemRoot; }],
    ["both names lowercase", c => { c.environment.allowlist = ["systemroot", "windir"]; c.environment.values = { systemroot: "C:\\Windows", windir: "C:\\Windows" }; }],
    ["extra unlisted value", c => { c.environment.values.PATH = "C:\\Windows"; }],
    ["string-valued inheritance", c => { c.environment.inherit = "false"; }],
    ["array-valued SystemRoot", c => { c.environment.values.SystemRoot = ["C:\\Windows"]; }],
  ];
  for (const path of ["C:\\Windows\\System32\\wsl.exe", "C:\\Windows\\SysWOW64\\wsl.exe",
    "C:\\fixture\\wsl.exe", "C:\\Program Files\\WSL\\wsl-alias.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\git.exe", "C:\\Program Files\\WSL\\WSL.exe"]) {
    cases.push(["nonexact target " + path, c => { c.executable.path = path; }]);
  }
  for (const name of ["SystemRoot", "WINDIR"]) {
    for (const value of ["C:\\Elsewhere", "C:\\windows", "C:\\Windows\\", ""]) {
      cases.push([name + " value " + JSON.stringify(value), c => { c.environment.values[name] = value; }]);
    }
  }
  for (const name of ["PATH", "SystemDrive", "RM0032_FIXTURE_MODE"]) {
    cases.push(["extra allowed name " + name, c => {
      c.environment.allowlist.push(name); c.environment.allowlist.sort(); c.environment.values[name] = "fixture";
    }]);
  }
  for (const [name, mutate] of cases) {
    await context.test(name, () => {
      const candidate = structuredClone(original);
      mutate(candidate);
      assert.notDeepEqual(candidate, original, "the hostile input must actually change");
      assert.throws(() => parseProcessRequest(candidate), ContractError);
      assert.throws(() => parseCanonicalProcessRequestBytes(Buffer.from(canonicalizeJson(candidate), "utf8")), ContractError);
    });
  }
});

test("stdin raw cap and request UTF-8 cap remain independent fail-closed bounds", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const atStdinCap = structuredClone(fixture.vectors[0].request);
  const maximumStdin = Buffer.alloc(262_144, 0x5a);
  atStdinCap.stdin.base64 = maximumStdin.toString("base64");
  atStdinCap.stdin.bytes = maximumStdin.byteLength;
  atStdinCap.stdin.sha256 = sha256Hex(maximumStdin);
  const parsed = parseProcessRequest(atStdinCap);
  assert.equal(parsed.stdin.bytes, 262_144);
  assert.throws(() => encodeCanonicalProcessRequest(parsed), /request-too-large/u);

  const aboveStdinCap = structuredClone(atStdinCap);
  const oversizedStdin = Buffer.alloc(262_145, 0x5a);
  aboveStdinCap.stdin.base64 = oversizedStdin.toString("base64");
  aboveStdinCap.stdin.bytes = oversizedStdin.byteLength;
  aboveStdinCap.stdin.sha256 = sha256Hex(oversizedStdin);
  assert.throws(() => parseProcessRequest(aboveStdinCap), ContractError);
});

test("contract fault ladder refuses schema, byte, authority, path, and retry drift", async (context) => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const original = fixture.vectors[0].request;
  const cases: Array<[string, (candidate: any) => void]> = [
    ["extra top-level property", (candidate) => { candidate.extra = true; }],
    ["missing executable", (candidate) => { delete candidate.executable; }],
    ["version drift", (candidate) => { candidate.schema = "decadans.rm0032.process-request.v2"; }],
    ["retry authority", (candidate) => { candidate.retryAuthorized = true; }],
    ["consumer drift", (candidate) => { candidate.containment.consumer = "another-consumer"; }],
    ["relative executable", (candidate) => { candidate.executable.path = ".\\runner.exe"; }],
    ["empty argv", (candidate) => { candidate.argv = []; }],
    ["stdin hash drift", (candidate) => { candidate.stdin.sha256 = "b".repeat(64); }],
    ["environment inheritance", (candidate) => { candidate.environment.inherit = true; }],
    ["sensitive environment", (candidate) => {
      candidate.environment.allowlist = ["API_TOKEN"];
      candidate.environment.values = { API_TOKEN: "fixture" };
    }],
    ["limit drift", (candidate) => { candidate.limits.stdoutBytesMax -= 1; }],
    ["marker escape", (candidate) => { candidate.attemptMarker.path = "C:\\fixtures\\escape.marker"; }],
    ["evidence property drift", (candidate) => { candidate.evidence.overwrite = true; }],
  ];

  for (const [name, mutate] of cases) {
    await context.test(name, () => {
      const candidate = structuredClone(original);
      mutate(candidate);
      assert.throws(() => parseProcessRequest(candidate), ContractError);
    });
  }

  await context.test("BOM bytes", () => {
    const canonical = Buffer.from(canonicalizeJson(original), "utf8");
    assert.throws(() => parseCanonicalProcessRequestBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical])), ContractError);
  });
  await context.test("non-canonical whitespace", () => {
    assert.throws(() => parseCanonicalProcessRequestBytes(Buffer.from(`${canonicalizeJson(original)}\n`, "utf8")), ContractError);
  });
  await context.test("oversized request", () => {
    assert.throws(() => parseCanonicalProcessRequestBytes(Buffer.alloc(65_537, 0x20)), ContractError);
  });
});

test("shared TypeScript/Rust refusal vectors are rejected by the TypeScript contract", async (context) => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  for (const vector of fixture.refusalVectors) {
    await context.test(vector.name, () => {
      const candidate = structuredClone(fixture.vectors[0].request);
      applyFixtureMutation(candidate, vector);
      assert.throws(() => parseProcessRequest(candidate), ContractError);
    });
  }
});

test("tracer: raw byte evidence is hash-bound and terminal-known", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const evidence = parseProcessEvidence(fixture.vectors[0].evidence);

  assert.equal(evidence.schema, PROCESS_EVIDENCE_SCHEMA);
  assert.equal(evidence.terminalState, "known-exit");
  assert.equal(evidence.exitCodeKnown, true);
  assert.equal(evidence.processStartCount, 1);
  assert.equal(Buffer.from(evidence.standardOutput.base64, "base64").toString("utf8"), "tracer-bullet");
});

test("evidence fault ladder refuses hash, terminal, property, time, and envelope drift", async (context) => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const original = fixture.vectors[0].evidence;
  const cases: Array<[string, (candidate: any) => void]> = [
    ["extra property", (candidate) => { candidate.extra = true; }],
    ["stream hash drift", (candidate) => { candidate.standardOutput.sha256 = "b".repeat(64); }],
    ["stream cardinality drift", (candidate) => { delete candidate.standardError.complete; }],
    ["known exit without code", (candidate) => { candidate.exitCodeKnown = false; candidate.exitCode = null; }],
    ["retry claim", (candidate) => { candidate.retryPerformed = true; }],
    ["cleanup claim", (candidate) => { candidate.cleanupPerformed = true; }],
    ["reversed time", (candidate) => { candidate.finishedUtc = "2026-08-26T23:59:59.000Z"; }],
    ["process cardinality", (candidate) => { candidate.processStartCount = 2; }],
    ["completion mismatch", (candidate) => { candidate.outputComplete = false; }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, () => {
      const candidate = structuredClone(original);
      mutate(candidate);
      assert.throws(() => parseProcessEvidence(candidate), ContractError);
    });
  }
  await context.test("truncated JSON", () => {
    const bytes = Buffer.from(canonicalizeJson(original), "utf8");
    assert.throws(() => parseCanonicalProcessEvidenceBytes(bytes.subarray(0, bytes.length - 1)), ContractError);
  });
  await context.test("non-canonical JSON", () => {
    assert.throws(() => parseCanonicalProcessEvidenceBytes(Buffer.from(`${canonicalizeJson(original)}\n`, "utf8")), ContractError);
  });
});

function applyFixtureMutation(
  candidate: Record<string, any>,
  vector: { action: "add" | "remove" | "replace"; path: string[]; value?: unknown },
): void {
  assert.ok(vector.path.length > 0);
  let parent: Record<string, any> = candidate;
  for (const segment of vector.path.slice(0, -1)) {
    assert.ok(parent[segment] !== null && typeof parent[segment] === "object");
    parent = parent[segment];
  }
  const leaf = vector.path.at(-1)!;
  if (vector.action === "remove") {
    delete parent[leaf];
  } else {
    parent[leaf] = structuredClone(vector.value);
  }
}
