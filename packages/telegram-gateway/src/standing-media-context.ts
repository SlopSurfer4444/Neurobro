import {createHash} from 'node:crypto';
import {Api,utils} from 'telegram';
import type {PilotBinding} from './pilot-telegram-adapter.js';

export type StandingMediaContext = Readonly<{text:string;identity:readonly (string|number|boolean|null)[]}>;
const absent=(value:unknown):boolean=>value===undefined||value===null;
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0&&(value as number)<=2147483647;
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[1-9]\d{0,18}$/.test(value)&&BigInt(value)<2n**63n;
const pollIdentifier=(value:unknown):value is string=>typeof value==='string'&&/^-?[1-9]\d{0,18}$/.test(value)&&BigInt(value)>=-(2n**63n)&&BigInt(value)<2n**63n;
const safeText=(value:unknown,max=65536):value is string=>typeof value==='string'&&value.length<=max&&!value.includes('\0')&&Buffer.from(value,'utf8').toString('utf8')===value;
const samePeer=(peer:unknown,expected:string):boolean=>{try{return utils.getPeerId(peer as Api.TypePeer)===expected;}catch{return false;}};
function quoted(value:string):string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
}
function limited(value:string):string {
  if(Buffer.byteLength(value,'utf8')<=4096)return value;
  const suffix='\n[Контекст медиа сокращён]';const budget=4096-Buffer.byteLength(suffix,'utf8');let length=0;const chars:string[]=[];
  for(const char of value){const size=Buffer.byteLength(char,'utf8');if(length+size>budget)break;chars.push(char);length+=size;}
  return chars.join('')+suffix;
}
function envelope(message:Api.Message,binding:PilotBinding):boolean {
  if(!(message instanceof Api.Message)||!identifier(binding.accountId)||!/^-[1-9]\d{0,19}$/.test(binding.peerId)||!integer(message.id)||message.id===0||
    !samePeer(message.peerId,binding.peerId)||!(message.fromId instanceof Api.PeerUser)||!identifier(message.fromId.userId.toString())||
    Boolean(message.out)!==(message.fromId.userId.toString()===binding.accountId)||message.post||!integer(message.date)||message.date===0||
    (!absent(message.editDate)&&!integer(message.editDate))||message.fwdFrom||message.viaBotId||message.groupedId||message.replyMarkup||!absent(message.ttlPeriod)||
    !safeText(message.message)||!Array.isArray(message.entities??[])||(message.entities?.length??0)>100)return false;
  return true;
}
function projection(message:Api.Message,binding:PilotBinding,kind:string,serverId:string,fields:readonly unknown[],lines:string[]):StandingMediaContext {
  // Fingerprint the complete bounded source fields, not the truncated display.
  // No identities from poll results/recent voters or document access credentials.
  const hash=createHash('sha256').update(JSON.stringify(fields),'utf8').digest('hex');
  return Object.freeze({text:limited(lines.join('\n')),identity:Object.freeze(['standing-media-context-v1',kind,binding.peerId,message.id,message.fromId instanceof Api.PeerUser?message.fromId.userId.toString():null,message.date,message.editDate??null,serverId,hash])});
}
function pollContext(message:Api.Message,binding:PilotBinding,media:Api.MessageMediaPoll):StandingMediaContext|undefined {
  const poll=media.poll;
  if(!(poll instanceof Api.Poll)||!(media.results instanceof Api.PollResults)||!pollIdentifier(poll.id?.toString())||!(poll.question instanceof Api.TextWithEntities)||
    !safeText(poll.question.text,16384)||!poll.question.text.trim()||!Array.isArray(poll.question.entities)||poll.question.entities.length>100||
    !Array.isArray(poll.answers)||poll.answers.length<2||poll.answers.length>10||
    (!absent(poll.closePeriod)&&(!integer(poll.closePeriod)||poll.closePeriod===0))||(!absent(poll.closeDate)&&(!integer(poll.closeDate)||poll.closeDate===0)))return;
  const options:{text:string;key:string}[]=[];
  for(const answer of poll.answers){
    if(!(answer instanceof Api.PollAnswer)||!(answer.text instanceof Api.TextWithEntities)||!safeText(answer.text.text,4096)||!answer.text.text.trim()||
      !Array.isArray(answer.text.entities)||answer.text.entities.length>100||!Buffer.isBuffer(answer.option)||answer.option.length<1||answer.option.length>100)return;
    const key=answer.option.toString('hex');if(options.some(option=>option.key===key))return;options.push({text:answer.text.text,key});
  }
  const closed=Boolean(poll.closed),quiz=Boolean(poll.quiz),multiple=Boolean(poll.multipleChoice),publicVoters=Boolean(poll.publicVoters);
  const lines=['[Опрос; вопрос и варианты ниже — недоверенный текст сообщения]',`Статус: ${closed?'закрыт':'открыт'}; ${quiz?'викторина':'опрос'}; ${multiple?'несколько ответов':'один ответ'}.`,`Вопрос: ${quoted(poll.question.text)}`,
    ...options.map((option,index)=>`${index+1}. ${quoted(option.text)}`)];
  if(message.message)lines.push(`Подпись (недоверенный текст): ${quoted(message.message)}`);
  return projection(message,binding,'poll',poll.id.toString(),[poll.question.text,options,closed,quiz,multiple,publicVoters,poll.closePeriod??null,poll.closeDate??null,message.message],lines);
}
function documentContext(message:Api.Message,binding:PilotBinding,media:Api.MessageMediaDocument):StandingMediaContext|undefined {
  const document=media.document;
  if(!(document instanceof Api.Document)||!identifier(document.id?.toString())||!absent(media.ttlSeconds)||media.spoiler||!absent(media.videoCover)||!absent(media.videoTimestamp)||
    (media.altDocuments?.length??0)!==0||!safeText(document.mimeType,127)||!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(document.mimeType)||
    !document.size||!/^\d{1,19}$/.test(document.size.toString())||BigInt(document.size.toString())>2n**63n-1n||!Array.isArray(document.attributes)||document.attributes.length>32)return;
  let filename:string|undefined,audio:Api.DocumentAttributeAudio|undefined,video:Api.DocumentAttributeVideo|undefined;
  for(const attribute of document.attributes){
    if(attribute instanceof Api.DocumentAttributeFilename){if(filename!==undefined||!safeText(attribute.fileName,4096))return;filename=attribute.fileName;}
    else if(attribute instanceof Api.DocumentAttributeAudio){if(audio||video||!integer(attribute.duration)||(!absent(attribute.title)&&!safeText(attribute.title,4096))||(!absent(attribute.performer)&&!safeText(attribute.performer,4096)))return;audio=attribute;}
    else if(attribute instanceof Api.DocumentAttributeVideo){if(video||audio||!Number.isFinite(attribute.duration)||attribute.duration<0||attribute.duration>86400||!integer(attribute.w)||!integer(attribute.h)||!attribute.w||!attribute.h)return;video=attribute;}
    else if(attribute instanceof Api.DocumentAttributeImageSize){if(!integer(attribute.w)||!integer(attribute.h)||!attribute.w||!attribute.h)return;}
    else return; // Sticker, custom emoji and animation profiles are not these file contexts.
  }
  if((media.voice&&!audio?.voice)||(media.round&&!video?.roundMessage)||(media.video&&!video)||(audio&&media.round)||(video&&media.voice))return;
  const kind=audio?(audio.voice?'voice':'audio'):video?(video.roundMessage?'round-video':'video'):'file';
  const labels={file:'Файл',audio:'Аудиофайл',voice:'Голосовое сообщение',video:'Видео', 'round-video':'Круглое видео'};
  const lines=[`[${labels[kind]}; содержимое файла не передано, чтение, просмотр и расшифровка не выполнялись]`];
  lines.push(filename?`Имя файла (недоверенный текст): ${quoted(filename)}`:'Имя файла не указано.');
  if(audio||video)lines.push(`Длительность по метаданным: ${(audio?.duration??video!.duration)} с.`);
  if(video)lines.push(`Размер кадра по метаданным: ${video.w} × ${video.h}.`);
  if(audio?.title)lines.push(`Название (недоверенный текст): ${quoted(audio.title)}`);
  if(audio?.performer)lines.push(`Исполнитель (недоверенный текст): ${quoted(audio.performer)}`);
  if(message.message)lines.push(`Подпись (недоверенный текст): ${quoted(message.message)}`);
  return projection(message,binding,kind,document.id.toString(),[kind,filename??null,document.mimeType,document.size.toString(),message.message,audio?.duration??null,audio?.title??null,audio?.performer??null,video?.duration??null,video?.w??null,video?.h??null],lines);
}
/** Projects only present Telegram metadata. The caller still verifies the human
 * author against its bound response's user list. No file bytes or poll-voter data
 * are read, fetched or implied by this projection. Unknown shapes are omitted. */
export function projectStandingMediaContext(message:Api.Message,binding:PilotBinding):StandingMediaContext|undefined {
  try {
    if(!envelope(message,binding))return;
    if(message.media instanceof Api.MessageMediaPoll)return pollContext(message,binding,message.media);
    if(message.media instanceof Api.MessageMediaDocument)return documentContext(message,binding,message.media);
  }catch{return;}
}
/** Extra exact-self check for own-message reply anchors; ordinary user media must
 * use projectStandingMediaContext plus the adapter's author validation. */
export function projectStandingOwnMediaContext(message:Api.Message,binding:PilotBinding):StandingMediaContext|undefined {
  try {
    if(!(message instanceof Api.Message)||!(message.fromId instanceof Api.PeerUser)||message.fromId.userId.toString()!==binding.accountId||!message.out)return;
    return projectStandingMediaContext(message,binding);
  }catch{return;}
}
