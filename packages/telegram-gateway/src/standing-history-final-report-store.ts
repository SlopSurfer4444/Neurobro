import { REPORT_REVIEW_SERIALIZED_BYTES, snapshotStandingHistoryReportReview } from "./standing-history-report-quality.js";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";
import { snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent } from "./standing-history-task-store.js";
export type StandingHistoryFinalReportNativeBinding = Readonly<{epochId:string; requestRef:string; purpose:"history-analysis"}>;
export type StandingHistoryFinalReportOutcome = "observed" | "unknown" | "refused";
export type StandingHistoryFinalReportStatus = Readonly<{storage:"ready"|"tail-refused"; reserved:boolean; modelReplayAllowed:false;
 nativeBinding?:StandingHistoryFinalReportNativeBinding; prepared?:Readonly<{body:string;bodyHash:string}>; modelOutcome?:StandingHistoryFinalReportOutcome}>;
export type StandingHistoryFinalReportStore = Readonly<{
 status():Promise<StandingHistoryFinalReportStatus>;
 reserve(binding:StandingHistoryFinalReportNativeBinding):Promise<StandingHistoryFinalReportStatus>;
 prepare(input:Readonly<{body:string}>):Promise<StandingHistoryFinalReportStatus>;
 recordOutcome(outcome:StandingHistoryFinalReportOutcome):Promise<StandingHistoryFinalReportStatus>;
 close():Promise<void>;
}>;
export class StandingHistoryFinalReportStoreError extends Error {
 constructor(readonly code:"input"|"binding"|"consumed"|"conflict"|"tail"|"limit"|"storage"|"busy"|"closed"|"aborted") {
 super("STANDING_HISTORY_FINAL_REPORT_"+code.toUpperCase()); this.name="StandingHistoryFinalReportStoreError";
 }
}
const fail=(code:StandingHistoryFinalReportStoreError["code"]):never=>{throw new StandingHistoryFinalReportStoreError(code)};
const DOMAIN="DecadansNeurobro/standing-history-final-report/v1";
const HEADER="intent.enc", RESERVATION="reservation.enc", PREPARED="prepared.enc", OUTCOME="outcome.enc";
const MAX_PLAIN=262144, MAX_CIPHER=524288;
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const digest=(v:unknown):v is string=>typeof v==="string" && /^[0-9a-f]{64}$/.test(v);
const text=(v:unknown,max:number):v is string=>typeof v==="string" && !!v.trim() && !v.includes("\0") && Buffer.byteLength(v)<=max && Buffer.from(v).toString("utf8")===v;
const sameDirectory=(a:BigIntStats,b:BigIntStats)=>a.dev===b.dev && a.ino===b.ino;
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(":");
const missing=(e:unknown)=>(e as NodeJS.ErrnoException)?.code==="ENOENT";
function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(keys.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}

function native(value:unknown):StandingHistoryFinalReportNativeBinding {
 const v=data(value,["epochId","requestRef","purpose"]);
 if(typeof v.epochId!=="string" || !/^[0-9a-f]{32}$/.test(v.epochId) || typeof v.requestRef!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.requestRef) || v.purpose!=="history-analysis") return fail("input");
 return Object.freeze({epochId:v.epochId,requestRef:v.requestRef,purpose:"history-analysis"});
}
/** One immutable finalization generation. A fresh reserve return alone admits a
 * model dispatch. Recovery never grants replay, including UNKNOWN/refused.
 * The host must establish exact native settlement and uncancelled current heads
 * before using prepared output after reopening. Content validation is structural,
 * not semantic acceptance. File sync does not promise directory power-loss durability. */
