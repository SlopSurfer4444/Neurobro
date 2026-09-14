import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { join, dirname, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ACCEPTED_C1, CARRIER_SCHEMA, STARTUP_SCHEMA, FIXED_CARRIER_PATH, STARTUP_BINDING_PATH,
  EXACT_P_DELTA, EXACT_A_DELTA, EXACT_K_DELTA, CARRIER_KEYS, GIT_GUARD_BINDINGS,
  GIT_GUARD_SEMANTICS, canonicalJson, sha256, parseRuntimeCarrier, parseExternalStartupBinding,
  assertCarrierStartupAgreement, runtimeGitGuardArgv, parseRuntimeLineage, parseRawGitDelta,
  validateGitGuardOutput, classifyRuntimePosture, RUNTIME_PROJECTIONS, assertRuntimeProjection,
} from "../src/phase3-hardening-runtime-contract-v1.mjs";

const FIXTURE_ROOT = "D:\\CodexScratch\\DecadansNeurobro\\phase3-prestart-p-g2-js-fixtures-20260905";
const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const GIT = "C:\\Program Files\\Git\\mingw64\\bin\\git.exe";
const empty = sha256(Buffer.alloc(0));
const encoded = value => Buffer.from(canonicalJson(value));
const shape = (keys, overrides={}) => Object.assign(Object.fromEntries(keys.map(k=>[k,null])),overrides);
const ordinary = path => ({path,bytes:1,sha256:"A".repeat(64)});
const wslEnvironment = () => ({inherit:false,allowlist:["SystemRoot","WINDIR"],values:{SystemRoot:"C:\\Windows",WINDIR:"C:\\Windows"}});
const physical = (path,provenance) => ({path,provenance,exists:true,regularFile:true,symbolicLink:false,reparsePoint:false,linkCount:1,realpathUnderRoot:true,canonicalRealpath:true,ancestryRegular:true,ancestryNonSymlink:true,ancestryNonReparse:true,ancestryOneLink:true,ancestryCanonicalRealpathUnderRoot:true});

function carrierFor(root,p,a) {
  const file=ordinary("C:\\fixture\\input");
  const c=shape(CARRIER_KEYS.TOP_KEYS,{
    schema:CARRIER_SCHEMA,fixedCarrierPath:FIXED_CARRIER_PATH,
    phase:shape(CARRIER_KEYS.PHASE_KEYS),
    predecessorBindings:{phase2Receipt:file,phase3A:shape(CARRIER_KEYS.PHASE3A_KEYS,{receipt:file,decision:file,artifactBindings:[]})},
    controllerBindings:shape(CARRIER_KEYS.CONTROLLER_KEYS,{source:file,test:file,receipt:{...file,outcome:"historical",selfAcceptanceClaimed:false}}),
    binaryBindings:{runner:ordinary("C:\\fixture\\runner.exe"),git:ordinary(GIT),wsl:ordinary("C:\\Program Files\\WSL\\wsl.exe")},
    productionBindings:{
      node:ordinary("C:\\fixture\\node.exe"),
      liveEntry:ordinary(win32.join(root,"packages","rm0032-phase3-runner","src","phase3-hardening-live-entry.mjs")),
      launcher:ordinary("C:\\fixture\\launcher.exe"),observer:ordinary("C:\\fixture\\observer.exe"),
      observerEvidenceRootAbsolutePath:"C:\\fixture\\observer-evidence"},
    repositoryBinding:{root,acceptedC1:{...ACCEPTED_C1},acceptedP:p,acceptedA:a},
    policy:shape(CARRIER_KEYS.POLICY_KEYS),review:shape(CARRIER_KEYS.REVIEW_KEYS),
    parentDecision:shape(CARRIER_KEYS.PARENT_DECISION_KEYS),authorization:shape(CARRIER_KEYS.AUTHORIZATION_KEYS),
    guestExecutables:[],commands:[],
  });
  c.commands=runtimeGitGuardArgv(c).map((argv,i)=>({role:"git-guard",decoder:"raw-hash-only",semanticClass:GIT_GUARD_SEMANTICS[i],requestPath:"C:\\fixture\\request-"+i,request:{argv,environment:{inherit:false,allowlist:[],values:{}}},expected:{exitCode:0,stdoutBinding:GIT_GUARD_BINDINGS[i],stderrBytes:0,stderrSha256:empty}}));
  c.commands.push({role:"wsl-management",decoder:"utf-16le-no-bom-strict",semanticClass:"fixture-never-executed",requestPath:"C:\\fixture\\request-6",request:{executable:{path:c.binaryBindings.wsl.path,sha256:c.binaryBindings.wsl.sha256.toLowerCase()},environment:wslEnvironment()},expected:{exitCode:0,stdoutBytes:0,stdoutSha256:empty,stderrBytes:0,stderrSha256:empty}});
  return c;
}
function startupFor(c,k,bytes) {
  return {schema:STARTUP_SCHEMA,acceptanceId:"12345678-1234-4123-8123-123456789abc",
    acceptedGeneration:{p:c.repositoryBinding.acceptedP,a:c.repositoryBinding.acceptedA,k},
    repositoryRoot:c.repositoryBinding.root,cwd:c.repositoryBinding.root,
    nativePrestart:ordinary("C:\\fixture\\native-prestart.exe"),
    node:{...c.productionBindings.node,version:"v24.15.0",platform:"win32",arch:"x64"},
    liveEntry:c.productionBindings.liveEntry,carrier:{path:win32.join(c.repositoryBinding.root,...FIXED_CARRIER_PATH.split("/")),bytes:bytes.length,sha256:sha256(bytes)},
    launcher:c.productionBindings.launcher,observer:c.productionBindings.observer,binaryBindings:c.binaryBindings};
}

