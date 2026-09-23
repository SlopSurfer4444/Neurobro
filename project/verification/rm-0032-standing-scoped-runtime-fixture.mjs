// Test-only composition. Actual runtime/owner/session/wire and disk records;
// ChildProcess-shaped private streams are synthetic, no process or model starts.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFileSync,mkdtempSync,readdirSync,unlinkSync,rmdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {prepareStandingEpochRuntime} from './rm-0032-standing-epoch-runtime.mjs';
import {startOwnedEpoch} from './rm-0032-standing-epoch-owner.mjs';
import {SOURCE_NAMES,SOURCE_PINS} from './rm-0032-standing-epoch-host.mjs';
const purposes=['conversation','history-analysis'];
const names=['neurobro_analysis_material','neurobro_analysis_notes','neurobro_analysis_commit'];
const custody={initialize:true,profile:true,controlsPassed:true,relayAfter:true,probePass:Array(9).fill(true),probeExitCodes:[0,20,20,22,22,20,40,30,61],accountChatgpt:true,astraMedium:true};
const capabilities={checked:true,imageGeneration:true,namespaceTools:false,webSearch:true};
function supervisor(client){return {schema:'standing-epoch-supervisor-v1',outcome:client.outcome==='observed'?'observed':'unknown',stage:'complete',preflight:true,custodyReady:true,clientNaturalSettlement:true,relaySettled:true,allProcessesSettled:true,settled:true,injectedPorts:false,
  clientExit:client.outcome==='observed'?0:1,relayExit:0,clientStdoutBytes:1000,clientStderrBytes:0,relayStdoutBytes:150,relayStderrBytes:0,client,
  relay:{version:1,settled:true,counters:{accepted:1,over_limit:0,refused:0,connected:1,completed:1,failed:0,cancelled:0,internal_error:0}}};}
