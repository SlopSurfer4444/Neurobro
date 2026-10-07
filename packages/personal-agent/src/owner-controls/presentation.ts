import type { OwnerScopeProposal } from './types.ts';

// Peer titles are external data. Keep them on one line, distinct from the host's approval instructions.
function label(value: string, limit: number): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, Math.max(0, limit - 1));
  return cut.replace(/[\uD800-\uDBFF]$/u, '') + '…';
}

/** A source approval is a readable exact peer list, not an internal JSON export. */
export function sourceProposalPresentation(proposal: OwnerScopeProposal): { card: string; attachment?: string } {
  if (proposal.kind !== 'sources' || !proposal.sources?.length) throw new Error('Source proposal presentation requires saved sources');
  const header = `${proposal.title}\n${proposal.monitor ? 'Предлагаю наблюдать за источниками' : 'Предлагаю читать источники'}: ${proposal.sources.length}.\nЭто предложение ещё не подтверждено.`;
  const footer = `Ответь на эту карточку «да» или «нет».\nПредложение #${proposal.id}\nДействует до ${proposal.expiresAt}.`;
  const repeatedHandles = new Set(proposal.sources.filter(source => source.username && proposal.sources!.filter(item => item.username?.toLowerCase() === source.username!.toLowerCase()).length > 1).map(source => source.username!.toLowerCase()));
  const rows = (bound: number) => proposal.sources!.map(source => `${bound ? label(source.label, bound) + ' ' : ''}${source.username
    ? '(@' + label(source.username, 32) + (repeatedHandles.has(source.username.toLowerCase()) ? '; ID ' + source.peerId : '') + ')' : '(ID ' + source.peerId + ')'}`).join('\n');
  for (const bound of [80, 48, 24, 0]) {
    const text = `${header}\n\n${rows(bound)}\n\n${footer}`;
    if (text.length <= 3300) return { card: text };
  }
  // Unusually long opaque peer IDs stay exact in the attached readable text.
  return { card: `${header}\n\nПолный точный список источников — в приложенном текстовом документе.\n\n${footer}`,
    attachment: `${header}\n\n${rows(1024)}\n\n${footer}` };
}