export async function openStandingHistoryFinalReportStore(input:Readonly<{
 directory:string;passphrase:string;intent:StandingHistoryTaskIntent;sourceHead:string;analysisHead:string;rootRef:string;mode:"create"|"open";signal?:AbortSignal;contextHash?:string;bodyKind?:"review";
}>):Promise<StandingHistoryFinalReportStore> {
 const args=data(input,["directory","passphrase","intent","sourceHead","analysisHead","rootRef","mode"],["signal","contextHash","bodyKind"]);
 let intent:StandingHistoryTaskIntent; try {intent=snapshotStandingHistoryTaskIntent(args.intent)} catch{return fail("input")}
 if(typeof args.directory!=="string" || !isAbsolute(args.directory) || resolve(args.directory)!==args.directory || !text(args.passphrase,4096) || args.passphrase.length<16 || !digest(args.sourceHead) || !digest(args.analysisHead) || typeof args.rootRef!=="string" || !/^hnode_[0-9a-f]{48}$/.test(args.rootRef) || args.mode!=="create" && args.mode!=="open" || Object.hasOwn(args,"signal") && (types.isProxy(args.signal)||!(args.signal instanceof AbortSignal))) return fail("input");
 if (Object.hasOwn(args,"contextHash") && !digest(args.contextHash)) return fail("input");
 if (Object.hasOwn(args,"bodyKind") && (args.bodyKind!=="review" || !digest(args.contextHash))) return fail("input");
 const bodyValid=(body:unknown):body is string=>{
   if(!text(body,args.bodyKind==="review"?REPORT_REVIEW_SERIALIZED_BYTES:32768))return false;
   if(args.bodyKind!=="review")return true;
   try{snapshotStandingHistoryReportReview(JSON.parse(body));return true}catch{return false}
 };
 const directory=args.directory, slot=join(directory,intent.taskId),signal=args.signal as AbortSignal|undefined;
 const header={domain:DOMAIN,kind:"intent",intent,sourceHead:args.sourceHead,analysisHead:args.analysisHead,rootRef:args.rootRef,...(args.contextHash?{contextHash:args.contextHash}:{})}, intentHash=hash(header);
 let passphrase=args.passphrase,tail=false;
 let binding:StandingHistoryFinalReportNativeBinding|undefined,prepared:Readonly<{body:string;bodyHash:string}>|undefined,outcome:StandingHistoryFinalReportOutcome|undefined;
  let revoked: "closed" | "aborted" | undefined, active: Promise<unknown> | undefined, closing: Promise<void> | undefined, initializing = true;
  let root: BigIntStats, owner: BigIntStats;
  const versions = new Map<string, string>();
  const live = () => { if (revoked) return fail(revoked); if (signal?.aborted) return fail("aborted"); };
  const shutdown = (): Promise<void> => {
    closing ??= (async () => { try { await active; } catch { /* Join actual admitted I/O and crypto. */ }
      finally { passphrase = ""; signal?.removeEventListener("abort", abort); } })();
    return closing;
  };
  const abort = () => { revoked ??= "aborted"; if (!initializing) void shutdown(); };
  signal?.addEventListener("abort", abort, { once: true });
  const check = async (known = false) => {
    live(); await assertPilotPrivateDirectory(directory); await assertPilotPrivateDirectory(slot);
    if (!sameDirectory(root, await lstat(directory, { bigint: true })) || !sameDirectory(owner, await lstat(slot, { bigint: true }))) return fail("storage");
    if (known) for (const [name, expected] of versions) {
      live(); const s = await lstat(join(slot, name), { bigint: true });
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || stamp(s) !== expected) return fail("storage");
    }
    live();
  };
  const read = async (name: string): Promise<{ value: unknown; version: string }> => {
    await check(); const path = join(slot, name), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CIPHER)) return fail("storage");
    const file = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      const inside = await file.stat({ bigint: true });
      if (!inside.isFile() || stamp(inside) !== stamp(before)) return fail("storage");
      bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { live(); const got = await file.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
      if (count !== Number(before.size) || stamp(await file.stat({ bigint: true })) !== stamp(before)) return fail("storage");
      const plain = await decryptSession(bytes.subarray(0, count).toString("utf8"), passphrase); live();
      if (Buffer.byteLength(plain) > MAX_PLAIN) return fail("limit");
      const value: unknown = JSON.parse(plain), after = await lstat(path, { bigint: true });
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || stamp(after) !== stamp(before)) return fail("storage");
      await check(); return { value, version: stamp(after) };
    } finally { bytes?.fill(0); await file.close(); }
  };
  const write = async (name: string, value: unknown): Promise<string> => {
    const plain = JSON.stringify(value); if (Buffer.byteLength(plain) > MAX_PLAIN) return fail("limit");
    await check(); const cipher = await encryptSession(plain, passphrase);
    if (Buffer.byteLength(cipher) > MAX_CIPHER) return fail("limit"); await check();
    const file = await open(join(slot, name), "wx", 0o600);
    try { await file.writeFile(cipher); await file.sync(); } finally { await file.close(); }
    const verified = await read(name); if (!same(verified.value, value)) return fail("storage"); return verified.version;
  };
  const inventory=async()=>{
    await check();const dir=await opendir(slot,{bufferSize:1});const expected=new Set(versions.keys());
    try {for(let n=0;n<5;n++){live();const entry=await dir.read();if(!entry)return expected.size===0;if(!entry.isFile()||entry.isSymbolicLink()||!expected.delete(entry.name))return false}return false}finally{await dir.close()}
  };
  const status=():StandingHistoryFinalReportStatus=>Object.freeze({storage:tail?"tail-refused":"ready",reserved:!!binding,modelReplayAllowed:false,...(binding?{nativeBinding:binding}:{}),...(prepared?{prepared}:{}),...(outcome?{modelOutcome:outcome}:{})});
  const record=(kind:string,value:unknown)=>({domain:DOMAIN,intentHash,kind,value});
  try {
    live();await assertPilotPrivateDirectory(directory);root=await lstat(directory,{bigint:true});live();
    if(args.mode==="create"){try{await mkdir(slot,{mode:0o700})}catch(e){return fail((e as NodeJS.ErrnoException)?.code==="EEXIST"?"consumed":"storage")}}
    await assertPilotPrivateDirectory(slot);owner=await lstat(slot,{bigint:true});
    if(args.mode==="create")versions.set(HEADER,await write(HEADER,header));
    else {
      const saved=await read(HEADER);if(!same(saved.value,header))return fail("binding");versions.set(HEADER,saved.version);
      for(const [name,kind] of [[RESERVATION,"reservation"],[PREPARED,"prepared"],[OUTCOME,"outcome"]] as const){
        try {
          const saved=await read(name),v=data(saved.value,["domain","intentHash","kind","value"]);
          if(v.domain!==DOMAIN||v.intentHash!==intentHash||v.kind!==kind)return fail("binding");
          if(kind==="reservation")binding=native(v.value);
          else if(kind==="prepared"){
            if(!binding)return fail("binding");const b=data(v.value,["body","bodyHash"]);
            if(!bodyValid(b.body)||b.bodyHash!==hash(b.body))return fail("binding");prepared=Object.freeze({body:b.body,bodyHash:b.bodyHash as string});
          }else {if(!binding || !["observed","unknown","refused"].includes(v.value as string))return fail("binding");outcome=v.value as StandingHistoryFinalReportOutcome; if(outcome==="refused"&&prepared)return fail("binding")}
          versions.set(name,saved.version);
        }catch(e){live();if(!missing(e))tail=true}
      }
    }
    if(!await inventory())tail=true;await check(true);initializing=false;live();
  }catch(e){initializing=false;passphrase="";signal?.removeEventListener("abort",abort);if(e instanceof StandingHistoryFinalReportStoreError)throw e;return fail("storage")}
  const operation=<T>(work:()=>Promise<T>):Promise<T>=>{
    live();if(active)return fail("busy");const pending=Promise.resolve().then(async()=>{await check(true);return work()});active=pending;
    return pending.catch(e=>{if(e instanceof StandingHistoryFinalReportStoreError)throw e;return fail("storage")}).finally(()=>{if(active===pending)active=undefined});
  };
  const writable=async()=>{if(!await inventory())tail=true;if(tail)return fail("tail")};
  const persist=async(name:string,kind:string,value:unknown)=>{try{versions.set(name,await write(name,record(kind,value)));await check(true)}catch(e){tail=true;throw e}};
  return Object.freeze<StandingHistoryFinalReportStore>({
    status:()=>operation(async()=>{if(!await inventory())tail=true;return status()}),
    reserve(value){const candidate=native(value);return operation(async()=>{await writable();if(binding)return fail("consumed");await persist(RESERVATION,"reservation",candidate);binding=candidate;return status()})},
    prepare(value){const v=data(value,["body"]);if(!bodyValid(v.body))return Promise.reject(new StandingHistoryFinalReportStoreError("input"));const candidate=Object.freeze({body:v.body,bodyHash:hash(v.body)});return operation(async()=>{await writable();if(!binding)return fail("consumed");if(prepared){if(!same(prepared,candidate))return fail("conflict");return status()}if(outcome)return fail("consumed");await persist(PREPARED,"prepared",candidate);prepared=candidate;return status()})},
    recordOutcome(value){if(!["observed","unknown","refused"].includes(value))return Promise.reject(new StandingHistoryFinalReportStoreError("input"));return operation(async()=>{await writable();if(!binding)return fail("consumed");if(outcome){if(outcome!==value)return fail("conflict");return status()}if(value==="refused"&&prepared)return fail("conflict");await persist(OUTCOME,"outcome",value);outcome=value;return status()})},
    close(){revoked??="closed";return shutdown()}
  });
}