test("actual Git constructs P then A then prewritten carrier-only K without any fixed-point computation", () => {
  mkdirSync(FIXTURE_ROOT,{recursive:true});
  const root=mkdtempSync(join(FIXTURE_ROOT,"constructible-"));
  const sourceObjects=execFileSync(GIT,["-C",SOURCE,"rev-parse","--git-path","objects"],{encoding:"utf8",windowsHide:true}).trim();
  const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,
    GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"NUL",GIT_TERMINAL_PROMPT:"0",
    GIT_ALTERNATE_OBJECT_DIRECTORIES:resolve(SOURCE,sourceObjects),
    GIT_AUTHOR_NAME:"Offline Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",
    GIT_COMMITTER_NAME:"Offline Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid",
    GIT_AUTHOR_DATE:"2001-01-01T00:00:00Z",GIT_COMMITTER_DATE:"2001-01-01T00:00:00Z"};
  const git=(args,input) => execFileSync(GIT,["--no-pager","-C",root,...args],{env,input,windowsHide:true,maxBuffer:16000000});
  git(["init","--quiet"]);
  git(["read-tree","--reset","-u",ACCEPTED_C1.commit]);
  git(["update-ref","HEAD",ACCEPTED_C1.commit]);
  const tupleOf=commit=>{ const [observed,tree,...parents]=git(["show","-s","--format=%H%n%T%n%P",commit]).toString().trim().split(/\r?\n/u); assert.equal(parents.length,1); assert.match(parents[0],/^[0-9a-f]{40}$/u); return {commit:observed,tree,parent:parents[0]}; };
  const deltas=[];
  const commits=[tupleOf(ACCEPTED_C1.commit)];
  const observeCommittedTreeEntry=(commit,path)=>{
    const record=git(["ls-tree",commit,"--",path]).toString().trim();
    const m=/^(\d{6}) (blob) [0-9a-f]{40}\t(.+)$/u.exec(record); assert.ok(m);
    return {path:m[3],mode:m[1],type:m[2]};
  };
  const facts=()=>({
    acceptedC1:{...ACCEPTED_C1},commits:[...commits],committedDeltas:[...deltas],
    head:git(["rev-parse","HEAD"]).toString().trim(),trackedWorktreeDelta:[],untrackedPaths:[],cachedDelta:[],
    indexVisibilityClean:true,observePhysicalEntry:(path,provenance)=>{
      const abs=join(root,...path.split("/")); const stat=lstatSync(abs);
      return {...physical(path,provenance),exists:true,regularFile:stat.isFile(),symbolicLink:stat.isSymbolicLink(),linkCount:stat.nlink,realpathUnderRoot:realpathSync(abs).startsWith(root+win32.sep)};
    },observeCommittedTreeEntry,
  });
  const author=(delta,role,carrierBytes)=>{
    for(const row of delta) {
      const path=join(root,...row.path.split("/"));mkdirSync(dirname(path),{recursive:true});
      writeFileSync(path,carrierBytes ?? Buffer.from("offline synthetic "+role+" "+row.path+"\n"));
    }
    const working=facts();
    working.trackedWorktreeDelta=delta.filter(r=>r.status==="M");
    working.untrackedPaths=delta.filter(r=>r.status==="A").map(r=>r.path);
    assert.equal(classifyRuntimePosture(working),role+"_WORKING_EXACT");
    assertRuntimeProjection(classifyRuntimePosture(working),role==="P"?"P":"K");
    for(const [key,value] of [["regularFile",false],["symbolicLink",true],["reparsePoint",true],["linkCount",2],["realpathUnderRoot",false],["ancestryNonReparse",false]]) {
      let observed=0;
      const hostile={...working,observePhysicalEntry:(path,provenance)=>{
        const result=working.observePhysicalEntry(path,provenance);
        if(path===delta[0].path) {observed++;result[key]=value;}
        return result;
      }};
      assert.throws(()=>classifyRuntimePosture(hostile),undefined,role+"-"+key);
      assert.ok(observed>0,"actual physical observer seam must be exercised");
    }
    assert.throws(()=>classifyRuntimePosture({...working,indexVisibilityClean:false}));
    assert.throws(()=>classifyRuntimePosture({...working,cachedDelta:[delta[0]]}));
    assert.throws(()=>classifyRuntimePosture({...working,untrackedPaths:[...working.untrackedPaths,"unexpected-extra"]}));
    git(["-c","core.autocrlf=false","add","--",...delta.map(r=>r.path)]);
    const tree=git(["write-tree"]).toString().trim();
    const parent=commits.at(-1).commit;
    const commit=git(["commit-tree",tree,"-p",parent],Buffer.from("offline synthetic "+role+"\n")).toString().trim();
    git(["update-ref","HEAD",commit]);
    const records=parseRawGitDelta(git(["diff","--raw","--no-abbrev","-z","--no-renames",parent+".."+commit,"--"]));
    deltas.push(records.map(({path,status,mode,type})=>({path,status,mode,type})));
    commits.push(tupleOf(commit));
    assert.equal(git(["status","--porcelain=v1","--untracked-files=all"]).length,0);
    assert.equal(classifyRuntimePosture(facts()),role+"_COMMIT_CLEAN");
    assertRuntimeProjection(classifyRuntimePosture(facts()),role==="P"?"P":"K");
    return commits.at(-1);
  };
  assert.equal(classifyRuntimePosture(facts()),"C1_COMMIT_CLEAN");
  const p=author(EXACT_P_DELTA,"P");
  const a=author(EXACT_A_DELTA,"A");
  const carrier=carrierFor(root,p,a),bytes=encoded(carrier);
  parseRuntimeCarrier(bytes);
  const beforeHash=sha256(bytes);
  const k=author(EXACT_K_DELTA,"K",bytes);
  const blob=git(["rev-parse","HEAD:"+FIXED_CARRIER_PATH]).toString().trim();
  const startup=startupFor(carrier,{...k,carrierBlobId:blob},bytes);
  const startupBytes=encoded(startup),binding=parseExternalStartupBinding(startupBytes);
  assertCarrierStartupAgreement(carrier,binding,bytes);
  assert.equal(sha256(readFileSync(join(root,...FIXED_CARRIER_PATH.split("/")))),beforeHash);
  for(const secret of [k.commit,k.tree,blob]) assert.equal(bytes.includes(Buffer.from(secret)),false);
  const outputs=runtimeGitGuardArgv(carrier).map(argv=>execFileSync(GIT,argv,{env,windowsHide:true,maxBuffer:1000000}));
  outputs.forEach((raw,index)=>validateGitGuardOutput(index,raw,{carrier,binding,carrierBytes:bytes}));
  assert.equal(parseRuntimeLineage(outputs[1])[3].commit,k.commit);
  const runGuards=out=>{
    let count=0,marker=0,wsl=0;
    try { out.forEach((raw,index)=>{count++;validateGitGuardOutput(index,raw,{carrier,binding,carrierBytes:bytes});});marker++;wsl++; } catch {}
    return {count,marker,wsl};
  };
  for(const index of [0,1,2,3,4,5]) {
    const hostile=outputs.map(b=>Buffer.from(b));
    hostile[index]=Buffer.concat([hostile[index],Buffer.from("hostile")]);
    assert.notDeepEqual(hostile[index],outputs[index]);
    assert.deepEqual(runGuards(hostile),{count:index+1,marker:0,wsl:0});
  }
  for(const [index,change] of [
    [2,b=>Buffer.from(b.toString().replace("100644 100644","100644 100755"))],
    [3,b=>Buffer.from(b.toString().replace(" A\u0000"," M\u0000"))],
    [4,b=>Buffer.from(b.toString().replace(" 0\t"," 2\t"))],
    [1,b=>{const out=Buffer.from(b);out[165]=out[165]===97?98:97;return out;}],
  ]) {
    const hostile=outputs.map(b=>Buffer.from(b));hostile[index]=change(hostile[index]);
    assert.notDeepEqual(hostile[index],outputs[index]);
    assert.deepEqual(runGuards(hostile),{count:index+1,marker:0,wsl:0});
  }
  for(const mutate of [
    f=>{f.commits[3]={...f.commits[3],parent:ACCEPTED_C1.commit};},
    f=>{f.indexVisibilityClean=false;},
    f=>{f.cachedDelta=[{path:FIXED_CARRIER_PATH,status:"M"}];},
    f=>{f.untrackedPaths=["extra"];},
    f=>{f.committedDeltas[2]=[{path:FIXED_CARRIER_PATH,status:"A",mode:"120000",type:"blob"}];},
  ]) {const f=facts();f.commits=structuredClone(f.commits);f.committedDeltas=structuredClone(f.committedDeltas);mutate(f);assert.throws(()=>classifyRuntimePosture(f));}
  const vectors=[{name:"valid-actual-git",canonicalBytesBase64:startupBytes.toString("base64"),accepted:true}];
  const invalid=[
    ["extra", b=>{b.extra=true;}],["wrong-schema",b=>{b.schema="old";}],["upper-id",b=>{b.acceptanceId=b.acceptanceId.toUpperCase();}],
    ["missing-native",b=>{delete b.nativePrestart;}],["wrong-p-parent",b=>{b.acceptedGeneration.p.parent=b.acceptedGeneration.a.commit;}],
    ["wrong-a-parent",b=>{b.acceptedGeneration.a.parent=ACCEPTED_C1.commit;}],["wrong-k-parent",b=>{b.acceptedGeneration.k.parent=ACCEPTED_C1.commit;}],
    ["unknown-generation-key",b=>{b.acceptedGeneration.ownerSid="S-1-0-0";}],["missing-blob",b=>{delete b.acceptedGeneration.k.carrierBlobId;}],
    ["wrong-cwd",b=>{b.cwd="C:\\elsewhere";}],["wrong-version",b=>{b.node.version="v24.14.0";}],
    ["wrong-entry",b=>{b.liveEntry.path="C:\\elsewhere\\phase3-hardening-live-entry.mjs";}],
    ["wrong-carrier",b=>{b.carrier.path="C:\\elsewhere\\carrier.json";}],["lower-sha",b=>{b.node.sha256=b.node.sha256.toLowerCase();}],
    ["native-sha-array",b=>{b.nativePrestart.sha256=[b.nativePrestart.sha256];}],
    ["node-sha-array",b=>{b.node.sha256=[b.node.sha256];}],
    ["p-tree-array",b=>{b.acceptedGeneration.p.tree=[b.acceptedGeneration.p.tree];}],
    ["k-blob-array",b=>{b.acceptedGeneration.k.carrierBlobId=[b.acceptedGeneration.k.carrierBlobId];}],
    ["acceptance-id-array",b=>{b.acceptanceId=[b.acceptanceId];}],
    ["p-commit-array",b=>{b.acceptedGeneration.p.commit=[b.acceptedGeneration.p.commit];}],
    ["p-parent-array",b=>{b.acceptedGeneration.p.parent=[b.acceptedGeneration.p.parent];}],
    ["unsafe-size",b=>{b.node.bytes=9007199254740992;}],["node-extra",b=>{b.node.argv=[];}],["path-collision",b=>{b.observer.path=b.launcher.path;}],
  ];
  for(const [name,mutate] of invalid) {const b=structuredClone(startup);mutate(b);const hostile=encoded(b);assert.notDeepEqual(hostile,startupBytes);assert.throws(()=>parseExternalStartupBinding(hostile),undefined,name);vectors.push({name,canonicalBytesBase64:hostile.toString("base64"),accepted:false});}
  for(const [name,hostile] of [["bom",Buffer.concat([Buffer.from([239,187,191]),startupBytes])],["duplicate",Buffer.from(startupBytes.toString().replace('{"acceptanceId":','{"schema":"duplicate","acceptanceId":'))],["trailing",Buffer.concat([startupBytes,Buffer.from("\n")])]]) {
    assert.throws(()=>parseExternalStartupBinding(hostile));vectors.push({name,canonicalBytesBase64:hostile.toString("base64"),accepted:false});
  }
  const corpusPath=join(FIXTURE_ROOT,"startup-wire-vectors.json");
  writeFileSync(corpusPath,encoded(vectors));
  for(const vector of JSON.parse(readFileSync(corpusPath,"utf8"))) {
    const input=Buffer.from(vector.canonicalBytesBase64,"base64");
    if(vector.accepted) parseExternalStartupBinding(input);else assert.throws(()=>parseExternalStartupBinding(input));
  }
  writeFileSync(join(FIXTURE_ROOT,"latest-fixture-receipt.json"),encoded({root,commits,carrierBlobId:blob,carrierSha256:beforeHash,corpusPath,corpusSha256:sha256(readFileSync(corpusPath)),structuralOnly:true,productionExecution:false}));
  console.log("P_JS_FIXTURE_RETAINED "+root+"; corpus="+corpusPath+"; sha256="+sha256(readFileSync(corpusPath)));
});

