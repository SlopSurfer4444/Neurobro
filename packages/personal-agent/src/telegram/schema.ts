import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { TdObject } from './transport.ts';
const source = readFileSync(new URL('./td_api.tl', import.meta.url), 'utf8');
export const TD_SCHEMA_SHA256 = createHash('sha256').update(source).digest('hex');
const shapes = new Map<string, Map<string,string>>();
const returns=new Map<string,string>();
for (const line of source.split('\n')) {
  const match = /^([A-Za-z][A-Za-z0-9]*)\s*(.*?)\s*=\s*([\w<>]+);$/.exec(line);
  if (match) {shapes.set(match[1]!, new Map([...match[2]!.matchAll(/(\w+):([^ ]+)/g)].map(m => [m[1]!, m[2]!])));returns.set(match[1]!,match[3]!);}
}
/** Exact pinned field names; recursive constructor and integer validation before native dispatch. */
export function validateTdObject(value: TdObject): void {
  const shape = shapes.get(value['@type']); if (!shape) throw new Error('TDLib constructor absent from pinned schema');
  for (const [key, field] of Object.entries(value)) {
    if (key === '@type' || key === '@extra') continue;
    const type = shape.get(key); if (!type) throw new Error(`TDLib field ${key} absent from pinned schema`);
    if (field === null) continue;
    const vector=/^vector<(.+)>$/.exec(type);
    if(vector){if(!Array.isArray(field))throw new Error(`TDLib vector required ${key}`);for(const entry of field)validateField(vector[1]!,entry,key);}
    else validateField(type,field,key);
  }
}
function validateField(type:string,field:any,key:string):void{
  if(field===null)return;
  if(type==='Bool'&&typeof field!=='boolean')throw new Error(`TDLib boolean required ${key}`);
  if((type==='string'||type==='bytes')&&typeof field!=='string')throw new Error(`TDLib string required ${key}`);
  if(type==='double'&&(typeof field!=='number'||!Number.isFinite(field)))throw new Error(`TDLib number required ${key}`);
  if(/^int(32|53|64)$/.test(type)){
    if(!((typeof field==='number'&&Number.isSafeInteger(field))||(typeof field==='string'&&/^-?\d+$/.test(field))))throw new Error(`lossy TDLib integer ${key}`);
    const n=BigInt(field),limit=type==='int32'?2147483647n:type==='int53'?9007199254740991n:9223372036854775807n;
    if(n < -limit-1n || n > limit)throw new Error(`TDLib integer out of range ${key}`);
  }
  if(field&&typeof field==='object'){if(Array.isArray(field))throw new Error(`TDLib constructor required ${key}`);const returned=returns.get(field['@type']);if(returned!==type&&field['@type']!==type)throw new Error(`TDLib constructor type mismatch ${key}`);validateTdObject(field);}
  else if(!['Bool','string','bytes','double','int32','int53','int64'].includes(type))throw new Error(`TDLib constructor required ${key}`);
}
