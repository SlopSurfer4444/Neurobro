import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TdlibTelegram, type TdJsonTransport, type TdObject, type TelegramReceipt } from '../../src/telegram/index.ts';
import type { Effect } from '../../src/contracts.ts';

test('channel join reconciles own membership without participant-list permission or repeated join', async () => {
  const calls: string[] = [], rows = new Map<string, TelegramReceipt>(); let joined = false, wrongIdentity = false;
  class Transport extends EventEmitter implements TdJsonTransport {
    async invoke(request: TdObject): Promise<TdObject> {
      calls.push(request['@type']);
      if (request['@type'] === 'getMe') return { '@type': 'user', id: '1' };
      if (request['@type'] === 'joinChat') { joined = true; wrongIdentity = true; return { '@type': 'chatJoinResultSuccess' }; }
      if (request['@type'] === 'getChat') return { '@type': 'chat', id: '-10042', type: { '@type': 'chatTypeSupergroup', supergroup_id: '42', is_channel: true } };
      if (request['@type'] === 'getSupergroup') return { '@type': 'supergroup', id: wrongIdentity ? '99' : '42', usernames: { active_usernames: ['PublicJobs'] }, status: { '@type': joined ? 'chatMemberStatusMember' : 'chatMemberStatusLeft' } };
      throw new Error('No participant inspection authority');
    }
    async close() {}
  }
  const port = new TdlibTelegram({ accountId: '1', transport: new Transport(), receipts: {
    async get(id) { return rows.get(id); }, async put(row) { rows.set(row.effectId, row); }, async findMessage() { return undefined; },
  } });
  const effect: Effect = { id: 'join-1', taskId: 'task', intentRevision: 1, grantId: 'grant', grantRevision: 1,
    capability: 'telegram.source.join', resource: '-10042', payload: { peerId: '-10042' }, payloadHash: 'bound', state: 'prepared', createdAt: '2026-10-05', updatedAt: '2026-10-05' };
  try {
    assert.equal((await port.dispatch(effect)).state, 'unknown');
    wrongIdentity = false; assert.equal((await port.reconcile(effect)).state, 'verified');
    assert.equal((await port.dispatch(effect)).state, 'verified');
    assert.equal(calls.filter(call => call === 'joinChat').length, 1); assert.ok(!calls.includes('getChatMember'));
  } finally { await port.close(); }
});
test('joining rejects private peers and username-less groups/channels before native mutation or receipt',async()=>{
  for(const kind of ['private','private-channel','private-group']){
    let joined=false,written=false;
    class Transport extends EventEmitter implements TdJsonTransport{
      async invoke(request:TdObject):Promise<TdObject>{switch(request['@type']){
        case 'getMe':return{'@type':'user',id:'1'};
        case 'getChat':return{'@type':'chat',id:'-10042',type:kind==='private'?{'@type':'chatTypePrivate',user_id:'42'}:{'@type':'chatTypeSupergroup',supergroup_id:'42',is_channel:kind==='private-channel'}};
        case 'getUser':return{'@type':'user',id:'42',have_access:true,type:{'@type':'userTypeRegular'},usernames:{active_usernames:['Poster']}};
        case 'getSupergroup':return{'@type':'supergroup',id:'42',usernames:{active_usernames:[]},is_channel:kind==='private-channel'};
        case 'joinChat':joined=true;return{'@type':'chatJoinResultSuccess'};default:throw new Error('Unexpected '+request['@type']);}}
      async close(){}
    }
    const port=new TdlibTelegram({accountId:'1',transport:new Transport(),receipts:{get:async()=>undefined,put:async()=>{written=true;},findMessage:async()=>undefined}});
    const effect:Effect={id:'join-1',taskId:'task',intentRevision:1,grantId:'grant',grantRevision:1,capability:'telegram.source.join',resource:'-10042',payload:{peerId:'-10042'},payloadHash:'bound',state:'prepared',createdAt:'',updatedAt:''};
    await assert.rejects(port.dispatch(effect),/public group or channel/);assert.equal(joined,false);assert.equal(written,false);await port.close();
  }
});
