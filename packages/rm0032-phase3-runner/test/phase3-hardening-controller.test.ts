import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, win32 } from "node:path";
import { test } from "node:test";

import {
  CONTRACT_LIMITS,
  PROCESS_CONSUMER,
  PROCESS_EVIDENCE_SCHEMA,
  PROCESS_REQUEST_SCHEMA,
  canonicalizeJson,
  parseCanonicalProcessRequestBytes,
  sha256Hex,
  type ProcessRequest,
} from "../src/contract.ts";
import {
  PHASE3_HARDENING_CARRIER_SCHEMA,
  PHASE3_HARDENING_FIXED_CARRIER_PATH,
  runPhase3HardeningController,
  type Phase3ControllerBoundary,
} from "../src/phase3-hardening-controller.ts";

const PHASE2_RECEIPT = {
  path: "project/verification/rm-0032-dedicated-wsl-distro-acquisition-import-receipt.json",
  bytes: 43_404,
  sha256: "521EA28F0570E2FDF9C5EB0B9B6F20B1E7C075ED248CED1EAA75A514DE72DD32",
};

const PHASE3A_ARTIFACTS = ([
  ["packages/rm0032-phase3-runner/package.json", 937, "83E4249D86A8DE9FE0ED4BADADFE3390B7F1061B8BE8420D20E2F4DEA926557A"],
  ["packages/rm0032-phase3-runner/tsconfig.json", 390, "ED31D9571111AA2C0DF5E511A746F1A39CF5D2525D8E16BA46BAC0ED471584C7"],
  ["packages/rm0032-phase3-runner/src/contract.ts", 26_159, "BBF93E822CEA9C420FF2936632B8B4DDD23F2DD24753374A5579D0524C56C012"],
  ["packages/rm0032-phase3-runner/src/typescript-baseline.ts", 15_456, "9CEE2B073429F5A801AE2E218F8A98FE360346FD776DBC5405189491EA9F6713"],
  ["packages/rm0032-phase3-runner/src/rust-sidecar-adapter.ts", 19_968, "6350934B398142221293D71B30F129481436A69E6559F65B9D307224EEE5DDE5"],
  ["packages/rm0032-phase3-runner/test/contract.test.ts", 7_658, "12FC9F32D4EF3ED683751EDF77B0070B4FA8EF641D551740010EFED99BCEEE1A"],
  ["packages/rm0032-phase3-runner/test/faults.test.ts", 36_294, "3350FBA908C586D63D27BA5633858EF64CF0A3AFECFDC9E0416E6332877D2120"],
  ["packages/rm0032-phase3-runner/bench/process-boundary-benchmark.ts", 17_403, "D9C20A6043064B6A9A0BBD66D4F97FA52779AA8DC0126A6690C78EA05AEAC102"],
  ["packages/rm0032-phase3-runner/fixtures/process-boundary-v1.json", 4_660, "1F2A0B693ED0CF8E7E020F38A4BA93BD88FB26FEF7D55ACAF16AD983FD581EB7"],
  ["crates/rm0032-phase3-runner/Cargo.toml", 596, "5F9AD6A53A71692DD80EDAA205562D155DEF1BB33199AB7ED8229A1C2C93ABCA"],
  ["crates/rm0032-phase3-runner/Cargo.lock", 5_545, "07487081DB08293FB92CE23CC818D3B9E72531A5931A1FB8B8B6523E0BDEE103"],
  ["crates/rm0032-phase3-runner/src/main.rs", 62_900, "E9ECF46850418E441814E5CF95E307EEB46D952CC511DF6AA313C0A367BCCE02"],
  ["crates/rm0032-phase3-runner/tests/contract_vectors.rs", 5_237, "4100B8A5CF168F1E9789DC5BED0216762A988CB1BF2193604BFB8855C4848D64"],
] as const).map(([path, bytes, sha256]) => ({ path, bytes, sha256 }));

const REPOSITORY_ROOT_URL = new URL("../../../", import.meta.url);
const PHASE3A_RECEIPT_PATH = "project/verification/rm-0032-phase3-typed-runner-acceptance-receipt.json";
const PHASE3A_DECISION_PATH = "project/decisions/rm-0032-phase3-typed-native-runner-boundary.md";
const CONTROLLER_SOURCE_PATH = "packages/rm0032-phase3-runner/src/phase3-hardening-controller.ts";
const CONTROLLER_TEST_PATH = "packages/rm0032-phase3-runner/test/phase3-hardening-controller.test.ts";
const CONTROLLER_RECEIPT_PATH = "project/verification/rm-0032-phase3-controller-acceptance-receipt.json";
const FIXTURE_RUNNER_PATH = "C:\\fixture\\bin\\rm0032-phase3-runner.exe";
const GIT_PATH = "C:\\Program Files\\Git\\cmd\\git.exe";
const WSL_PATH = "C:\\Windows\\System32\\wsl.exe";
const ACCEPTED_PHASE3A_COMMIT = "d4b2b6eac03cdf3ae845afae5c96ad869b370ca4";
const INVENTED_BOUND_FILE_CONTENT = new Map<string, Buffer>([
  [FIXTURE_RUNNER_PATH, Buffer.from("invented accepted runner", "utf8")],
  [WSL_PATH, Buffer.from("invented wsl binary", "utf8")],
  [CONTROLLER_SOURCE_PATH, Buffer.from("invented accepted controller source", "utf8")],
  [CONTROLLER_TEST_PATH, Buffer.from("invented accepted controller test", "utf8")],
  [CONTROLLER_RECEIPT_PATH, Buffer.from("invented accepted controller receipt", "utf8")],
]);
const IMMUTABLE_REPOSITORY_BOUND_PATHS = new Set([
  PHASE2_RECEIPT.path,
  PHASE3A_RECEIPT_PATH,
  PHASE3A_DECISION_PATH,
  ...PHASE3A_ARTIFACTS.map((entry) => entry.path),
]);
const REPOSITORY_WORK_TREE = fileURLToPath(REPOSITORY_ROOT_URL);
const REPOSITORY_GIT_DIRECTORY = repositoryGitDirectory(REPOSITORY_WORK_TREE);
const IMMUTABLE_GIT_BLOB_MAX_BYTES = 4 * 1024 * 1024;
const IMMUTABLE_GIT_BLOB_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const IMMUTABLE_GIT_BLOB_TIMEOUT_MS = 10_000;
const SCRUBBED_IMMUTABLE_GIT_ENV = Object.freeze({
  SystemRoot: "C:\\Windows",
  WINDIR: "C:\\Windows",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "NUL",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
});
const immutableRepositoryBoundFileCache = new Map<string, Buffer>();
const immutableRepositoryBoundFileReadCounts = new Map<string, number>();
let immutableRepositoryBoundFileAggregateBytes = 0;

test("tracer: the public controller fails closed on malformed carrier bytes without touching a boundary", async () => {
  let boundaryCalls = 0;
  const boundary: Phase3ControllerBoundary = {
    async readBoundFile() {
      boundaryCalls += 1;
      throw new Error("unreachable read boundary");
    },
    async createNewDurableFile() {
      boundaryCalls += 1;
      throw new Error("unreachable write boundary");
    },
    monotonicMilliseconds() {
      boundaryCalls += 1;
      return 0;
    },
    async invokeAcceptedRustSidecar() {
      boundaryCalls += 1;
      throw new Error("unreachable sidecar boundary");
    },
  };

  const result = await runPhase3HardeningController(
    Buffer.from("not-json", "utf8"),
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    boundary,
  );

  assert.deepEqual(Object.keys(result).sort(), [
    "acceptedCommandCount",
    "attemptEvidenceBytes",
    "attemptEvidenceSha256",
    "carrierBytes",
    "carrierSha256",
    "cleanupAuthorized",
    "controllerKillCount",
    "outcome",
    "receiptCandidate",
    "retryAuthorized",
    "runnerTerminationRequestCount",
    "rustInvocationCount",
  ]);
  assert.equal(result.outcome, "terminal-refused");
  assert.equal(result.retryAuthorized, false);
  assert.equal(result.cleanupAuthorized, false);
  assert.equal(result.acceptedCommandCount, 0);
  assert.equal(result.rustInvocationCount, 0);
  assert.equal(result.controllerKillCount, 0);
  assert.equal(result.runnerTerminationRequestCount, 0);
  assert.equal(result.carrierBytes, 8);
  assert.match(result.carrierSha256, /^[0-9A-F]{64}$/u);
  assert.equal(result.attemptEvidenceBytes, 0);
  assert.equal(result.attemptEvidenceSha256, "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855");
  assert.equal("raw" in result.receiptCandidate, false);
  assert.equal(boundaryCalls, 0);
});

