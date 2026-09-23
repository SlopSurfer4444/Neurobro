import { STANDING_INCOMING_TEXT_BYTES } from "./standing-context.js";
import { scrypt } from "node:crypto";
import { types } from "node:util";
import type { PilotBinding, PilotPrimary } from "./pilot-telegram-adapter.js";
import type { ConversationReferences } from "./conversation-references.js";
import { projectStandingOwnAction, type StandingOwnActionSource, type StandingOwnActionView } from "./standing-own-action-projection.js";
import type { StandingSharedContextCoverage } from "./standing-shared-context.js";

export type StandingOwnActionContextPage = Readonly<{
  source: Readonly<{ items: readonly StandingOwnActionView[]; coverage: StandingSharedContextCoverage }>;
}>;
export type StandingOwnActionMemory = Readonly<{
  /** Trusted post-persistence producer metadata only, never model arguments. */
  observe(input: Readonly<{slot: string; source: StandingOwnActionSource}>): void;
  forPrimary(input: Readonly<{primary: PilotPrimary; asOf: number}>): StandingOwnActionContextPage;
  close(): void;
}>;
type Owner = Readonly<{binding: PilotBinding; primary: PilotPrimary; references: ConversationReferences; scopeRef: string; asOf: number; signal: AbortSignal}>;
const owners = new WeakMap<object, Owner>();
const DOMAIN = "DecadansNeurobro/standing-own-action-memory/reference-key/v1";
const fail = (): never => { throw new Error("STANDING_OWN_ACTION_MEMORY_REFUSED"); };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const ds = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(ds);
  if (names.length !== keys.length || names.some(k => typeof k !== "string" || !keys.includes(k))) return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) { const d = ds[key]; if (!d || !("value" in d) || !d.enumerable) return fail(); result[key] = d.value; }
  return result;
}
function validText(value: unknown, cap: number, minimum = 0): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= cap && !value.includes("\0") &&
    Buffer.byteLength(value) <= cap && Buffer.from(value).toString() === value;
}
const userId = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,19}$/u.test(v);
const queryNoise = new Set(("a an and are as at be by can did do for from how i in is it me my of on or that the this to was we what when where which with you your " +
  "промпт prompt бро нейробро а без бы был была были в во вот все где да для до его ее ещё еще же за и из или как какой какая какие когда мне мы на не но ну о об он она они от по под пожалуйста про с со так там то ты у уже что это я мой моя мои наш наша наши " +
  "покажи найди отправь скинь напомни можешь сейчас только ответ сообщение").split(/\s+/u));
function recallTerms(text: string, limit: number): Set<string> {
  const terms = new Set<string>();
  for (const match of text.normalize("NFKC").toLowerCase().replaceAll("ё", "е").matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0];
    if (term.length < 2 || term.length > 64 || !/\p{L}/u.test(term) || queryNoise.has(term)) continue;
    terms.add(term); if (terms.size === limit) break;
  }
  return terms;
}
function recallText(view: StandingOwnActionView): string {
  const content = view.content;
  switch (content.kind) {
    case "text": return content.text ?? "";
    case "photo": return content.caption;
    case "artifact": return content.filename + " " + content.caption;
    case "poll": return [content.question ?? "", ...content.options].join(" ");
    case "self-profile": return [content.firstName ?? "", content.lastName ?? ""].join(" ");
    default: return "";
  }
}
/** Bounded lexical recall from already projected evidence, not a semantic or
 * archive search. Reserve two recent actions for continuity, then lift up to six
 * older matches ahead of recency fillers. Matching never changes a verdict,
 * grants an artifact capability, or interprets source text as instructions. */
