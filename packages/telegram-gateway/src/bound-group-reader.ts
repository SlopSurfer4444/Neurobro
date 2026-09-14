import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import type { PilotBinding, PilotInvoker } from "./pilot-telegram-adapter.js";

export class BoundGroupReaderError extends Error {
  constructor(readonly code: "binding" | "input" | "cursor" | "protocol" | "transport" | "inaccessible" | "aborted" | "busy") { super("BOUND_GROUP_" + code.toUpperCase()); }
}
const fail = (code: BoundGroupReaderError["code"]): never => { throw new BoundGroupReaderError(code); };
const id = (v: unknown): string => { const s = String(v); return /^[1-9]\d{0,19}$/.test(s) ? s : fail("protocol"); };
const count = (v: unknown): number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 2147483647 ? Number(v) : fail("protocol");
const flag = (v: unknown): boolean => v == null ? false : typeof v === "boolean" ? v : fail("protocol");
const clean = (v: unknown, max: number): string => {
  if (typeof v !== "string" || Buffer.byteLength(v) > max || Buffer.from(v).toString() !== v) return fail("protocol");
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ");
};
/** Metadata describes the received User entity, never a complete personal profile. */
export type BoundGroupMember = Readonly<{ memberRef: string; displayName: string; username?: string; role: "owner" | "admin" | "member";
  metadata: "full" | "partial" | "deleted" | "unavailable" }>;
export type BoundGroupInfo = Readonly<{ title: string; about: string; memberCount: number | null; kind: "basic-group" | "supergroup";
  permissions: Readonly<{ role: "owner" | "admin" | "member"; canViewParticipants: boolean; participantsHidden: boolean | null }> }>;
export type BoundGroupPage = Readonly<{ members: readonly BoundGroupMember[]; cursor: string | null; status: "more" | "exhausted" | "inaccessible";
  coverage: Readonly<{ scope: "available-participants"; fullRoster: false; paginationComplete: boolean; mayChangeBetweenPages: boolean; participantRows: number;
    metadata: Readonly<{ scope: "returned-page"; complete: boolean; full: number; partial: number; deleted: number; unavailable: number }> }> }>;
type Position = { offset: number; snapshot?: readonly BoundGroupMember[] };

/** Sole-client, exact-bound read capability. Names are untrusted content. close()
 * revokes immediately and joins the real pending invoke; it cannot cancel network
 * I/O itself. The connection owner must settle its client to unblock pending I/O.
 * Recent participants are an available view, never a claim of a complete roster. */