test("tracer: canonical carrier binds Phase 2, accepted Phase 3A, and future controller artifacts before process use", async () => {
  const fixture = makeControllerFixture();
  const drifted = structuredClone(fixture.carrier);
  drifted.predecessorBindings.phase3A.verdict = "UNREVIEWED";
  const driftedBytes = encodeCarrier(drifted);
  const driftBoundary = makeFakeBoundary(drifted, driftedBytes, "poison");

  const refused = await runPhase3HardeningController(
    driftedBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    driftBoundary.boundary,
  );
  assert.equal(refused.outcome, "terminal-refused");
  assert.equal(driftBoundary.writes.length, 0);
  assert.equal(driftBoundary.rustInvocations.length, 0);

  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "poison");
  const reached = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );
  assert.equal(reached.outcome, "terminal-unknown");
  assert.equal(reached.retryAuthorized, false);
  assert.equal(reached.cleanupAuthorized, false);
  assert.equal(reached.rustInvocationCount, 1);
  assert.equal(reached.acceptedCommandCount, 0);
  assert.equal(fake.rustInvocations.length, 1);
  assert.equal(fake.writes.length, 1);
  assert.equal(fake.writes[0]?.path, fixture.carrier.commands[0].requestPath);
  assert.ok(fake.reads.includes(PHASE2_RECEIPT.path));
  assert.ok(fake.reads.includes("project/verification/rm-0032-phase3-typed-runner-acceptance-receipt.json"));
  assert.ok(fake.reads.includes("packages/rm0032-phase3-runner/src/phase3-hardening-controller.ts"));
  const historicalPath = PHASE3A_ARTIFACTS[0]!.path;
  const immutableBytes = truthfulBoundFileContent(historicalPath);
  const divergentImmutableBytes = Buffer.concat([immutableBytes, Buffer.from("historical-fixture-regression", "utf8")]);
  const divergent = makeFakeBoundary(
    fixture.carrier,
    fixture.carrierBytes,
    "poison",
    new Map([[historicalPath, divergentImmutableBytes]]),
  );
  const divergentRefusal = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    divergent.boundary,
  );
  assert.equal(divergentRefusal.outcome, "terminal-refused");
  assert.equal(divergentRefusal.rustInvocationCount, 0);
  assert.equal(divergentRefusal.acceptedCommandCount, 0);
  assert.equal(divergent.writes.length, 0, "divergent immutable fixture refuses before a durable sidecar write");
  assert.equal(divergent.rustInvocations.length, 0, "divergent immutable fixture refuses before accepted command dispatch");
  assert.ok(divergent.reads.includes(historicalPath), "divergent immutable fixture reaches the real controller read seam");
  assert.deepEqual(binding(historicalPath, immutableBytes), PHASE3A_ARTIFACTS[0]);
  assert.equal(immutableRepositoryBoundFileCache.size, IMMUTABLE_REPOSITORY_BOUND_PATHS.size);
  assert.ok(immutableRepositoryBoundFileAggregateBytes <= IMMUTABLE_GIT_BLOB_CACHE_MAX_BYTES, "immutable Phase3A Git cache aggregate is bounded");
  for (const path of IMMUTABLE_REPOSITORY_BOUND_PATHS) {
    assert.equal(immutableRepositoryBoundFileReadCounts.get(path), 1, `immutable Phase3A Git blob read exactly once: ${path}`);
  }
});

test("tracer: one invented WSL command follows five Git guards through one request and one Rust call per command", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");

  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );

  assert.equal(result.outcome, "known-clear");
  assert.equal(result.acceptedCommandCount, 6);
  assert.equal(result.rustInvocationCount, 6);
  assert.equal(result.runnerTerminationRequestCount, 0);
  assert.equal(result.controllerKillCount, 0);
  assert.equal(result.retryAuthorized, false);
  assert.equal(result.cleanupAuthorized, false);
  assert.equal(fake.rustInvocations.length, 6);
  assert.equal(fake.writes.length, 7);
  assert.equal(fake.writes[5]?.path, fixture.carrier.authorization.attemptEvidencePath);
  assert.equal(fake.writes[6]?.path, fixture.carrier.commands[5].requestPath);
  assert.ok(result.attemptEvidenceBytes > 0);
  assert.match(result.attemptEvidenceSha256, /^[0-9A-F]{64}$/u);
  const receiptText = JSON.stringify(result.receiptCandidate);
  assert.doesNotMatch(receiptText, /base64|rawProcessBodies":true|WSL version/u);
});

test("tracer: a known nonzero Git guard stops before every later request and WSL invocation", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "known-nonzero-at-2");

  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );

  assert.equal(result.outcome, "terminal-known-failure");
  assert.equal(result.acceptedCommandCount, 2);
  assert.equal(result.rustInvocationCount, 3);
  assert.equal(fake.rustInvocations.length, 3);
  assert.equal(fake.writes.length, 3);
  assert.equal(result.attemptEvidenceBytes, 0);
  assert.equal(result.retryAuthorized, false);
});

test("tracer: an unknown durable command result stops with no replay and no later command", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "unknown-at-2");

  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );

  assert.equal(result.outcome, "terminal-unknown", JSON.stringify(result.receiptCandidate));
  assert.equal(result.acceptedCommandCount, 2);
  assert.equal(result.rustInvocationCount, 3);
  assert.equal(fake.rustInvocations.length, 3);
  assert.equal(fake.writes.length, 3);
  assert.equal(result.retryAuthorized, false);
  assert.equal(result.cleanupAuthorized, false);
});

test("carrier and predecessor hostile ladder refuses property, version, hash, verdict, and cardinality drift before writes", async (context) => {
  const cases: Array<[string, (carrier: any) => void]> = [
    ["extra top-level property", (carrier) => { carrier.unexpected = true; }],
    ["carrier schema drift", (carrier) => { carrier.schema = "decadans.rm0032.phase3-hardening-carrier.v2"; }],
    ["Phase 2 receipt hash drift", (carrier) => { carrier.predecessorBindings.phase2Receipt.sha256 = "A".repeat(64); }],
    ["Phase 3A commit drift", (carrier) => { carrier.predecessorBindings.phase3A.commit = "f".repeat(40); }],
    ["Phase 3A receipt hash drift", (carrier) => { carrier.predecessorBindings.phase3A.receipt.sha256 = "A".repeat(64); }],
    ["Phase 3A verdict drift", (carrier) => { carrier.predecessorBindings.phase3A.verdict = "UNREVIEWED"; }],
    ["Phase 3A artifact missing", (carrier) => { carrier.predecessorBindings.phase3A.artifactBindings.pop(); }],
    ["controller commit drift", (carrier) => { carrier.controllerBindings.commit = "f".repeat(40); }],
    ["controller tree drift", (carrier) => { carrier.controllerBindings.tree = "f".repeat(40); }],
    ["controller verdict drift", (carrier) => { carrier.controllerBindings.verdict = "UNREVIEWED"; }],
    ["controller receipt extra property", (carrier) => { carrier.controllerBindings.receipt.extra = true; }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const fixture = makeControllerFixture();
      mutate(fixture.carrier);
      const bytes = encodeCarrier(fixture.carrier);
      const fake = makeFakeBoundary(fixture.carrier, bytes, "success");
      const result = await runPhase3HardeningController(bytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
      assert.equal(result.outcome, "terminal-refused");
      assert.equal(fake.writes.length, 0);
      assert.equal(fake.rustInvocations.length, 0);
    });
  }
});

