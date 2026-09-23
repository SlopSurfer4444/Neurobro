import { createHash, createHmac } from "node:crypto";
import { types } from "node:util";
import type { PilotRecord, PilotReply } from "./pilot-outbox.js";
import { copyTelegramTextEntities } from "./telegram-text-format.js";
import { generatedImageDeliveryKey, generatedImagePlanHash, type ImageDeliveryPlan, type ImageDeliveryRecord } from "./generated-image-outbox.js";
import { artifactDeliveryKey, artifactDeliveryPlanHash, type ArtifactDeliveryPlan, type ArtifactDeliveryRecord } from "./standing-artifact-outbox.js";
import { decodeStandingActionSlot, standingActionKey, type StandingActionBinding, type StandingActionIntent, type StandingActionTerminal } from "./standing-action-journal.js";
import { validateStandingPollObjectEvidence } from "./standing-object-evidence.js";

/** Already authenticated AND semantically validated by the owning source reader.
 * These inputs are host capabilities, never model arguments. Shape/hash checks
 * below check correspondence; they cannot authenticate a caller's JSON, prove
 * original I/O settlement, or establish that a remote object still exists.
 * Source readers/indexing and durable host key provisioning remain separate work.
 */
export type StandingOwnActionSource = Readonly<
  { family: "pilot"; record: PilotRecord; reply?: PilotReply } |
  { family: "generated-image"; plan: ImageDeliveryPlan; terminal: ImageDeliveryRecord } |
  { family: "artifact"; plan: ArtifactDeliveryPlan; terminal: ArtifactDeliveryRecord } |
  { family: "bound-action"; binding: StandingActionBinding; intent: StandingActionIntent; terminal: StandingActionTerminal }
>;
export type StandingOwnActionProjectionInput = Readonly<{
  binding: Readonly<{ accountId: string; chatId: string }>;
  referenceKey: string;
  /** Canonical opaque immutable slot token supplied by the reader, never a path. */
  slot: string;
  source: StandingOwnActionSource;
}>;
export type StandingOwnActionGap = "observation-date-not-retained" | "server-date-not-retained" | "current-availability-not-checked" |
  "identity-not-retained" | "text-not-joined" | "formatting-not-projected" | "object-provenance-not-retained" | "outcome-not-verified";
export type StandingOwnActionContent = Readonly<
  { kind: "text"; text: string | null } |
  { kind: "photo"; generation: "completed"; caption: string; mimeType: "image/png"; byteLength: number; width: number; height: number } |
  { kind: "artifact"; caption: string; filename: string; mimeType: string; byteLength: number; sourceKind: "download" | "generated" | "attachment"; mediaKind: "file" | "audio" | "video" | "voice" | "round-video" } |
  { kind: "poll"; question: string | null; options: readonly string[] } |
  { kind: "reaction"; requestedEmoji: string | null } |
  { kind: "self-profile"; firstName: string | null; lastName: string | null; hasPhoto: boolean | null } |
  { kind: "group-avatar"; hasPhoto: boolean | null }
>;
export type StandingOwnActionView = Readonly<{
  schema: "standing-own-action-view-v1";
  actionRef: string;
  kind: StandingOwnActionContent["kind"];
  operation: string;
  verdict: "verified" | "unknown" | "refused" | "incomplete" | "failed-terminal";
  effect: "changed" | "unchanged" | "observed" | "not-proven";
  provenance: "authenticated-own-action-record";
  observedAt: number | null;
  serverDate: null;
  /** Only a validated persisted poll evidence record supplies this reference. */
  objectRef?: string;
  /** Persisted concrete message/media/poll identity, not an access capability. */
  identityKnown: boolean;
  currentAvailability: "not-checked";
  content: StandingOwnActionContent;
  gaps: readonly StandingOwnActionGap[];
}>;
const fail = (): never => { throw new Error("STANDING_OWN_ACTION_PROJECTION_REFUSED"); };
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const jsonHash = (v: unknown) => hash(JSON.stringify(v));
const hex = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const long = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,18}$/.test(v) && BigInt(v) < 2n ** 63n;
const integer = (v: unknown, max: number, min = 1): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const msg = (v: unknown) => integer(v, 2147483647);
const str = (v: unknown, bytes: number, empty = true): v is string => typeof v === "string" && v.length <= bytes && (empty || v.trim().length > 0) &&
  !v.includes("\0") && Buffer.byteLength(v) <= bytes && Buffer.from(v).toString() === v;
