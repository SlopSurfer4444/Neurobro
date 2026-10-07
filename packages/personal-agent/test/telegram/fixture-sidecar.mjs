import readline from 'node:readline';
const lines=readline.createInterface({input:process.stdin});
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
const readyDelay=Number(process.argv.find(v=>v.startsWith('--ready-delay='))?.split('=')[1]??0);
if(readyDelay)setTimeout(()=>emit({'@type':'neurobroSidecarStatus',state:'ready',client_id:1}),readyDelay);
else emit({'@type':'neurobroSidecarStatus',state:'ready',client_id:1});
if(process.argv.includes('--late-close-frame'))lines.on('close',()=>setTimeout(()=>{emit({'@type':'updateAuthorizationState',authorization_state:{'@type':'authorizationStateClosed'}});process.exit(0);},100));
lines.on('line',line=>{const value=JSON.parse(line);if(value['@type']==='malformed'){process.stdout.write('{invalid JSON}\n');return;}if(value['@type']==='close'){
  if(process.argv.includes('--late-close-frame')){
    setTimeout(()=>{emit({'@type':'updateAuthorizationState',authorization_state:{'@type':'authorizationStateClosed'}});process.exit(0);},100);return;
  }
  emit({'@type':'ok','@extra':value['@extra']});emit({'@type':'updateAuthorizationState',authorization_state:{'@type':'authorizationStateClosed'}});process.exit(0);
}if(value['@type']==='slow')setTimeout(()=>{emit({'@type':'ok','@extra':value['@extra']});emit({'@type':'updateConnectionState',state:{'@type':'connectionStateReady'}});},80);else setTimeout(()=>emit({...value,'@type':'ok'}),value.value==='one'?20:1);});