test("current carrier requires empty Git and exact direct-WSL Windows environments",()=>{
  const p={commit:"1".repeat(40),tree:"2".repeat(40),parent:ACCEPTED_C1.commit};
  const a={commit:"3".repeat(40),tree:"4".repeat(40),parent:p.commit};
  const base=carrierFor("C:\\fixture\\repo",p,a);
  base.commands.push({...structuredClone(base.commands[6]),role:"wsl-guest",requestPath:"C:\\fixture\\request-7"});
  parseRuntimeCarrier(encoded(base));
  for(const command of base.commands.slice(0,6)) assert.deepEqual(command.request.environment,{inherit:false,allowlist:[],values:{}});
  assert.deepEqual(base.commands[6].request.environment,wslEnvironment());
  const cases=[
    ["empty WSL environment",c=>{c.commands[6].request.environment={inherit:false,allowlist:[],values:{}};}],
    ["empty later WSL guest environment",c=>{c.commands[7].request.environment={inherit:false,allowlist:[],values:{}};}],
    ["generic fixture environment on WSL",c=>{c.commands[6].request.environment={inherit:false,allowlist:["LANG"],values:{LANG:"C"}};}],
    ["missing environment",c=>{delete c.commands[6].request.environment;}],
    ["missing SystemRoot",c=>{c.commands[6].request.environment.allowlist=["WINDIR"];delete c.commands[6].request.environment.values.SystemRoot;}],
    ["missing WINDIR",c=>{c.commands[6].request.environment.allowlist=["SystemRoot"];delete c.commands[6].request.environment.values.WINDIR;}],
    ["wrong Windows directory",c=>{c.commands[6].request.environment.values.SystemRoot="C:\\Elsewhere";}],
    ["value casing",c=>{c.commands[6].request.environment.values.WINDIR="C:\\windows";}],
    ["name casing",c=>{c.commands[6].request.environment.allowlist=["SystemRoot","windir"];}],
    ["inherited environment",c=>{c.commands[6].request.environment.inherit=true;}],
    ["duplicate names",c=>{c.commands[6].request.environment.allowlist.push("WINDIR");}],
    ["unsorted names",c=>{c.commands[6].request.environment.allowlist.reverse();}],
    ["values-key mismatch",c=>{delete c.commands[6].request.environment.values.WINDIR;}],
    ["unlisted value",c=>{c.commands[6].request.environment.values.PATH="C:\\Windows";}],
    ["extra environment property",c=>{c.commands[6].request.environment.extra=false;}],
    ["request hash differs from carrier",c=>{c.commands[6].request.executable.sha256="b".repeat(64);}],
    ["carrier hash differs from request",c=>{c.binaryBindings.wsl.sha256="B".repeat(64);}],
  ];
  for(const name of ["PATH","SystemDrive","RM0032_FIXTURE_MODE"]) cases.push(["extra WSL name "+name,c=>{
    const env=c.commands[6].request.environment;env.allowlist.push(name);env.allowlist.sort();env.values[name]="fixture";
  }]);
  for(const target of ["C:\\Windows\\System32\\wsl.exe","C:\\Windows\\SysWOW64\\wsl.exe","C:\\fixture\\wsl.exe",GIT]) cases.push(["wrong WSL target "+target,c=>{
    c.commands[6].request.executable.path=target;
  }]);
  for(let index=0;index<6;index++) {
    cases.push(["Windows pair on Git "+index,c=>{c.commands[index].request.environment=wslEnvironment();}]);
    cases.push(["generic environment on Git "+index,c=>{c.commands[index].request.environment={inherit:false,allowlist:["LANG"],values:{LANG:"C"}};}]);
  }
  for(const [name,mutate] of cases) {
    const hostile=structuredClone(base);mutate(hostile);
    assert.notDeepEqual(encoded(hostile),encoded(base),name);
    assert.throws(()=>parseRuntimeCarrier(encoded(hostile)),undefined,name);
  }
});