const one = (v: unknown, values: readonly string[]) => typeof v === "string" && values.includes(v);
function data(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, any> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
  const keys = Object.keys(v);
  if (required.some(k => !Object.hasOwn(v, k)) || keys.some(k => !required.includes(k) && !optional.includes(k))) return fail();
  return v as Record<string, any>;
}
/** Inert bounded snapshot, before accessing any caller-owned fields. */
function snapshot(value: unknown, maxBytes = 65536): any {
  let nodes = 0, serializedBytes = 0;
  const charge = (bytes: number) => { serializedBytes += bytes; if (serializedBytes > maxBytes) return fail(); };
  function copy(v: unknown, depth: number): any {
    if (++nodes > 8192 || depth > 14) return fail();
    if (v === null || typeof v === "boolean") { charge(JSON.stringify(v).length); return v; }
    if (typeof v === "string") { if (!str(v, 16384)) return fail(); charge(Buffer.byteLength(JSON.stringify(v))); return v; }
    if (typeof v === "number") { if (!Number.isFinite(v)) return fail(); charge(JSON.stringify(v).length); return v; }
    if (!v || typeof v !== "object" || types.isProxy(v)) return fail();
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return fail();
    const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
    if (keys.length > 8193) return fail();
    if (array) {
      const length = Object.getOwnPropertyDescriptor(v, "length")!.value;
      if (!integer(length, 8192, 0) || keys.length !== length + 1) return fail();
      charge(2 + Math.max(0, length - 1));
      const out: any[] = [];
      for (let i = 0; i < length; i++) { const d = ds[String(i)]; if (!d || !("value" in d) || !d.enumerable) return fail(); out.push(copy(d.value, depth + 1)); }
      return Object.freeze(out);
    }
    charge(2 + Math.max(0, keys.length - 1));
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (typeof k !== "string" || !str(k, 128) || k === "__proto__" || k === "constructor" || k === "prototype") return fail();
      charge(Buffer.byteLength(JSON.stringify(k)) + 1);
      const d = ds[k]!; if (!("value" in d) || !d.enumerable) return fail(); out[k] = copy(d.value, depth + 1);
    }
    return Object.freeze(out);
  }
  return copy(value, 0);
}
function canonical(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  return Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" : "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}
const OPERATIONS = ["send-text", "send-photo", "send-artifact", "create-poll", "read-poll", "close-poll", "read-reactions", "set-reaction", "read-self-profile", "set-display-name", "set-avatar", "set-group-avatar", "resolve-object"];
const KIND_OPERATIONS: Record<StandingOwnActionContent["kind"], readonly string[]> = {
  text: ["send-text"], photo: ["send-photo"], artifact: ["send-artifact"], poll: ["create-poll", "read-poll", "close-poll", "resolve-object"],
  reaction: ["set-reaction", "read-reactions"], "self-profile": ["read-self-profile", "set-display-name", "set-avatar"], "group-avatar": ["set-group-avatar"],
};
const GAPS: readonly StandingOwnActionGap[] = ["observation-date-not-retained", "server-date-not-retained", "current-availability-not-checked", "identity-not-retained", "text-not-joined", "formatting-not-projected", "object-provenance-not-retained", "outcome-not-verified"];
function contentCopy(value: unknown): StandingOwnActionContent {
  const c = value as any;
  switch (c?.kind) {
    case "text": data(c, ["kind", "text"]); if (!(c.text === null || str(c.text, 4096, false))) return fail(); break;
    case "photo": data(c, ["kind", "generation", "caption", "mimeType", "byteLength", "width", "height"]);
      if (c.generation !== "completed" || c.mimeType !== "image/png" || !str(c.caption, 1024) || !integer(c.byteLength, 8 * 1024 * 1024) || !integer(c.width, 8192) || !integer(c.height, 8192) || c.width * c.height > 16 * 1024 * 1024) return fail(); break;
    case "artifact": data(c, ["kind", "caption", "filename", "mimeType", "byteLength", "sourceKind", "mediaKind"]);
      if (!str(c.caption, 1024) || !str(c.filename, 255, false) || !str(c.mimeType, 255, false) || !integer(c.byteLength, 32 * 1024 * 1024) || !one(c.sourceKind, ["download", "generated", "attachment"]) || !one(c.mediaKind, ["file", "audio", "video", "voice", "round-video"])) return fail(); break;
    case "poll": data(c, ["kind", "question", "options"]);
      if (!(c.question === null || str(c.question, 1020, false)) || !Array.isArray(c.options) || c.options.length > 10 || c.options.some((v: unknown) => !str(v, 400, false)) || (c.question === null ? c.options.length !== 0 : c.options.length < 2)) return fail(); break;
    case "reaction": data(c, ["kind", "requestedEmoji"]); if (!(c.requestedEmoji === null || str(c.requestedEmoji, 128, false))) return fail(); break;
    case "self-profile": data(c, ["kind", "firstName", "lastName", "hasPhoto"]);
      if (!(c.firstName === null || str(c.firstName, 1024)) || !(c.lastName === null || str(c.lastName, 1024)) || !(c.hasPhoto === null || typeof c.hasPhoto === "boolean")) return fail(); break;
    case "group-avatar": data(c, ["kind", "hasPhoto"]); if (!(c.hasPhoto === null || typeof c.hasPhoto === "boolean")) return fail(); break;
    default: return fail();
  }
  return c;
}
/** Validates a public view's shape, not the provenance assertion inside it. */
export function snapshotStandingOwnActionView(value: unknown): StandingOwnActionView {
  const v = data(snapshot(value, 12288), ["schema", "actionRef", "kind", "operation", "verdict", "effect", "provenance", "observedAt", "serverDate", "identityKnown", "currentAvailability", "content", "gaps"], ["objectRef"]);
  const c = contentCopy(v.content);
  if (v.schema !== "standing-own-action-view-v1" || typeof v.actionRef !== "string" || !/^act_[0-9a-f]{48}$/.test(v.actionRef) || c.kind !== v.kind || !one(v.operation, KIND_OPERATIONS[c.kind]) ||
      !one(v.verdict, ["verified", "unknown", "refused", "incomplete", "failed-terminal"]) || !one(v.effect, ["changed", "unchanged", "observed", "not-proven"]) ||
      v.verdict !== "verified" && v.effect !== "not-proven" || v.provenance !== "authenticated-own-action-record" ||
      !(v.observedAt === null || integer(v.observedAt, 253402300799)) || v.serverDate !== null || typeof v.identityKnown !== "boolean" || v.currentAvailability !== "not-checked" ||
      !Array.isArray(v.gaps) || v.gaps.some((g: unknown) => !one(g, GAPS)) || new Set(v.gaps).size !== v.gaps.length ||
      Object.hasOwn(v, "objectRef") && (typeof v.objectRef !== "string" || !/^obj_[0-9a-f]{48}$/.test(v.objectRef) || v.kind !== "poll" || v.verdict !== "verified" || !v.identityKnown)) return fail();
  const object = Object.hasOwn(v, "objectRef"), verified = v.verdict === "verified";
  const expectedIdentity = verified && (["text", "photo", "artifact"].includes(v.kind) || object);
  if (v.identityKnown !== expectedIdentity || (v.observedAt !== null) !== object || object && v.operation !== "create-poll" ||
      !v.gaps.includes("server-date-not-retained") || !v.gaps.includes("current-availability-not-checked") ||
      (v.observedAt === null) !== v.gaps.includes("observation-date-not-retained") || (!v.identityKnown) !== v.gaps.includes("identity-not-retained") ||
      (!verified) !== v.gaps.includes("outcome-not-verified") ||
      c.kind === "text" && (c.text === null) !== v.gaps.includes("text-not-joined") ||
      c.kind === "poll" && ((c.question !== null) !== object || !object && !v.gaps.includes("object-provenance-not-retained")) ||
      ["reaction", "self-profile", "group-avatar"].includes(c.kind) && !v.gaps.includes("object-provenance-not-retained") ||
      c.kind === "self-profile" && (verified ? c.firstName === null || c.lastName === null || c.hasPhoto === null : c.firstName !== null || c.lastName !== null || c.hasPhoto !== null) ||
      c.kind === "group-avatar" && (verified ? c.hasPhoto === null : c.hasPhoto !== null)) return fail();
  return v as StandingOwnActionView;
}
function verdict(state: unknown): StandingOwnActionView["verdict"] {
  if (state === "planned" || state === "sending") return "incomplete";
  if (state === "failed_terminal") return "failed-terminal";
  if (state === "verified" || state === "unknown" || state === "refused") return state;
  return fail();
}