test("carrier byte envelope refuses BOM, duplicate keys, whitespace, oversize, and alternate fixed path before boundary use", async (context) => {
  const fixture = makeControllerFixture();
  const canonical = fixture.carrierBytes.toString("utf8");
  const cases: Array<[string, Buffer, string]> = [
    ["UTF-8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture.carrierBytes]), PHASE3_HARDENING_FIXED_CARRIER_PATH],
    ["duplicate key", Buffer.from(canonical.replace(
      `"schema":"${PHASE3_HARDENING_CARRIER_SCHEMA}"`,
      `"schema":"${PHASE3_HARDENING_CARRIER_SCHEMA}","schema":"${PHASE3_HARDENING_CARRIER_SCHEMA}"`,
    ), "utf8"), PHASE3_HARDENING_FIXED_CARRIER_PATH],
    ["trailing whitespace", Buffer.from(`${canonical}\n`, "utf8"), PHASE3_HARDENING_FIXED_CARRIER_PATH],
    ["oversized", Buffer.alloc(65_537, 0x20), PHASE3_HARDENING_FIXED_CARRIER_PATH],
    ["alternate fixed path", fixture.carrierBytes, "project/verification/other.json"],
  ];
  for (const [name, bytes, path] of cases) {
    await context.test(name, async () => {
      let calls = 0;
      const boundary: Phase3ControllerBoundary = {
        async readBoundFile() { calls += 1; throw new Error("unreachable"); },
        async createNewDurableFile() { calls += 1; throw new Error("unreachable"); },
        monotonicMilliseconds() { calls += 1; return 0; },
        async invokeAcceptedRustSidecar() { calls += 1; throw new Error("unreachable"); },
      };
      const result = await runPhase3HardeningController(bytes, path, boundary);
      assert.equal(result.outcome, "terminal-refused");
      assert.equal(calls, 0);
    });
  }
});

test("tracer: dirty Git evidence stops before authorization marker and every later command", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "dirty-git-status");
  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );
  assert.equal(result.outcome, "terminal-unknown", JSON.stringify(result.receiptCandidate));
  assert.equal(result.acceptedCommandCount, 0);
  assert.equal(result.rustInvocationCount, 1);
  assert.equal(fake.rustInvocations.length, 1);
  assert.equal(fake.writes.length, 1);
  assert.equal(result.attemptEvidenceBytes, 0);
});

test("WSL and Git argv hostile ladder refuses bare, altered, reordered, cross-distro, shell, and metacharacter commands", async (context) => {
  const cases: Array<[string, (carrier: any) => void]> = [
    ["bare WSL", (carrier) => { carrier.commands[5].request.argv = []; }],
    ["altered allowed management command", (carrier) => { carrier.commands[5].request.argv = ["--status"]; }],
    ["reordered Git guards", (carrier) => { [carrier.commands[0], carrier.commands[1]] = [carrier.commands[1], carrier.commands[0]]; }],
    ["docker terminate", (carrier) => { carrier.commands[5].request.argv = ["--terminate", "docker-desktop"]; }],
    ["forbidden import", (carrier) => { carrier.commands[5].request.argv = ["--import", "DecadansNeurobro", "C:\\x", "C:\\y"]; }],
    ["wrong guest distro", (carrier) => {
      carrier.commands[5].role = "wsl-guest";
      carrier.commands[5].decoder = "utf-8-no-bom-strict";
      carrier.commands[5].semanticClass = "guest-identity-probe";
      carrier.commands[5].request.argv = ["--distribution", "docker-desktop", "--user", "root", "--exec", "/usr/bin/systemctl", "--version"];
    }],
    ["wrong guest user", (carrier) => {
      carrier.commands[5].role = "wsl-guest";
      carrier.commands[5].decoder = "utf-8-no-bom-strict";
      carrier.commands[5].semanticClass = "guest-identity-probe";
      carrier.commands[5].request.argv = ["--distribution", "DecadansNeurobro", "--user", "docker", "--exec", "/usr/bin/systemctl", "--version"];
    }],
    ["guest without internal timeout", (carrier) => {
      carrier.commands[5].role = "wsl-guest";
      carrier.commands[5].decoder = "utf-8-no-bom-strict";
      carrier.commands[5].semanticClass = "guest-identity-probe";
      carrier.commands[5].request.argv = ["--distribution", "DecadansNeurobro", "--user", "root", "--exec", "/usr/bin/systemctl", "show"];
    }],
    ["guest shell", (carrier) => {
      carrier.guestExecutables = ["/bin/sh", "/usr/bin/systemctl"];
      carrier.commands[5].role = "wsl-guest";
      carrier.commands[5].decoder = "utf-8-no-bom-strict";
      carrier.commands[5].semanticClass = "guest-identity-probe";
      carrier.commands[5].request.argv = ["--distribution", "DecadansNeurobro", "--user", "root", "--exec", "/bin/sh", "-c", "true"];
    }],
    ["guest metacharacter", (carrier) => {
      carrier.commands[5].role = "wsl-guest";
      carrier.commands[5].decoder = "utf-8-no-bom-strict";
      carrier.commands[5].semanticClass = "guest-identity-probe";
      carrier.commands[5].request.argv = ["--distribution", "DecadansNeurobro", "--user", "root", "--exec", "/usr/bin/systemctl", "show;id"];
    }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const fixture = makeControllerFixture();
      mutate(fixture.carrier);
      const bytes = encodeCarrier(fixture.carrier);
      const fake = makeFakeBoundary(fixture.carrier, bytes, "success");
      const result = await runPhase3HardeningController(bytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
      assert.equal(result.outcome, "terminal-refused");
      assert.equal(fake.writes.length, 0);
      assert.equal(fake.rustInvocations.length, 0);
    });
  }
});

test("command, stdin, decoded-stream, and declared deadline caps refuse before writes", async (context) => {
  const cases: Array<[string, (carrier: any) => void]> = [
    ["aggregate deadline above maximum", (carrier) => { carrier.policy.aggregateDeadlineMs = 420_001; }],
    ["command count above maximum", (carrier) => {
      while (carrier.commands.length <= 48) carrier.commands.push(structuredClone(carrier.commands[5]));
    }],
    ["artifact stdin above per-command cap", (carrier) => {
      const bytes = Buffer.alloc(16_385, 0x41);
      carrier.commands[5].request.stdin = {
        encoding: "base64",
        base64: bytes.toString("base64"),
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
      };
    }],
    ["decoded output above cap", (carrier) => { carrier.commands[5].expected.stdoutBytes = 65_537; }],
    ["declared outer interval exceeds aggregate", (carrier) => { carrier.policy.aggregateDeadlineMs = 5_999; }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const fixture = makeControllerFixture();
      mutate(fixture.carrier);
      const bytes = encodeCarrier(fixture.carrier);
      const fake = makeFakeBoundary(fixture.carrier, bytes, "success");
      const result = await runPhase3HardeningController(bytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
      assert.equal(result.outcome, "terminal-refused");
      assert.equal(fake.writes.length, 0);
      assert.equal(fake.rustInvocations.length, 0);
    });
  }
});

test("tracer: insufficient monotonic remaining interval refuses before the first request write", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "deadline-before-first");
  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );
  assert.equal(result.outcome, "terminal-refused");
  assert.equal(result.rustInvocationCount, 0);
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.rustInvocations.length, 0);
});

test("an initial monotonic clock exception is terminal-refused without rejecting the public entry", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
  let clockReads = 0;
  fake.boundary.monotonicMilliseconds = () => {
    clockReads += 1;
    throw new Error("invented initial monotonic clock failure");
  };
  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );
  assert.equal(result.outcome, "terminal-refused");
  assert.equal(clockReads, 1);
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.rustInvocations.length, 0);
});

test("a monotonic clock exception after one completed command is terminal-unknown with no later action", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
  const originalClock = fake.boundary.monotonicMilliseconds.bind(fake.boundary);
  let clockReads = 0;
  fake.boundary.monotonicMilliseconds = () => {
    clockReads += 1;
    if (clockReads === 3) throw new Error("invented post-effect monotonic clock failure");
    return originalClock();
  };
  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );
  assert.equal(result.outcome, "terminal-unknown");
  assert.equal(result.acceptedCommandCount, 1);
  assert.equal(result.rustInvocationCount, 1);
  assert.equal(clockReads, 3);
  assert.equal(fake.writes.length, 1);
  assert.equal(fake.rustInvocations.length, 1);
});

test("a regressing later monotonic reading is terminal-unknown after the first completed command", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
  const readings = [1_000, 50_000, 1_001, 1_002, 1_003, 1_004, 1_005];
  let clockIndex = 0;
  fake.boundary.monotonicMilliseconds = () => {
    const reading = readings[clockIndex];
    assert.notEqual(reading, undefined, "unexpected extra monotonic read");
    clockIndex += 1;
    return reading!;
  };
  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );
  assert.equal(result.outcome, "terminal-unknown");
  assert.equal(result.acceptedCommandCount, 1);
  assert.equal(result.rustInvocationCount, 1);
  assert.equal(clockIndex, 3);
  assert.equal(fake.writes.length, 1);
  assert.equal(fake.rustInvocations.length, 1);
});