test("carrier schema forbids K self-identities and symbolic Git output hashes",()=>{
  const p={commit:"1".repeat(40),tree:"2".repeat(40),parent:ACCEPTED_C1.commit};
  const a={commit:"3".repeat(40),tree:"4".repeat(40),parent:p.commit};
  const base=carrierFor("C:\\fixture\\repo",p,a);
  parseRuntimeCarrier(encoded(base));
  for(const mutate of [
    c=>{c.schema="decadans.rm0032.phase3-hardening-carrier.v15";},
    c=>{c.repositoryBinding.carrierCommit="5".repeat(40);},
    c=>{c.repositoryBinding.carrierTree="6".repeat(40);},
    c=>{c.repositoryBinding.carrierBlobId="7".repeat(40);},
    c=>{c.lineageBindings=[{role:"K",commit:"5".repeat(40)}];},
    c=>{c.commands[1].expected.stdoutSha256="A".repeat(64);},
    c=>{c.commands[4].expected.stdoutSha256="A".repeat(64);},
    c=>{c.commands[5].expected.stdoutBytes=123;},
  ]) {const c=structuredClone(base);mutate(c);assert.notDeepEqual(c,base);assert.throws(()=>parseRuntimeCarrier(encoded(c)));}
  assert.equal(STARTUP_BINDING_PATH,"C:\\ProgramData\\DecadansNeurobro\\startup-trust-v1\\accepted-launchbinding-v1.json");
});