/** Stable only for the same host key, binding, family, immutable slot and terminal
 * hash. Does not issue object capabilities or assert current availability. */
export function projectStandingOwnAction(value: StandingOwnActionProjectionInput): StandingOwnActionView {
  try { return project(value); } catch { return fail(); }
}
function project(value: StandingOwnActionProjectionInput): StandingOwnActionView {
  const input = data(snapshot(value), ["binding", "referenceKey", "slot", "source"]), b = data(input.binding, ["accountId", "chatId"]);
  if (!long(b.accountId) || typeof b.chatId !== "string" || !/^-[1-9]\d{0,19}$/.test(b.chatId) || !hex(input.referenceKey) ||
      typeof input.slot !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.slot)) return fail();
  const s = input.source as StandingOwnActionSource, gaps: StandingOwnActionGap[] = ["server-date-not-retained", "current-availability-not-checked"];
  let content: StandingOwnActionContent, operation: string, state: StandingOwnActionView["verdict"], effect: StandingOwnActionView["effect"] = "not-proven";
  let identityKnown = false, observedAt: number | null = null, objectRef: string | undefined, terminal: unknown;
  const bound = (a: { accountId: string; chatId: string }) => { if (a.accountId !== b.accountId || a.chatId !== b.chatId) return fail(); };
  if (s.family === "pilot") {
    data(s, ["family", "record"], ["reply"]);
    const r = data(s.record, ["version", "state", "idempotencyKey", "randomId", "chatId", "accountId", "replyToMessageId", "contentHash", "textBytes"], ["messageId", "wireReplyToMessageId"]);
    bound(s.record); state = verdict(r.state); terminal = r; operation = "send-text";
    if (r.version !== "pilot-outbox-v1" || !one(r.state, ["planned", "sending", "verified", "unknown", "failed_terminal"]) || !long(r.randomId) || !hex(r.contentHash) || !integer(r.textBytes, 4096) || !(r.replyToMessageId === null || msg(r.replyToMessageId)) ||
        (state === "verified") !== Object.hasOwn(r, "messageId") || Object.hasOwn(r, "messageId") && !msg(r.messageId) ||
        Object.hasOwn(r, "wireReplyToMessageId") && (state !== "verified" || r.wireReplyToMessageId !== null || !msg(r.replyToMessageId)) ||
        r.idempotencyKey !== jsonHash([r.chatId, r.replyToMessageId === null ? "owner-greeting" : "owner-prompt", r.replyToMessageId, r.replyToMessageId === null ? "message" : "reply", r.contentHash])) return fail();
    let text: string | null = null;
    if (s.reply) {
      const reply = data(s.reply, ["chatId", "replyToMessageId", "text"], ["entities"]);
      if (reply.chatId !== b.chatId || reply.replyToMessageId !== r.replyToMessageId || !str(reply.text, 4096, false) || Buffer.byteLength(reply.text) !== r.textBytes) return fail();
      const entities = Object.hasOwn(reply, "entities") ? copyTelegramTextEntities(reply.text, reply.entities) : undefined;
      if ((entities === undefined ? hash(reply.text) : jsonHash(["DecadansNeurobro/pilot-formatted-text/v1", reply.text, entities])) !== r.contentHash) return fail();
      text = reply.text; if (entities !== undefined) gaps.push("formatting-not-projected");
    } else gaps.push("text-not-joined");
    identityKnown = state === "verified"; content = { kind: "text", text };
  } else if (s.family === "generated-image" || s.family === "artifact") {
    data(s, ["family", "plan", "terminal"]);
    const p = s.plan, t = s.terminal; bound(p.approved); terminal = t; state = verdict(t.state);
    if (!one(t.state, ["sending", "verified", "unknown", "failed_terminal"]) || !msg(p.approved.replyToMessageId) || !long(p.randomId) || t.key !== p.key || !hex(p.artifact.sha256)) return fail();
    if (s.family === "generated-image") {
      const p = s.plan, t = s.terminal;
      data(p, ["version", "key", "generation", "approved", "artifact", "caption", "randomId"]);
      data(t, ["key", "planHash", "state"], ["messageId", "photoId", "diagnostics"]);
      if (p.version !== "generated-image-delivery-v1" || p.generation !== "completed" || p.key !== generatedImageDeliveryKey(p.approved) || t.planHash !== generatedImagePlanHash(p) ||
          canonical(p.approved.origin) !== canonical(p.artifact.origin) || p.artifact.version !== "generated-image-v1" || p.artifact.mimeType !== "image/png" ||
          (state === "verified") !== (Object.hasOwn(t, "messageId") && Object.hasOwn(t, "photoId")) ||
          state !== "verified" && (Object.hasOwn(t, "messageId") || Object.hasOwn(t, "photoId")) || state === "verified" && (!msg(t.messageId) || !long(t.photoId)) ||
          Object.hasOwn(t, "diagnostics") && !["unknown", "failed-terminal"].includes(state)) return fail();
      content = { kind: "photo", generation: "completed", caption: p.caption, mimeType: "image/png", byteLength: p.artifact.byteLength, width: p.artifact.width, height: p.artifact.height }; operation = "send-photo";
    } else {
      const p = s.plan, t = s.terminal;
      data(p, ["version", "key", "approved", "artifact", "caption", "randomId"], ["mediaKind", "mediaProfile"]);
      data(t, ["key", "planHash", "state"], ["acknowledgement", "failure"]);
      if (p.version !== "standing-artifact-delivery-v1" || p.key !== artifactDeliveryKey(p.approved) || t.planHash !== artifactDeliveryPlanHash(p) || p.artifact.version !== "standing-artifact-v1" ||
          p.artifact.requestRef !== p.approved.requestRef || (state === "verified") !== Object.hasOwn(t, "acknowledgement") ||
          (["unknown", "failed-terminal"].includes(state)) !== Object.hasOwn(t, "failure")) return fail();
      if (t.acknowledgement) { const a = data(t.acknowledgement, ["messageId", "documentId"]); if (!msg(a.messageId) || !long(a.documentId)) return fail(); }
      content = { kind: "artifact", caption: p.caption, filename: p.artifact.filename, mimeType: p.artifact.mimeType, byteLength: p.artifact.byteLength, sourceKind: p.artifact.source.kind, mediaKind: p.mediaKind ?? (p.artifact.audio ? "audio" : "file") }; operation = "send-artifact";
    }
    identityKnown = state === "verified";
  } else if (s.family === "bound-action") {
    data(s, ["family", "binding", "intent", "terminal"]); bound(s.binding);
    const key = standingActionKey(s.binding), domain = "DecadansNeurobro/standing-action-journal/v1";
    const decoded = decodeStandingActionSlot({ domain, key, kind: "intent", payload: { binding: s.binding, intent: s.intent } },
      { domain, key, kind: "terminal", payload: { intentHash: jsonHash(s.intent), terminal: s.terminal } }, key);
    const action = decoded.intent.action as Record<string, any>, result = decoded.terminal.result as Record<string, any>;
    if (!action || !result || Array.isArray(action) || Array.isArray(result) || result.verdict !== decoded.terminal.state || !one(action.kind, OPERATIONS)) return fail();
    terminal = decoded.terminal; operation = action.kind; state = verdict(decoded.terminal.state);
    if (["create-poll", "read-poll", "close-poll", "resolve-object"].includes(operation)) {
      content = { kind: "poll", question: null, options: [] };
      if (decoded.terminal.privateObjectEvidence) {
        const e = validateStandingPollObjectEvidence(decoded.terminal.privateObjectEvidence, s.binding, s.intent);
        content = { kind: "poll", question: e.record.poll.question, options: e.record.poll.options };
        objectRef = e.objectRef; observedAt = e.observedAt; identityKnown = true;
      } else gaps.push("object-provenance-not-retained");
    } else if (["set-reaction", "read-reactions"].includes(operation)) {
      content = { kind: "reaction", requestedEmoji: operation === "set-reaction" ? action.emoji : null }; gaps.push("object-provenance-not-retained");
    } else if (operation === "set-group-avatar") {
      content = { kind: "group-avatar", hasPhoto: state === "verified" ? result.group?.hasPhoto : null }; gaps.push("object-provenance-not-retained");
    } else if (["read-self-profile", "set-display-name", "set-avatar"].includes(operation)) {
      content = { kind: "self-profile", firstName: state === "verified" ? result.profile?.firstName : null, lastName: state === "verified" ? result.profile?.lastName : null, hasPhoto: state === "verified" ? result.profile?.hasPhoto : null };
      gaps.push("object-provenance-not-retained");
    } else return fail();
    if (state === "verified") {
      if (["read-self-profile", "read-poll", "read-reactions", "resolve-object"].includes(operation)) effect = "observed";
      else if (result.code === "unchanged" || result.change === "unchanged" || result.change === "already-closed") effect = "unchanged";
      else if (operation === "create-poll" && identityKnown || result.code === "verified" || ["set", "replaced", "removed", "closed"].includes(result.change)) effect = "changed";
    }
  } else return fail();
  if (state === "verified" && ["send-text", "send-photo", "send-artifact"].includes(operation)) effect = "changed";
  if (observedAt === null) gaps.push("observation-date-not-retained");
  if (!identityKnown) gaps.push("identity-not-retained");
  if (state !== "verified") gaps.push("outcome-not-verified");
  const actionRef = "act_" + createHmac("sha256", Buffer.from(input.referenceKey, "hex")).update(canonical([
    "DecadansNeurobro/own-action-projection/v1", s.family, b.accountId, b.chatId, input.slot, hash(canonical(terminal)),
  ])).digest("hex").slice(0, 48);
  return snapshotStandingOwnActionView({ schema: "standing-own-action-view-v1", actionRef, kind: content.kind, operation, verdict: state, effect,
    provenance: "authenticated-own-action-record", observedAt, serverDate: null, ...(objectRef ? { objectRef } : {}), identityKnown,
    currentAvailability: "not-checked", content, gaps });
}
