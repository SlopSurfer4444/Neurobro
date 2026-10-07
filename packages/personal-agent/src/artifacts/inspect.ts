import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactRecord, Json } from '../contracts.ts';
import { safePath } from './paths.ts';

export interface InspectRequest { offset?:number; limit?:number; sheet?:string; delimiter?:','|';'|'\t' }
export interface ArtifactInspection { format:string; unit:string; items:Json[]; coverage:{start:number;end:number;total:number;more:boolean}; gaps:Json[]; limitations:string[]; [key:string]:Json }
export interface InspectorOptions {
  /** Absolute native Python executable, supplied by trusted host. No shell/PATH discovery. */
  pythonExecutable?:string; timeoutMs?:number; maxInputBytes?:number; maxExpandedBytes?:number;
  maxOutputBytes?:number; maxEntries?:number; maxCompressionRatio?:number; maxXmlElements?:number;
  maxPdfPages?:number;
  /** Overrides the local Python PDF decoder when explicitly supplied by the trusted host. */
  pdfExtractor?:(record:ArtifactRecord,bytes:Uint8Array,request:InspectRequest)=>Promise<ArtifactInspection>;
}
const xlsx='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function integer(value:number|undefined,fallback:number,min:number,max:number,name:string):number{const n=value??fallback;if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`Invalid ${name}`);return n;}
function page(items:Json[],offset:number,limit:number,format:string,unit:string,limitations:string[]=[]):ArtifactInspection{
  if(offset>items.length)throw new Error('Inspection offset exceeds total');const end=Math.min(items.length,offset+limit);
  return{format,unit,items:items.slice(offset,end),coverage:{start:offset,end,total:items.length,more:end<items.length},gaps:[],limitations};
}
function csvRows(text:string,delimiter:string,maxCells:number):string[][]{
  const rows:string[][]=[];let row:string[]=[],field='',quoted=false,closedQuote=false,atStart=true,cells=0;
  const cell=()=>{row.push(field);field='';closedQuote=false;atStart=true;if(++cells>maxCells)throw new Error('CSV cell count exceeds configured limit');};
  const finish=()=>{cell();rows.push(row);row=[];};
  for(let i=0;i<text.length;i++){
    const char=text[i]!;
    if(quoted){if(char==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closedQuote=true;}}else field+=char;continue;}
    if(char==='"'){if(!atStart)throw new Error('Malformed CSV quote inside unquoted field');quoted=true;atStart=false;continue;}
    if(char===delimiter){cell();continue;}
    if(char==='\n'||char==='\r'){if(char==='\r'&&text[i+1]==='\n')i++;finish();continue;}
    if(closedQuote)throw new Error('Malformed CSV content after closing quote');field+=char;atStart=false;
  }
  if(quoted)throw new Error('Unclosed CSV quoted field');if(field.length||row.length||!atStart)finish();return rows;
}
/** Deterministic extraction, never an additional LLM call. Original bytes remain in the task vault. */
export class ArtifactInspector {
  private readonly options:InspectorOptions; private readonly inputLimit:number;private readonly outputLimit:number;
  constructor(options:InspectorOptions={}){
    if(options.pythonExecutable && !isAbsolute(options.pythonExecutable))throw new Error('pythonExecutable must be an absolute native executable');
    this.options=options;this.inputLimit=integer(options.maxInputBytes,64*1024*1024,1,256*1024*1024,'inspection input limit');this.outputLimit=integer(options.maxOutputBytes,2*1024*1024,1024,16*1024*1024,'inspection output limit');
  }
  async inspect(record:ArtifactRecord,bytes:Uint8Array,request:InspectRequest={}):Promise<ArtifactInspection>{
    if(bytes.byteLength>this.inputLimit)throw new Error('Inspection input exceeds configured byte limit; not truncated');
    const offset=integer(request.offset,0,0,10_000_000,'inspection offset'),limit=integer(request.limit,100,1,1000,'inspection page limit');
    let result:ArtifactInspection;
    if(record.mimeType===xlsx || record.mimeType===docx)result=await this.ooxml(record,bytes,{...request,offset,limit});
    else if(record.mimeType==='application/pdf'){
      result=this.options.pdfExtractor?await this.options.pdfExtractor(record,bytes,{...request,offset,limit}):await this.pdf(bytes,{...request,offset,limit});
    }else if(record.mimeType==='application/json'){
      const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      // Preserve unsafe integer lexemes instead of rounding identifiers during JSON parsing.
      const value=JSON.parse(text,((key:string,value:unknown,context?:{source?:string})=>typeof value==='number'&&!Number.isSafeInteger(value)&&Number.isInteger(value)?{type:'exact-json-number',source:context?.source??String(value)}:value) as (key:string,value:unknown)=>unknown) as Json;
      const stack:{value:Json;depth:number}[]=[{value,depth:0}];let nodes=0;
      while(stack.length){const current=stack.pop()!;if(++nodes>250_000 || current.depth>128)throw new Error('JSON structure exceeds configured depth/node limits');if(current.value && typeof current.value==='object')for(const item of Object.values(current.value))stack.push({value:item,depth:current.depth+1});}
      const items=Array.isArray(value)?value:value!==null&&typeof value==='object'?Object.entries(value).map(([key,value])=>({key,value})): [value];
      result=page(items,offset,limit,'json',Array.isArray(value)?'array items':value!==null&&typeof value==='object'?'object entries':'scalar',['Unsafe integer lexemes are returned as exact-json-number records; no schema validation is implied']);
    }else if(record.mimeType==='text/csv'){
      const delimiter=request.delimiter??',';if(![',',';','\t'].includes(delimiter))throw new Error('Unsupported CSV delimiter');
      const rows=csvRows(new TextDecoder('utf-8',{fatal:true}).decode(bytes),delimiter,250_000);
      result={...page(rows,offset,limit,'csv','rows including header',['Cell values remain exact strings; header/type inference and formulas are not performed']),delimiter};
    }else if(record.mimeType.startsWith('text/')){
      const lines=new TextDecoder('utf-8',{fatal:true}).decode(bytes).split(/\r\n|\n|\r/u);result=page(lines,offset,limit,'text','lines');
    }else throw new Error(`Inspection unsupported for ${record.mimeType}; bytes/path preview does not establish visual or audio understanding`);
    if(Buffer.byteLength(JSON.stringify(result))>this.outputLimit)throw new Error('Inspection output exceeds configured byte limit; request a smaller explicit page');return result;
  }
  private async pdf(bytes:Uint8Array,request:InspectRequest):Promise<ArtifactInspection>{
    const executable=this.options.pythonExecutable;if(!executable)throw new Error('PDF inspection unsupported: configure the existing absolute Python executable with pypdf');
    safePath(executable,'file');const helper=fileURLToPath(new URL('./inspect_pdf.py',import.meta.url));safePath(helper,'file');
    const timeout=integer(this.options.timeoutMs,20_000,100,60_000,'inspection timeout');
    const limits={maxInputBytes:this.inputLimit,maxOutputBytes:this.outputLimit,maxExpandedBytes:integer(this.options.maxExpandedBytes,32*1024*1024,1024,256*1024*1024,'PDF expanded limit'),maxPdfPages:integer(this.options.maxPdfPages,2000,1,10_000,'PDF page count limit')};
    const input=JSON.stringify({bytes:Buffer.from(bytes).toString('base64'),offset:request.offset,limit:request.limit,limits});
    return new Promise<ArtifactInspection>((resolve,reject)=>{
      const env:NodeJS.ProcessEnv={};for(const name of ['SystemRoot','WINDIR','TEMP','TMP','PATH'])if(process.env[name])env[name]=process.env[name];
      const child=spawn(executable,['-I','-B',helper],{stdio:['pipe','pipe','pipe'],windowsHide:true,env});
      const chunks:Buffer[]=[];let length=0,failed:Error|undefined;
      const timer=setTimeout(()=>{failed=new Error('PDF inspection timed out; no successful result');child.kill();},timeout);
      child.stdout.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>this.outputLimit){failed=new Error('PDF helper output exceeds configured limit');child.kill();}else chunks.push(chunk);});
      // Arbitrary diagnostics can include document content or host paths. Only fixed helper errors are public.
      child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
      child.on('error',()=>{failed=new Error('PDF helper unavailable: configured Python executable could not be started');});
      child.on('close',code=>{clearTimeout(timer);if(failed){reject(failed);return;}try{
        const response=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {ok?:boolean;inspection?:ArtifactInspection;error?:string};
        if(code!==0||!response.ok||!response.inspection)throw new Error(response.error??'PDF helper failed');
        const result=response.inspection,c=result.coverage;
        if(result.format!=='pdf'||result.unit!=='pages'||!c||c.start!==request.offset||!Number.isSafeInteger(c.total)||c.total<0||c.total>limits.maxPdfPages||c.start>c.total||c.end!==Math.min(c.total,c.start+request.limit!)||c.more!==(c.end<c.total)||!Array.isArray(result.items)||result.items.length!==c.end-c.start||!Array.isArray(result.gaps)||!Array.isArray(result.limitations))throw new Error('PDF helper returned invalid page coverage');
        resolve(result);
      }catch(error){reject(error);}});
      child.stdin.end(input);
    });
  }
  private async ooxml(record:ArtifactRecord,bytes:Uint8Array,request:InspectRequest):Promise<ArtifactInspection>{
    const executable=this.options.pythonExecutable;if(!executable)throw new Error('OOXML inspection unavailable: configure the existing absolute Python executable');
    safePath(executable,'file');const helper=fileURLToPath(new URL('./inspect_ooxml.py',import.meta.url));safePath(helper,'file');
    const timeout=integer(this.options.timeoutMs,20_000,100,60_000,'inspection timeout');
    const limits={maxOutputBytes:this.outputLimit,maxExpandedBytes:integer(this.options.maxExpandedBytes,32*1024*1024,1024,256*1024*1024,'OOXML expanded limit'),maxEntries:integer(this.options.maxEntries,10_000,1,100_000,'OOXML entry limit'),maxCompressionRatio:integer(this.options.maxCompressionRatio,100,1,1000,'OOXML ratio limit'),maxXmlElements:integer(this.options.maxXmlElements,250_000,1,2_000_000,'OOXML element limit')};
    const input=JSON.stringify({kind:record.mimeType===xlsx?'xlsx':'docx',bytes:Buffer.from(bytes).toString('base64'),offset:request.offset,limit:request.limit,sheet:request.sheet,limits});
    return new Promise<ArtifactInspection>((resolve,reject)=>{
      const env:NodeJS.ProcessEnv={};for(const name of ['SystemRoot','WINDIR','TEMP','TMP','PATH'])if(process.env[name])env[name]=process.env[name];
      const child=spawn(executable,['-I','-B',helper],{stdio:['pipe','pipe','pipe'],windowsHide:true,env});
      const chunks:Buffer[]=[];let length=0,failed:Error|undefined;
      const timer=setTimeout(()=>{failed=new Error('OOXML inspection timed out; no successful result');child.kill();},timeout);
      child.stdout.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>this.outputLimit){failed=new Error('OOXML helper output exceeds configured limit');child.kill();}else chunks.push(chunk);});
      // Diagnostics may contain untrusted document data; never forward arbitrary stderr or host environment.
      child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
      child.on('error',error=>{failed=new Error(`OOXML helper unavailable: ${error.message}`);});
      child.on('close',code=>{clearTimeout(timer);if(failed){reject(failed);return;}try{const response=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {ok?:boolean;inspection?:ArtifactInspection;error?:string};if(code!==0||!response.ok||!response.inspection)throw new Error(response.error??'OOXML helper failed');resolve(response.inspection);}catch(error){reject(error);}});
      child.stdin.end(input);
    });
  }
}