test("retained actual-Git startup wire parser agrees on forbidden Windows characters and Unicode",()=>{
  // Focused execution deliberately requires the retained, owning-test-generated
  // real-Git corpus. The aggregate creates it in its constructibility test first.
  const corpusPath=join(FIXTURE_ROOT,"startup-wire-vectors.json");
  const previous=JSON.parse(readFileSync(corpusPath,"utf8"));
  const valid=previous.find(vector=>vector.accepted);
  assert.ok(valid,"retained real-Git positive vector required");
  const acceptedBytes=Buffer.from(valid.canonicalBytesBase64,"base64");
  const baseline=parseExternalStartupBinding(acceptedBytes);
  const added=[];
  for(const [name,segment] of [
    ["path-star","bad*name"],["path-question","bad?name"],["path-double-quote",'bad"name'],
    ["path-less-than","bad<name"],["path-greater-than","bad>name"],["path-pipe","bad|name"],
    ["path-lone-high-surrogate","bad\uD800name"],["path-lone-low-surrogate","bad\uDC00name"],
    ["path-literal-bom","bad\uFEFFname"],
  ]) {
    const hostile=structuredClone(baseline);
    hostile.nativePrestart.path="C:\\fixture\\"+segment+"\\prestart.exe";
    const bytes=encoded(hostile);
    assert.notDeepEqual(bytes,acceptedBytes);
    assert.throws(()=>parseExternalStartupBinding(bytes),undefined,name);
    added.push({name,canonicalBytesBase64:bytes.toString("base64"),accepted:false});
  }
  const pair=structuredClone(baseline);
  pair.nativePrestart.path="C:\\fixture\\supplementary-\uD83D\uDE00\\prestart.exe";
  const pairBytes=encoded(pair);
  parseExternalStartupBinding(pairBytes);
  added.push({name:"path-valid-supplementary-unicode",canonicalBytesBase64:pairBytes.toString("base64"),accepted:true});
  const addedNames=new Set(added.map(v=>v.name));
  const corpus=[...previous.filter(v=>!addedNames.has(v.name)),...added];
  for(const vector of corpus) {
    const bytes=Buffer.from(vector.canonicalBytesBase64,"base64");
    if(vector.accepted) parseExternalStartupBinding(bytes);else assert.throws(()=>parseExternalStartupBinding(bytes),undefined,vector.name);
  }
  writeFileSync(corpusPath,encoded(corpus));
  const receiptPath=join(FIXTURE_ROOT,"latest-fixture-receipt.json");
  const receipt=JSON.parse(readFileSync(receiptPath,"utf8"));
  // Preserve the actual Git observations; only add this separate parser corpus revision.
  writeFileSync(receiptPath,encoded({...receipt,corpusSha256:sha256(readFileSync(corpusPath)),parserCorpusRevalidated:true}));
  console.log("P_JS_WIRE_CORPUS_REVALIDATED "+corpusPath+"; vectors="+corpus.length+"; sha256="+sha256(readFileSync(corpusPath)));
});