test("equal monotonic readings remain valid because the clock contract is nondecreasing", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
  let clockReads = 0;
  fake.boundary.monotonicMilliseconds = () => {
    clockReads += 1;
    return 1_000;
  };
  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );
  assert.equal(result.outcome, "known-clear");
  assert.equal(result.acceptedCommandCount, 6);
  assert.equal(result.rustInvocationCount, 6);
  assert.equal(clockReads, 7);
  assert.equal(fake.writes.length, 7);
  assert.equal(fake.rustInvocations.length, 6);
});

test("tracer: an existing carrier-level attempt marker consumes no new command authority", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "attempt-marker-collision");
  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );
  assert.equal(result.outcome, "terminal-refused");
  assert.equal(result.acceptedCommandCount, 5);
  assert.equal(result.rustInvocationCount, 5);
  assert.equal(fake.rustInvocations.length, 5);
  assert.equal(fake.writes.length, 6);
  assert.equal(fake.writes[5]?.path, fixture.carrier.authorization.attemptEvidencePath);
  assert.equal(result.attemptEvidenceBytes, 0);
});

test("bound-file hostile ladder refuses missing, extra, hash, path, resolved-path, and reparse drift before writes", async (context) => {
  const cases: Array<[string, (observation: any) => void]> = [
    ["missing property", (observation) => { delete observation.resolvedPath; }],
    ["extra property", (observation) => { observation.unexpected = true; }],
    ["hash drift", (observation) => { observation.sha256 = "A".repeat(64); }],
    ["path drift", (observation) => { observation.path = "packages/rm0032-phase3-runner/src/other.ts"; }],
    ["resolved path drift", (observation) => { observation.resolvedPath = "C:\\fixture\\repo\\other.ts"; }],
    ["reparse drift", (observation) => { observation.isReparsePoint = true; }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const fixture = makeControllerFixture();
      const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
      const originalRead = fake.boundary.readBoundFile.bind(fake.boundary);
      fake.boundary.readBoundFile = async (path) => {
        const observation: any = await originalRead(path);
        if (path === fixture.carrier.controllerBindings.source.path) mutate(observation);
        return observation;
      };
      const result = await runPhase3HardeningController(
        fixture.carrierBytes,
        PHASE3_HARDENING_FIXED_CARRIER_PATH,
        fake.boundary,
      );
      assert.equal(result.outcome, "terminal-refused");
      assert.equal(fake.writes.length, 0);
      assert.equal(fake.rustInvocations.length, 0);
    });
  }
});

test("the future controller receipt hash must match its exact bound-file observation before writes", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
  const originalRead = fake.boundary.readBoundFile.bind(fake.boundary);
  fake.boundary.readBoundFile = async (path) => {
    const observation: any = await originalRead(path);
    if (path === fixture.carrier.controllerBindings.receipt.path) observation.sha256 = "A".repeat(64);
    return observation;
  };
  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );
  assert.equal(result.outcome, "terminal-refused");
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.rustInvocations.length, 0);
});

test("bound-file content is independently hashed even when same-length metadata is spoofed", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
  const originalRead = fake.boundary.readBoundFile.bind(fake.boundary);
  fake.boundary.readBoundFile = async (path) => {
    const observation = await originalRead(path);
    if (path !== fixture.carrier.controllerBindings.source.path) return observation;
    const corrupted = Buffer.from(observation.content);
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    return { ...observation, content: corrupted };
  };
  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );
  assert.equal(result.outcome, "terminal-refused");
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.rustInvocations.length, 0);
});

test("Git parent, tree, delta, mode, blob, and carrier-byte drift stops before the marker", async (context) => {
  const faults: Array<[string, number, Buffer]> = [
    ["wrong parent", 1, Buffer.from(`${"c".repeat(40)}\n${"d".repeat(40)}\n${"f".repeat(40)}\n`, "utf8")],
    ["wrong tree", 1, Buffer.from(`${"c".repeat(40)}\n${"f".repeat(40)}\n${"a".repeat(40)}\n`, "utf8")],
    ["extra delta", 2, Buffer.from(`${PHASE3_HARDENING_FIXED_CARRIER_PATH}\nextra.txt\n`, "utf8")],
    ["wrong mode", 3, Buffer.from(`100755 ${"e".repeat(40)} 0\t${PHASE3_HARDENING_FIXED_CARRIER_PATH}\n`, "utf8")],
    ["wrong blob", 3, Buffer.from(`100644 ${"f".repeat(40)} 0\t${PHASE3_HARDENING_FIXED_CARRIER_PATH}\n`, "utf8")],
    ["carrier bytes", 4, Buffer.from("different carrier bytes", "utf8")],
  ];
  for (const [name, ordinal, output] of faults) {
    await context.test(name, async () => {
      const fixture = makeControllerFixture();
      const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
      overrideSidecarOutput(fake, ordinal, output);
      const result = await runPhase3HardeningController(
        fixture.carrierBytes,
        PHASE3_HARDENING_FIXED_CARRIER_PATH,
        fake.boundary,
      );
      assert.equal(result.outcome, "terminal-unknown");
      assert.equal(result.rustInvocationCount, ordinal + 1);
      assert.equal(result.attemptEvidenceBytes, 0);
      assert.equal(fake.rustInvocations.length, ordinal + 1);
    });
  }
});

