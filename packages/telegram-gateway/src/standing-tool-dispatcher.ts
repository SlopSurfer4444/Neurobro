/** Named tools are registered by the owning application, never by chat input.
 * This dispatches bounded native tool requests; each handler still owns its
 * target references, argument validation, operation ledger and actual effects. */
export type EpochToolScope = Readonly<{ requestRef:string;callRef:string;signal:AbortSignal }>;
export type EpochExtraTool = Readonly<{name:string;call(argumentsValue:unknown,scope:EpochToolScope):Promise<unknown>}>;
export type EpochToolResult = Readonly<{success:boolean;contentItems:readonly[Readonly<{type:"inputText";text:string}>]}>;
export class StandingToolDispatchError extends Error { constructor(){super("STANDING_TOOL_DISPATCH_REFUSED");} }
const fail=():never=>{throw new StandingToolDispatchError();};
const validName=(name:unknown):name is string=>typeof name==="string"&&/^neurobro_[a-z][a-z0-9_]{0,54}$/.test(name);
function record(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=="object"||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==keys.length)return fail();
  const result:Record<string,unknown>={};
  for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!("value"in d))return fail();result[key]=d.value;}
  return result;
}
function result(value:unknown):EpochToolResult{
  const v=record(value,["success","contentItems"]),items=v.contentItems;
  if(typeof v.success!=="boolean"||!Array.isArray(items)||items.length!==1||Reflect.ownKeys(items).length!==2)return fail();
  const d=Object.getOwnPropertyDescriptor(items,"0");if(!d||!("value"in d))return fail();
  const item=record(d.value,["type","text"]);
  if(item.type!=="inputText"||typeof item.text!=="string"||Buffer.byteLength(item.text)>65536||Buffer.from(item.text).toString()!==item.text)return fail();
  let decoded:unknown;try{decoded=JSON.parse(item.text);}catch{return fail();}
  if(!decoded||typeof decoded!=="object"||Array.isArray(decoded))return fail();
  const captured=Object.freeze({success:v.success,contentItems:Object.freeze([Object.freeze({type:"inputText" as const,text:item.text})]) as EpochToolResult["contentItems"]});
  if(Buffer.byteLength(JSON.stringify(captured))>131584)return fail();return captured;
}

export function createStandingToolDispatcher(history:{call(argumentsValue:unknown):Promise<unknown>},extraTools:readonly EpochExtraTool[]){
  if(!history||typeof history.call!=="function")return fail();
  return createDispatcher(history.call.bind(history),extraTools);
}

/** Explicit registry for an isolated scope. No implicit raw-history capability.
 * The host session still validates its exact purpose-specific names/order. */
export function createStandingNamedToolDispatcher(tools:readonly EpochExtraTool[]){
  if(!Array.isArray(tools)||tools.length===0)return fail();
  return createDispatcher(undefined,tools);
}

function createDispatcher(historyCall:((argumentsValue:unknown)=>Promise<unknown>)|undefined,extraTools:readonly EpochExtraTool[]){
  if(!Array.isArray(extraTools)||extraTools.length>(historyCall?31:32)||
      Reflect.ownKeys(extraTools).length!==extraTools.length+1)return fail();
  const handlers=new Map<string,EpochExtraTool["call"]>();
  if(historyCall)handlers.set("neurobro_read_history",async args=>historyCall(args));
  for(let i=0;i<extraTools.length;i++){
    const d=Object.getOwnPropertyDescriptor(extraTools,String(i));if(!d||!("value"in d))return fail();
    const entry=record(d.value,["name","call"]);
    if(!validName(entry.name)||handlers.has(entry.name)||typeof entry.call!=="function")return fail();
    const call=entry.call as EpochExtraTool["call"],receiver=Object.freeze({name:entry.name,call});
    handlers.set(entry.name,(args,scope)=>Reflect.apply(call,receiver,[args,scope]));
  }
  const names=Object.freeze([...handlers.keys()]);
  let closed=false,active:Promise<EpochToolResult>|undefined;
  return Object.freeze({names,
    async call(name:string,argumentsValue:unknown,scope:EpochToolScope):Promise<EpochToolResult>{
      if(closed||scope.signal.aborted||active||!handlers.has(name))return fail();
      const copiedScope=Object.freeze({requestRef:scope.requestRef,callRef:scope.callRef,signal:scope.signal});
      let done!:(value:EpochToolResult)=>void,failed!:(error:unknown)=>void;
      const pending=new Promise<EpochToolResult>((resolve,reject)=>{done=resolve;failed=reject;});active=pending;
      // Argument shape belongs to each registered handler. The wire parser
      // already owns these JSON values; no filesystem or peer selector is added.
      void(async()=>{
        try{
          const value=await handlers.get(name)!(argumentsValue,copiedScope);
          if(closed||copiedScope.signal.aborted)return fail();done(result(value));
        }catch{failed(new StandingToolDispatchError());}
      })();
      try{return await pending;}finally{if(active===pending)active=undefined;}
    },
    async close(){closed=true;try{await active;}catch{/* The admitted caller owns its failure. */}}
  });
}