test("retained real-Git P A K classifier postures require the matching closed runtime projection",()=>{
  const receipt=JSON.parse(readFileSync(join(FIXTURE_ROOT,"latest-fixture-receipt.json"),"utf8"));
  assert.equal(receipt.structuralOnly,true);
  const root=receipt.root;
  assert.ok(root.startsWith(FIXTURE_ROOT+"\\constructible-"));
  const objects=execFileSync(GIT,["-C",SOURCE,"rev-parse","--git-path","objects"],{encoding:"utf8",windowsHide:true,timeout:15000}).trim();
  const env={SystemRoot:"C:\\Windows",WINDIR:"C:\\Windows",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"NUL",GIT_OPTIONAL_LOCKS:"0",GIT_ALTERNATE_OBJECT_DIRECTORIES:resolve(SOURCE,objects)};
  const git=args=>execFileSync(GIT,["--no-pager","-C",root,...args],{env,windowsHide:true,maxBuffer:4000000,timeout:15000});
  const tuples=parseRuntimeLineage(git(["log","--no-walk=unsorted","--no-notes","--no-decorate","--no-show-signature","--color=never","--format=%H%x00%T%x00%P%x00",...receipt.commits.map(t=>t.commit)]));
  assert.deepEqual(tuples,receipt.commits);
  const manifests=[EXACT_P_DELTA,EXACT_A_DELTA,EXACT_K_DELTA];
  const deltas=[],treeEntries=new Map();
  for(let i=1;i<4;i++) {
    deltas.push(parseRawGitDelta(git(["diff","--raw","--no-abbrev","-z","--no-renames",tuples[i-1].commit+".."+tuples[i].commit,"--"])).map(({path,status,mode,type})=>({path,status,mode,type})));
    const records=git(["ls-tree","--full-tree","-z",tuples[i].commit,"--",...manifests[i-1].map(r=>r.path)]).toString("utf8").split("\0").filter(Boolean);
    for(const record of records) {
      const m=/^(\d{6}) (blob) [0-9a-f]{40}\t(.+)$/u.exec(record);assert.ok(m);
      treeEntries.set(tuples[i].commit+"\0"+m[3],{path:m[3],mode:m[1],type:m[2]});
    }
  }
  const baseAt=count=>({
    acceptedC1:{...ACCEPTED_C1},commits:tuples.slice(0,count),committedDeltas:deltas.slice(0,count-1),head:tuples[count-1].commit,
    trackedWorktreeDelta:[],untrackedPaths:[],cachedDelta:[],indexVisibilityClean:true,
    observeCommittedTreeEntry:(commit,path)=>{const observed=treeEntries.get(commit+"\0"+path);assert.ok(observed);return {...observed};},
    observePhysicalEntry:(path,provenance)=>{
      const target=join(root,...path.split("/"));const stat=lstatSync(target);
      return {...physical(path,provenance),regularFile:stat.isFile(),symbolicLink:stat.isSymbolicLink(),linkCount:stat.nlink,realpathUnderRoot:realpathSync(target).startsWith(root+"\\")};
    },
  });
  const cases=[];
  for(let count=1;count<=4;count++) cases.push([baseAt(count),count<=2?"P":"K"]);
  for(let count=1;count<=3;count++) {
    const working=baseAt(count),delta=manifests[count-1];
    working.trackedWorktreeDelta=delta.filter(r=>r.status==="M");
    working.untrackedPaths=delta.filter(r=>r.status==="A").map(r=>r.path);
    cases.push([working,count===1?"P":"K"]);
  }
  for(const [facts,node] of cases) {
    const posture=classifyRuntimePosture(facts);
    assert.equal(assertRuntimeProjection(posture,node),RUNTIME_PROJECTIONS[node]);
    for(const wrong of ["A",node==="P"?"K":"P","unknown",null]) assert.throws(()=>assertRuntimeProjection(posture,wrong),undefined,posture+":"+wrong);
  }
  assert.deepEqual(RUNTIME_PROJECTIONS.P.writeDelta,EXACT_P_DELTA);
  assert.deepEqual(RUNTIME_PROJECTIONS.K.writeDelta,EXACT_K_DELTA);
  assert.equal(Object.isFrozen(RUNTIME_PROJECTIONS),true);
  assert.equal(Object.isFrozen(RUNTIME_PROJECTIONS.K.writeDelta[0]),true);
  assert.throws(()=>assertRuntimeProjection("A_REFUSED","A"));
});