/** Read only the authenticated binding; never admits dispatch or repairs a slot.
 * A caller must reopen the store to validate its complete immutable inventory. */
export async function readStandingHistoryFinalReportRoot(input: Readonly<{
 directory:string; passphrase:string; intent:StandingHistoryTaskIntent; sourceHead:string; analysisHead:string;
}>):Promise<string|undefined> {
 const intent=snapshotStandingHistoryTaskIntent(input.intent), slot=join(input.directory,intent.taskId), path=join(slot,HEADER);
 try {
  await assertPilotPrivateDirectory(input.directory); const root=await lstat(input.directory,{bigint:true});
  await assertPilotPrivateDirectory(slot); const owner=await lstat(slot,{bigint:true}), before=await lstat(path,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>BigInt(MAX_CIPHER))return undefined;
  const file=await open(path,"r"); let bytes:Buffer|undefined;
  try {
   if(stamp(await file.stat({bigint:true}))!==stamp(before))return undefined;
   bytes=Buffer.alloc(Number(before.size)+1);let count=0;
   while(count<bytes.length){const r=await file.read(bytes,count,bytes.length-count,null);if(!r.bytesRead)break;count+=r.bytesRead;}
   if(count!==Number(before.size)||stamp(await file.stat({bigint:true}))!==stamp(before))return undefined;
   const plain=await decryptSession(bytes.subarray(0,count).toString("utf8"),input.passphrase);
   if(Buffer.byteLength(plain)>MAX_PLAIN)return undefined;
   const v=data(JSON.parse(plain),["domain","kind","intent","sourceHead","analysisHead","rootRef"]);
   if(v.domain!==DOMAIN||v.kind!=="intent"||!same(v.intent,intent)||v.sourceHead!==input.sourceHead||v.analysisHead!==input.analysisHead||typeof v.rootRef!=="string"||!/^hnode_[0-9a-f]{48}$/.test(v.rootRef))return undefined;
   if(stamp(await lstat(path,{bigint:true}))!==stamp(before)||!sameDirectory(root,await lstat(input.directory,{bigint:true}))||!sameDirectory(owner,await lstat(slot,{bigint:true})))return undefined;
   return v.rootRef;
  }finally{bytes?.fill(0);await file.close();}
 }catch{return undefined;}
}