export class ScopedRuntimeChild extends EventEmitter {
  constructor(bootstrap,analysisCall,options={}){
    super();this.expectedBootstrap=bootstrap;this.analysisCall=analysisCall;this.pid=1234;
    this.version=options.sessionMode==='standing-scoped-epoch-v2'?'v2':'v1';this.purposes=this.version==='v2'?[...purposes,'community-assessment']:purposes;
    this.communityAnswer=options.communityAnswer??JSON.stringify({decision:'silent',caseKey:null,answer:null});this.holdCommunity=options.holdCommunity;
    this.refuseAnalysis=options.refuseAnalysis??false;this.closedCode='CLOSED';this.terminalSent=false;
    this.stdin=new PassThrough();this.stdout=new PassThrough();this.stderr=new PassThrough();this.bytes=Buffer.alloc(0);this.bootstrapped=false;
    this.sent=[];this.turns=0;this.local=Object.fromEntries(this.purposes.map(p=>[p,0]));this.calls=Object.fromEntries(this.purposes.map(p=>[p,0]));this.turnCalls=0;this.pending=false;this.current=null;this.kills=0;this.exited=false;
    this.stdin.on('data',data=>this.consume(data));
    this.stdin.on('finish',()=>{this.stdout.end();this.stderr.end();setImmediate(()=>{this.exited=true;this.emit('exit',0,null);this.emit('close',0,null);});});
  }
  output(value){this.stdout.write(JSON.stringify(value)+'\n');}
  consume(data){
    this.bytes=Buffer.concat([this.bytes,data]);
    if(!this.bootstrapped){const size=this.expectedBootstrap.length;if(this.bytes.length<size)return;
      assert.deepEqual(this.bytes.subarray(0,size),this.expectedBootstrap);this.bytes=this.bytes.subarray(size);this.bootstrapped=true;
      this.output({kind:'custodyReady',proof:{custody:{...custody,relayAfter:false},capabilities}});
      this.output({kind:'ready',protocol:'standing-scoped-epoch-'+this.version,scopes:[{purpose:'conversation',tools:['neurobro_read_history']},{purpose:'history-analysis',tools:names},...(this.version==='v2'?[{purpose:'community-assessment',tools:[]}]:[])]});
    }
    for(;;){const at=this.bytes.indexOf(10);if(at<0)return;const value=JSON.parse(this.bytes.subarray(0,at));this.bytes=this.bytes.subarray(at+1);this.sent.push(value);this.frame(value);}
  }
  receipt(){
    const purposes=this.purposes,unknown=this.pending,started=purposes.filter(p=>this.local[p]>0).length;
    const facts={schema:'neurobro-native-scoped-epoch-'+this.version,threadLimit:purposes.length,threadStartDispatches:started,turnStartDispatches:this.turns,
      threadStarted:started>0,poisoned:unknown,busy:false,turnsAttempted:this.turns,toolCalls:this.calls.conversation+this.calls['history-analysis'],turnsAdmitted:this.turns,
      turnLimit:16,epochSeconds:900,turnSeconds:300,running:false,releasePending:false,closed:true,resourceSettlementObserved:false,unreleasedTurn:unknown,
      slots:purposes.map(purpose=>({purpose,threadStarted:this.local[purpose]>0,turnsAdmitted:this.local[purpose],turnsAttempted:this.local[purpose],toolCalls:this.calls[purpose],closed:true,poisoned:unknown&&this.current.purpose===purpose}))};
    return {schema:'decadans.rm0032.standing-scoped-epoch.'+this.version,outcome:unknown?'unknown':'observed',code:unknown?'SESSION_UNKNOWN':'OK',stage:'complete',injectedPorts:false,
      limits:{prepSeconds:120,epochSeconds:900,cleanupSeconds:35,turnLimit:16,threadLimit:purposes.length,history:true,images:true,syntheticOnly:false},custody,capabilities,
      native:{admitted:true,threadStartDispatches:started,turnStartDispatches:this.turns,threadsAcknowledged:started,
        slotWeb:purposes.map(purpose=>({purpose,turnsAttempted:this.local[purpose],admitted:0,completed:0,search:0,openPage:0,findInPage:0,other:0}))},
      session:{custodyPublished:true,ready:true,closed:true,code:this.closedCode,facts},
      diagnostics:{originalCode:unknown?'SESSION_UNKNOWN':'OK',originalStage:'complete',cleanupUnknown:false,rpcCode:unknown?'TRANSPORT_UNKNOWN':'OK',rpcSite:'none',rpcOperation:'none',idleFailure:null},
      appServer:{launched:true,stdinClosed:true,stdoutEof:true,reaped:true,exitCode:0,stderrBytes:0,stderrComplete:true,transportUnknown:unknown}};
  }
  complete(){const frame=this.current,scope={purpose:frame.purpose,requestRef:frame.requestRef,threadId:'thread-'+frame.purpose,turnId:'turn-'+this.turns,turnNumber:this.turns,threadTurnNumber:this.local[frame.purpose]};
    this.output({kind:'scope',scope});this.output({kind:'completed',scope,answer:frame.purpose==='community-assessment'?this.communityAnswer:'Bound internal result',kindOfAnswer:'text',toolCalls:this.turnCalls,toolRefusals:0});}
  nextAnalysis(lastResult){
    const call=this.analysisCall({index:this.turnCalls,lastResult,requestRef:this.current.requestRef,input:this.current.input});
    if(call===null){this.complete();return;}
    assert.ok(call&&names.includes(call.name)&&this.turnCalls<8);this.turnCalls++;this.calls['history-analysis']++;
    this.output({kind:'tool',purpose:'history-analysis',requestRef:this.current.requestRef,callRef:'call-'+this.turns+'-'+this.turnCalls,name:call.name,arguments:call.arguments});
  }
  terminal(){if(this.terminalSent)return;this.terminalSent=true;const receipt=this.receipt();this.output({kind:'closed',code:this.closedCode,facts:receipt.session.facts});this.output({kind:'epochResult',receipt});this.output({kind:'supervisorResult',receipt:supervisor(receipt)});}
  frame(frame){
    if(frame.kind==='turn'&&frame.purpose==='history-analysis'&&this.refuseAnalysis){
      this.closedCode='EPOCH_LIMIT';this.output({kind:'notAdmitted',purpose:frame.purpose,requestRef:frame.requestRef,reason:'time',turnsAdmitted:this.turns,turnStartDispatches:this.turns});this.terminal();
    }
    else if(frame.kind==='turn'){this.turns++;this.local[frame.purpose]++;this.current=frame;this.turnCalls=0;this.pending=true;
      if(frame.purpose==='history-analysis')this.nextAnalysis(undefined);else if(frame.purpose!=='community-assessment'||!this.holdCommunity)this.complete();}
    else if(frame.kind==='toolResult')this.nextAnalysis(frame.result);
    else if(frame.kind==='release'){this.pending=false;this.output({kind:'released',purpose:frame.purpose,requestRef:frame.requestRef,delivery:frame.delivery});}
    else if(frame.kind==='close')this.terminal();
  }
  kill(){this.kills++;return false;}
}
/** analysisCall({index,lastResult,requestRef,input}) returns {name,arguments} or
 * null to complete. Default performs one actual material handler callback. */