test("startup v2 closes binary role fields and all nine paths without legacy fallback",()=>{
  const p={commit:"1".repeat(40),tree:"2".repeat(40),parent:ACCEPTED_C1.commit};
  const a={commit:"3".repeat(40),tree:"4".repeat(40),parent:p.commit};
  const k={commit:"5".repeat(40),tree:"6".repeat(40),parent:a.commit,carrierBlobId:"e".repeat(40)};
  const c=carrierFor("C:\\fixture\\repo",p,a),bytes=encoded(c),base=startupFor(c,k,bytes);
  assert.equal(parseExternalStartupBinding(encoded(base)).schema,"decadans.rm0032.accepted-startup-launchbinding.v2");
  assert.equal(parseExternalStartupBinding(encoded(base)).binaryBindings.git.path,GIT);
  assert.equal(parseExternalStartupBinding(encoded(base)).binaryBindings.wsl.path,"C:\\Program Files\\WSL\\wsl.exe");
  assertCarrierStartupAgreement(c,parseExternalStartupBinding(encoded(base)),bytes);
  const changes=[
    b=>{b.schema="decadans.rm0032.accepted-startup-launchbinding.v1";},
    b=>{delete b.binaryBindings;},
    b=>{b.binaryBindings.extra=b.binaryBindings.runner;},
    b=>{b.binaryBindings.runner.path=b.launcher.path;},
    b=>{b.binaryBindings.runner.path=b.launcher.path.toLowerCase().replace(/^c:/u,"C:");},
    b=>{b.binaryBindings.git.path="C:\\fixture\\git.exe";},
    b=>{b.binaryBindings.git.path="C:\\Program Files\\Git\\cmd\\git.exe";},
    b=>{b.binaryBindings.wsl.path="C:\\fixture\\wsl.exe";},
    b=>{b.binaryBindings.wsl.path="C:\\Windows\\System32\\wsl.exe";},
    b=>{b.binaryBindings.wsl.path="C:\\Windows\\SysWOW64\\wsl.exe";},
    b=>{b.binaryBindings.wsl.path="C:\\Program Files\\WSL\\wsl-alias.exe";},
  ];
  for(const role of ["runner","git","wsl"]) {
    changes.push(b=>{delete b.binaryBindings[role];});
    for(const field of ["path","bytes","sha256"]) changes.push(b=>{delete b.binaryBindings[role][field];});
    changes.push(b=>{b.binaryBindings[role].extra=true;});
    for(const value of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,"1",null]) changes.push(b=>{b.binaryBindings[role].bytes=value;});
    for(const value of ["a".repeat(64),["A".repeat(64)],1,null]) changes.push(b=>{b.binaryBindings[role].sha256=value;});
  }
  for(const change of changes) {
    const hostile=structuredClone(base);change(hostile);
    assert.notDeepEqual(encoded(hostile),encoded(base));
    assert.throws(()=>parseExternalStartupBinding(encoded(hostile)));
  }
  assert.equal(EXACT_P_DELTA.length,32);
  assert.equal(EXACT_P_DELTA.filter(r=>r.status==="M").length,21);
  assert.equal(EXACT_P_DELTA.filter(r=>r.status==="A").length,11);
  assert.deepEqual(EXACT_P_DELTA.slice(-4,-1),[
    {status:"M",path:"packages/rm0032-phase3-runner/src/contract.ts"},
    {status:"M",path:"packages/rm0032-phase3-runner/test/contract.test.ts"},
    {status:"M",path:"crates/rm0032-phase3-runner/src/main.rs"},
  ]);
  assert.equal(EXACT_P_DELTA.at(-1).path,"project/verification/rm-0032-phase3-prestart-integration-acceptance-receipt.json");
});