function selectOwnActions(recent: readonly StandingOwnActionView[], query: string): readonly StandingOwnActionView[] {
  const terms = recallTerms(query, 64);
  if (terms.size === 0 || recent.length <= 2) return recent.slice(0, 8);
  const documents = recent.map(view => recallTerms(recallText(view), 256));
  const frequencies = new Map<string, number>();
  for (const document of documents) for (const term of terms) if (document.has(term)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  const ranked = recent.map((view, index) => ({ view, index, score: [...terms].reduce((score, term) =>
    score + (documents[index]!.has(term) ? 1 / frequencies.get(term)! : 0), 0) }))
    .filter(item => item.index >= 2 && item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 6);
  if (!ranked.length) return recent.slice(0, 8);
  const selected = [...ranked.map(item => item.view), ...recent.slice(0, 2)];
  const seen = new Set(selected.map(view => view.actionRef));
  for (const view of recent) if (selected.length < 8 && !seen.has(view.actionRef)) { selected.push(view); seen.add(view.actionRef); }
  return selected;
}
function check(owner: Owner): void {
  if (owner.signal.aborted || !owner.references.matches(owner.binding.peerId, owner.binding.accountId) ||
      owner.references.speaker(owner.primary.ownerId) === "neurobro") return fail();
}

/** Volatile, bounded read-side memory. Derivation uses the existing passphrase
 * and explicit account/chat domain, independently of connection-local aliases.
 * Opening joins real scrypt even on abort; the password buffer is then cleared.
 * Closing wipes the retained derived key and revokes issued pages. The projector
 * accepts a transient hex key, which this module does not retain.
 * No disk, client, model, timer or new credential is created. A callback must
 * supply records whose persistence/authentication its source owner established;
 * projection and key derivation cannot authenticate caller-provided JSON.
 */
export async function openStandingOwnActionMemory(input: Readonly<{
  binding: PilotBinding; passphrase: string; references: ConversationReferences; scopeRef: string; signal: AbortSignal;
}>): Promise<StandingOwnActionMemory> {
  const args = record(input, ["binding", "passphrase", "references", "scopeRef", "signal"]), b = record(args.binding, ["accountId", "peerId"]);
  if (!userId(b.accountId) || typeof b.peerId !== "string" || !/^-[1-9]\d{0,19}$/u.test(b.peerId) || !validText(args.passphrase, 4096, 16) ||
      !args.references || typeof args.references !== "object" || types.isProxy(args.references) ||
      typeof args.scopeRef !== "string" || !/^[a-z][a-z0-9-]{0,31}_[0-9a-f]{32,64}$/u.test(args.scopeRef) ||
      types.isProxy(args.signal) || !(args.signal instanceof AbortSignal)) return fail();
  const binding = Object.freeze({ accountId: b.accountId, peerId: b.peerId }), references = args.references as ConversationReferences,
    scopeRef = args.scopeRef, signal = args.signal;
  if (signal.aborted || !references.matches(binding.peerId, binding.accountId)) return fail();
  const password = Buffer.from(args.passphrase, "utf8"); delete args.passphrase;
  let key: Buffer | undefined;
  try {
    key = await new Promise<Buffer>((resolve, reject) => scrypt(password, JSON.stringify([DOMAIN, binding.accountId, binding.peerId]), 32,
      (error, derived) => { if (error) { derived?.fill(0); reject(error); } else resolve(derived); }));
    if (signal.aborted || !references.matches(binding.peerId, binding.accountId)) return fail();
  } catch { key?.fill(0); return fail(); }
  finally { password.fill(0); }
  const retainedKey = key, stop = new AbortController(), ownerSignal = AbortSignal.any([signal, stop.signal]);
  const entries = new Map<string, StandingOwnActionView>();
  let closed = false;
  const live = () => { if (closed || signal.aborted || !references.matches(binding.peerId, binding.accountId)) return fail(); };
  const close = () => { if (closed) return; closed = true; stop.abort(); entries.clear(); retainedKey.fill(0); signal.removeEventListener("abort", close); };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) { close(); return fail(); }
  return Object.freeze({
    observe(value: Readonly<{slot:string;source:StandingOwnActionSource}>): void {
      if (closed) return;
      live(); const v = record(value, ["slot", "source"]);
      if (!validText(v.slot, 128, 1) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(v.slot) || !v.source || typeof v.source !== "object" || types.isProxy(v.source)) return fail();
      const family = Object.getOwnPropertyDescriptor(v.source, "family");
      if (!family || !("value" in family) || !["pilot", "generated-image", "artifact", "bound-action"].includes(family.value)) return fail();
      const view = projectStandingOwnAction({ binding: { accountId: binding.accountId, chatId: binding.peerId }, referenceKey: retainedKey.toString("hex"),
        slot: v.slot, source: v.source as StandingOwnActionSource });
      const slotKey = family.value + ":" + v.slot;
      entries.delete(slotKey); entries.set(slotKey, view);
      if (entries.size > 32) entries.delete(entries.keys().next().value!);
    },
    forPrimary(value: Readonly<{primary:PilotPrimary;asOf:number}>): StandingOwnActionContextPage {
      live(); const v = record(value, ["primary", "asOf"]), p = record(v.primary, ["chatId", "ownerId", "messageId", "text"]);
      if (p.chatId !== binding.peerId || !userId(p.ownerId) || references.speaker(p.ownerId) === "neurobro" ||
          !Number.isInteger(p.messageId) || Number(p.messageId) < 1 || Number(p.messageId) > 2147483647 || !validText(p.text, STANDING_INCOMING_TEXT_BYTES, 1) ||
          !Number.isSafeInteger(v.asOf) || Number(v.asOf) < 1 || Number(v.asOf) > 253402300799) return fail();
      const primary = Object.freeze({ chatId: p.chatId, ownerId: p.ownerId, messageId: Number(p.messageId), text: p.text }), asOf = Number(v.asOf);
      // Recency is local observation order, not Telegram chronology. Query recall
      // only changes selection among those same bounded authenticated facts.
      const items = Object.freeze(selectOwnActions([...entries.values()].reverse(), primary.text));
      if (items.some(item => item.observedAt !== null && item.observedAt > asOf)) return fail();
      const page: StandingOwnActionContextPage = Object.freeze({ source: Object.freeze({ items,
        coverage: Object.freeze({ availability: items.length ? "available" : "unavailable", freshness: items.length ? "stale" : "unknown",
          scanned: entries.size, hasMore: null, omittedAtSource: null }) }) });
      const owner = { binding, primary, references, scopeRef, asOf, signal: ownerSignal }; check(owner); owners.set(page, owner); return page;
    },
    close,
  });
}

export function requireStandingOwnActionContext(page: StandingOwnActionContextPage, primary: PilotPrimary,
  references: ConversationReferences | undefined, expected: Readonly<{scopeRef:string;asOf:number}>): StandingOwnActionContextPage {
  const owner = owners.get(page), v = record(expected, ["scopeRef", "asOf"]);
  if (!owner || references !== owner.references || primary.chatId !== owner.primary.chatId || primary.ownerId !== owner.primary.ownerId ||
      primary.messageId !== owner.primary.messageId || primary.text !== owner.primary.text || v.scopeRef !== owner.scopeRef || v.asOf !== owner.asOf) return fail();
  check(owner); return page;
}