test("UTF-8 and UTF-16 decoder ladder rejects BOM, malformed units, replacement, NUL, and unexpected stderr after evidence", async (context) => {
  const faults: Array<[string, number, Buffer]> = [
    ["UTF-8 BOM", 0, Buffer.from([0xef, 0xbb, 0xbf])],
    ["malformed UTF-8", 0, Buffer.from([0xc3, 0x28])],
    ["UTF-8 replacement", 0, Buffer.from("\uFFFD", "utf8")],
    ["UTF-8 NUL", 0, Buffer.from([0x00])],
    ["UTF-16 BOM", 5, Buffer.from([0xff, 0xfe, 0x41, 0x00])],
    ["odd UTF-16", 5, Buffer.from([0x41])],
    ["malformed UTF-16 surrogate", 5, Buffer.from([0x00, 0xd8, 0x41, 0x00])],
    ["UTF-16 replacement", 5, Buffer.from([0xfd, 0xff])],
    ["UTF-16 NUL", 5, Buffer.from([0x00, 0x00])],
  ];
  for (const [name, ordinal, output] of faults) {
    await context.test(name, async () => {
      const fixture = makeControllerFixture();
      fixture.carrier.commands[ordinal].expected = rawExpectation(output, Buffer.alloc(0), 0);
      const bytes = encodeCarrier(fixture.carrier);
      const fake = makeFakeBoundary(fixture.carrier, bytes, "success");
      overrideSidecarOutput(fake, ordinal, output);
      const result = await runPhase3HardeningController(bytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
      assert.equal(result.outcome, "terminal-unknown");
      assert.equal(result.rustInvocationCount, ordinal + 1);
      assert.equal(fake.rustInvocations.length, ordinal + 1);
    });
  }

  await context.test("unexpected stderr", async () => {
    const fixture = makeControllerFixture();
    const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
    overrideSidecarOutput(fake, 0, Buffer.alloc(0), Buffer.from("unexpected", "utf8"));
    const result = await runPhase3HardeningController(
      fixture.carrierBytes,
      PHASE3_HARDENING_FIXED_CARRIER_PATH,
      fake.boundary,
    );
    assert.equal(result.outcome, "terminal-unknown");
    assert.equal(result.rustInvocationCount, 1);
  });
});

test("silent mutator requires empty raw streams and remains a carrier-bound one-call command", async () => {
  const fixture = makeControllerFixture();
  fixture.carrier.commands[5].request.argv = ["--terminate", "DecadansNeurobro"];
  fixture.carrier.commands[5].decoder = "silent-mutator";
  fixture.carrier.commands[5].semanticClass = "wsl-target-terminated";
  fixture.carrier.commands[5].expected = rawExpectation(Buffer.alloc(0), Buffer.alloc(0), 0);
  const bytes = encodeCarrier(fixture.carrier);
  const fake = makeFakeBoundary(fixture.carrier, bytes, "success");
  overrideSidecarOutput(fake, 5, Buffer.alloc(0));
  const result = await runPhase3HardeningController(bytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
  assert.equal(result.outcome, "known-clear");
  assert.equal(result.rustInvocationCount, 6);
  assert.equal(result.acceptedCommandCount, 6);
});

test("carrier-approved guest executable runs only behind the exact five-second internal timeout grammar", async () => {
  const fixture = makeControllerFixture();
  const output = Buffer.from("fixture-identity-clear\n", "utf8");
  fixture.carrier.guestExecutables = ["/usr/bin/systemctl", "/usr/bin/timeout"];
  fixture.carrier.commands[5].role = "wsl-guest";
  fixture.carrier.commands[5].decoder = "utf-8-no-bom-strict";
  fixture.carrier.commands[5].semanticClass = "guest-identity-probe";
  fixture.carrier.commands[5].request.argv = [
    "--distribution", "DecadansNeurobro", "--user", "root", "--exec",
    "/usr/bin/timeout", "--signal=TERM", "5s", "/usr/bin/systemctl", "show", "--property=Version",
  ];
  fixture.carrier.commands[5].expected = rawExpectation(output, Buffer.alloc(0), 0);
  const bytes = encodeCarrier(fixture.carrier);
  const fake = makeFakeBoundary(fixture.carrier, bytes, "success");
  overrideSidecarOutput(fake, 5, output);
  const result = await runPhase3HardeningController(bytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
  assert.equal(result.outcome, "known-clear");
  assert.equal(result.acceptedCommandCount, 6);
  assert.equal(fake.rustInvocations.length, 6);
});

test("authorization and request path hostiles refuse UUID, retry, cleanup, phase advance, collision, and escape before writes", async (context) => {
  const cases: Array<[string, (carrier: any) => void]> = [
    ["lowercase authorization UUID", (carrier) => { carrier.authorization.id = carrier.authorization.id.toLowerCase(); }],
    ["retry authority", (carrier) => { carrier.authorization.retryAuthorized = true; }],
    ["cleanup authority", (carrier) => { carrier.authorization.cleanupAuthorized = true; }],
    ["phase advance authority", (carrier) => { carrier.authorization.phaseAdvanceAuthorized = true; }],
    ["Phase 4 authority", (carrier) => { carrier.authorization.phase4Authorized = true; }],
    ["request and evidence collision", (carrier) => { carrier.commands[0].requestPath = carrier.commands[0].request.evidence.path; }],
    ["attempt and evidence collision", (carrier) => { carrier.commands[0].request.attemptMarker.path = carrier.commands[0].request.evidence.path; }],
    ["request escape", (carrier) => { carrier.commands[0].requestPath = "C:\\outside\\request.json"; }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const fixture = makeControllerFixture();
      mutate(fixture.carrier);
      const bytes = encodeCarrier(fixture.carrier);
      const fake = makeFakeBoundary(fixture.carrier, bytes, "success");
      const result = await runPhase3HardeningController(bytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
      assert.equal(result.outcome, "terminal-refused");
      assert.equal(fake.writes.length, 0);
      assert.equal(fake.rustInvocations.length, 0);
    });
  }
});

test("a request CreateNew exception after the boundary records the write is terminal-unknown without Rust or later action", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
  const originalWrite = fake.boundary.createNewDurableFile.bind(fake.boundary);
  fake.boundary.createNewDurableFile = async (path, bytes) => {
    await originalWrite(path, bytes);
    throw new Error("invented request CreateNew disposition uncertainty");
  };
  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );
  assert.equal(result.outcome, "terminal-unknown");
  assert.equal(result.acceptedCommandCount, 0);
  assert.equal(result.rustInvocationCount, 0);
  assert.equal(fake.writes.length, 1);
  assert.equal(fake.rustInvocations.length, 0);
});

test("write, marker, sidecar, and evidence fault ladder remains one-shot with no later invocation", async (context) => {
  await context.test("request CreateNew collision", async () => {
    const fixture = makeControllerFixture();
    const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
    const original = fake.boundary.createNewDurableFile.bind(fake.boundary);
    fake.boundary.createNewDurableFile = async (path, bytes) => ({ ...(await original(path, bytes)), created: false });
    const result = await runPhase3HardeningController(fixture.carrierBytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
    assert.equal(result.outcome, "terminal-refused");
    assert.equal(fake.writes.length, 1);
    assert.equal(fake.rustInvocations.length, 0);
  });

  await context.test("request readback drift", async () => {
    const fixture = makeControllerFixture();
    const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
    const original = fake.boundary.createNewDurableFile.bind(fake.boundary);
    fake.boundary.createNewDurableFile = async (path, bytes) => ({
      ...(await original(path, bytes)),
      content: Buffer.from("drift", "utf8"),
    });
    const result = await runPhase3HardeningController(fixture.carrierBytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
    assert.equal(result.outcome, "terminal-unknown");
    assert.equal(fake.writes.length, 1);
    assert.equal(fake.rustInvocations.length, 0);
  });

  await context.test("request durability drift", async () => {
    const fixture = makeControllerFixture();
    const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
    const original = fake.boundary.createNewDurableFile.bind(fake.boundary);
    fake.boundary.createNewDurableFile = async (path, bytes) => ({
      ...(await original(path, bytes)),
      durableFlushCompleted: false,
    });
    const result = await runPhase3HardeningController(fixture.carrierBytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
    assert.equal(result.outcome, "terminal-unknown");
    assert.equal(fake.writes.length, 1);
    assert.equal(fake.rustInvocations.length, 0);
  });

  await context.test("attempt evidence write uncertainty", async () => {
    const fixture = makeControllerFixture();
    const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
    const original = fake.boundary.createNewDurableFile.bind(fake.boundary);
    fake.boundary.createNewDurableFile = async (path, bytes) => {
      const observation = await original(path, bytes);
      if (path === fixture.carrier.authorization.attemptEvidencePath) throw new Error("invented post-write uncertainty");
      return observation;
    };
    const result = await runPhase3HardeningController(fixture.carrierBytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
    assert.equal(result.outcome, "terminal-unknown");
    assert.equal(result.rustInvocationCount, 5);
    assert.equal(fake.writes.length, 6);
    assert.equal(fake.rustInvocations.length, 5);
  });

  await context.test("sidecar throw after marker", async () => {
    const fixture = makeControllerFixture();
    const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
    throwSidecarAt(fake, 5, 1);
    const result = await runPhase3HardeningController(fixture.carrierBytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
    assert.equal(result.outcome, "terminal-unknown");
    assert.equal(result.rustInvocationCount, 6);
    assert.equal(result.runnerTerminationRequestCount, 1);
    assert.ok(result.attemptEvidenceBytes > 0);
    assert.equal(fake.rustInvocations.length, 6);
  });

  await context.test("durable evidence binding corruption", async () => {
    const fixture = makeControllerFixture();
    const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
    corruptSidecarEvidenceAt(fake, 2);
    const result = await runPhase3HardeningController(fixture.carrierBytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
    assert.equal(result.outcome, "terminal-unknown");
    assert.equal(result.rustInvocationCount, 3);
    assert.equal(fake.rustInvocations.length, 3);
    assert.equal(result.attemptEvidenceBytes, 0);
  });
});

test("tracer: a violating runner termination count is reported honestly and never replayed", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
  throwSidecarAt(fake, 0, 2);
  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );
  assert.equal(result.outcome, "terminal-unknown");
  assert.equal(result.rustInvocationCount, 1);
  assert.equal(result.runnerTerminationRequestCount, 2);
  assert.equal(fake.rustInvocations.length, 1);
  assert.equal(result.retryAuthorized, false);
});

test("deadline and output-cap terminal evidence remains unknown and stops before every later command", async (context) => {
  for (const terminalState of ["deadline-killed", "stdout-cap-killed", "stderr-cap-killed"] as const) {
    await context.test(terminalState, async () => {
      const fixture = makeControllerFixture();
      const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
      overrideSidecarTerminalAt(fake, 2, terminalState);
      const result = await runPhase3HardeningController(
        fixture.carrierBytes,
        PHASE3_HARDENING_FIXED_CARRIER_PATH,
        fake.boundary,
      );
      assert.equal(result.outcome, "terminal-unknown");
      assert.equal(result.acceptedCommandCount, 2);
      assert.equal(result.rustInvocationCount, 3);
      assert.equal(fake.rustInvocations.length, 3);
      assert.equal(result.retryAuthorized, false);
    });
  }
});

test("receipt candidate has an exact raw-free property set and grants no live, lifecycle, retry, cleanup, or Phase 4 authority", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );
  const receipt: any = result.receiptCandidate;
  assert.deepEqual(Object.keys(receipt).sort(), [
    "attemptEvidence", "carrier", "cleanupAuthorized", "commands", "counts", "lifecycleAdvanced",
    "liveAuthorityGranted", "outcome", "phase", "phase4AuthorityGranted", "rawProcessBodies",
    "retryAuthorized", "schema", "semanticClass",
  ]);
  assert.equal(receipt.rawProcessBodies, false);
  assert.equal(receipt.retryAuthorized, false);
  assert.equal(receipt.cleanupAuthorized, false);
  assert.equal(receipt.liveAuthorityGranted, false);
  assert.equal(receipt.lifecycleAdvanced, false);
  assert.equal(receipt.phase4AuthorityGranted, false);
  assert.equal(receipt.commands.length, 6);
  for (const command of receipt.commands) {
    assert.equal("base64" in command, false);
    assert.equal("argv" in command, false);
    assert.equal("requestPath" in command, false);
    assert.equal("executable" in command, false);
  }
  assert.doesNotMatch(JSON.stringify(receipt), /credential|telegram|session|runtimePointer|base64/u);
});

function makeControllerFixture() {
  const repositoryRoot = "C:\\fixture\\repo";
  const operationRoot = "C:\\fixture\\phase3";
  const controllerCommit = "a".repeat(40);
  const controllerTree = "b".repeat(40);
  const carrierCommit = "c".repeat(40);
  const carrierTree = "d".repeat(40);
  const carrierBlobId = "e".repeat(40);
  const runner = binding(FIXTURE_RUNNER_PATH, truthfulBoundFileContent(FIXTURE_RUNNER_PATH));
  const git = binding(GIT_PATH, truthfulBoundFileContent(GIT_PATH));
  const wsl = binding(WSL_PATH, truthfulBoundFileContent(WSL_PATH));
  const controllerBindings = {
    commit: controllerCommit,
    tree: controllerTree,
    verdict: "WHOLE_PHASE3_CONTROLLER_BOUNDARY_CLEAR",
    source: binding(CONTROLLER_SOURCE_PATH, truthfulBoundFileContent(CONTROLLER_SOURCE_PATH)),
    test: binding(CONTROLLER_TEST_PATH, truthfulBoundFileContent(CONTROLLER_TEST_PATH)),
    receipt: {
      ...binding(CONTROLLER_RECEIPT_PATH, truthfulBoundFileContent(CONTROLLER_RECEIPT_PATH)),
      outcome: "candidate-clear/repo-only-controller-boundary",
      selfAcceptanceClaimed: false,
    },
  };
  const authorizationId = "A1111111-1111-4111-8111-111111111111";
  const attemptEvidencePath = `${operationRoot}\\phase3-hardening-controller.attempt.json`;
  const gitArgv = [
    ["--no-pager", "-C", repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all"],
    ["--no-pager", "-C", repositoryRoot, "rev-parse", "HEAD^{commit}", "HEAD^{tree}", "HEAD^"],
    ["--no-pager", "-C", repositoryRoot, "diff", "--name-only", "--no-renames", `${controllerCommit}..HEAD`, "--"],
    ["--no-pager", "-C", repositoryRoot, "ls-files", "--stage", "--full-name", "--", PHASE3_HARDENING_FIXED_CARRIER_PATH],
    ["--no-pager", "-C", repositoryRoot, "show", `HEAD:${PHASE3_HARDENING_FIXED_CARRIER_PATH}`],
  ];
  const gitOutputs = [
    Buffer.alloc(0),
    Buffer.from(`${carrierCommit}\n${carrierTree}\n${controllerCommit}\n`, "utf8"),
    Buffer.from(`${PHASE3_HARDENING_FIXED_CARRIER_PATH}\n`, "utf8"),
    Buffer.from(`100644 ${carrierBlobId} 0\t${PHASE3_HARDENING_FIXED_CARRIER_PATH}\n`, "utf8"),
    Buffer.alloc(0),
  ];
  const commands = gitArgv.map((argv, index) => makeCommand({
    ordinal: index,
    role: "git-guard",
    decoder: index === 4 ? "raw-hash-only" : "utf-8-no-bom-strict",
    semanticClass: ["git-status-clean", "git-revision-binding", "git-carrier-only-delta", "git-stage0-carrier", "git-carrier-blob"][index]!,
    operationRoot,
    authorizationId: operationUuid(index),
    executable: git,
    argv,
    stdout: gitOutputs[index]!,
  }));
  commands.push(makeCommand({
    ordinal: 5,
    role: "wsl-management",
    decoder: "utf-16le-no-bom-strict",
    semanticClass: "wsl-version-observed",
    operationRoot,
    authorizationId: operationUuid(5),
    executable: wsl,
    argv: ["--version"],
    stdout: Buffer.from("WSL version: 2.4.0\r\n", "utf16le"),
  }));

  const carrier: any = {
    schema: PHASE3_HARDENING_CARRIER_SCHEMA,
    phase: {
      id: "phase-3-wsl-hardening-identity-and-resource-verification",
      status: "pending",
      subSlice: "phase3b-live-guest-hardening",
      autoContinue: false,
      phase4Available: false,
    },
    fixedCarrierPath: PHASE3_HARDENING_FIXED_CARRIER_PATH,
    predecessorBindings: {
      phase2Receipt: { ...PHASE2_RECEIPT },
      phase3A: {
        commit: "d4b2b6eac03cdf3ae845afae5c96ad869b370ca4",
        tree: "8859d0fa46777bfedb33f440147d11b5e8dd1870",
        parent: "9c440e24d5f9b12f6e700dad20b494a317a81311",
        receipt: {
          path: PHASE3A_RECEIPT_PATH,
          bytes: 14_230,
          sha256: "A9ECFC607B307AC68F45E247A8787DAB67A7B42EAC75D0037ED4E5F8B41BEC1C",
        },
        decision: {
          path: PHASE3A_DECISION_PATH,
          bytes: 10_492,
          sha256: "2850A0783C07AC379303F3EFE327E235AEF96689AF5B9319CA22CE7CEC367B09",
        },
        verdict: "WHOLE_PHASE3A_TYPED_RUNNER_BOUNDARY_CLEAR",
        artifactBindings: PHASE3A_ARTIFACTS.map((entry) => ({ ...entry })),
      },
    },
    controllerBindings,
    binaryBindings: { runner, git, wsl },
    repositoryBinding: {
      root: repositoryRoot,
      acceptedControllerCommit: controllerCommit,
      acceptedControllerTree: controllerTree,
      carrierCommit,
      carrierTree,
      carrierParent: controllerCommit,
      carrierOnlyDeltaPath: PHASE3_HARDENING_FIXED_CARRIER_PATH,
      carrierBlobId,
    },
    policy: {
      aggregateDeadlineMs: 60_000,
      commandCountMax: 48,
      decodedStreamBytesMax: 65_536,
      artifactStdinBytesEachMax: 16_384,
      artifactStdinBytesAggregateMax: 65_536,
      outerDeadlineGraceMs: 5_000,
      guestInternalTimeoutSeconds: 5,
      retryAuthorized: false,
      cleanupAuthorized: false,
      phaseAdvanceAuthorized: false,
      phase4Authorized: false,
    },
    review: {
      verdict: "PREMUTATION_CLEAR",
      independent: true,
      controllerVerdict: "WHOLE_PHASE3_CONTROLLER_BOUNDARY_CLEAR",
    },
    parentDecision: {
      decision: "EXECUTE_EXACT_PHASE3B_CARRIER_ONCE",
      stable: true,
    },
    authorization: {
      id: authorizationId,
      oneShot: true,
      retryAuthorized: false,
      cleanupAuthorized: false,
      phaseAdvanceAuthorized: false,
      phase4Authorized: false,
      attemptEvidencePath,
    },
    guestExecutables: ["/usr/bin/systemctl"],
    commands,
  };
  carrier.commands[4].expected = {
    exitCode: 0,
    stdoutBinding: "exact-carrier-bytes",
    stderrBytes: 0,
    stderrSha256: sha256Hex(Buffer.alloc(0)).toUpperCase(),
  };
  const carrierBytes = encodeCarrier(carrier);
  return { carrier, carrierBytes };
}

function makeCommand(input: {
  ordinal: number;
  role: string;
  decoder: string;
  semanticClass: string;
  operationRoot: string;
  authorizationId: string;
  executable: { path: string; sha256: string };
  argv: string[];
  stdout: Buffer;
}) {
  const requestPath = `${input.operationRoot}\\requests\\${String(input.ordinal).padStart(2, "0")}.json`;
  const request: ProcessRequest = {
    schema: PROCESS_REQUEST_SCHEMA,
    operationId: input.authorizationId,
    oneShot: true,
    retryAuthorized: false,
    executable: { path: input.executable.path, sha256: input.executable.sha256.toLowerCase() },
    argv: input.argv,
    stdin: { encoding: "base64", base64: "", bytes: 0, sha256: sha256Hex(Buffer.alloc(0)) },
    environment: { inherit: false, allowlist: [], values: {} },
    limits: {
      requestBytesMax: CONTRACT_LIMITS.requestBytesMax,
      stdinBytesMax: CONTRACT_LIMITS.stdinBytesMax,
      stdoutBytesMax: CONTRACT_LIMITS.stdoutBytesMax,
      stderrBytesMax: CONTRACT_LIMITS.stderrBytesMax,
      evidenceBytesMax: CONTRACT_LIMITS.evidenceBytesMax,
      concurrencyMax: 1,
      childProcessMax: 1,
      deadlineMs: 1_000,
      aggregateDeadlineMs: CONTRACT_LIMITS.aggregateDeadlineMs,
      memoryBytesMax: CONTRACT_LIMITS.memoryBytesMax,
      cpuPercentMax: CONTRACT_LIMITS.cpuPercentMax,
    },
    containment: { consumer: PROCESS_CONSUMER, operationRoot: input.operationRoot, requireCanonicalPaths: true },
    attemptMarker: { path: `${input.operationRoot}\\markers\\${String(input.ordinal).padStart(2, "0")}.json`, createNew: true },
    evidence: { path: `${input.operationRoot}\\evidence\\${String(input.ordinal).padStart(2, "0")}.json`, schema: PROCESS_EVIDENCE_SCHEMA, createNew: true },
  };
  return {
    role: input.role,
    decoder: input.decoder,
    semanticClass: input.semanticClass,
    requestPath,
    request,
    expected: rawExpectation(input.stdout, Buffer.alloc(0), 0),
  };
}

function rawExpectation(stdout: Uint8Array, stderr: Uint8Array, exitCode: number) {
  return {
    exitCode,
    stdoutBytes: stdout.byteLength,
    stdoutSha256: sha256Hex(stdout).toUpperCase(),
    stderrBytes: stderr.byteLength,
    stderrSha256: sha256Hex(stderr).toUpperCase(),
  };
}

function truthfulBoundFileContent(path: string): Buffer {
  const invented = INVENTED_BOUND_FILE_CONTENT.get(path);
  if (invented !== undefined) return Buffer.from(invented);
  if (path === GIT_PATH) return readFileSync(path);
  assert.ok(IMMUTABLE_REPOSITORY_BOUND_PATHS.has(path), `unallowlisted bound-file fixture read: ${path}`);
  const cached = immutableRepositoryBoundFileCache.get(path);
  if (cached !== undefined) return Buffer.from(cached);
  assert.ok(
    immutableRepositoryBoundFileCache.size < IMMUTABLE_REPOSITORY_BOUND_PATHS.size,
    "immutable bound-file fixture cache is bounded by the accepted Phase3A path set",
  );
  let content: Buffer;
  try {
    content = Buffer.from(execFileSync(
      GIT_PATH,
      ["--git-dir", REPOSITORY_GIT_DIRECTORY, "--work-tree", REPOSITORY_WORK_TREE, "--no-replace-objects", "show", `${ACCEPTED_PHASE3A_COMMIT}:${path}`],
      {
        cwd: REPOSITORY_WORK_TREE,
        env: SCRUBBED_IMMUTABLE_GIT_ENV,
        encoding: null,
        shell: false,
        timeout: IMMUTABLE_GIT_BLOB_TIMEOUT_MS,
        maxBuffer: IMMUTABLE_GIT_BLOB_MAX_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    ));
    if (content.byteLength > IMMUTABLE_GIT_BLOB_MAX_BYTES || immutableRepositoryBoundFileAggregateBytes + content.byteLength > IMMUTABLE_GIT_BLOB_CACHE_MAX_BYTES) throw new Error("immutable Git blob cap");
  } catch {
    throw new Error(`accepted Phase3A immutable bound-file unavailable: ${path}`);
  }
  immutableRepositoryBoundFileCache.set(path, content);
  immutableRepositoryBoundFileAggregateBytes += content.byteLength;
  immutableRepositoryBoundFileReadCounts.set(path, (immutableRepositoryBoundFileReadCounts.get(path) ?? 0) + 1);
  return Buffer.from(content);
}

function repositoryGitDirectory(workTree: string): string {
  const dotGit = resolve(workTree, ".git");
  if (lstatSync(dotGit).isDirectory()) return dotGit;
  const pointer = readFileSync(dotGit, "utf8").trim();
  const match = /^gitdir:\s*(.+)$/iu.exec(pointer);
  assert.ok(match, "repository .git pointer must bind an explicit Git directory");
  const gitDirectory = resolve(workTree, match[1]!);
  assert.ok(win32.isAbsolute(gitDirectory), "repository Git directory must be absolute");
  return gitDirectory;
}

function binding(path: string, bytes: Uint8Array) {
  return { path, bytes: bytes.byteLength, sha256: sha256Hex(bytes).toUpperCase() };
}

function encodeCarrier(carrier: unknown): Buffer {
  return Buffer.from(canonicalizeJson(carrier), "utf8");
}

function operationUuid(index: number): string {
  return `22222222-2222-4222-8${String(index).padStart(3, "0")}-222222222222`;
}

function makeFakeBoundary(
  carrier: any,
  carrierBytes: Buffer,
  behavior:
    | "poison"
    | "success"
    | "known-nonzero-at-2"
    | "unknown-at-2"
    | "dirty-git-status"
    | "deadline-before-first"
    | "attempt-marker-collision",
  immutableBoundFileOverrides: ReadonlyMap<string, Uint8Array> = new Map(),
) {
  const reads: string[] = [];
  const writes: Array<{ path: string; bytes: Buffer }> = [];
  const rustInvocations: Array<{ bytes: Buffer; authority: unknown }> = [];
  const bindings = [
    carrier.predecessorBindings.phase2Receipt,
    carrier.predecessorBindings.phase3A.receipt,
    carrier.predecessorBindings.phase3A.decision,
    ...carrier.predecessorBindings.phase3A.artifactBindings,
    carrier.controllerBindings.source,
    carrier.controllerBindings.test,
    carrier.controllerBindings.receipt,
    carrier.binaryBindings.runner,
    carrier.binaryBindings.git,
    carrier.binaryBindings.wsl,
  ];
  const byPath = new Map(bindings.map((entry: any) => [entry.path, entry]));
  assert.ok(immutableBoundFileOverrides.size <= 1, "fixture permits at most one immutable bound-file override");
  for (const path of immutableBoundFileOverrides.keys()) assert.ok(IMMUTABLE_REPOSITORY_BOUND_PATHS.has(path), `fixture immutable override is unallowlisted: ${path}`);
  let clock = 1_000;
  let clockCalls = 0;
  const boundary: Phase3ControllerBoundary = {
    async readBoundFile(path) {
      reads.push(path);
      if (path === PHASE3_HARDENING_FIXED_CARRIER_PATH) {
        return fileObservation(path, win32.join(carrier.repositoryBinding.root, path), carrierBytes);
      }
      const entry: any = byPath.get(path);
      assert.ok(entry, `unexpected bound-file read ${path}`);
      const override = immutableBoundFileOverrides.get(path);
      const content = override === undefined ? truthfulBoundFileContent(path) : Buffer.from(override);
      if (override === undefined) {
        assert.equal(content.byteLength, entry.bytes, `fixture byte binding drift: ${path}`);
        assert.equal(sha256Hex(content).toUpperCase(), entry.sha256, `fixture hash binding drift: ${path}`);
      }
      return fileObservation(
        path,
        win32.isAbsolute(path) ? path : win32.join(carrier.repositoryBinding.root, path),
        content,
      );
    },
    async createNewDurableFile(path, bytes) {
      const content = Buffer.from(bytes);
      writes.push({ path, bytes: content });
      return {
        path,
        resolvedPath: path,
        created: behavior === "attempt-marker-collision" && path === carrier.authorization.attemptEvidencePath
          ? false
          : true,
        durableFlushCompleted: true,
        exists: true,
        kind: "regular-file",
        isContained: true,
        isReparsePoint: false,
        bytes: content.byteLength,
        sha256: sha256Hex(content).toUpperCase(),
        content,
      };
    },
    monotonicMilliseconds() {
      clockCalls += 1;
      if (behavior === "deadline-before-first" && clockCalls === 2) return 55_002;
      clock += 1;
      return clock;
    },
    async invokeAcceptedRustSidecar(requestBytes, authority) {
      const ordinal = rustInvocations.length;
      rustInvocations.push({ bytes: Buffer.from(requestBytes), authority });
      if (behavior === "poison") throw new Error("POISON_AFTER_ALL_BINDINGS");
      const request = parseCanonicalProcessRequestBytes(requestBytes);
      return makeSuccessfulSidecarResult(
        requestBytes,
        request,
        behavior === "dirty-git-status" && ordinal === 0
          ? Buffer.from("?? unexpected.txt\n", "utf8")
          : inventedCommandOutput(carrier, carrierBytes, ordinal),
        behavior === "known-nonzero-at-2" && ordinal === 2 ? 23 : 0,
        behavior === "unknown-at-2" && ordinal === 2,
      );
    },
  };
  return { boundary, reads, writes, rustInvocations };
}

function overrideSidecarOutput(
  fake: ReturnType<typeof makeFakeBoundary>,
  faultOrdinal: number,
  output: Buffer,
  stderr = Buffer.alloc(0),
): void {
  const original = fake.boundary.invokeAcceptedRustSidecar.bind(fake.boundary);
  let ordinal = 0;
  fake.boundary.invokeAcceptedRustSidecar = async (requestBytes, authority) => {
    const current = ordinal;
    ordinal += 1;
    if (current !== faultOrdinal) return await original(requestBytes, authority);
    fake.rustInvocations.push({ bytes: Buffer.from(requestBytes), authority });
    const request = parseCanonicalProcessRequestBytes(requestBytes);
    return makeSuccessfulSidecarResult(requestBytes, request, output, 0, false, stderr);
  };
}

function throwSidecarAt(
  fake: ReturnType<typeof makeFakeBoundary>,
  faultOrdinal: number,
  killRequestCount: number,
): void {
  const original = fake.boundary.invokeAcceptedRustSidecar.bind(fake.boundary);
  let ordinal = 0;
  fake.boundary.invokeAcceptedRustSidecar = async (requestBytes, authority) => {
    const current = ordinal;
    ordinal += 1;
    if (current !== faultOrdinal) return await original(requestBytes, authority);
    fake.rustInvocations.push({ bytes: Buffer.from(requestBytes), authority });
    throw Object.assign(new Error("invented accepted-sidecar uncertainty"), {
      termination: { killRequestCount },
    });
  };
}

function corruptSidecarEvidenceAt(fake: ReturnType<typeof makeFakeBoundary>, faultOrdinal: number): void {
  const original = fake.boundary.invokeAcceptedRustSidecar.bind(fake.boundary);
  let ordinal = 0;
  fake.boundary.invokeAcceptedRustSidecar = async (requestBytes, authority) => {
    const current = ordinal;
    ordinal += 1;
    if (current !== faultOrdinal) return await original(requestBytes, authority);
    fake.rustInvocations.push({ bytes: Buffer.from(requestBytes), authority });
    const request = parseCanonicalProcessRequestBytes(requestBytes);
    const result = makeSuccessfulSidecarResult(requestBytes, request, Buffer.alloc(0));
    return { ...result, requestSha256: "0".repeat(64) };
  };
}

function overrideSidecarTerminalAt(
  fake: ReturnType<typeof makeFakeBoundary>,
  faultOrdinal: number,
  terminalState: "deadline-killed" | "stdout-cap-killed" | "stderr-cap-killed",
): void {
  const original = fake.boundary.invokeAcceptedRustSidecar.bind(fake.boundary);
  let ordinal = 0;
  fake.boundary.invokeAcceptedRustSidecar = async (requestBytes, authority) => {
    const current = ordinal;
    ordinal += 1;
    if (current !== faultOrdinal) return await original(requestBytes, authority);
    fake.rustInvocations.push({ bytes: Buffer.from(requestBytes), authority });
    const request = parseCanonicalProcessRequestBytes(requestBytes);
    const result: any = makeSuccessfulSidecarResult(requestBytes, request, Buffer.alloc(0));
    result.evidence.terminalState = terminalState;
    result.evidence.exitCodeKnown = false;
    result.evidence.exitCode = null;
    result.evidence.outputComplete = false;
    if (terminalState === "stderr-cap-killed") {
      result.evidence.standardError.complete = false;
      result.evidence.standardError.truncated = true;
    } else {
      result.evidence.standardOutput.complete = false;
      result.evidence.standardOutput.truncated = true;
    }
    const durableEvidence = Buffer.from(canonicalizeJson(result.evidence), "utf8");
    result.evidenceBytes = durableEvidence.byteLength;
    result.evidenceSha256 = sha256Hex(durableEvidence);
    return result;
  };
}

function inventedCommandOutput(carrier: any, carrierBytes: Buffer, ordinal: number): Buffer {
  switch (ordinal) {
    case 0:
      return Buffer.alloc(0);
    case 1:
      return Buffer.from(
        `${carrier.repositoryBinding.carrierCommit}\n${carrier.repositoryBinding.carrierTree}\n${carrier.repositoryBinding.acceptedControllerCommit}\n`,
        "utf8",
      );
    case 2:
      return Buffer.from(`${PHASE3_HARDENING_FIXED_CARRIER_PATH}\n`, "utf8");
    case 3:
      return Buffer.from(
        `100644 ${carrier.repositoryBinding.carrierBlobId} 0\t${PHASE3_HARDENING_FIXED_CARRIER_PATH}\n`,
        "utf8",
      );
    case 4:
      return carrierBytes;
    case 5:
      return Buffer.from("WSL version: 2.4.0\r\n", "utf16le");
    default:
      throw new Error(`unexpected invented command ordinal ${ordinal}`);
  }
}

function makeSuccessfulSidecarResult(
  requestBytes: Uint8Array,
  request: ProcessRequest,
  stdout: Buffer,
  exitCode = 0,
  unknown = false,
  stderr = Buffer.alloc(0),
) {
  const empty = Buffer.alloc(0);
  const evidence = {
    schema: PROCESS_EVIDENCE_SCHEMA,
    requestBytes: requestBytes.byteLength,
    requestSha256: sha256Hex(requestBytes),
    executableSha256Observed: request.executable.sha256,
    argv: [...request.argv],
    stdinBytes: request.stdin.bytes,
    stdinSha256: request.stdin.sha256,
    startedUtc: "2026-08-27T00:00:00.000Z",
    finishedUtc: "2026-08-27T00:00:00.010Z",
    processStartCount: 1 as const,
    terminalState: unknown ? "unknown" : "known-exit",
    exitCodeKnown: !unknown,
    exitCode: unknown ? null : exitCode,
    outputComplete: !unknown,
    standardOutput: {
      base64: stdout.toString("base64"),
      bytes: stdout.byteLength,
      sha256: sha256Hex(stdout),
      complete: !unknown,
      truncated: unknown,
    },
    standardError: {
      base64: stderr.toString("base64"),
      bytes: stderr.byteLength,
      sha256: sha256Hex(stderr),
      complete: true,
      truncated: false,
    },
    retryPerformed: false as const,
    cleanupPerformed: false as const,
  };
  const durableEvidence = Buffer.from(canonicalizeJson(evidence), "utf8");
  const ack = Buffer.from("invented-ack", "utf8");
  return {
    adapter: "replaceable-rust-sidecar-v1" as const,
    requestSha256: sha256Hex(requestBytes),
    sidecarProcessStartCount: 1 as const,
    sidecarExitCodeKnown: true as const,
    sidecarExitCode: 0 as const,
    sidecarOutputComplete: true as const,
    sidecarStdoutBytes: ack.byteLength,
    sidecarStdoutSha256: sha256Hex(ack),
    sidecarStderrBytes: 0 as const,
    sidecarStderrSha256: sha256Hex(empty),
    evidenceRecoveredBeforeAckParse: true as const,
    evidenceBytes: durableEvidence.byteLength,
    evidenceSha256: sha256Hex(durableEvidence),
    runnerPeakWorkingSetBytes: 1_048_576,
    retryPerformed: false as const,
    evidence,
  };
}

function fileObservation(path: string, resolvedPath: string, content: Buffer) {
  return {
    path,
    resolvedPath,
    exists: true,
    kind: "regular-file",
    isContained: true,
    isReparsePoint: false,
    bytes: content.byteLength,
    sha256: sha256Hex(content).toUpperCase(),
    content,
  };
}
