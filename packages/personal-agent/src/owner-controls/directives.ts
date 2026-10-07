export type DirectOwnerDirective =
  | { kind: 'observe' | 'read' | 'unsubscribe'; selectors: string[]; forwardedSource?: boolean }
  | { kind: 'approve'; proposalId?: string; selectedIds?: string[] }
  | { kind: 'reject'; proposalId?: string };

const MAX_INPUT_LENGTH = 4096;
const MAX_SELECTORS = 32;
const ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,63}';
const USERNAME = '[A-Za-z][A-Za-z0-9_]{3,31}';
const publicSelector = new RegExp(`^(?:@|(?:https://)?t\\.me/)(${USERNAME})/?$`, 'i');
const privatePostSelector = /^(?:https:\/\/)?t\.me\/c\/([1-9][0-9]{0,19})\/([1-9][0-9]{0,19})\/?$/i;

function parseSelector(token: string): string | undefined {
  // A slash is valid on a URL, but never on a bare username.
  if (token.startsWith('@') && token.endsWith('/')) return undefined;
  const publicMatch = publicSelector.exec(token);
  if (publicMatch) return `@${publicMatch[1]}`;
  const privateMatch = privatePostSelector.exec(token);
  if (privateMatch) return `https://t.me/c/${privateMatch[1]}/${privateMatch[2]}`;
  return undefined;
}

/**
 * Recognizes only complete, direct command forms. The caller must establish
 * owner identity and reply/forward provenance before using the result; this
 * parser does not grant authority or resolve a pending proposal by itself.
 */
export function parseOwnerDirective(text: string): DirectOwnerDirective | undefined {
  if (text.length > MAX_INPUT_LENGTH || /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u.test(text)) return undefined;
  let command = text.trim();
  if (/^\/бро /i.test(command)) command = command.slice(5).trimStart();
  if (!command) return undefined;

  if (/^(?:наблюдай этот источник|(?:monitor|watch) this source)$/i.test(command)) {
    return { kind: 'observe', selectors: [], forwardedSource: true };
  }

  const sourceCommand = /^(наблюдай|monitor|watch|читай|read|перестань наблюдать|unsubscribe) +(.+)$/i.exec(command);
  if (sourceCommand) {
    const tokens = sourceCommand[2]!.split(/ +/);
    if (tokens.length > MAX_SELECTORS) return undefined;
    const selectors = tokens.map(parseSelector);
    if (selectors.some((selector) => selector === undefined)) return undefined;
    const verb = sourceCommand[1]!.toLowerCase();
    const kind = verb === 'читай' || verb === 'read' ? 'read'
      : verb === 'перестань наблюдать' || verb === 'unsubscribe' ? 'unsubscribe' : 'observe';
    return { kind, selectors: [...new Set(selectors as string[])] };
  }

  const approval = new RegExp(`^(?:да(?:, +делай)?|ага|ок|давай|подтверждаю|подтвердить|approve|yes)(?: +#(${ID}))?(?: +(?:только|only) +(${ID}(?: *, *${ID})*))?\\.?$`, 'i').exec(command);
  if (approval) {
    const proposalId = approval[1];
    const selectedIds = approval[2]?.split(/ *, */);
    if (selectedIds && (selectedIds.length > MAX_SELECTORS || new Set(selectedIds).size !== selectedIds.length)) return undefined;
    return { kind: 'approve', ...(proposalId ? { proposalId } : {}), ...(selectedIds ? { selectedIds } : {}) };
  }

  const rejection = new RegExp(`^(?:нет|отклонить|отклоняю|reject|no)(?: +#(${ID}))?$`, 'i').exec(command);
  if (rejection) return { kind: 'reject', ...(rejection[1] ? { proposalId: rejection[1] } : {}) };
  return undefined;
}
