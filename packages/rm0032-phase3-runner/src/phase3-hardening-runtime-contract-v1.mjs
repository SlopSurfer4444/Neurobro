// Pure P runtime policy. Structural evidence is never independent acceptance.
import { createHash } from "node:crypto";
import { win32 } from "node:path";

export const ACCEPTED_C1 = Object.freeze({commit:"dad22e37dc12da1ffbf3f1cdf961db6e49da305d",tree:"c02022c8175368a60384b327cceccc7f00c9290a",parent:"a81bc769c44582a801cc62986e3d5f58f945d72d"});
export const CARRIER_SCHEMA = "decadans.rm0032.phase3-hardening-carrier.v16";
export const STARTUP_SCHEMA = "decadans.rm0032.accepted-startup-launchbinding.v2";
export const STARTUP_BINDING_PATH = "C:\\ProgramData\\DecadansNeurobro\\startup-trust-v1\\accepted-launchbinding-v1.json";
export const FIXED_CARRIER_PATH = "project/verification/rm-0032-phase3-live-hardening-carrier.json";
export const FIXED_STARTUP_BINDING_PATH = STARTUP_BINDING_PATH;
export const EXACT_P_DELTA = deepFreeze([
  {
    "path": "AGENTS.md",
    "status": "M"
  },
  {
    "path": "project/implementation-plan.md",
    "status": "M"
  },
  {
    "path": "project/project-state.md",
    "status": "M"
  },
  {
    "path": "project/roadmap.md",
    "status": "M"
  },
  {
    "path": "project/verification/repo-native-continuation.test.mjs",
    "status": "M"
  },
  {
    "path": "project/verification/rm-0032-persistent-wsl2-subscription-only-gate-matrix.json",
    "status": "M"
  },
  {
    "path": "project/verification/rm-0032-persistent-wsl2-subscription-only-gate-matrix.test.mjs",
    "status": "M"
  },
  {
    "path": "packages/rm0032-phase3-runner/src/phase3-hardening-controller-v2.ts",
    "status": "M"
  },
  {
    "path": "packages/rm0032-phase3-runner/test/phase3-hardening-controller-v2.test.ts",
    "status": "M"
  },
  {
    "path": "packages/rm0032-phase3-runner/src/phase3-hardening-bootstrap-v1.ts",
    "status": "M"
  },
  {
    "path": "packages/rm0032-phase3-runner/test/phase3-hardening-bootstrap-v1.test.ts",
    "status": "M"
  },
  {
    "path": "packages/rm0032-phase3-runner/src/phase3-hardening-live-entry.mjs",
    "status": "M"
  },
  {
    "path": "packages/rm0032-phase3-runner/test/phase3-hardening-live-entry.test.ts",
    "status": "M"
  },
  {
    "path": "crates/rm0032-phase3-native-observer-launcher-v1/Cargo.toml",
    "status": "M"
  },
  {
    "path": "crates/rm0032-phase3-native-observer-launcher-v1/src/main.rs",
    "status": "M"
  },
  {
    "path": "packages/rm0032-phase3-runner/src/phase3-hardening-runtime-contract-v1.mjs",
    "status": "A"
  },
  {
    "path": "packages/rm0032-phase3-runner/src/phase3-hardening-runtime-contract-v1.d.mts",
    "status": "A"
  },
  {
    "path": "packages/rm0032-phase3-runner/test/phase3-hardening-runtime-contract-v1.test.mjs",
    "status": "A"
  },
  {
    "path": "crates/rm0032-phase3-native-observer-launcher-v1/src/native_startup_files.rs",
    "status": "A"
  },
  {
    "path": "crates/rm0032-phase3-native-observer-launcher-v1/src/bin/phase3-prestart-v1.rs",
    "status": "A"
  },
  {
    "path": "crates/rm0032-phase3-native-observer-launcher-v1/tests/prestart-contract-vectors.rs",
    "status": "A"
  },
  {
    "path": "crates/rm0032-phase3-native-observer-launcher-v1/tests/prestart-windows-native.rs",
    "status": "A"
  },
  {
    "path": "crates/rm0032-phase3-native-observer-launcher-v1/src/native_ledger_security.rs",
    "status": "A"
  },
  {
    "path": "crates/rm0032-phase3-native-observer-launcher-v1/src/native_launcher_privilege.rs",
    "status": "A"
  },
  {
    "path": "crates/rm0032-phase3-native-observer-launcher-v1/tests/launcher-windows-security.rs",
    "status": "A"
  },
  {
    "path": "crates/rm0032-phase3-native-observer-launcher-v1/tests/launcher-contract-vectors.rs",
    "status": "M"
  },
  {
    "path": "crates/rm0032-phase3-native-observer-v1/src/main.rs",
    "status": "M"
  },
  {
    "path": "crates/rm0032-phase3-native-observer-v1/tests/observer-contract-vectors.rs",
    "status": "M"
  },
  {
    "path": "packages/rm0032-phase3-runner/src/contract.ts",
    "status": "M"
  },
  {
    "path": "packages/rm0032-phase3-runner/test/contract.test.ts",
    "status": "M"
  },
  {
    "path": "crates/rm0032-phase3-runner/src/main.rs",
    "status": "M"
  },
  {
    "path": "project/verification/rm-0032-phase3-prestart-integration-acceptance-receipt.json",
    "status": "A"
  }
]);
export const EXACT_A_DELTA = deepFreeze(["project/implementation-plan.md","project/project-state.md","project/roadmap.md","project/verification/rm-0032-persistent-wsl2-subscription-only-gate-matrix.json","project/verification/rm-0032-persistent-wsl2-subscription-only-gate-matrix.test.mjs"].map(path => ({path,status:"M"})));
export const EXACT_K_DELTA = deepFreeze([{path:FIXED_CARRIER_PATH,status:"A"}]);
export const CARRIER_KEYS = deepFreeze({
  TOP_KEYS: [
  "schema", "phase", "fixedCarrierPath", "predecessorBindings", "controllerBindings",
  "binaryBindings", "productionBindings", "repositoryBinding", "policy", "review", "parentDecision",
  "authorization", "guestExecutables", "commands",
],
  PHASE_KEYS: ["id", "status", "subSlice", "autoContinue", "phase4Available"],
  PREDECESSOR_KEYS: ["phase2Receipt", "phase3A"],
  PHASE3A_KEYS: ["commit", "tree", "parent", "receipt", "decision", "verdict", "artifactBindings"],
  FILE_BINDING_KEYS: ["path", "bytes", "sha256"],
  CONTROLLER_KEYS: ["commit", "tree", "verdict", "source", "test", "receipt"],
  CONTROLLER_RECEIPT_KEYS: ["path", "bytes", "sha256", "outcome", "selfAcceptanceClaimed"],
  BINARY_KEYS: ["runner", "git", "wsl"],
  PRODUCTION_KEYS: ["node", "liveEntry", "launcher", "observer", "observerEvidenceRootAbsolutePath"],
  REPOSITORY_KEYS: ["root", "acceptedC1", "acceptedP", "acceptedA"],
  POLICY_KEYS: [
  "aggregateDeadlineMs", "commandCountMax", "decodedStreamBytesMax", "artifactStdinBytesEachMax",
  "artifactStdinBytesAggregateMax", "outerDeadlineGraceMs", "guestInternalTimeoutSeconds",
  "retryAuthorized", "cleanupAuthorized", "phaseAdvanceAuthorized", "phase4Authorized",
],
  REVIEW_KEYS: ["verdict", "independent", "controllerVerdict"],
  PARENT_DECISION_KEYS: ["decision", "stable"],
  AUTHORIZATION_KEYS: [
  "id", "oneShot", "retryAuthorized", "cleanupAuthorized", "phaseAdvanceAuthorized",
  "phase4Authorized", "attemptEvidencePath",
],
  COMMAND_KEYS: ["role", "decoder", "semanticClass", "requestPath", "request", "expected"],
  EXPECTED_RAW_KEYS: ["exitCode", "stdoutBytes", "stdoutSha256", "stderrBytes", "stderrSha256"],
  EXPECTED_CARRIER_KEYS: ["exitCode", "stdoutBinding", "stderrBytes", "stderrSha256"],
});
export const GIT_GUARD_BINDINGS = Object.freeze(["clean-status","accepted-c1-p-a-observed-k-lineage","p-to-a-exact-five","a-to-k-carrier-only","accepted-k-stage-zero-blob","exact-carrier-bytes"]);
export const GIT_GUARD_SEMANTICS = Object.freeze(["clean-status-index-worktree-and-untracked-output","config-stable-four-record-c1-p-a-k-lineage","p-to-a-diff-is-exact-five-authority-paths","a-to-k-diff-is-exact-carrier-only","carrier-is-one-stage0-mode100644-blob","head-carrier-bytes-and-sha256-equal-acknowledgment"]);
const EMPTY_SHA256 = sha256(new Uint8Array());
const OID = /^[0-9a-f]{40}$/u;
const SHA = /^[0-9A-F]{64}$/u;
const TUPLE_KEYS = ["commit","tree","parent"];
const FILE_KEYS = ["path","bytes","sha256"];
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function requireThat(ok, code) { if (!ok) fail(code); }
function deepFreeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key)+":"+canonicalJson(value[key])).join(",") + "}";
}
function equal(a,b,code) { requireThat(canonicalJson(a) === canonicalJson(b),code); }
export function exactRecord(value, keys, label) {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value),label+"-object-refused");
  equal(Object.keys(value).sort(),[...keys].sort(),label+"-keys-refused");
  return value;
}
export function parseCanonicalBytes(bytes, label="canonical") {
  requireThat(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 65536,label+"-size-refused");
  let text, value;
  try { text = new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes); value = JSON.parse(text); } catch { fail(label+"-json-refused"); }
  requireThat(!text.includes("\uFEFF") && canonicalJson(value) === text,label+"-canonical-refused");
  return value;
}
export function canonicalDosPath(value,label="path") {
  requireThat(typeof value === "string" && /^[A-Z]:\\/u.test(value) && !/[\x00-\x1f\x7f"<>|?*\uD800-\uDFFF]/u.test(value) && !value.includes("/") && win32.normalize(value) === value && !value.endsWith("\\") && value.slice(2).split("\\").filter(Boolean).every(part => !/[. ]$/u.test(part) && !part.includes(":")),label+"-refused");
  return value;
}
export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex").toUpperCase(); }
function tuple(value,label,extra=[]) { exactRecord(value,[...TUPLE_KEYS,...extra],label); for (const key of TUPLE_KEYS) requireThat(typeof value[key] === "string" && OID.test(value[key]),label+"-"+key+"-refused"); return value; }
function file(value,label,extra=[]) {
  exactRecord(value,[...FILE_KEYS,...extra],label);
  canonicalDosPath(value.path,label+"-path");
  requireThat(Number.isSafeInteger(value.bytes) && value.bytes > 0 && typeof value.sha256 === "string" && SHA.test(value.sha256),label+"-binding-refused");
  return value;
}
export function parseExternalStartupBinding(bytes) {
  const b=exactRecord(parseCanonicalBytes(bytes,"startup"),["schema","acceptanceId","acceptedGeneration","repositoryRoot","cwd","nativePrestart","node","liveEntry","carrier","launcher","observer","binaryBindings"],"startup");
  requireThat(b.schema === STARTUP_SCHEMA && typeof b.acceptanceId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(b.acceptanceId),"startup-schema-or-id-refused");
  canonicalDosPath(b.repositoryRoot,"startup-root"); requireThat(b.cwd === b.repositoryRoot,"startup-cwd-refused");
  const g=exactRecord(b.acceptedGeneration,["p","a","k"],"startup-generation");
  tuple(g.p,"startup-p"); tuple(g.a,"startup-a"); tuple(g.k,"startup-k",["carrierBlobId"]);
  requireThat(typeof g.k.carrierBlobId === "string" && OID.test(g.k.carrierBlobId),"startup-blob-refused");
  requireThat(g.p.parent === ACCEPTED_C1.commit && g.a.parent === g.p.commit && g.k.parent === g.a.commit && new Set([ACCEPTED_C1.commit,g.p.commit,g.a.commit,g.k.commit]).size === 4,"startup-chain-refused");
  for (const key of ["nativePrestart","liveEntry","carrier","launcher","observer"]) file(b[key],"startup-"+key);
  exactRecord(b.binaryBindings,CARRIER_KEYS.BINARY_KEYS,"startup-binaries");
  for (const key of CARRIER_KEYS.BINARY_KEYS) file(b.binaryBindings[key],"startup-binary-"+key);
  requireThat(b.binaryBindings.runner.path.toLowerCase().endsWith(".exe"),"startup-runner-extension-refused");
  requireThat(b.binaryBindings.git.path==="C:\\Program Files\\Git\\mingw64\\bin\\git.exe","startup-git-path-refused");
  requireThat(b.binaryBindings.wsl.path==="C:\\Program Files\\WSL\\wsl.exe","startup-wsl-path-refused");
  file(b.node,"startup-node",["version","platform","arch"]);
  equal([b.node.version,b.node.platform,b.node.arch],["v24.15.0","win32","x64"],"startup-runtime-refused");
  requireThat(win32.basename(b.node.path)==="node.exe","startup-node-name-refused");
  requireThat(b.liveEntry.path === win32.join(b.repositoryRoot,"packages","rm0032-phase3-runner","src","phase3-hardening-live-entry.mjs"),"startup-entry-path-refused");
  requireThat(b.carrier.path === win32.join(b.repositoryRoot,...FIXED_CARRIER_PATH.split("/")),"startup-carrier-path-refused");
  requireThat(new Set([...["nativePrestart","node","liveEntry","carrier","launcher","observer"].map(k=>b[k].path),...CARRIER_KEYS.BINARY_KEYS.map(k=>b.binaryBindings[k].path)].map(path=>path.toUpperCase())).size === 9,"startup-path-collision-refused");
  return deepFreeze(b);
}
export function parseRuntimeCarrier(bytes) {
  const c=exactRecord(parseCanonicalBytes(bytes,"carrier"),CARRIER_KEYS.TOP_KEYS,"carrier");
  requireThat(c.schema===CARRIER_SCHEMA && c.fixedCarrierPath===FIXED_CARRIER_PATH,"carrier-schema-refused");
  const pairs=[["phase","PHASE_KEYS"],["predecessorBindings","PREDECESSOR_KEYS"],["controllerBindings","CONTROLLER_KEYS"],["binaryBindings","BINARY_KEYS"],["productionBindings","PRODUCTION_KEYS"],["repositoryBinding","REPOSITORY_KEYS"],["policy","POLICY_KEYS"],["review","REVIEW_KEYS"],["parentDecision","PARENT_DECISION_KEYS"],["authorization","AUTHORIZATION_KEYS"]];
  for(const [key,schema] of pairs) exactRecord(c[key],CARRIER_KEYS[schema],key);
  const repo=c.repositoryBinding;
  canonicalDosPath(repo.root,"carrier-root");
  tuple(repo.acceptedC1,"carrier-c1"); equal(repo.acceptedC1,ACCEPTED_C1,"carrier-c1-anchor-refused");
  tuple(repo.acceptedP,"carrier-p"); tuple(repo.acceptedA,"carrier-a");
  requireThat(repo.acceptedP.parent===ACCEPTED_C1.commit && repo.acceptedA.parent===repo.acceptedP.commit && new Set([ACCEPTED_C1.commit,repo.acceptedP.commit,repo.acceptedA.commit]).size===3,"carrier-chain-refused");
  const nestedFile=(v,label,extra=[])=>exactRecord(v,[...FILE_KEYS,...extra],label);
  nestedFile(c.predecessorBindings.phase2Receipt,"phase2");
  const a=exactRecord(c.predecessorBindings.phase3A,CARRIER_KEYS.PHASE3A_KEYS,"phase3A");
  nestedFile(a.receipt,"phase3A-receipt"); nestedFile(a.decision,"phase3A-decision");
  requireThat(Array.isArray(a.artifactBindings),"phase3A-artifacts-refused"); a.artifactBindings.forEach((v,i)=>nestedFile(v,"artifact-"+i));
  nestedFile(c.controllerBindings.source,"controller-source"); nestedFile(c.controllerBindings.test,"controller-test"); nestedFile(c.controllerBindings.receipt,"controller-receipt",["outcome","selfAcceptanceClaimed"]);
  for(const key of CARRIER_KEYS.BINARY_KEYS) nestedFile(c.binaryBindings[key],"binary-"+key);
  for(const key of ["node","liveEntry","launcher","observer"]) file(c.productionBindings[key],"production-"+key);
  canonicalDosPath(c.productionBindings.observerEvidenceRootAbsolutePath,"observer-evidence-root");
  requireThat(Array.isArray(c.commands) && c.commands.length>=7 && c.commands.length<=48,"carrier-commands-refused");
  for(const [i,command] of c.commands.entries()) {
    exactRecord(command,CARRIER_KEYS.COMMAND_KEYS,"command-"+i);
    const expected=exactRecord(command.expected,i<6?CARRIER_KEYS.EXPECTED_CARRIER_KEYS:CARRIER_KEYS.EXPECTED_RAW_KEYS,"expected-"+i);
    requireThat(expected.stderrBytes===0 && expected.stderrSha256===EMPTY_SHA256,"expected-stderr-refused");
    const request=command.request;
    if(i<6) {
      requireThat(command.role==="git-guard" && command.semanticClass===GIT_GUARD_SEMANTICS[i] && expected.exitCode===0 && expected.stdoutBinding===GIT_GUARD_BINDINGS[i],"git-symbolic-expectation-refused");
      equal(request?.environment,{inherit:false,allowlist:[],values:{}},"git-environment-binding-refused");
    } else {
      requireThat(command.role==="wsl-management" || command.role==="wsl-guest","wsl-command-role-refused");
      requireThat(request?.executable?.path==="C:\\Program Files\\WSL\\wsl.exe" && request.executable.path===c.binaryBindings.wsl.path && typeof c.binaryBindings.wsl.sha256==="string" && request.executable.sha256===c.binaryBindings.wsl.sha256.toLowerCase(),"wsl-executable-binding-refused");
      equal(request.environment,{inherit:false,allowlist:["SystemRoot","WINDIR"],values:{SystemRoot:"C:\\Windows",WINDIR:"C:\\Windows"}},"wsl-environment-binding-refused");
    }
  }
  return c;
}
export function assertCarrierStartupAgreement(c, binding, bytes) {
  requireThat(binding.carrier.bytes===bytes.byteLength && binding.carrier.sha256===sha256(bytes),"startup-carrier-bytes-refused");
  requireThat(c.repositoryBinding.root===binding.repositoryRoot,"startup-root-binding-refused");
  equal(c.repositoryBinding.acceptedP,binding.acceptedGeneration.p,"startup-p-binding-refused");
  equal(c.repositoryBinding.acceptedA,binding.acceptedGeneration.a,"startup-a-binding-refused");
  // The owner-protected v2 binding is consumed by native startup with retained image
  // handles. This agreement is not native-origin authentication against the owner.
  equal(c.binaryBindings,binding.binaryBindings,"startup-binary-bindings-refused");
  for(const key of ["node","liveEntry","launcher","observer"]) {
    const {path,bytes:count,sha256:hash}=binding[key];
    equal(c.productionBindings[key],{path,bytes:count,sha256:hash},"startup-"+key+"-binding-refused");
  }
}
export function runtimeGitGuardArgv(c) {
  const root=c.repositoryBinding.root, p=c.repositoryBinding.acceptedP.commit, a=c.repositoryBinding.acceptedA.commit;
  const lead=["--no-pager","-C",root];
  return [
    [...lead,"status","--porcelain=v1","--untracked-files=all"],
    [...lead,"log","--no-walk=unsorted","--no-notes","--no-decorate","--no-show-signature","--color=never","--format=%H%x00%T%x00%P%x00",ACCEPTED_C1.commit,p,a,"HEAD"],
    [...lead,"diff","--raw","--no-abbrev","-z","--no-renames",p+".."+a,"--"],
    [...lead,"diff","--raw","--no-abbrev","-z","--no-renames",a+"..HEAD","--"],
    [...lead,"ls-files","--stage","--full-name","--",FIXED_CARRIER_PATH],
    [...lead,"show","HEAD:"+FIXED_CARRIER_PATH],
  ];
}
export function parseRuntimeLineage(raw) {
  requireThat(raw instanceof Uint8Array && raw.byteLength===496,"lineage-raw-length-refused");
  const text=Buffer.from(raw).toString("latin1");
  const result=[];
  for(let i=0;i<4;i++) {
    const match=/^([0-9a-f]{40})\0([0-9a-f]{40})\0([0-9a-f]{40})\0\n$/u.exec(text.slice(i*124,(i+1)*124));
    requireThat(match,"lineage-raw-framing-refused");
    result.push({commit:match[1],tree:match[2],parent:match[3]});
  }
  requireThat(new Set(result.map(t=>t.commit)).size===4,"lineage-commit-reuse-refused");
  for(let i=1;i<4;i++) requireThat(result[i].parent===result[i-1].commit,"lineage-parent-refused");
  equal(result[0],ACCEPTED_C1,"lineage-c1-anchor-refused");
  return result;
}
export function parseRawGitDelta(raw) {
  requireThat(raw instanceof Uint8Array && raw.byteLength>0 && raw.byteLength<=65536,"delta-size-refused");
  const text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(raw);
  requireThat(text.endsWith("\0"),"delta-framing-refused");
  const parts=text.slice(0,-1).split("\0"), rows=[];
  requireThat(parts.length%2===0,"delta-framing-refused");
  for(let i=0;i<parts.length;i+=2) {
    const match=/^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AM])$/u.exec(parts[i]);
    requireThat(match && parts[i+1] && !/[\x00-\x1f\x7f\\\\]/u.test(parts[i+1]),"delta-record-refused");
    const [,oldMode,mode,oldOid,oid,status]=match;
    requireThat(mode==="100644" && (status==="A" ? oldMode==="000000" && oldOid==="0".repeat(40) : oldMode==="100644" && oldOid!=="0".repeat(40)) && oid!=="0".repeat(40),"delta-mode-or-oid-refused");
    rows.push({path:parts[i+1],status,mode,type:"blob",oldOid,oid});
  }
  requireThat(new Set(rows.map(r=>r.path)).size===rows.length,"delta-duplicate-refused");
  return rows;
}
function sameDelta(actual,expected,label) {
  requireThat(Array.isArray(actual) && actual.length===expected.length && new Set(actual.map(r=>r.path)).size===actual.length,label+"-cardinality-refused");
  equal(actual.map(r=>({path:r.path,status:r.status})).sort((a,b)=>a.path.localeCompare(b.path)),expected.map(r=>({path:r.path,status:r.status})).sort((a,b)=>a.path.localeCompare(b.path)),label+"-paths-refused");
}
export function validateGitGuardOutput(index,raw,{carrier,binding,carrierBytes}) {
  requireThat(Number.isSafeInteger(index) && index>=0 && index<6,"git-guard-index-refused");
  const g=binding.acceptedGeneration;
  if(index===0) requireThat(raw.byteLength===0,"git-status-dirty");
  if(index===1) {
    const {carrierBlobId,...k}=g.k;
    equal(parseRuntimeLineage(raw),[ACCEPTED_C1,g.p,g.a,k],"lineage-external-binding-refused");
  }
  if(index===2 || index===3) {
    const rows=parseRawGitDelta(raw);
    sameDelta(rows,index===2?EXACT_A_DELTA:EXACT_K_DELTA,"git-delta");
    if(index===3) requireThat(rows[0].oid===g.k.carrierBlobId,"git-carrier-blob-refused");
  }
  if(index===4) requireThat(Buffer.from(raw).equals(Buffer.from("100644 "+g.k.carrierBlobId+" 0\t"+FIXED_CARRIER_PATH+"\n")),"git-carrier-stage-refused");
  if(index===5) requireThat(Buffer.from(raw).equals(Buffer.from(carrierBytes)) && sha256(raw)===binding.carrier.sha256,"git-carrier-bytes-refused");
}
export function classifyRuntimePosture(facts) {
  exactRecord(facts,["acceptedC1","commits","committedDeltas","head","trackedWorktreeDelta","untrackedPaths","cachedDelta","indexVisibilityClean","observePhysicalEntry","observeCommittedTreeEntry"],"posture");
  equal(facts.acceptedC1,ACCEPTED_C1,"posture-c1-anchor-refused");
  const {commits,committedDeltas}=facts;
  requireThat(Array.isArray(commits) && commits.length>=1 && commits.length<=4 && Array.isArray(committedDeltas) && committedDeltas.length===commits.length-1,"posture-chronology-refused");
  equal(commits[0],ACCEPTED_C1,"posture-c1-tuple-refused");
  requireThat(facts.head===commits.at(-1).commit && facts.indexVisibilityClean===true && Array.isArray(facts.cachedDelta) && facts.cachedDelta.length===0,"posture-head-or-index-refused");
  const deltas=[EXACT_P_DELTA,EXACT_A_DELTA,EXACT_K_DELTA];
  const roles=["C1","P","A","K"];
  const seen=new Set();
  for(let i=0;i<commits.length;i++) {
    tuple(commits[i],"posture-tuple");
    requireThat(!seen.has(commits[i].commit),"posture-repeated-commit-refused"); seen.add(commits[i].commit);
    if(i===0) continue;
    requireThat(commits[i].parent===commits[i-1].commit,"posture-parent-refused");
    sameDelta(committedDeltas[i-1],deltas[i-1],"posture-committed");
    for(const row of committedDeltas[i-1]) {
      exactRecord(row,["path","status","mode","type"],"posture-row");
      requireThat(row.mode==="100644" && row.type==="blob","posture-mode-type-refused");
      const entry=facts.observeCommittedTreeEntry(commits[i].commit,row.path);
      equal(entry,{path:row.path,mode:"100644",type:"blob"},"posture-committed-entry-refused");
    }
  }
  requireThat(Array.isArray(facts.trackedWorktreeDelta) && Array.isArray(facts.untrackedPaths),"posture-working-type-refused");
  if(facts.trackedWorktreeDelta.length===0 && facts.untrackedPaths.length===0) return roles[commits.length-1]+"_COMMIT_CLEAN";
  requireThat(commits.length<4,"posture-after-k-refused");
  const desired=deltas[commits.length-1];
  sameDelta(facts.trackedWorktreeDelta,desired.filter(r=>r.status==="M"),"posture-tracked");
  const newPaths=desired.filter(r=>r.status==="A").map(r=>r.path);
  equal([...facts.untrackedPaths].sort(),[...newPaths].sort(),"posture-untracked-refused");
  for(const row of desired) {
    const provenance=row.status==="M"?"tracked-modified":"untracked-new";
    const e=facts.observePhysicalEntry(row.path,provenance);
    requireThat(e && e.path===row.path && e.provenance===provenance,"posture-physical-path-refused");
    for(const key of ["exists","regularFile","realpathUnderRoot","canonicalRealpath","ancestryRegular","ancestryNonSymlink","ancestryNonReparse","ancestryOneLink","ancestryCanonicalRealpathUnderRoot"]) requireThat(e[key]===true,"posture-physical-"+key+"-refused");
    requireThat(e.symbolicLink===false && e.reparsePoint===false && e.linkCount===1,"posture-physical-form-refused");
  }
  return roles[commits.length]+"_WORKING_EXACT";
}
export function resolveRuntimeFilePath(repositoryRoot,path) {
  canonicalDosPath(repositoryRoot,"observer-root");
  requireThat(typeof path === "string" && path.length>0,"observer-target-path-refused");
  if(win32.isAbsolute(path)) return canonicalDosPath(path,"observer-target-path");
  requireThat(!path.includes("\\") && path.split("/").every(part=>part.length>0 && part!=="." && part!==".." && !/[\\:*?"<>|\x00-\x1f\x7f]/u.test(part) && !/[. ]$/u.test(part)),"observer-relative-path-refused");
  const target=win32.join(repositoryRoot,...path.split("/"));
  requireThat(target.startsWith(repositoryRoot+"\\"),"observer-containment-refused");
  return target;
}

export const RUNTIME_PROJECTIONS = deepFreeze({
  P: {checkpoint:"phase3-prestart-p-integration-v1",status:"offline-authoring-active",writeDelta:EXACT_P_DELTA},
  K: {checkpoint:"phase3-prestart-k-carrier-authoring-v1",status:"offline-carrier-authoring-at-independently-accepted-a-no-live-authority",writeDelta:EXACT_K_DELTA},
});
const POSTURE_PROJECTION = Object.freeze({
  C1_COMMIT_CLEAN:"P", P_WORKING_EXACT:"P", P_COMMIT_CLEAN:"P",
  A_WORKING_EXACT:"K", A_COMMIT_CLEAN:"K", K_WORKING_EXACT:"K", K_COMMIT_CLEAN:"K",
});
export function assertRuntimeProjection(posture,node) {
  requireThat(typeof posture==="string" && Object.hasOwn(POSTURE_PROJECTION,posture),"runtime-projection-posture-refused");
  requireThat(typeof node==="string" && (node==="P" || node==="K") && POSTURE_PROJECTION[posture]===node,"runtime-projection-node-refused");
  return RUNTIME_PROJECTIONS[node];
}