test("startup and carrier WSL byte and hash bindings agree independently of the fixed engine path",()=>{
  const p={commit:"1".repeat(40),tree:"2".repeat(40),parent:ACCEPTED_C1.commit};
  const a={commit:"3".repeat(40),tree:"4".repeat(40),parent:p.commit};
  const k={commit:"5".repeat(40),tree:"6".repeat(40),parent:a.commit,carrierBlobId:"e".repeat(40)};
  const c=carrierFor("C:\\fixture\\repo",p,a),bytes=encoded(c),base=startupFor(c,k,bytes);
  for(const field of ["bytes","sha256"]) {
    const hostile=structuredClone(base);
    hostile.binaryBindings.wsl[field]=field==="bytes"?base.binaryBindings.wsl.bytes+1:"B".repeat(64);
    assert.notDeepEqual(encoded(hostile),encoded(base));
    const parsed=parseExternalStartupBinding(encoded(hostile));
    assert.throws(()=>assertCarrierStartupAgreement(c,parsed,bytes),/startup-binary-bindings-refused/u);
  }
});

test("native-owned v2 cross-language bytes agree and historical v1 corpora are refusal-only",()=>{
  // Native owns this literal and its generation. Consume exact embedded bytes;
  // never rewrite its corpus or depend on a provisioned ProgramData file.
  const source=readFileSync(join(SOURCE,"crates/rm0032-phase3-native-observer-launcher-v1/tests/prestart-contract-vectors.rs"),"utf8");
  const literal=name=>{
    const matches=[...source.matchAll(new RegExp("const "+name+': &str = r###"([\\s\\S]*?)"###;',"gu"))];
    assert.equal(matches.length,1,name);
    return Buffer.from(matches[0][1],"utf8");
  };
  const bytes=literal("V2_CROSS_LANGUAGE_VECTORS");
  assert.equal(bytes.length,171906);
  assert.equal(sha256(bytes),"7D0B45134943BF5DA768BEF4617A9294F17F56571E218F8401CE6AC0C66CD283");
  const vectors=JSON.parse(bytes.toString());
  assert.equal(vectors.length,51);
  assert.equal(new Set(vectors.map(v=>v.name)).size,51);
  let accepted=0;
  for(const vector of vectors) {
    assert.deepEqual(Object.keys(vector).sort(),["accepted","canonicalBytesBase64","name"]);
    assert.equal(typeof vector.accepted,"boolean");
    const raw=Buffer.from(vector.canonicalBytesBase64,"base64");
    assert.equal(raw.toString("base64"),vector.canonicalBytesBase64);
    if(vector.accepted) {
      const binding=parseExternalStartupBinding(raw);
      assert.equal(binding.schema,STARTUP_SCHEMA);
      assert.equal(binding.binaryBindings.wsl.path,"C:\\Program Files\\WSL\\wsl.exe");
      assert.deepEqual(Object.keys(binding.binaryBindings).sort(),["git","runner","wsl"]);
      accepted++;
    } else assert.throws(()=>parseExternalStartupBinding(raw),undefined,vector.name);
  }
  assert.equal(accepted,2);
  for(const name of ["FINAL_CROSS_LANGUAGE_VECTORS","CURRENT_CROSS_LANGUAGE_VECTORS"]) {
    const historical=JSON.parse(literal(name).toString());
    assert.ok(historical.length>0);
    for(const vector of historical) assert.throws(()=>parseExternalStartupBinding(Buffer.from(vector.canonicalBytesBase64,"base64")),undefined,name+":"+vector.name);
  }
});
