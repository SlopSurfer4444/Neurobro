import { ACCEPTED_C1, GIT_GUARD_BINDINGS, GIT_GUARD_SEMANTICS, runtimeGitGuardArgv, resolveRuntimeFilePath, assertCarrierStartupAgreement } from "../src/phase3-hardening-runtime-contract-v1.mjs";
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
  PHASE3_HARDENING_CARRIER_V16_SCHEMA as PHASE3_HARDENING_CARRIER_SCHEMA,
  PHASE3_HARDENING_V16_FIXED_CARRIER_PATH as PHASE3_HARDENING_FIXED_CARRIER_PATH,
  runPhase3HardeningControllerV2 as runControllerProduction,
  type Phase3ControllerBoundary,
} from "../src/phase3-hardening-controller-v2.ts";


const TEST_P = {commit:"1".repeat(40),tree:"2".repeat(40),parent:ACCEPTED_C1.commit};
const TEST_A = {commit:"3".repeat(40),tree:"4".repeat(40),parent:TEST_P.commit};
const TEST_K = {commit:"5".repeat(40),tree:"6".repeat(40),parent:TEST_A.commit,carrierBlobId:"e".repeat(40)};
function runtimeLineage(carrier: any) { const {carrierBlobId,...k}=TEST_K; return [carrier.repositoryBinding.acceptedC1,carrier.repositoryBinding.acceptedP,carrier.repositoryBinding.acceptedA,k]; }
function fixtureStartupBytes(bytes: Uint8Array): Buffer {
  let c: any; try { c=JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { c=makeControllerFixture().carrier; }
  const production = c.productionBindings ?? makeControllerFixture().carrier.productionBindings;
  return Buffer.from(canonicalizeJson({
    schema:"decadans.rm0032.accepted-startup-launchbinding.v2",
    acceptanceId:"12345678-1234-4123-8123-123456789abc",
    acceptedGeneration:{p:TEST_P,a:TEST_A,k:TEST_K},
    repositoryRoot:"C:\\fixture\\repo",cwd:"C:\\fixture\\repo",
    nativePrestart:{path:"C:\\fixture\\bin\\prestart.exe",bytes:1,sha256:"A".repeat(64)},
    node:{...production.node,version:"v24.15.0",platform:"win32",arch:"x64"},
    liveEntry:production.liveEntry,
    carrier:{path:"C:\\fixture\\repo\\"+PHASE3_HARDENING_FIXED_CARRIER_PATH.replaceAll("/","\\"),bytes:bytes.byteLength,sha256:sha256Hex(bytes).toUpperCase()},
    launcher:production.launcher,observer:production.observer,
    binaryBindings:c.binaryBindings ?? makeControllerFixture().carrier.binaryBindings,
  }));
}
function runPhase3HardeningController(bytes: Uint8Array,path:string,boundary:Phase3ControllerBoundary) {
  return runControllerProduction(bytes,path,boundary,fixtureStartupBytes(bytes));
}
function rawDelta(paths: readonly string[],status:"A"|"M"):Buffer {
  return Buffer.from(paths.map(path=>":"+ (status==="A"?"000000":"100644")+" 100644 "+(status==="A"?"0":"d").repeat(40)+" "+"e".repeat(40)+" "+status+"\0"+path+"\0").join(""));
}

const PHASE3B_AUTHORITY_PATHS = [
  "project/implementation-plan.md",
  "project/project-state.md",
  "project/roadmap.md",
  "project/verification/rm-0032-persistent-wsl2-subscription-only-gate-matrix.json",
  "project/verification/rm-0032-persistent-wsl2-subscription-only-gate-matrix.test.mjs",
] as const;

const LINEAGE_PREFIX = [
  ["C0", "b4ee0da9695085cf358d65633da9eb46bd65de5e", "ba43887c3b7501a90e7fe2cec057e40e86a09a1a", "c540c4c3fc143fb52d028f984d565a7ea6ab0f3c"],
  ["R0", "25a82334557df600bbbcbbe7c383826beb690d6f", "7419b7582638ba3f51f110eb78af30e0be2943ae", "b4ee0da9695085cf358d65633da9eb46bd65de5e"],
  ["RO", "5cbd9babc1a5e32d8480d74a97a14dc9aba53cdc", "00d52e8aaff32b95cd6eaf20dd1563c6341025f3", "25a82334557df600bbbcbbe7c383826beb690d6f"],
  ["RP", "ca6e0bb50beb149da62b821828f5caca8137ec01", "15406402f18d3387b6716f8f9ddbb221fd8cc963", "5cbd9babc1a5e32d8480d74a97a14dc9aba53cdc"],
  ["P2A", "c9afb95d1480c53216439a34f27fa931ebd31c8b", "37ede695cbd37326cc7d374ced5a3eb3bb971cfb", "ca6e0bb50beb149da62b821828f5caca8137ec01"],
  ["P2R", "518c34ee921cf5b7f79a318dc04d945fcc80eb2f", "dfddf448b10ad183d9e1d30fdbd46e02491dffa6", "c9afb95d1480c53216439a34f27fa931ebd31c8b"],
  ["fixed-maintenance-non-role", "37845a57cf314c9ec77de06674a1b24c1159ea4e", "de0e83c203c8f0516aa97261df1f847c6c084840", "518c34ee921cf5b7f79a318dc04d945fcc80eb2f"],
  ["OP0", "1073ccdfca29d67ac8f9b3e385ba51a12301bc1b", "059181b9aa5ff9242d4d928dd9eddc00913bab6b", "37845a57cf314c9ec77de06674a1b24c1159ea4e"],
  ["RA", "a780dce2994f6479b49d815aa05e77b76926618e", "2d1b8c450b5029680d4452ed6daf71db792e66a1", "1073ccdfca29d67ac8f9b3e385ba51a12301bc1b"],
  ["replacement-RAC1", "b29636b6fd9b1ca9eebe11719eca1a5ed7b226fa", "beff6ed4d4a3e89f5dd6dcf42828b5a02d468a1d", "a780dce2994f6479b49d815aa05e77b76926618e"],
  ["receipt-control-non-role", "2eb7e3ef0c5e03b34b9400775f50b063aa418a47", "448aa53cf8d5d524679b7ee2610c16f7eabacf0d", "b29636b6fd9b1ca9eebe11719eca1a5ed7b226fa"],
  ["DR2-authority-amendment-non-role", "e993e1ed32256c337460dd42438b972f67066ed4", "654777bc2229311966cb89f3e89b8ae74a7eab70", "2eb7e3ef0c5e03b34b9400775f50b063aa418a47"],
  ["DR2", "8ec88b6fcbe309bdc94d87b4301bedd25ce5a4f9", "fa9fa1371b9ee6542d58b0b399c8c97067f23f4b", "e993e1ed32256c337460dd42438b972f67066ed4"],
  ["postcommit-validator-hardening-non-role", "b589b6e8a1cb19c33baa14ab30325043f67db469", "d3d71ea98aaea023c5c56f42f6a71004c24b73a9", "8ec88b6fcbe309bdc94d87b4301bedd25ce5a4f9"],
  ["OPR", "34adef7691665f9ec7838be73cb6a65fd747ad55", "e1bbe173ddb81bfd75213998112b70e977f75f59", "b589b6e8a1cb19c33baa14ab30325043f67db469"],
  ["OAC", "721c7a7fbeabae3e9987cf5c49a928661e8729ad", "fed2841ae6c6cf54142aa697a81f2b7ada9c4cb4", "34adef7691665f9ec7838be73cb6a65fd747ad55"],
  ["O", "4b8cdbb5784abf971fd3072e68c8e03c16a2ec7e", "655ed46ca53dd1f60811ddd722b8f903b1852564", "721c7a7fbeabae3e9987cf5c49a928661e8729ad"],
  ["R1", "342d0d072ae50524da6706b1e2e5668bac47470e", "6722f668e1e795f5486b6f8afa6b3f804cd77677", "4b8cdbb5784abf971fd3072e68c8e03c16a2ec7e"],
  ["R2", "360e9d3a8267f0ea2bedf9d159e1356854b1361b", "8921f84e7be79d531472bfa53ea6f527594897ac", "342d0d072ae50524da6706b1e2e5668bac47470e"],
  ["C1-recovery-authority-amendment-non-role", "a81bc769c44582a801cc62986e3d5f58f945d72d", "4160d57c70b44d26ed9c042865bb93e9405da6d2", "360e9d3a8267f0ea2bedf9d159e1356854b1361b"],
] as const;

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
const FIXTURE_NODE_PATH = "C:\\fixture\\bin\\node.exe";
const FIXTURE_LIVE_ENTRY_PATH = "C:\\fixture\\repo\\packages\\rm0032-phase3-runner\\src\\phase3-hardening-live-entry.mjs";
const FIXTURE_LAUNCHER_PATH = "C:\\fixture\\bin\\rm0032-phase3-native-observer-launcher-v1.exe";
const FIXTURE_OBSERVER_PATH = "C:\\fixture\\bin\\rm0032-phase3-native-observer-v1.exe";
const GIT_PATH = "C:\\Program Files\\Git\\mingw64\\bin\\git.exe";
const WSL_PATH = "C:\\Program Files\\WSL\\wsl.exe";
const ACCEPTED_PHASE3A_COMMIT = "d4b2b6eac03cdf3ae845afae5c96ad869b370ca4";
const INVENTED_BOUND_FILE_CONTENT = new Map<string, Buffer>([
  [FIXTURE_RUNNER_PATH, Buffer.from("invented accepted runner", "utf8")],
  [FIXTURE_NODE_PATH, Buffer.from("invented accepted node", "utf8")],
  [FIXTURE_LIVE_ENTRY_PATH, Buffer.from("invented accepted live entry", "utf8")],
  [FIXTURE_LAUNCHER_PATH, Buffer.from("invented accepted launcher", "utf8")],
  [FIXTURE_OBSERVER_PATH, Buffer.from("invented accepted observer", "utf8")],
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
test("startup v2 binary pins are mandatory, closed, and independently agree before effects",async context=>{
  const changes: Array<[string,(v:any)=>void]> = [
    ["old v1",v=>{v.schema="decadans.rm0032.accepted-startup-launchbinding.v1";}],
    ["missing binaryBindings",v=>{delete v.binaryBindings;}],
    ["extra binary role",v=>{v.binaryBindings.extra=v.binaryBindings.runner;}],
  ];
  for(const role of ["runner","git","wsl"]) {
    changes.push(["missing "+role,v=>{delete v.binaryBindings[role];}]);
    changes.push(["extra "+role+" field",v=>{v.binaryBindings[role].verified=true;}]);
    for(const field of ["path","bytes","sha256"]) {
      changes.push([role+" "+field,v=>{
        if(field==="path") v.binaryBindings[role].path="C:\\fixture\\other-"+role+".exe";
        else if(field==="bytes") v.binaryBindings[role].bytes++;
        else v.binaryBindings[role].sha256="F".repeat(64);
      }]);
    }
  }
  for(const [name,change] of changes) await context.test(name,async()=>{
    const fixture=makeControllerFixture();
    const baseline=fixtureStartupBytes(fixture.carrierBytes);
    const hostile=JSON.parse(baseline.toString());change(hostile);
    const bytes=encodeCarrier(hostile);assert.notDeepEqual(bytes,baseline);
    const fake=makeFakeBoundary(fixture.carrier,fixture.carrierBytes,"success");
    const result=await runControllerProduction(fixture.carrierBytes,PHASE3_HARDENING_FIXED_CARRIER_PATH,fake.boundary,bytes);
    assert.equal(result.outcome,"terminal-refused");
    assert.deepEqual(fake.reads,[]);assert.deepEqual(fake.writes,[]);assert.deepEqual(fake.rustInvocations,[]);
    assert.equal(result.attemptEvidenceBytes,0);
  });
  for(const role of ["runner","git","wsl"]) for(const field of ["path","bytes","sha256"]) await context.test("independent carrier "+role+" "+field,async()=>{
    const fixture=makeControllerFixture();
    const startup=JSON.parse(fixtureStartupBytes(fixture.carrierBytes).toString());
    const original=structuredClone(fixture.carrier.binaryBindings);
    if(field==="path") fixture.carrier.binaryBindings[role].path="C:\\fixture\\other-"+role+".exe";
    else if(field==="bytes") fixture.carrier.binaryBindings[role].bytes++;
    else fixture.carrier.binaryBindings[role].sha256="F".repeat(64);
    const bytes=encodeCarrier(fixture.carrier);
    startup.carrier.bytes=bytes.length;startup.carrier.sha256=sha256Hex(bytes).toUpperCase();
    assert.deepEqual(startup.binaryBindings,original);
    assert.notDeepEqual(startup.binaryBindings,fixture.carrier.binaryBindings);
    const fake=makeFakeBoundary(fixture.carrier,bytes,"success");
    const result=await runControllerProduction(bytes,PHASE3_HARDENING_FIXED_CARRIER_PATH,fake.boundary,encodeCarrier(startup));
    assert.equal(result.outcome,"terminal-refused");
    assert.throws(()=>assertCarrierStartupAgreement(fixture.carrier,startup,bytes),/startup-binary-bindings-refused/u);
    assert.equal(result.receiptCandidate.semanticClass,"carrier-or-bound-file-refused");
    assert.deepEqual(fake.reads,[]);assert.deepEqual(fake.writes,[]);assert.deepEqual(fake.rustInvocations,[]);
  });
});

test("direct Git engine pins refuse the old wrapper and old image hash before effects",async context=>{
  const fixture=makeControllerFixture();
  assert.equal(fixture.carrier.binaryBindings.git.path,GIT_PATH);
  assert.equal(fixture.carrier.binaryBindings.git.sha256,"CAB4C4EEA1D869CF9F7BE73868DC9A90AD2DF1B1B673E5F8C8714A576C25EA96");
  const baseline=makeFakeBoundary(fixture.carrier,fixture.carrierBytes,"success");
  assert.equal((await runPhase3HardeningController(fixture.carrierBytes,PHASE3_HARDENING_FIXED_CARRIER_PATH,baseline.boundary)).outcome,"known-clear");
  for(const [name,path] of [["old wrapper","C:\\Program Files\\Git\\cmd\\git.exe"],["old image at direct path",GIT_PATH]]) await context.test(name,async()=>{
    const hostile=structuredClone(fixture.carrier);
    hostile.binaryBindings.git={path,bytes:46480,sha256:"81EF35AE005CA9318018D18E3327578CE939FB99FEAAD6B2D7C8AB15F3DE8DB5"};
    for(const command of hostile.commands.slice(0,6)) command.request.executable={path,sha256:hostile.binaryBindings.git.sha256.toLowerCase()};
    const bytes=encodeCarrier(hostile);assert.notDeepEqual(bytes,fixture.carrierBytes);
    const fake=makeFakeBoundary(hostile,bytes,"success");
    // Regenerate the startup binding too, so agreement drift cannot mask the fixed policy.
    const result=await runPhase3HardeningController(bytes,PHASE3_HARDENING_FIXED_CARRIER_PATH,fake.boundary);
    assert.equal(result.outcome,"terminal-refused");
    assert.deepEqual(fake.reads,[]);assert.deepEqual(fake.writes,[]);assert.deepEqual(fake.rustInvocations,[]);
  });
});

test("direct WSL engine pins refuse old shims, alternate paths, and request mismatches before effects",async context=>{
  const fixture=makeControllerFixture();
  assert.equal(fixture.carrier.binaryBindings.wsl.path,"C:\\Program Files\\WSL\\wsl.exe");
  for(const [name,path] of [
    ["old System32 shim","C:\\Windows\\System32\\wsl.exe"],
    ["SysWOW64 shim","C:\\Windows\\SysWOW64\\wsl.exe"],
    ["alternate engine","C:\\fixture\\wsl.exe"],
    ["engine alias","C:\\Program Files\\WSL\\wsl-alias.exe"],
  ]) await context.test(name!,async()=>{
    const hostile=structuredClone(fixture.carrier);
    hostile.binaryBindings.wsl.path=path;
    for(const command of hostile.commands.slice(6)) command.request.executable.path=path;
    const bytes=encodeCarrier(hostile);assert.notDeepEqual(bytes,fixture.carrierBytes);
    const fake=makeFakeBoundary(hostile,bytes,"success");
    // Regenerate startup too: agreement drift must not mask the fixed path policy.
    const result=await runPhase3HardeningController(bytes,PHASE3_HARDENING_FIXED_CARRIER_PATH,fake.boundary);
    assert.equal(result.outcome,"terminal-refused");
    assert.deepEqual(fake.reads,[]);assert.deepEqual(fake.writes,[]);assert.deepEqual(fake.rustInvocations,[]);
  });
  for(const field of ["path","sha256"] as const) await context.test(`request ${field} mismatch`,async()=>{
    const hostile=structuredClone(fixture.carrier);
    hostile.commands[6].request.executable[field]=field==="path"?"C:\\Windows\\System32\\wsl.exe":"0".repeat(64);
    const bytes=encodeCarrier(hostile);assert.notDeepEqual(bytes,fixture.carrierBytes);
    const fake=makeFakeBoundary(hostile,bytes,"success");
    const result=await runPhase3HardeningController(bytes,PHASE3_HARDENING_FIXED_CARRIER_PATH,fake.boundary);
    assert.equal(result.outcome,"terminal-refused");
    assert.deepEqual(fake.reads,[]);assert.deepEqual(fake.writes,[]);assert.deepEqual(fake.rustInvocations,[]);
  });
});

test("native-bound large EXEs bypass only observer binary reads while all receipts and carrier remain connected",async()=>{
  // Use the actual direct Git engine bytes and hash; its image also exceeds 256 KiB.
  const previousRunner=INVENTED_BOUND_FILE_CONTENT.get(FIXTURE_RUNNER_PATH)!;
  const previousWsl=INVENTED_BOUND_FILE_CONTENT.get(WSL_PATH)!;
  INVENTED_BOUND_FILE_CONTENT.set(FIXTURE_RUNNER_PATH,Buffer.alloc(1_446_912,0x52));
  INVENTED_BOUND_FILE_CONTENT.set(WSL_PATH,Buffer.alloc(4_248_608,0x57));
  try {
    const fixture=makeControllerFixture();
    assert.ok(fixture.carrier.binaryBindings.runner.bytes>262144);
    assert.ok(fixture.carrier.binaryBindings.git.bytes>262144);
    assert.ok(fixture.carrier.binaryBindings.wsl.bytes>262144);
    const fake=makeFakeBoundary(fixture.carrier,fixture.carrierBytes,"success");
    const exePaths=new Set([FIXTURE_RUNNER_PATH,GIT_PATH,WSL_PATH]);let exeReads=0;
    const original=fake.boundary.readBoundFile.bind(fake.boundary);
    fake.boundary.readBoundFile=async path=>{
      if(exePaths.has(path)){exeReads++;throw Error("EXE observer read forbidden");}
      return original(path);
    };
    const result=await runControllerProduction(fixture.carrierBytes,PHASE3_HARDENING_FIXED_CARRIER_PATH,fake.boundary,fixtureStartupBytes(fixture.carrierBytes));
    assert.equal(result.outcome,"known-clear");assert.equal(exeReads,0);
    assert.deepEqual(fake.reads,[PHASE3_HARDENING_FIXED_CARRIER_PATH,PHASE2_RECEIPT.path,fixture.carrier.predecessorBindings.phase3A.receipt.path,fixture.carrier.predecessorBindings.phase3A.decision.path,fixture.carrier.controllerBindings.receipt.path]);
    assert.equal(fake.rustInvocations.length,7);
    assert.equal(fake.writes[6]?.path,fixture.carrier.authorization.attemptEvidencePath);
    assert.equal(parseCanonicalProcessRequestBytes(fake.rustInvocations[6]!.bytes).executable.path,WSL_PATH);
    assert.ok(result.attemptEvidenceBytes>0);
  } finally {
    INVENTED_BOUND_FILE_CONTENT.set(FIXTURE_RUNNER_PATH,previousRunner);
    INVENTED_BOUND_FILE_CONTENT.set(WSL_PATH,previousWsl);
  }
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
  assert.equal(fake.reads.includes("packages/rm0032-phase3-runner/src/phase3-hardening-controller.ts"),false);
  const historicalPath = PHASE2_RECEIPT.path;
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
  assert.deepEqual(binding(historicalPath, immutableBytes), PHASE2_RECEIPT);
  // Offline historical audit only; current runtime does not reread these source blobs.
  for (const path of IMMUTABLE_REPOSITORY_BOUND_PATHS) truthfulBoundFileContent(path);
  assert.equal(immutableRepositoryBoundFileCache.size, IMMUTABLE_REPOSITORY_BOUND_PATHS.size);
  assert.ok(immutableRepositoryBoundFileAggregateBytes <= IMMUTABLE_GIT_BLOB_CACHE_MAX_BYTES, "immutable Phase3A Git cache aggregate is bounded");
  for (const path of IMMUTABLE_REPOSITORY_BOUND_PATHS) {
    assert.equal(immutableRepositoryBoundFileReadCounts.get(path), 1, `immutable Phase3A Git blob read exactly once: ${path}`);
  }
});

test("tracer: one invented WSL command follows six Git guards through one request and one Rust call per command", async () => {
  const fixture = makeControllerFixture();
  for (const command of fixture.carrier.commands.slice(0, 6)) {
    assert.deepEqual(command.request.environment, { inherit: false, allowlist: [], values: {} });
  }
  assert.deepEqual(fixture.carrier.commands[6].request.environment, {
    inherit: false, allowlist: ["SystemRoot", "WINDIR"], values: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
  });
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");

  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );

  assert.equal(result.outcome, "known-clear");
  assert.equal(result.acceptedCommandCount, 7);
  assert.equal(result.rustInvocationCount, 7);
  assert.equal(result.runnerTerminationRequestCount, 0);
  assert.equal(result.controllerKillCount, 0);
  assert.equal(result.retryAuthorized, false);
  assert.equal(result.cleanupAuthorized, false);
  assert.equal(fake.rustInvocations.length, 7);
  assert.equal(fake.writes.length, 8);
  assert.equal(fake.writes[6]?.path, fixture.carrier.authorization.attemptEvidencePath);
  assert.equal(fake.writes[7]?.path, fixture.carrier.commands[6].requestPath);
  for (const productionBinding of [
    fixture.carrier.productionBindings.node,
    fixture.carrier.productionBindings.liveEntry,
    fixture.carrier.productionBindings.launcher,
    fixture.carrier.productionBindings.observer,
  ]) {
    assert.equal(
      fake.reads.includes(productionBinding.path),
      false,
      `bootstrap-owned production image must not cross the observer's 262144-byte read seam: ${productionBinding.path}`,
    );
  }
  assert.equal(fixture.carrier.commands[1].request.argv.length, 14);
  assert.equal(fixture.carrier.commands[1].request.argv.at(-1), "HEAD");
  assert.equal(inventedCommandOutput(fixture.carrier, fixture.carrierBytes, 1).byteLength, 496);
  // Observe the real immutable process-contract parser at the exercised sidecar seam,
  // not just the fixture declaration. No Git or WSL process is started by this fake.
  const observedGuard2 = parseCanonicalProcessRequestBytes(fake.rustInvocations[1]!.bytes);
  assert.deepEqual(observedGuard2.argv, fixture.carrier.commands[1].request.argv);
  assert.equal(observedGuard2.argv.length, 14);
  assert.equal(observedGuard2.argv[10], ACCEPTED_C1.commit);
  assert.equal(runtimeLineage(fixture.carrier).length, 4);
  assert.equal(fixture.carrier.repositoryBinding.acceptedP.parent, observedGuard2.argv[10]);
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
    ["old v1 carrier schema", (carrier) => { carrier.schema = "decadans.rm0032.phase3-hardening-carrier.v1"; }],
    ["Phase 2 receipt hash drift", (carrier) => { carrier.predecessorBindings.phase2Receipt.sha256 = "A".repeat(64); }],
    ["Phase 3A commit drift", (carrier) => { carrier.predecessorBindings.phase3A.commit = "f".repeat(40); }],
    ["Phase 3A receipt hash drift", (carrier) => { carrier.predecessorBindings.phase3A.receipt.sha256 = "A".repeat(64); }],
    ["Phase 3A verdict drift", (carrier) => { carrier.predecessorBindings.phase3A.verdict = "UNREVIEWED"; }],
    ["Phase 3A artifact missing", (carrier) => { carrier.predecessorBindings.phase3A.artifactBindings.pop(); }],
    ["controller commit drift", (carrier) => { carrier.controllerBindings.commit = "f".repeat(40); }],
    ["controller tree drift", (carrier) => { carrier.controllerBindings.tree = "f".repeat(40); }],
    ["controller verdict drift", (carrier) => { carrier.controllerBindings.verdict = "UNREVIEWED"; }],
    ["controller receipt extra property", (carrier) => { carrier.controllerBindings.receipt.extra = true; }],
    ["P tuple missing", carrier => { delete carrier.repositoryBinding.acceptedP; }],
    ["P parent drift", carrier => { carrier.repositoryBinding.acceptedP.parent = "f".repeat(40); }],
    ["A commit reuse", carrier => { carrier.repositoryBinding.acceptedA.commit = carrier.repositoryBinding.acceptedP.commit; }],
    ["repository C1 mismatch", carrier => { carrier.repositoryBinding.acceptedC1.commit = "f".repeat(40); }],
    ["old rev-parse guard", (carrier) => { carrier.commands[1].request.argv = ["--no-pager", "-C", carrier.repositoryBinding.root, "rev-parse", "HEAD^{commit}", "HEAD^{tree}", "HEAD^"]; }],
    ["13-argv stale lineage guard", (carrier) => { carrier.commands[1].request.argv.pop(); }],
    ["15-argv lineage guard cap plus one", (carrier) => { carrier.commands[1].request.argv.push("unexpected"); }],
    ["old K self commit", carrier => { carrier.repositoryBinding.carrierCommit = "f".repeat(40); }],
    ["old K self tree", carrier => { carrier.repositoryBinding.carrierTree = "f".repeat(40); }],
    ["old K self blob", carrier => { carrier.repositoryBinding.carrierBlobId = "f".repeat(40); }],
    ["old K lineage", carrier => { carrier.lineageBindings = runtimeLineage(carrier); }],
    ["self-dependent hash", carrier => { carrier.commands[1].expected.stdoutSha256 = "F".repeat(64); }],
    ["stale 2728-byte lineage expectation", (carrier) => { carrier.commands[1].expected.stdoutBytes = 2_728; }],
    ["rejected TypeScript live entry", (carrier) => { carrier.productionBindings.liveEntry.path = FIXTURE_LIVE_ENTRY_PATH.replace(/\.mjs$/u, ".ts"); }],
    ["production binding extra property", (carrier) => { carrier.productionBindings.extra = true; }],
    ["launcher basename drift", (carrier) => { carrier.productionBindings.launcher.path = "C:\\fixture\\bin\\other.exe"; }],
    ["production path collision", (carrier) => { carrier.productionBindings.observerEvidenceRootAbsolutePath = carrier.productionBindings.observer.path; }],
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

test("WSL environment policy refuses before any controller boundary call or durable side effect", async (context) => {
  const cases: Array<[string, (carrier: any) => void]> = [
    ["empty WSL environment", c => { c.commands[6].request.environment = { inherit: false, allowlist: [], values: {} }; }],
    ["generic WSL environment", c => { c.commands[6].request.environment = { inherit: false, allowlist: ["LANG"], values: { LANG: "C" } }; }],
    ["missing SystemRoot", c => { c.commands[6].request.environment.allowlist = ["WINDIR"]; delete c.commands[6].request.environment.values.SystemRoot; }],
    ["missing WINDIR", c => { c.commands[6].request.environment.allowlist = ["SystemRoot"]; delete c.commands[6].request.environment.values.WINDIR; }],
    ["wrong Windows value", c => { c.commands[6].request.environment.values.WINDIR = "C:\\Elsewhere"; }],
    ["inherited WSL environment", c => { c.commands[6].request.environment.inherit = true; }],
    ["unlisted PATH", c => { c.commands[6].request.environment.values.PATH = "C:\\Windows"; }],
    ["non-WSL target with Windows pair", c => { c.commands[6].request.executable.path = c.binaryBindings.git.path; }],
    ["shim target with Windows pair", c => { c.commands[6].request.executable.path = "C:\\Windows\\System32\\wsl.exe"; }],
    ["mismatched WSL hash", c => { c.commands[6].request.executable.sha256 = "b".repeat(64); }],
  ];
  for (let index = 0; index < 6; index++) cases.push(["nonempty Git environment " + index, c => {
    c.commands[index].request.environment = { inherit: false, allowlist: ["LANG"], values: { LANG: "C" } };
  }]);
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const fixture = makeControllerFixture();
      mutate(fixture.carrier);
      const bytes = encodeCarrier(fixture.carrier);
      assert.notDeepEqual(bytes, fixture.carrierBytes, "the refused carrier must actually differ");
      let boundaryCalls = 0;
      const boundary: Phase3ControllerBoundary = {
        async readBoundFile() { boundaryCalls++; throw new Error("unexpected bound read"); },
        async createNewDurableFile() { boundaryCalls++; throw new Error("unexpected durable write"); },
        monotonicMilliseconds() { boundaryCalls++; return 0; },
        async invokeAcceptedRustSidecar() { boundaryCalls++; throw new Error("unexpected Rust dispatch"); },
      };
      const result = await runPhase3HardeningController(bytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, boundary);
      assert.equal(result.outcome, "terminal-refused");
      assert.equal(result.acceptedCommandCount, 0);
      assert.equal(result.rustInvocationCount, 0);
      assert.equal(result.attemptEvidenceBytes, 0);
      assert.equal(boundaryCalls, 0, "environment policy is checked before reads, writes, clocks or Rust calls");
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
    ["bare WSL", (carrier) => { carrier.commands[6].request.argv = []; }],
    ["altered allowed management command", (carrier) => { carrier.commands[6].request.argv = ["--status"]; }],
    ["reordered Git guards", (carrier) => { [carrier.commands[0], carrier.commands[1]] = [carrier.commands[1], carrier.commands[0]]; }],
    ["docker terminate", (carrier) => { carrier.commands[6].request.argv = ["--terminate", "docker-desktop"]; }],
    ["forbidden import", (carrier) => { carrier.commands[6].request.argv = ["--import", "DecadansNeurobro", "C:\\x", "C:\\y"]; }],
    ["wrong guest distro", (carrier) => {
      carrier.commands[6].role = "wsl-guest";
      carrier.commands[6].decoder = "utf-8-no-bom-strict";
      carrier.commands[6].semanticClass = "guest-identity-probe";
      carrier.commands[6].request.argv = ["--distribution", "docker-desktop", "--user", "root", "--exec", "/usr/bin/systemctl", "--version"];
    }],
    ["wrong guest user", (carrier) => {
      carrier.commands[6].role = "wsl-guest";
      carrier.commands[6].decoder = "utf-8-no-bom-strict";
      carrier.commands[6].semanticClass = "guest-identity-probe";
      carrier.commands[6].request.argv = ["--distribution", "DecadansNeurobro", "--user", "docker", "--exec", "/usr/bin/systemctl", "--version"];
    }],
    ["guest without internal timeout", (carrier) => {
      carrier.commands[6].role = "wsl-guest";
      carrier.commands[6].decoder = "utf-8-no-bom-strict";
      carrier.commands[6].semanticClass = "guest-identity-probe";
      carrier.commands[6].request.argv = ["--distribution", "DecadansNeurobro", "--user", "root", "--exec", "/usr/bin/systemctl", "show"];
    }],
    ["guest shell", (carrier) => {
      carrier.guestExecutables = ["/bin/sh", "/usr/bin/systemctl"];
      carrier.commands[6].role = "wsl-guest";
      carrier.commands[6].decoder = "utf-8-no-bom-strict";
      carrier.commands[6].semanticClass = "guest-identity-probe";
      carrier.commands[6].request.argv = ["--distribution", "DecadansNeurobro", "--user", "root", "--exec", "/bin/sh", "-c", "true"];
    }],
    ["guest metacharacter", (carrier) => {
      carrier.commands[6].role = "wsl-guest";
      carrier.commands[6].decoder = "utf-8-no-bom-strict";
      carrier.commands[6].semanticClass = "guest-identity-probe";
      carrier.commands[6].request.argv = ["--distribution", "DecadansNeurobro", "--user", "root", "--exec", "/usr/bin/systemctl", "show;id"];
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
      while (carrier.commands.length <= 48) carrier.commands.push(structuredClone(carrier.commands[6]));
    }],
    ["artifact stdin above per-command cap", (carrier) => {
      const bytes = Buffer.alloc(16_385, 0x41);
      carrier.commands[6].request.stdin = {
        encoding: "base64",
        base64: bytes.toString("base64"),
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
      };
    }],
    ["decoded output above cap", (carrier) => { carrier.commands[6].expected.stdoutBytes = 65_537; }],
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
    if (clockReads === 5) throw new Error("invented post-effect monotonic clock failure");
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
  assert.equal(clockReads, 5);
  assert.equal(fake.writes.length, 1);
  assert.equal(fake.rustInvocations.length, 1);
});

test("a regressing later monotonic reading is terminal-unknown after the first completed command", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
  const readings = [1_000, 1_000, 1_000, 50_000, 1_001];
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
  assert.equal(clockIndex, 5);
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
  assert.equal(result.acceptedCommandCount, 7);
  assert.equal(result.rustInvocationCount, 7);
  assert.equal(clockReads, 22);
  assert.equal(fake.writes.length, 8);
  assert.equal(fake.rustInvocations.length, 7);
});

test("a final durable request write cannot consume the reserved child and launcher interval", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
  let clockReads = 0;
  fake.boundary.monotonicMilliseconds = () => {
    clockReads += 1;
    if (clockReads === 20) return 55_000;
    if (clockReads === 21) return 55_001;
    return 1_000;
  };
  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );
  assert.equal(result.outcome, "terminal-unknown");
  assert.equal(result.acceptedCommandCount, 6);
  assert.equal(result.rustInvocationCount, 6);
  assert.equal(clockReads, 21);
  assert.equal(fake.writes.length, 8);
  assert.equal(fake.rustInvocations.length, 6);
});

test("a final sidecar result after the aggregate deadline cannot become known-clear", async () => {
  const fixture = makeControllerFixture();
  const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
  let clockReads = 0;
  fake.boundary.monotonicMilliseconds = () => {
    clockReads += 1;
    return clockReads === 22 ? 61_001 : 1_000;
  };
  const result = await runPhase3HardeningController(
    fixture.carrierBytes,
    PHASE3_HARDENING_FIXED_CARRIER_PATH,
    fake.boundary,
  );
  assert.equal(result.outcome, "terminal-unknown");
  assert.equal(result.acceptedCommandCount, 6);
  assert.equal(result.rustInvocationCount, 7);
  assert.equal(clockReads, 22);
  assert.equal(fake.writes.length, 8);
  assert.equal(fake.rustInvocations.length, 7);
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
  assert.equal(result.acceptedCommandCount, 6);
  assert.equal(result.rustInvocationCount, 6);
  assert.equal(fake.rustInvocations.length, 6);
  assert.equal(fake.writes.length, 7);
  assert.equal(fake.writes[6]?.path, fixture.carrier.authorization.attemptEvidencePath);
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
        if (path === fixture.carrier.controllerBindings.receipt.path) mutate(observation);
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
    if (path !== fixture.carrier.controllerBindings.receipt.path) return observation;
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

test("Git lineage, authority delta, carrier delta, mode, blob, and carrier-byte drift stops before the marker", async (context) => {
  const faults: Array<[string, number, (fixture: ReturnType<typeof makeControllerFixture>) => Buffer]> = [
    ["wrong lineage parent", 1, (fixture) => {
      const lineage = structuredClone(runtimeLineage(fixture.carrier));
      lineage[1].parent = "f".repeat(40);
      return encodeLineageOutput(lineage);
    }],
    ["wrong lineage tree", 1, (fixture) => {
      const lineage = structuredClone(runtimeLineage(fixture.carrier));
      lineage[1].tree = "f".repeat(40);
      return encodeLineageOutput(lineage);
    }],
    ["extra authority delta", 2, () => Buffer.from(`${PHASE3B_AUTHORITY_PATHS.join("\n")}\nextra.txt\n`, "utf8")],
    ["extra carrier delta", 3, () => Buffer.from(`${PHASE3_HARDENING_FIXED_CARRIER_PATH}\nextra.txt\n`, "utf8")],
    ["wrong mode", 4, () => Buffer.from(`100755 ${"e".repeat(40)} 0\t${PHASE3_HARDENING_FIXED_CARRIER_PATH}\n`, "utf8")],
    ["wrong blob", 4, () => Buffer.from(`100644 ${"f".repeat(40)} 0\t${PHASE3_HARDENING_FIXED_CARRIER_PATH}\n`, "utf8")],
    ["carrier bytes", 5, () => Buffer.from("different carrier bytes", "utf8")],
  ];
  for (const [name, ordinal, makeOutput] of faults) {
    await context.test(name, async () => {
      const fixture = makeControllerFixture();
      const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
      overrideSidecarOutput(fake, ordinal, makeOutput(fixture));
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

test("raw lineage framing hostiles reach guard 2 and stop before the marker without retry", async (context) => {
  const fixture = makeControllerFixture();
  const canonical = encodeLineageOutput(runtimeLineage(fixture.carrier));
  const firstNul = canonical.indexOf(0x00);
  assert.ok(firstNul > 0);
  const vectors: Array<[string, () => Buffer]> = [
    ["495 truncated", () => canonical.subarray(0, canonical.byteLength - 1)],
    ["497 suffix", () => Buffer.concat([canonical, Buffer.from([0x00])])],
    ["missing P record", () => Buffer.concat([canonical.subarray(0,124),canonical.subarray(248)])],
    ["P/A reordered", () => Buffer.concat([canonical.subarray(0,124),canonical.subarray(248,372),canonical.subarray(124,248),canonical.subarray(372)])],
    ["P raw commit drift", () => {const bytes=Buffer.from(canonical);bytes[124]=0x66;return bytes;}],
    ["P raw tree drift", () => {const bytes=Buffer.from(canonical);bytes[165]=0x66;return bytes;}],
    ["P raw parent drift", () => {const bytes=Buffer.from(canonical);bytes[206]=0x66;return bytes;}],
    ["prefix", () => Buffer.concat([Buffer.from([0x61]), canonical])],
    ["NUL replaced", () => { const bytes = Buffer.from(canonical); bytes[firstNul] = 0x58; return bytes; }],
    ["LF replaced", () => { const bytes = Buffer.from(canonical); bytes[123] = 0x58; return bytes; }],
    ["uppercase hex", () => { const bytes = Buffer.from(canonical); bytes[0] = 0x42; return bytes; }],
    ["non-hex", () => { const bytes = Buffer.from(canonical); bytes[0] = 0x67; return bytes; }],
    ["control byte", () => { const bytes = Buffer.from(canonical); bytes[0] = 0x01; return bytes; }],
  ];
  for (const [name, makeOutput] of vectors) {
    await context.test(name, async () => {
      const local = makeControllerFixture();
      const hostile = makeOutput();
      assert.notDeepEqual(hostile, canonical, "hostile lineage bytes must actually differ");
      const carrierBytes = encodeCarrier(local.carrier);
      const fake = makeFakeBoundary(local.carrier, carrierBytes, "success");
      overrideSidecarOutput(fake, 1, hostile);
      const result = await runPhase3HardeningController(
        carrierBytes,
        PHASE3_HARDENING_FIXED_CARRIER_PATH,
        fake.boundary,
      );
      assert.equal(result.outcome, "terminal-unknown");
      assert.equal(result.rustInvocationCount, 2);
      assert.equal(fake.rustInvocations.length, 2);
      assert.equal(result.attemptEvidenceBytes, 0);
    });
  }
});

test("UTF-8 and UTF-16 decoder ladder rejects BOM, malformed units, replacement, NUL, and unexpected stderr after evidence", async (context) => {
  const faults: Array<[string, number, Buffer]> = [
    ["UTF-8 BOM", 0, Buffer.from([0xef, 0xbb, 0xbf])],
    ["malformed UTF-8", 0, Buffer.from([0xc3, 0x28])],
    ["UTF-8 replacement", 0, Buffer.from("\uFFFD", "utf8")],
    ["UTF-8 NUL", 0, Buffer.from([0x00])],
    ["UTF-16 BOM", 6, Buffer.from([0xff, 0xfe, 0x41, 0x00])],
    ["odd UTF-16", 6, Buffer.from([0x41])],
    ["malformed UTF-16 surrogate", 6, Buffer.from([0x00, 0xd8, 0x41, 0x00])],
    ["UTF-16 replacement", 6, Buffer.from([0xfd, 0xff])],
    ["UTF-16 NUL", 6, Buffer.from([0x00, 0x00])],
  ];
  for (const [name, ordinal, output] of faults) {
    await context.test(name, async () => {
      const fixture = makeControllerFixture();
      if (ordinal >= 6) fixture.carrier.commands[ordinal].expected = rawExpectation(output, Buffer.alloc(0), 0);
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
  fixture.carrier.commands[6].request.argv = ["--terminate", "DecadansNeurobro"];
  fixture.carrier.commands[6].decoder = "silent-mutator";
  fixture.carrier.commands[6].semanticClass = "wsl-target-terminated";
  fixture.carrier.commands[6].expected = rawExpectation(Buffer.alloc(0), Buffer.alloc(0), 0);
  const bytes = encodeCarrier(fixture.carrier);
  const fake = makeFakeBoundary(fixture.carrier, bytes, "success");
  overrideSidecarOutput(fake, 6, Buffer.alloc(0));
  const result = await runPhase3HardeningController(bytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
  assert.equal(result.outcome, "known-clear");
  assert.equal(result.rustInvocationCount, 7);
  assert.equal(result.acceptedCommandCount, 7);
});

test("target terminate accepts only carrier-pinned strict UTF-16 output and keeps silent mutators silent", async (context) => {
  const success = Buffer.from("Fixture termination completed.\r\n", "utf16le");
  const changed = Buffer.from(success);
  changed[0] = changed[0]! ^ 1;
  const malformed = Buffer.from([0x00, 0xd8, 0x41, 0x00]);
  const cases = [
    { name: "exact nonempty UTF-16 success", decoder: "utf-16le-no-bom-strict", expected: success, output: success, clear: true },
    { name: "same length but different raw hash", decoder: "utf-16le-no-bom-strict", expected: success, output: changed, clear: false },
    { name: "different raw byte length", decoder: "utf-16le-no-bom-strict", expected: success, output: success.subarray(2), clear: false },
    { name: "pinned malformed UTF-16 still refuses", decoder: "utf-16le-no-bom-strict", expected: malformed, output: malformed, clear: false },
    { name: "silent mutator rejects even pinned nonempty output", decoder: "silent-mutator", expected: success, output: success, clear: false },
  ];
  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const fixture = makeControllerFixture();
      const command = fixture.carrier.commands[6];
      command.request.argv = ["--terminate", "DecadansNeurobro"];
      command.semanticClass = "wsl-target-terminated";
      command.decoder = entry.decoder;
      command.expected = rawExpectation(entry.expected, Buffer.alloc(0), 0);
      const bytes = encodeCarrier(fixture.carrier);
      const fake = makeFakeBoundary(fixture.carrier, bytes, "success");
      overrideSidecarOutput(fake, 6, entry.output);
      const result = await runPhase3HardeningController(bytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
      assert.equal(result.outcome, entry.clear ? "known-clear" : "terminal-unknown");
      assert.equal(result.acceptedCommandCount, entry.clear ? 7 : 6);
      assert.equal(result.rustInvocationCount, 7);
      assert.equal(fake.rustInvocations.length, 7);
      const observed = parseCanonicalProcessRequestBytes(fake.rustInvocations[6]!.bytes);
      assert.deepEqual(observed.argv, ["--terminate", "DecadansNeurobro"]);
      assert.equal(result.runnerTerminationRequestCount, 0);
      assert.equal(result.controllerKillCount, 0);
      assert.equal(result.retryAuthorized, false);
      assert.equal(result.cleanupAuthorized, false);
    });
  }
});

test("carrier-approved guest executable runs only behind the exact five-second internal timeout grammar", async () => {
  const fixture = makeControllerFixture();
  const output = Buffer.from("fixture-identity-clear\n", "utf8");
  fixture.carrier.guestExecutables = ["/usr/bin/systemctl", "/usr/bin/timeout"];
  fixture.carrier.commands[6].role = "wsl-guest";
  fixture.carrier.commands[6].decoder = "utf-8-no-bom-strict";
  fixture.carrier.commands[6].semanticClass = "guest-identity-probe";
  fixture.carrier.commands[6].request.argv = [
    "--distribution", "DecadansNeurobro", "--user", "root", "--exec",
    "/usr/bin/timeout", "--signal=TERM", "5s", "/usr/bin/systemctl", "show", "--property=Version",
  ];
  fixture.carrier.commands[6].expected = rawExpectation(output, Buffer.alloc(0), 0);
  const bytes = encodeCarrier(fixture.carrier);
  const fake = makeFakeBoundary(fixture.carrier, bytes, "success");
  overrideSidecarOutput(fake, 6, output);
  const result = await runPhase3HardeningController(bytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
  assert.equal(result.outcome, "known-clear");
  assert.equal(result.acceptedCommandCount, 7);
  assert.equal(fake.rustInvocations.length, 7);
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
    assert.equal(result.rustInvocationCount, 6);
    assert.equal(fake.writes.length, 7);
    assert.equal(fake.rustInvocations.length, 6);
  });

  await context.test("sidecar throw after marker", async () => {
    const fixture = makeControllerFixture();
    const fake = makeFakeBoundary(fixture.carrier, fixture.carrierBytes, "success");
    throwSidecarAt(fake, 6, 1);
    const result = await runPhase3HardeningController(fixture.carrierBytes, PHASE3_HARDENING_FIXED_CARRIER_PATH, fake.boundary);
    assert.equal(result.outcome, "terminal-unknown");
    assert.equal(result.rustInvocationCount, 7);
    assert.equal(result.runnerTerminationRequestCount, 1);
    assert.ok(result.attemptEvidenceBytes > 0);
    assert.equal(fake.rustInvocations.length, 7);
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
  assert.equal(receipt.commands.length, 7);
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
  const controllerCommit = LINEAGE_PREFIX[0][1];
  const controllerTree = LINEAGE_PREFIX[0][2];
  const lineageBindings = [ACCEPTED_C1, TEST_P, TEST_A, {commit:TEST_K.commit,tree:TEST_K.tree,parent:TEST_K.parent}];
  const runner = binding(FIXTURE_RUNNER_PATH, truthfulBoundFileContent(FIXTURE_RUNNER_PATH));
  const git = binding(GIT_PATH, truthfulBoundFileContent(GIT_PATH));
  const wsl = binding(WSL_PATH, truthfulBoundFileContent(WSL_PATH));
  const node = binding(FIXTURE_NODE_PATH, truthfulBoundFileContent(FIXTURE_NODE_PATH));
  const liveEntry = binding(FIXTURE_LIVE_ENTRY_PATH, truthfulBoundFileContent(FIXTURE_LIVE_ENTRY_PATH));
  const launcher = binding(FIXTURE_LAUNCHER_PATH, truthfulBoundFileContent(FIXTURE_LAUNCHER_PATH));
  const observer = binding(FIXTURE_OBSERVER_PATH, truthfulBoundFileContent(FIXTURE_OBSERVER_PATH));
  const controllerBindings = {
    commit: controllerCommit,
    tree: controllerTree,
    verdict: "WHOLE_PHASE3_CONTROLLER_BOUNDARY_CLEAR",
    source: {path:CONTROLLER_SOURCE_PATH,bytes:53287,sha256:"7962896074F424E4BEA233F662B3DBAF90EC1386F515114E77342636F5D72E48"},
    test: {path:CONTROLLER_TEST_PATH,bytes:61636,sha256:"8B81031C14EBB6E8ECA57D98F2946B6924A526213B018390942C98E03B0CADC8"},
    receipt: {
      ...binding(CONTROLLER_RECEIPT_PATH, truthfulBoundFileContent(CONTROLLER_RECEIPT_PATH)),
      outcome: "candidate-clear/repo-only-controller-boundary",
      selfAcceptanceClaimed: false,
    },
  };
  const authorizationId = "A1111111-1111-4111-8111-111111111111";
  const attemptEvidencePath = `${operationRoot}\\phase3-hardening-controller.attempt.json`;
  const gitArgv = runtimeGitGuardArgv({repositoryBinding:{root:repositoryRoot,acceptedP:TEST_P,acceptedA:TEST_A}});
  const gitOutputs = [
    Buffer.alloc(0),
    encodeLineageOutput(lineageBindings),
    rawDelta(PHASE3B_AUTHORITY_PATHS,"M"),
    rawDelta([PHASE3_HARDENING_FIXED_CARRIER_PATH],"A"),
    Buffer.from(`100644 ${TEST_K.carrierBlobId} 0\t${PHASE3_HARDENING_FIXED_CARRIER_PATH}\n`, "utf8"),
    Buffer.alloc(0),
  ];
  const commands = gitArgv.map((argv, index) => makeCommand({
    ordinal: index,
    role: "git-guard",
    decoder: index === 1 || index === 5 ? "raw-hash-only" : "utf-8-no-bom-strict",
    semanticClass: GIT_GUARD_SEMANTICS[index]!,
    operationRoot,
    authorizationId: operationUuid(index),
    executable: git,
    argv,
    stdout: gitOutputs[index]!,
  }));
  commands.push(makeCommand({
    ordinal: 6,
    role: "wsl-management",
    decoder: "utf-16le-no-bom-strict",
    semanticClass: "wsl-version-observed",
    operationRoot,
    authorizationId: operationUuid(6),
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
    productionBindings: {
      node,
      liveEntry,
      launcher,
      observer,
      observerEvidenceRootAbsolutePath: "C:\\fixture\\observer-evidence",
    },
    repositoryBinding: {root:repositoryRoot, acceptedC1: {...ACCEPTED_C1}, acceptedP:{...TEST_P},acceptedA:{...TEST_A}},
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
  for (let index=0;index<6;index++) carrier.commands[index].expected = {
    exitCode:0, stdoutBinding:GIT_GUARD_BINDINGS[index], stderrBytes:0, stderrSha256:sha256Hex(Buffer.alloc(0)).toUpperCase()
  };
  const carrierBytes = encodeCarrier(carrier);
  return { carrier, carrierBytes };
}

function encodeLineageOutput(bindings: Array<{ commit: string; tree: string; parent: string }>): Buffer {
  const output = Buffer.concat(bindings.map((entry) => Buffer.from(`${entry.commit}\0${entry.tree}\0${entry.parent}\0\n`, "ascii")));
  assert.equal(output.byteLength, 496);
  return output;
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
    environment: input.role === "git-guard"
      ? { inherit: false, allowlist: [], values: {} }
      : { inherit: false, allowlist: ["SystemRoot", "WINDIR"], values: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" } },
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
    carrier.productionBindings.node,
    carrier.productionBindings.liveEntry,
    carrier.productionBindings.launcher,
    carrier.productionBindings.observer,
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
        return fileObservation(path, resolveRuntimeFilePath(carrier.repositoryBinding.root, path), carrierBytes);
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
        win32.isAbsolute(path) ? path : resolveRuntimeFilePath(carrier.repositoryBinding.root, path),
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
      return encodeLineageOutput(runtimeLineage(carrier));
    case 2:
      return rawDelta(PHASE3B_AUTHORITY_PATHS,"M");
    case 3:
      return rawDelta([PHASE3_HARDENING_FIXED_CARRIER_PATH],"A");
    case 4:
      return Buffer.from(
        `100644 ${TEST_K.carrierBlobId} 0\t${PHASE3_HARDENING_FIXED_CARRIER_PATH}\n`,
        "utf8",
      );
    case 5:
      return carrierBytes;
    case 6:
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

test("independent startup pins are mandatory and drift refuses before marker or WSL", async (context) => {
  for (const [name, change, expectedCalls] of [
    ["missing bytes", (_value:any)=>Buffer.alloc(0),0],
    ["extra startup property", (value:any)=>{value.extra=true;return Buffer.from(canonicalizeJson(value));},0],
    ["P identity substitution", (value:any)=>{value.acceptedGeneration.p.tree="f".repeat(40);return Buffer.from(canonicalizeJson(value));},0],
    ["carrier byte pin drift", (value:any)=>{value.carrier.sha256="F".repeat(64);return Buffer.from(canonicalizeJson(value));},0],
    ["accepted K tree disagreement", (value:any)=>{value.acceptedGeneration.k.tree="f".repeat(40);return Buffer.from(canonicalizeJson(value));},2],
    ["accepted K blob disagreement", (value:any)=>{value.acceptedGeneration.k.carrierBlobId="f".repeat(40);return Buffer.from(canonicalizeJson(value));},4],
  ] as Array<[string,(v:any)=>Buffer,number]>) {
    await context.test(name,async()=>{
      const fixture=makeControllerFixture();
      const baseline=fixtureStartupBytes(fixture.carrierBytes);
      const hostile=change(JSON.parse(baseline.toString("utf8")));
      assert.notDeepEqual(hostile,baseline);
      const fake=makeFakeBoundary(fixture.carrier,fixture.carrierBytes,"success");
      const result=await runControllerProduction(fixture.carrierBytes,PHASE3_HARDENING_FIXED_CARRIER_PATH,fake.boundary,hostile);
      assert.notEqual(result.outcome,"known-clear");
      assert.equal(fake.rustInvocations.length,expectedCalls);
      assert.equal(result.attemptEvidenceBytes,0);
      assert.equal(fake.rustInvocations.some(invocation=>parseCanonicalProcessRequestBytes(invocation.bytes).executable.path===WSL_PATH),false);
    });
  }
});

test("current accepted-C1 extracted sources are not mistaken for historical Phase3A/C0 bytes",async()=>{
  const adapterPath="packages/rm0032-phase3-runner/src/rust-sidecar-adapter.ts";
  const actualAdapter=readFileSync(new URL(adapterPath,REPOSITORY_ROOT_URL));
  const actualController=readFileSync(new URL(CONTROLLER_SOURCE_PATH,REPOSITORY_ROOT_URL));
  assert.equal(actualAdapter.length,26741);
  assert.notEqual(actualAdapter.length,PHASE3A_ARTIFACTS.find(b=>b.path===adapterPath)!.bytes);
  assert.notEqual(actualController.length,53287);
  const fixture=makeControllerFixture();
  const fake=makeFakeBoundary(fixture.carrier,fixture.carrierBytes,"poison");
  const original=fake.boundary.readBoundFile.bind(fake.boundary);
  fake.boundary.readBoundFile=async path=>{
    if(path===adapterPath || path===CONTROLLER_SOURCE_PATH) {
      const bytes=path===adapterPath?actualAdapter:actualController;
      return fileObservation(path,resolveRuntimeFilePath(fixture.carrier.repositoryBinding.root,path),bytes);
    }
    return original(path);
  };
  const result=await runPhase3HardeningController(fixture.carrierBytes,PHASE3_HARDENING_FIXED_CARRIER_PATH,fake.boundary);
  assert.equal(result.rustInvocationCount,1);
  assert.equal(result.attemptEvidenceBytes,0);
  for(const historical of [adapterPath,CONTROLLER_SOURCE_PATH,CONTROLLER_TEST_PATH]) assert.equal(fake.reads.includes(historical),false);
  for(const required of [PHASE3_HARDENING_FIXED_CARRIER_PATH,PHASE2_RECEIPT.path,fixture.carrier.predecessorBindings.phase3A.receipt.path,fixture.carrier.predecessorBindings.phase3A.decision.path,fixture.carrier.controllerBindings.receipt.path]) assert.ok(fake.reads.includes(required),required);
});
