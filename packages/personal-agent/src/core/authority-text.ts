import type { Observation } from '../contracts.ts';

/** Malformed native provenance fails closed instead of silently treating the quoted text as authority. */
function ranges(observation: Observation): { offset: number; length: number }[] | undefined {
  const spans = observation.authorityTextRanges;
  if (!spans) return [];
  const length = observation.text?.length ?? 0;
  if (!Array.isArray(spans) || spans.some(span => !span || !Number.isSafeInteger(span.offset) || !Number.isSafeInteger(span.length) ||
    span.offset < 0 || span.length <= 0 || span.offset + span.length > length || !['quote', 'code'].includes(span.kind))) return undefined;
  return spans;
}

/** Complete authority directives may not incorporate any native quoted/code text. */
export function hasQuotedAuthorityText(observation: Observation): boolean {
  const spans = ranges(observation);
  return !spans || spans.some(span => /\S/u.test((observation.text ?? '').slice(span.offset, span.offset + span.length)));
}

/** Ordinary analysis may include quoted material, but the command itself must begin outside it. */
export function beginsWithQuotedCommand(observation: Observation, prefix = '/бро'): boolean {
  const spans = ranges(observation);
  if (!spans) return true;
  const text = observation.text ?? '';
  let offset = text.search(/\S/u);
  if (offset < 0) return false;
  if (spans.some(span => offset >= span.offset && offset < span.offset + span.length)) return true;
  if (text.slice(offset).startsWith(prefix) && /\s|^$/u.test(text.slice(offset + prefix.length, offset + prefix.length + 1))) {
    const rest = text.slice(offset + prefix.length), content = rest.search(/\S/u);
    if (content < 0) return false;
    offset += prefix.length + content;
  }
  return spans.some(span => offset >= span.offset && offset < span.offset + span.length);
}
