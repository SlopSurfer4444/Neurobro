import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TdlibTelegram, type TdJsonTransport, type TdObject, type TelegramReceiptStore } from '../../src/telegram/index.ts';
import type { MessageRef, Observation } from '../../src/contracts.ts';
const receipts:TelegramReceiptStore={get:async()=>undefined,put:async()=>{},findMessage:async()=>undefined};
const ref:MessageRef={accountId:'42',peerId:'-100555',messageId:'100'};
const message=(content:TdObject):TdObject=>({'@type':'message',id:'100',chat_id:'-100555',sender_id:{'@type':'messageSenderUser',user_id:'77'},date:10,edit_date:0,is_outgoing:false,content});
class Fake extends EventEmitter implements TdJsonTransport {
  current:TdObject=message({'@type':'messageText',text:{text:'fresh'}});
  async invoke(request:TdObject):Promise<TdObject>{if(request['@type']==='getMe')return{'@type':'user',id:'42'};if(request['@type']==='getMessage')return structuredClone(this.current);if(request['@type']==='getChatHistory')return{'@type':'messages',messages:[structuredClone(this.current)]};throw new Error('unexpected native method');}
  async close(){}
}
const poll=()=>({'@type':'messagePoll',poll:{'@type':'poll',id:'9223372036854775807',question:{'@type':'formattedText',text:'Which option?',entities:[]},is_anonymous:true,is_closed:false,allows_multiple_answers:false,total_voter_count:7,can_see_results:true,type:{'@type':'pollTypeQuiz',correct_option_ids:[1],explanation:{text:'private explanation'}},options:[{id:'opaque:first',text:{text:'First'},voter_count:3,is_chosen:false,recent_voter_ids:[{user_id:'secret-voter'}]},{id:'opaque:second',text:{text:'Second'},voter_count:4,is_chosen:true}],recent_voter_ids:[{user_id:'secret-voter'}],country_codes:['private-country']}});
test('fresh poll snapshot preserves exact IDs, results, current choice and quiz state without voters',async()=>{
  const transport=new Fake();transport.current=message(poll());const port=new TdlibTelegram({accountId:'42',transport,receipts});
  const observation=(await port.getMessage(ref))!;assert.deepEqual(observation.messageDetails,{poll:{pollId:'9223372036854775807',question:'Which option?',options:[{id:'opaque:first',index:0,text:'First',votes:3,chosen:false},{id:'opaque:second',index:1,text:'Second',votes:4,chosen:true}],anonymous:true,closed:false,quiz:true,multiple:false,totalVotes:7,resultsAvailable:true,correctOptionIds:[1]}});
  assert.doesNotMatch(JSON.stringify(observation),/secret-voter|private explanation|private-country/);
  const previous=observation.version;transport.current.content.poll.is_closed=true;transport.current.content.poll.options[0].is_chosen=true;
  const fresh=(await port.getMessage(ref))!;assert.notEqual(fresh.version,previous);assert.equal(fresh.messageDetails?.poll?.closed,true);assert.equal(fresh.messageDetails?.poll?.options[0]?.chosen,true);
  assert.deepEqual((await port.readHistory('-100555',{limit:1}))[0]?.messageDetails,fresh.messageDetails);await port.close();
});
test('poll results unavailable and missing native counts are represented without invented zeroes',async()=>{
  const transport=new Fake();transport.current=message(poll());transport.current.content.poll.can_see_results=false;transport.current.content.poll.type={'@type':'pollTypeRegular'};delete transport.current.content.poll.total_voter_count;delete transport.current.content.poll.options[0].is_chosen;
  const port=new TdlibTelegram({accountId:'42',transport,receipts}),details=(await port.getMessage(ref))!.messageDetails!.poll!;
  assert.equal(details.resultsAvailable,false);assert.equal(details.quiz,false);assert.equal(details.totalVotes,undefined);assert.equal(details.options[0]?.chosen,undefined);assert.equal(details.options[0]?.votes,undefined);assert.equal(details.options[1]?.votes,undefined);assert.equal(details.correctOptionIds,undefined);await port.close();
});
test('keyboard snapshot exposes layout and labels but strips callback, authentication and ordinary URLs',async()=>{
  const transport=new Fake();transport.current.reply_markup={'@type':'replyMarkupInlineKeyboard',rows:[[{text:'Callback label',type:{'@type':'inlineKeyboardButtonTypeCallback',data:'secret-callback'}},{text:'Login',type:{'@type':'inlineKeyboardButtonTypeLoginUrl',url:'https://private.test/auth?secret=token',id:'123'}}],[{text:'Web',type:{'@type':'inlineKeyboardButtonTypeUrl',url:'https://private.test/route'}},{text:'Payment',type:{'@type':'inlineKeyboardButtonTypeBuy'}}]]};
  const port=new TdlibTelegram({accountId:'42',transport,receipts}),before=(await port.getMessage(ref))!;
  assert.deepEqual(before.messageDetails,{keyboardType:'inline',buttons:[{row:0,column:0,label:'Callback label',type:'inlineKeyboardButtonTypeCallback'},{row:0,column:1,label:'Login',type:'inlineKeyboardButtonTypeLoginUrl'},{row:1,column:0,label:'Web',type:'inlineKeyboardButtonTypeUrl'},{row:1,column:1,label:'Payment',type:'inlineKeyboardButtonTypeBuy'}]});
  assert.doesNotMatch(JSON.stringify(before),/secret-callback|private.test|secret=token/);
  transport.current.reply_markup.rows[0][0].type.data='other-secret';assert.notEqual((await port.getMessage(ref))!.version,before.version,'callback preconditions invalidate even without disclosing bytes');
  transport.current.reply_markup={'@type':'replyMarkupShowKeyboard',rows:[[{text:'Share contact',type:{'@type':'keyboardButtonTypeRequestPhoneNumber'}}]]};const reply=(await port.getMessage(ref))!;assert.equal(reply.messageDetails?.keyboardType,'reply');assert.equal(reply.messageDetails?.buttons?.[0]?.type,'keyboardButtonTypeRequestPhoneNumber');await port.close();
});
test('reaction snapshot preserves available native types and counts and changes message version',async()=>{
  const transport=new Fake();transport.current.interaction_info={view_count:10,reactions:{'@type':'messageReactions',reactions:[{type:{'@type':'reactionTypeEmoji',emoji:'👍'},total_count:2,is_chosen:true,recent_sender_ids:[{user_id:'secret-reactor'}]},{type:{'@type':'reactionTypeCustomEmoji',custom_emoji_id:'9223372036854775807'},total_count:1,is_chosen:false},{type:{'@type':'reactionTypePaid'},total_count:5,is_chosen:false}],paid_reactors:[{sender_id:'secret-payer'}]}};
  const port=new TdlibTelegram({accountId:'42',transport,receipts}),first=(await port.getMessage(ref))!;
  assert.deepEqual(first.messageDetails?.reactions,[{type:'emoji',emoji:'👍',count:2,chosen:true},{type:'custom-emoji',customEmojiId:'9223372036854775807',count:1,chosen:false},{type:'paid',count:5,chosen:false}]);assert.doesNotMatch(JSON.stringify(first),/secret-reactor|secret-payer/);
  transport.current.interaction_info.reactions.reactions[0].total_count=3;const second=(await port.getMessage(ref))!;assert.notEqual(second.version,first.version);assert.equal(second.messageDetails?.reactions?.[0]?.count,3);
  transport.current.interaction_info.reactions.reactions=[];assert.deepEqual((await port.getMessage(ref))!.messageDetails?.reactions,[]);delete transport.current.interaction_info;assert.equal((await port.getMessage(ref))!.messageDetails,undefined);await port.close();
});
test('metadata projection is bounded and signals omitted native fields without truncating identities',async()=>{
  const transport=new Fake();transport.current=message(poll());const p=transport.current.content.poll;p.question.text='q'.repeat(5000);p.options=Array.from({length:101},(_,index)=>({id:`option-${index}`,text:{text:'x'.repeat(1100)},voter_count:index,is_chosen:false}));p.options[0].id='i'.repeat(257);
  transport.current.reply_markup={'@type':'replyMarkupInlineKeyboard',rows:Array.from({length:33},()=>Array.from({length:17},()=>({text:'label'.repeat(100),type:{'@type':'inlineKeyboardButtonTypeCallback',data:'secret'}})))};
  transport.current.interaction_info={reactions:{reactions:Array.from({length:65},()=>({type:{'@type':'reactionTypeEmoji',emoji:'😀'},total_count:1,is_chosen:false}))}};
  const port=new TdlibTelegram({accountId:'42',transport,receipts}),details=(await port.getMessage(ref))!.messageDetails!;
  assert.equal(details.truncated,true);assert.equal(details.poll?.question.length,4096);assert.equal(details.poll?.options.length,99);assert.equal(details.poll?.options[0]?.id,'option-1');assert.equal(details.poll?.options[0]?.index,1);assert.equal(details.poll?.options[0]?.text.length,1024);assert.equal(details.buttons?.length,128);assert.equal(details.buttons?.[0]?.label.length,256);assert.equal(details.reactions?.length,64);await port.close();
});
test('message details originate from the same intake message and never stale native read payload',async()=>{
  const transport=new Fake(),saved:Observation[]=[],port=new TdlibTelegram({accountId:'42',transport,receipts,spool:{append:async event=>{saved.push(event);}}}),abort=new AbortController(),iterator=port.observations(abort.signal)[Symbol.asyncIterator]();
  transport.emit('update',{'@type':'updateNewMessage',message:message(poll())});const observation=(await iterator.next()).value!;assert.equal(observation.messageDetails?.poll?.totalVotes,7);assert.deepEqual(saved[0]?.messageDetails,observation.messageDetails);
  transport.emit('update',{'@type':'updateMessageContent',chat_id:'-100555',message_id:'100',new_content:{'@type':'messagePoll',poll:{...poll().poll,total_voter_count:8}}});const edited=(await iterator.next()).value!;assert.equal(edited.messageDetails?.poll?.totalVotes,8);assert.notEqual(edited.version,observation.version);abort.abort();await iterator.return?.();await port.close();
});
