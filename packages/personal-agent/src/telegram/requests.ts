import type { TdObject } from './transport.ts';
const obj = (type: string, fields: TdObject = {}): TdObject => ({ '@type': type, ...fields });
const text = (value: string) => obj('formattedText', { text: value, entities: [] });
const topic = (args: TdObject) => args.resolvedTopic ?? (args.threadId ? obj('messageTopicThread', { message_thread_id: args.threadId }) : null);
const sendOptions = (args: TdObject) => obj('messageSendOptions', { disable_notification: !!args.silent, from_background: true, paid_message_star_count: 0, scheduling_state: args.sendAt ? obj('messageSchedulingStateSendAtDate', { send_date: args.sendAt }) : null });
const messageContent = (args: TdObject) => {
  if (!args.mediaType) return obj('inputMessageText', { text: text(args.text ?? ''), link_preview_options: null, clear_draft: false });
  const names: Record<string,string> = { photo:'Photo', video:'Video', document:'Document', audio:'Audio', voice:'VoiceNote', animation:'Animation', sticker:'Sticker', videoNote:'VideoNote' };
  const suffix = names[args.mediaType]; if (!suffix) throw new Error('unsupported Telegram media profile');
  if (!args.path) throw new Error('media needs trusted staged local path');
  if(args.mediaType==='videoNote'&&(!Number.isInteger(args.length)||args.length<1||args.length>640))throw new Error('Telegram round video requires trusted dimensions of 1..640; media metadata preparation unavailable');
  const field=args.mediaType === 'voice' ? 'voice_note' : args.mediaType === 'videoNote' ? 'video_note' : args.mediaType;
  const input=obj(`input${suffix}`,{[field]:obj('inputFileLocal',{path:args.path}),...(args.mediaType==='document'?{disable_content_type_detection:true}:{}),...(args.mediaType==='voice'?{duration:args.duration??0,waveform:args.waveform??''}:{}),...(args.mediaType==='videoNote'?{duration:args.duration??0,length:args.length??0}:{}),...(args.mediaType==='video'?{duration:args.duration??0,width:args.width??0,height:args.height??0,supports_streaming:true}:{}),...(args.mediaType==='audio'?{duration:args.duration??0,title:args.title??'',performer:args.performer??''}:{})});
  return obj(`inputMessage${suffix}`, { [field]:input, ...(args.mediaType === 'sticker' || args.mediaType === 'videoNote' ? {} : { caption: text(args.caption ?? args.text ?? '') }) });
};
export const EFFECT_METHODS: Record<string, string[]> = {
  'telegram.send':['sendMessage'], 'telegram.message.send':['sendMessage'], 'message.send':['sendMessage'], 'telegram.media.send':['sendMessage'],
  'telegram.message.edit':['editMessageText','editMessageCaption'], 'telegram.message.delete':['deleteMessages'],
  'telegram.poll.create':['sendMessage'], 'telegram.poll.vote':['setPollAnswer'], 'telegram.poll.stop':['stopPoll'], 'telegram.reaction.set':['addMessageReaction','removeMessageReaction'],
  'telegram.profile.update':['setName','setBio','setUsername'], 'telegram.profile.avatar':['setProfilePhoto'],
  'telegram.bot.click':['getCallbackQueryAnswer'], 'telegram.schedule.create':['sendMessage'], 'telegram.schedule.edit':['editMessageSchedulingState'], 'telegram.schedule.cancel':['deleteMessages'], 'telegram.source.join':['joinChat'],
  'telegram.folder.create':['createChatFolder'], 'telegram.folder.update':['editChatFolder'],
};
export const READ_METHODS: Record<string, string[]> = {
  'telegram.chats.list':['getCurrentState','loadChats','getUser','getSupergroup','getBasicGroup'],
  'telegram.history.read':['getChatHistory'], 'telegram.search':['searchChatMessages'], 'telegram.context.read':['getMessage','getMessageThreadHistory','getChatHistory'],
  'telegram.poll.results':['getMessage','getPollVoters'], 'telegram.participants.read':['getSupergroupMembers','getBasicGroupFullInfo'],
  'telegram.profile.read':['getUser','getUserFullInfo'], 'telegram.bot.buttons':['getMessage'], 'telegram.scheduled.list':['getChatScheduledMessages'],
  'telegram.source.discover':['searchChats','searchContacts','searchChatsOnServer','searchPublicChats','searchUserByPhoneNumber','createPrivateChat','searchPublicChat','getMessageLinkInfo','getChat','getUser','getSupergroup'],
};
export function effectRequest(capability: string, peerId: string, args: TdObject): TdObject {
  if (args.tdlib) throw new Error('raw TDLib envelope is not a capability payload');
  const common = { chat_id: peerId, topic_id: topic(args), reply_to: args.replyToMessageId ? obj('inputMessageReplyToMessage', { message_id: args.replyToMessageId }) : null, options: sendOptions(args), reply_markup: null };
  if (['telegram.send','message.send','telegram.message.send','telegram.media.send','telegram.schedule.create'].includes(capability)) return obj('sendMessage', { ...common, input_message_content: messageContent(args) });
  switch (capability) {
    case 'telegram.message.edit': return obj('editMessageText', { chat_id:peerId, message_id:args.messageId, reply_markup:null, input_message_content:messageContent(args) });
    case 'telegram.message.delete': case 'telegram.schedule.cancel': return obj('deleteMessages', { chat_id:peerId, message_ids:args.messageIds ?? [args.messageId], revoke:args.revoke ?? true });
    case 'telegram.poll.create': return obj('sendMessage', { ...common, input_message_content:obj('inputMessagePoll', { question:text(args.question), options:(args.options ?? []).map((s:string) => obj('inputPollOption',{text:text(s),media:null})),description:text(''),media:null,is_anonymous:args.anonymous ?? true,allows_multiple_answers:!!args.multiple,allows_revoting:false,members_only:false,country_codes:[],shuffle_options:false,hide_results_until_closes:false, type:args.quiz ? obj('inputPollTypeQuiz',{correct_option_ids:[args.correctOption],explanation:text(args.explanation??''),explanation_media:null}) : obj('inputPollTypeRegular',{allow_adding_options:false}), open_period:0, close_date:0, is_closed:false }) });
    case 'telegram.poll.vote': return obj('setPollAnswer', { chat_id:peerId, message_id:args.messageId, option_ids:args.optionIds });
    case 'telegram.poll.stop': return obj('stopPoll', {chat_id:peerId,message_id:args.messageId,reply_markup:null});
    case 'telegram.reaction.set': return obj(args.remove ? 'removeMessageReaction' : 'addMessageReaction', { chat_id:peerId, message_id:args.messageId, reaction_type:obj('reactionTypeEmoji',{emoji:args.emoji}), ...(!args.remove ? {is_big:!!args.big,update_recent_reactions:false}: {}) });
    case 'telegram.profile.update': if (args.bio !== undefined) return obj('setBio',{bio:args.bio}); if (args.username !== undefined) return obj('setUsername',{username:args.username}); return obj('setName',{first_name:args.firstName,last_name:args.lastName ?? ''});
    case 'telegram.profile.avatar': return obj('setProfilePhoto',{photo:obj('inputChatPhotoStatic',{photo:obj('inputFileLocal',{path:args.path})}),is_public:!!args.public});
    case 'telegram.bot.click': return obj('getCallbackQueryAnswer',{chat_id:peerId,message_id:args.messageId,payload:obj('callbackQueryPayloadData',{data:args.data})});
    case 'telegram.schedule.edit': return obj('editMessageSchedulingState',{chat_id:peerId,message_id:args.messageId,scheduling_state:obj('messageSchedulingStateSendAtDate',{send_date:args.sendAt})});
    case 'telegram.source.join': return obj('joinChat',{chat_id:peerId});
    case 'telegram.folder.create': return obj('createChatFolder',{folder:args.resolvedFolder});
    case 'telegram.folder.update': return obj('editChatFolder',{chat_folder_id:args.folderId,folder:args.resolvedFolder});
    default: throw new Error('unsupported Telegram effect capability');
  }
}
export function readRequest(capability: string, peerId: string, args: TdObject): TdObject {
  if (args.tdlib) throw new Error('raw TDLib envelope is not a capability payload');
  switch (capability) {
    case 'telegram.history.read': return obj('getChatHistory',{chat_id:peerId,from_message_id:args.before ?? '0',offset:0,limit:Math.min(args.limit ?? 50,100),only_local:false});
    case 'telegram.search': return obj('searchChatMessages',{chat_id:peerId,topic_id:topic(args),query:args.query ?? '',sender_id:null,from_message_id:args.before ?? '0',offset:0,limit:Math.min(args.limit ?? 50,100),filter:null});
    case 'telegram.context.read': if(args.threadId)return obj('getMessageThreadHistory',{chat_id:peerId,message_id:args.messageId,from_message_id:args.before??'0',offset:0,limit:Math.min(args.limit??50,100)});if((args.limit??1)>1)return obj('getChatHistory',{chat_id:peerId,from_message_id:args.messageId,offset:-Math.min(Math.floor(args.limit/2),99),limit:Math.min(args.limit,100),only_local:false});return obj('getMessage',{chat_id:peerId,message_id:args.messageId});
    case 'telegram.poll.results': case 'telegram.bot.buttons': return obj('getMessage',{chat_id:peerId,message_id:args.messageId});
    case 'telegram.participants.read': return obj('getSupergroupMembers',{supergroup_id:args.supergroupId,filter:args.query?obj('supergroupMembersFilterSearch',{query:args.query}):null,offset:args.offset ?? 0,limit:Math.min(args.limit ?? 50,200)});
    case 'telegram.profile.read': if(args.userId!==undefined&&String(args.userId)!==peerId)throw new Error('profile read escaped resource');return obj('getUserFullInfo',{user_id:peerId});
    case 'telegram.scheduled.list': return obj('getChatScheduledMessages',{chat_id:peerId});
    case 'telegram.source.discover': return obj('searchPublicChats',{query:args.query});
    default: throw new Error('unsupported Telegram read capability');
  }
}
