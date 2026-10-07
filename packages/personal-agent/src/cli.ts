import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin, stdout } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, encryptionKey } from './config.ts';
import { openTelegram, startApplication } from './app.ts';
import { acquireLease } from './lease.ts';
import { runDoctor, prepareIsolatedProfile } from '../tools/ops/index.ts';
import { ask, askSecret } from './prompts.ts';
import { collectApiCredentials, enrollAccount, bindControlPeer, requireUnenrolled, onboardingStage, OnboardingClosureError, OnboardingStageError, type EnrollmentPrompts } from './onboarding.ts';
import { TdRequestError, type TdErrorReason } from './telegram/transport.ts';

function option(args: string[], name: string): string | undefined { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
const output = (value: unknown) => stdout.write(JSON.stringify(value, null, 2) + '\n');
const REASON_GUIDANCE:Partial<Record<TdErrorReason,string>>={
  USERNAME_NOT_OCCUPIED:'The exact username was not found. Verify its current spelling in Telegram; no alternative conversation was selected.',
  USERNAME_INVALID:'Verify the exact Telegram username format, including underscores.',
  USER_NOT_FOUND:'Telegram could not read the selected user. Verify that the intended private peer still exists.',
  CHAT_NOT_FOUND:'Telegram could not read the selected chat. Verify the exact private control peer before binding.',
  FLOOD_WAIT:'Telegram rate limited this request. Wait before another explicit attempt; no request was automatically repeated.',
  PHONE_CODE_INVALID:'The submitted login code was rejected. Request a fresh code through the explicit login flow.',
  PHONE_CODE_EXPIRED:'The submitted login code expired. Request a fresh code through the explicit login flow.',
  PASSWORD_HASH_INVALID:'The submitted two-factor password was rejected. Check it locally.',
  PHONE_NUMBER_INVALID:'The submitted phone number was rejected. Check it locally.',
  EMAIL_INVALID:'The submitted authentication email was rejected. Check it locally.',
  EMAIL_CODE_INVALID:'The submitted email code was rejected. Request a fresh code through the explicit login flow.',
  API_ID_INVALID:'Check the locally supplied Telegram API credentials.',API_HASH_INVALID:'Check the locally supplied Telegram API credentials.',
  AUTH_KEY_UNREGISTERED:'The saved session requires explicit owner authentication. Preserve its database; do not reset it.',
  AUTH_KEY_DUPLICATED:'Telegram rejected the session authorization. Preserve its database and reconcile before another attempt.',
  SESSION_REVOKED:'The saved session was revoked. Preserve its database and use explicit owner authentication.',
  SESSION_EXPIRED:'The saved session expired. Preserve its database and use explicit owner authentication.',
};
const LOCAL_COMMAND_DETAILS=new Set([
  'Command requires --config <file>','Enrollment needs an interactive terminal; authentication values cannot be passed in CLI arguments',
  'Enrollment requires a new unbound profile; use login for an already bound account','Enrollment required; run enroll --config <file> before account login verification',
  'Enrollment requires a primary Telegram user account','Enrollment identity is not a valid Telegram user ID',
  'Enrollment encountered an unsupported interactive authorization state','Enrollment authorization did not settle within the bounded interactive flow',
  'Enrollment configuration source mismatch','Enrollment Telegram directories do not match the isolated profile','Enrollment state key must contain 32 bytes',
  'Enrollment configuration must be an ordinary exclusive file','Enrollment configuration changed; re-read before binding','Enrollment configuration changed; binding was not applied',
  'Control peer binding requires --username <exact private username>','Control peer requires an exact Telegram username','Control peer username did not resolve to a chat',
  'Control peer chat identity changed during fresh verification','Control peer must be a verified private conversation','Control peer is not an accessible private Telegram user or bot',
  'Control peer username did not match the exact fresh identity','Control peer binding requires the already enrolled primary owner','Control peer cannot be the enrolled owner; Saved Messages are reserved for storage',
  'Control peer configuration source mismatch','Control peer Telegram directories do not match the isolated profile','Control peer binding requires trusted local confirmation',
  'Control peer authorization does not match the enrolled owner','Control peer owner binding changed',
  'Start blocked: enroll and confirm the owner account before starting','Telegram login closure requires reconciliation',
  'Telegram API ID must be a positive int32','Telegram API hash must contain 32 hexadecimal characters',
]);
/** Only controlled stage/codes and exact local guidance reach the terminal. Never native error text. */
export function commandFailure(error:unknown):Record<string,unknown>{
  const result:Record<string,unknown>={error:'PERSONAL_AGENT_COMMAND_FAILED'};
  if(error instanceof OnboardingStageError){
    result.stage=error.stage;result.outcome=error.outcome;
    if(error.telegramReason)result.telegramReason=error.telegramReason;if(error.telegramCode!==undefined)result.telegramCode=error.telegramCode;
    result.detail=`${error.message}. ${error.telegramReason&&REASON_GUIDANCE[error.telegramReason]||'Inspect local configuration and run doctor; no uncertain operation was retried.'}`;return result;
  }
  if(error instanceof OnboardingClosureError)return{...result,stage:'transport-close',outcome:'unknown',detail:'Telegram transport closure requires reconciliation. Binding was not applied; preserve the existing session and custody marker.'};
  if(error instanceof TdRequestError){if(error.reason)result.telegramReason=error.reason;if(error.code!==undefined)result.telegramCode=error.code;result.detail=error.reason&&REASON_GUIDANCE[error.reason]||'Telegram request failed. Inspect local configuration and run doctor; no uncertain operation was retried.';return result;}
  const message=error instanceof Error?error.message:'';
  result.detail=LOCAL_COMMAND_DETAILS.has(message)||/^Required environment variable is absent: [A-Z][A-Z0-9_]*$/.test(message)?message:/^Telegram login required \(authorizationState[A-Za-z]+\); run login --config explicitly$/.test(message)?'Telegram login required; run login --config explicitly':'Inspect local configuration and run doctor; no uncertain operation was retried.';
  return result;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0] ?? 'help';
  if (command === 'help' || command === '--help') {
    stdout.write('Neurobro personal agent\n\n  doctor --config <file> [--runtime <bindings.json>]\n  init --state <new absolute directory>\n  enroll --config <file>\n  bind-control --config <file> --username <exact private username>\n  login --config <file>\n  start --config <file>\n  stop --config <file>\n\nEnroll confirms the primary account locally. Control peer binding is separate and accepts a private user or bot conversation. Saved Messages remain storage. STOP remains until explicit start readiness.\nNew profile only; no existing service or credentials are adopted.\n'); return;
  }
  if (command === 'init') {
    const path = option(args, '--state'); if (!path) throw new Error('init requires --state <new absolute directory>');
    const profile = await prepareIsolatedProfile(resolve(path), { profileId: 'neurobro-personal' });
    output(profile); return;
  }
  const file = option(args, '--config'); if (!file) throw new Error('Command requires --config <file>');
  const config = loadConfig(resolve(file));
  if (command === 'doctor') {
    const runtimeFile = option(args, '--runtime');
    const report = await runDoctor(config, { runtime: runtimeFile ? JSON.parse(readFileSync(resolve(runtimeFile), 'utf8')) : undefined });
    output(report); if (!report.configurationValid) process.exitCode = 2; return;
  }
  if (command === 'stop') {
    mkdirSync(config.stateDirectory, { recursive: true });
    writeFileSync(join(config.stateDirectory, 'STOP'), JSON.stringify({ schemaVersion: 1, reason: 'owner CLI stop', at: new Date().toISOString() }), { mode: 0o600 });
    const deadline = Date.now() + 30_000;
    while (existsSync(join(config.stateDirectory, 'service.lock')) && Date.now() < deadline) await delay(200);
    output({ stopRequested: true, brokerLeaseReleased: !existsSync(join(config.stateDirectory, 'service.lock')), nativeTaskSettlement: 'not_asserted' }); return;
  }
  if(command==='enroll'||command==='bind-control'){
    if(!stdin.isTTY)throw new Error('Enrollment needs an interactive terminal; authentication values cannot be passed in CLI arguments');
    if(command==='enroll')requireUnenrolled(config);
    const username=command==='bind-control'?option(args,'--username'):undefined;
    if(command==='bind-control'&&!username)throw new Error('Control peer binding requires --username <exact private username>');
    const prompts:EnrollmentPrompts={ask,askSecret,
      async confirmIdentity(identity){output({discoveredPrimaryAccount:identity,controlPeerId:config.account.controlPeerId});return(await ask(`Confirm this primary account by typing its exact ID ${identity.accountId}: `)).trim()===identity.accountId;},
      async confirmControl(identity){output({verifiedPrivateControlConversation:identity,primaryAccountId:config.account.id});return(await ask(`Confirm @${identity.username} as the private control conversation by typing exact peer ID ${identity.peerId}: `)).trim()===identity.peerId;},
    };
    const credentials=await collectApiCredentials(config,prompts),key=encryptionKey(config);
    const lease=acquireLease(config.stateDirectory,{allowStopped:true});
    let closureUnknown=false;
    try{
      const result=command==='enroll'?await enrollAccount({configPath:resolve(file),config,key,credentials,prompts}):await bindControlPeer({configPath:resolve(file),config,key,credentials,prompts,username:username!});
      output({...result,serviceStarted:false,stopPreserved:existsSync(join(config.stateDirectory,'STOP'))});return;
    }catch(error){closureUnknown=error instanceof OnboardingClosureError;throw error;
    }finally{
      // Failed native settlement retains custody and blocks all subsequent starts.
      if(!closureUnknown&&!existsSync(join(config.stateDirectory,'.neurobro-reconciliation-required.json')))lease.close();
    }
  }
  if (command === 'login') {
    if (!stdin.isTTY) throw new Error('Login needs an interactive terminal; do not pass authentication codes in CLI arguments');
    if(config.account.id==='0'||config.account.ownerId==='0')throw new Error('Enrollment required; run enroll --config <file> before account login verification');
    const lease = acquireLease(config.stateDirectory, { allowStopped: true });
    let telegram: Awaited<ReturnType<typeof openTelegram>> | undefined;
    try {
      telegram = await openTelegram(config, encryptionKey(config));
      for (;;) {
        const state = await onboardingStage('authorization-state',()=>telegram!.authStatus());
        switch (state['@type']) {
          case 'authorizationStateReady': await onboardingStage('account-identity',()=>telegram!.verifyAccount()); output({ authenticated: true, accountMatched: true }); return;
          case 'authorizationStateWaitPhoneNumber': {const phone=await ask('Telegram phone: ');await onboardingStage('submit-phone',()=>telegram!.submitAuth({ '@type': 'setAuthenticationPhoneNumber', phone_number:phone, settings: null }));break;}
          case 'authorizationStateWaitCode': {const code=await askSecret('Telegram login code: ');await onboardingStage('submit-code',()=>telegram!.submitAuth({ '@type': 'checkAuthenticationCode', code }));break;}
          case 'authorizationStateWaitPassword': {const password=await askSecret('Telegram 2FA password: ');await onboardingStage('submit-password',()=>telegram!.submitAuth({ '@type': 'checkAuthenticationPassword', password }));break;}
          case 'authorizationStateWaitEmailAddress': {const email=await ask('Telegram email: ');await onboardingStage('submit-email',()=>telegram!.submitAuth({ '@type': 'setAuthenticationEmailAddress', email_address:email }));break;}
          case 'authorizationStateWaitEmailCode': {const code=await askSecret('Email login code: ');await onboardingStage('submit-email-code',()=>telegram!.submitAuth({ '@type': 'checkAuthenticationEmailCode', code: { '@type': 'emailAddressAuthenticationCode', code } }));break;}
          default: throw new Error(`Unsupported interactive authorization state: ${state['@type']}`);
        }
      }
    } finally {
      try { await telegram?.close(); }
      catch {
        writeFileSync(join(config.stateDirectory, '.neurobro-reconciliation-required.json'), JSON.stringify({ schemaVersion: 1, reason: 'login_transport_closure_unknown', at: new Date().toISOString() }), { mode: 0o600 });
        throw new Error('Telegram login closure requires reconciliation');
      } finally { lease.close(); }
    }
  }
  if (command !== 'start') throw new Error('Unknown command');
  const abort = new AbortController();
  const stop = () => abort.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await startApplication(config, abort.signal); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Native/provider messages may embed submitted content. Only known local guidance reaches stdout.
    process.stderr.write(JSON.stringify(commandFailure(error)) + '\n');
    process.exitCode = 1;
  });
}