export async function scopedRuntimeFixture(options={}){
  const build=resolve(options.build??process.env.NEUROBRO_GATEWAY_BUILD??'packages/telegram-gateway/dist');
  const {createEpochWire}=await import(pathToFileURL(resolve(build,'src/standing-epoch-wire.js')));
  const {openStandingScopedEpochSession}=await import(pathToFileURL(resolve(build,'src/standing-scoped-epoch-session.js')));
  const {isEpochTurnNotAdmitted}=await import(pathToFileURL(resolve(build,'src/standing-epoch-session.js')));
  const parent=mkdtempSync(resolve(tmpdir(),'scoped-owned-runtime-')),children=[],ownerInputs=[];
  const sources=Object.fromEntries(Object.entries(SOURCE_NAMES).map(([key,name])=>[key,readFileSync(new URL(name,import.meta.url),'utf8')]));
  const make=(selectedMode=options.sessionMode??'standing-scoped-epoch-v1')=>prepareStandingEpochRuntime({sources,pins:SOURCE_PINS,attemptParent:parent,workerToken:'e'.repeat(32),sessionMode:selectedMode,createWire:createEpochWire,openSession:openStandingScopedEpochSession,isTurnNotAdmitted:isEpochTurnNotAdmitted},{
    ...(options.communityAssessmentTimeoutMs===undefined?{}:{communityAssessmentTimeoutMs:options.communityAssessmentTimeoutMs}),
    openOwner:input=>{const child=new ScopedRuntimeChild(input.bootstrap,options.analysisCall??(({index})=>index===0?{name:names[0],arguments:{}}:null),options);children.push(child);ownerInputs.push(input);return startOwnedEpoch({...input,...(options.clock?{clock:options.clock}:{}),recordFinal:async(...args)=>{
      if(options.holdFinal)await options.holdFinal;
      if(options.failFinal)throw Error('synthetic persistence failure');
      return input.recordFinal(...args);
    }});},
    spawn:()=>children.at(-1),
  });
  const runtime=make(),control=new AbortController(),connection=runtime.openConnection({signal:control.signal,history:{call:async()=>({success:true,contentItems:[{type:'inputText',text:'{}'}]})}});
  const cleanup=()=>{for(const token of readdirSync(parent)){assert.match(token,/^[a-f0-9]{32}$/u);const path=resolve(parent,token);
    for(const file of readdirSync(path)){assert.ok(['intent.json','controller.json','actual.json'].includes(file));unlinkSync(resolve(path,file));}rmdirSync(path);}rmdirSync(parent);};
  return {parent,children,ownerInputs,runtime,connection,control,make,cleanup,isTurnNotAdmitted:isEpochTurnNotAdmitted};
}
