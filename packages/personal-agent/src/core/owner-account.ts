/** Explicit host-configured delegation for the connected owner's private assistant.
 * This is never an external-message send permission or a model-selected wildcard. */
export const OWNER_ACCOUNT_RESOURCE = 'owner-account-chats';
export const OWNER_ACCOUNT_READS = ['telegram.history','telegram.search','telegram.message.get','telegram.context','telegram.file.get',
  'telegram.participants','telegram.poll.results','telegram.reactions.get','telegram.bot.buttons','telegram.schedule.list',
  'telegram.peer.inspect','telegram.channels.related'] as const;
export const OWNER_ACCOUNT_ACTIONS = ['telegram.folder.create','telegram.folder.update','telegram.source.join'] as const;
export function permitsOwnerAccountResource(capability:string,resource:string):boolean {
  return /^-?[1-9][0-9]{0,19}$/.test(resource) && [...OWNER_ACCOUNT_READS,...OWNER_ACCOUNT_ACTIONS].includes(capability as typeof OWNER_ACCOUNT_READS[number]);
}