export function createBoundGroupReader(input: { client: PilotInvoker; binding: PilotBinding; peer: Api.InputPeerChat | Api.InputPeerChannel; self: Api.User; signal: AbortSignal }) {
  const account = String(input.binding.accountId), bound = String(input.binding.peerId), signal = input.signal;
  let group: string, channel: boolean, hash = "";
  try {
    if (!(input.self instanceof Api.User) || !input.self.self || input.self.bot || input.self.deleted || id(input.self.id) !== account) return fail("binding");
    channel = input.peer instanceof Api.InputPeerChannel;
    if (!(input.peer instanceof Api.InputPeerChat) && !channel) return fail("binding");
    group = id(input.peer instanceof Api.InputPeerChat ? input.peer.chatId : input.peer.channelId);
    if (utils.getPeerId(channel ? new Api.PeerChannel({ channelId: bigInt(group) }) : new Api.PeerChat({ chatId: bigInt(group) })) !== bound) return fail("binding");
    if (input.peer instanceof Api.InputPeerChannel) { hash = String(input.peer.accessHash); const h = BigInt(hash); if (h === 0n || h < -(2n ** 63n) || h >= 2n ** 63n) return fail("binding"); }
  } catch { return fail("binding"); }
  const invoke = input.client.invoke.bind(input.client), refs = new Map<string, string>(), cursors = new Map<string, Position>();
  let closed = false, pending: Promise<unknown> | undefined;
  const revoke = () => { closed = true; refs.clear(); cursors.clear(); };
  signal.addEventListener("abort", revoke, { once: true });
  const check = () => { if (closed || signal.aborted) { revoke(); return fail("aborted"); } };
  const inputChannel = () => new Api.InputChannel({ channelId: bigInt(group), accessHash: bigInt(hash) });
  const call = async (request: Api.AnyRequest) => {
    check();
    try { const result = await invoke(request); check(); return result; }
    catch (error) { check(); const e = (error as { errorMessage?: unknown })?.errorMessage;
      return fail(typeof e === "string" && ["CHANNEL_PRIVATE", "CHAT_ADMIN_REQUIRED", "USER_BANNED_IN_CHANNEL"].includes(e) ? "inaccessible" : "transport"); }
  };
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    try { check(); if (pending) return Promise.reject(new BoundGroupReaderError("busy")); } catch (e) { return Promise.reject(e); }
    // Deferred work ensures ownership is published before invoke can reenter.
    const task = Promise.resolve().then(work).then(value => { check(); if (Buffer.byteLength(JSON.stringify(value)) > 65536) return fail("protocol"); return value; })
      .catch(e => { if (e instanceof BoundGroupReaderError) throw e; return fail("protocol"); });
    pending = task;
    void task.then(() => { pending = undefined; }, () => { pending = undefined; });
    return task;
  };
  const members = (parts: readonly (Api.TypeChatParticipant | Api.TypeChannelParticipant)[], users: readonly Api.TypeUser[]): readonly BoundGroupMember[] => {
    if (!Array.isArray(parts) || !Array.isArray(users) || parts.length > 200 || users.length > 400) return fail("protocol");
    const map = new Map<string, Api.User | Api.UserEmpty>(), seen = new Set<string>();
    for (const u of users) {
      if (!(u instanceof Api.User || u instanceof Api.UserEmpty)) return fail("protocol");
      const key = id(u.id);
      if (map.has(key)) return fail("protocol");
      if (u instanceof Api.User) {
        const own = flag(u.self), deleted = flag(u.deleted); flag(u.min);
        if (own && key !== account || key === account && (deleted || flag(u.bot))) return fail("protocol");
      }
      // UserEmpty/deleted/min are legitimate TL states. Unreferenced entities
      // are never projected; only participant rows establish member provenance.
      map.set(key, u);
    }
    return Object.freeze(parts.map(p => {
      if (!(p instanceof Api.ChatParticipant || p instanceof Api.ChatParticipantCreator || p instanceof Api.ChatParticipantAdmin ||
        p instanceof Api.ChannelParticipant || p instanceof Api.ChannelParticipantSelf || p instanceof Api.ChannelParticipantCreator || p instanceof Api.ChannelParticipantAdmin)) return fail("protocol");
      const key = id(p.userId), u = map.get(key);
      if (seen.has(key) || (p instanceof Api.ChannelParticipantSelf && key !== account) || (p instanceof Api.ChannelParticipantAdmin && flag(p.self) && key !== account)) return fail("protocol");
      seen.add(key);
      const metadata: BoundGroupMember["metadata"] = !u || u instanceof Api.UserEmpty ? "unavailable" : flag(u.deleted) ? "deleted" : flag(u.min) ? "partial" : "full";
      const available = u instanceof Api.User && metadata !== "deleted" ? u : undefined;
      const displayName = metadata === "deleted" ? "Удалённый аккаунт" : metadata === "unavailable" ? "Участник (данные недоступны)" :
        Array.from([clean(available?.firstName ?? "", 256), clean(available?.lastName ?? "", 256)].join(" ").trim()).slice(0, 96).join("") || "Участник";
      const username = available?.username == null ? undefined : clean(available.username, 64);
      if (username !== undefined && !/^[A-Za-z0-9_]{1,64}$/.test(username)) return fail("protocol");
      let memberRef = refs.get(key); if (!memberRef) { if (refs.size >= 100000) return fail("protocol"); memberRef = "member_" + randomUUID(); refs.set(key, memberRef); }
      return Object.freeze({ memberRef, displayName, ...(username ? { username } : {}), metadata, role:
        p instanceof Api.ChatParticipantCreator || p instanceof Api.ChannelParticipantCreator ? "owner" as const :
        p instanceof Api.ChatParticipantAdmin || p instanceof Api.ChannelParticipantAdmin ? "admin" as const : "member" as const });
    }));
  };
  const validateParticipantChats = (chats: readonly Api.TypeChat[]) => {
    if (!Array.isArray(chats) || chats.length > 100) return fail("protocol");
    const seen = new Set<string>();
    for (const chat of chats) {
      if (!(chat instanceof Api.ChatEmpty || chat instanceof Api.Chat || chat instanceof Api.ChatForbidden || chat instanceof Api.Channel || chat instanceof Api.ChannelForbidden)) return fail("protocol");
      const key = (chat instanceof Api.Channel || chat instanceof Api.ChannelForbidden ? "channel:" : "chat:") + id(chat.id);
      if (seen.has(key)) return fail("protocol"); seen.add(key);
      if (!(chat instanceof Api.ChatEmpty)) clean(chat.title, 1024);
    }
    // TL198 carries Vector<Chat> alongside participants. These bounded entities
    // are metadata only: no output, lookup, peer selection or invocation uses them.
  };
  const full = async () => {
    const e = await call(channel ? new Api.channels.GetFullChannel({ channel: inputChannel() }) : new Api.messages.GetFullChat({ chatId: bigInt(group) }));
    if (!(e instanceof Api.messages.ChatFull) || e.chats.length > 100 || e.users.length > 400) return fail("protocol");
    const f = e.fullChat;
    if ((channel ? !(f instanceof Api.ChannelFull) : !(f instanceof Api.ChatFull)) || id(f.id) !== group) return fail("protocol");
    const matches = e.chats.filter(c => (channel ? c instanceof Api.Channel : c instanceof Api.Chat) && id(c.id) === group);
    if (matches.length !== 1) return fail("protocol");
    const c = matches[0]!;
    if (!(c instanceof Api.Chat || c instanceof Api.Channel) || c.left || (c instanceof Api.Chat && (c.deactivated || c.migratedTo)) ||
      (c instanceof Api.Channel && (c.min || c.broadcast || !(c.megagroup || c.gigagroup)))) return fail("protocol");
    if (c.adminRights != null && !(c.adminRights instanceof Api.ChatAdminRights)) return fail("protocol");
    if (f instanceof Api.ChatFull && (!(f.participants instanceof Api.ChatParticipants || f.participants instanceof Api.ChatParticipantsForbidden) || id(f.participants.chatId) !== group)) return fail("protocol");
    const info: BoundGroupInfo = Object.freeze({ title: clean(c.title, 1024), about: clean(f.about, 16384), kind: channel ? "supergroup" : "basic-group",
      memberCount: f instanceof Api.ChannelFull ? f.participantsCount == null ? null : count(f.participantsCount) : count((c as Api.Chat).participantsCount),
      permissions: Object.freeze({ role: flag(c.creator) ? "owner" : c.adminRights ? "admin" : "member",
        canViewParticipants: f instanceof Api.ChannelFull ? flag(f.canViewParticipants) : f.participants instanceof Api.ChatParticipants,
        participantsHidden: f instanceof Api.ChannelFull ? flag(f.participantsHidden) : null }) });
    return { e, f, info };
  };
  const page = (values: readonly BoundGroupMember[], cursor: string | null, status: BoundGroupPage["status"], participantRows = 0): BoundGroupPage => {
    const counts = { full: 0, partial: 0, deleted: 0, unavailable: 0 };
    for (const member of values) counts[member.metadata]++;
    return Object.freeze({ members: values, cursor, status,
      coverage: Object.freeze({ scope: "available-participants", fullRoster: false, paginationComplete: status === "exhausted", mayChangeBetweenPages: channel, participantRows,
        metadata: Object.freeze({ scope: "returned-page", complete: status !== "inaccessible" && counts.full === values.length, ...counts }) }) });
  };
  return Object.freeze({
    async close(): Promise<void> { revoke(); signal.removeEventListener("abort", revoke); await pending?.then(() => {}, () => {}); },
    groupInfo: () => run(async () => (await full()).info),
    listParticipants: (request: Readonly<{ cursor?: string }> = {}): Promise<BoundGroupPage> => {
      // Capture before publishing deferred work. Never execute caller accessors or
      // proxy traps, including while another operation owns the invocation slot.
      let old: string | undefined;
      try {
        if (!request || typeof request !== "object" || types.isProxy(request)) return Promise.reject(new BoundGroupReaderError("input"));
        const prototype = Object.getPrototypeOf(request);
        if (prototype !== Object.prototype && prototype !== null) return Promise.reject(new BoundGroupReaderError("input"));
        if (Reflect.ownKeys(request).some(key => key !== "cursor")) return Promise.reject(new BoundGroupReaderError("input"));
        const descriptor = Object.getOwnPropertyDescriptor(request, "cursor");
        if (descriptor && (!("value" in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== "string"))) return Promise.reject(new BoundGroupReaderError("input"));
        old = descriptor?.value as string | undefined;
      } catch { return Promise.reject(new BoundGroupReaderError("input")); }
      return run(async () => {
      const pos = old === undefined ? { offset: 0 } : cursors.get(old);
      if (!pos) return fail("cursor");
      let values: readonly BoundGroupMember[], more: boolean, next: Position, participantRows: number;
      try {
        if (!channel && pos.snapshot) {
          values = pos.snapshot.slice(pos.offset, pos.offset + 100); more = pos.offset + values.length < pos.snapshot.length;
          participantRows = Math.min(100, pos.snapshot.length - pos.offset);
          next = { offset: pos.offset + participantRows, snapshot: pos.snapshot };
        } else {
          const { f, e, info } = await full();
          if (!info.permissions.canViewParticipants) { if (old) cursors.delete(old); return page([], null, "inaccessible"); }
          if (f instanceof Api.ChatFull && f.participants instanceof Api.ChatParticipants) {
            const snapshot = members(f.participants.participants, e.users); values = snapshot.slice(0, 100); more = snapshot.length > 100;
            participantRows = Math.min(100, f.participants.participants.length); next = { offset: participantRows, snapshot };
          } else {
            const response = await call(new Api.channels.GetParticipants({ channel: inputChannel(), filter: new Api.ChannelParticipantsRecent(), offset: pos.offset, limit: 100, hash: bigInt.zero }));
            if (!(response instanceof Api.channels.ChannelParticipants) || !Array.isArray(response.participants) || response.participants.length > 100) return fail("protocol");
            validateParticipantChats(response.chats);
            count(response.count); values = members(response.participants, response.users);
            // A short nonempty page is not proof of exhaustion; advance by exactly what was returned.
            participantRows = response.participants.length; more = participantRows !== 0; next = { offset: count(pos.offset + participantRows) };
          }
        }
      } catch (e) { if (e instanceof BoundGroupReaderError && e.code === "inaccessible") { if (old) cursors.delete(old); return page([], null, "inaccessible"); } throw e; }
      if (old) cursors.delete(old);
      const cursor = more ? randomUUID() : null;
      if (cursor) { if (cursors.size >= 256) return fail("cursor"); cursors.set(cursor, next); }
      return page(Object.freeze([...values]), cursor, more ? "more" : "exhausted", participantRows);
      });
    }
  });
}
