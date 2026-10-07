import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { acquireLease } from '../../src/lease.ts';
test('simultaneous processes cannot steal a newly replaced stale lease',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'neurobro-lease-'));
  const workers:ReturnType<typeof spawn>[]=[];
  try{
    // Finished child supplies a proven absent process ID, rather than guessing a PID.
    const gone=spawn(process.execPath,['-e','process.exit(0)']);const pid=gone.pid!;await new Promise(resolve=>gone.once('close',resolve));
    writeFileSync(join(dir,'service.lock'),JSON.stringify({id:randomUUID(),pid}));
    const script=`import {acquireLease} from ${JSON.stringify(new URL('../../src/lease.ts',import.meta.url).href)};let lease;try{lease=acquireLease(process.argv[1]);process.stdout.write('won\\n')}catch{process.stdout.write('blocked\\n')}process.stdin.once('data',()=>{lease?.close();process.exit(0)});`;
    const results=await Promise.all([1,2].map(()=>new Promise<string>((resolve,reject)=>{
      const child=spawn(process.execPath,['--input-type=module','-e',script,dir],{stdio:['pipe','pipe','pipe']});workers.push(child);child.once('error',reject);child.stdout!.once('data',data=>resolve(data.toString().trim()));
    })));
    assert.equal(results.filter(result=>result==='won').length,1);assert.equal(results.filter(result=>result==='blocked').length,1);
    await Promise.all(workers.map(child=>new Promise<void>(resolve=>{child.once('close',()=>resolve());child.stdin!.end('stop\n');})));
    assert.equal(existsSync(join(dir,'service.lock')),false);
  }finally{for(const worker of workers)if(worker.exitCode===null)worker.kill();assert.ok(dir.startsWith(join(tmpdir(),'neurobro-lease-')));rmSync(dir,{recursive:true,force:true});}
});
test('login may retain STOP but cannot bypass reconciliation or concurrent custody',()=>{
  const dir=mkdtempSync(join(tmpdir(),'neurobro-lease-'));
  try{
    writeFileSync(join(dir,'STOP'),'owner stop');assert.throws(()=>acquireLease(dir),/STOP/);
    const login=acquireLease(dir,{allowStopped:true});assert.ok(existsSync(join(dir,'STOP')));assert.throws(()=>acquireLease(dir,{allowStopped:true}),/Another broker/);login.close();
    writeFileSync(join(dir,'.neurobro-reconciliation-required.json'),'{}');assert.throws(()=>acquireLease(dir,{allowStopped:true}),/reconciliation/);
  }finally{assert.ok(dir.startsWith(join(tmpdir(),'neurobro-lease-')));rmSync(dir,{recursive:true,force:true});}
});
