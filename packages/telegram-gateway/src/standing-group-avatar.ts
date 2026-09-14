import { createHash } from "node:crypto";
import { types } from "node:util";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import type { PilotBinding, PilotInvoker } from "./pilot-telegram-adapter.js";
import type { StandingSelfProfileImage } from "./standing-self-profile.js";
import { STANDING_AVATAR_MAX_BYTES } from "./standing-avatar-policy.js";

export type StandingGroupAvatarResult = Readonly<{
  verdict: "verified" | "refused" | "unknown";
  code: "verified" | "input" | "state" | "stopped" | "identity" | "rights" | "protocol" | "transport" | "changed" | "primary";
  group?: Readonly<{ hasPhoto: boolean }>;
}>;
type Snapshot = { title: string; photoId: string | null };
class AvatarError extends Error { constructor(readonly code: StandingGroupAvatarResult["code"]) { super("GROUP_AVATAR_" + code); } }
const fail = (code: StandingGroupAvatarResult["code"]): never => { throw new AvatarError(code); };
const positive = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,18}$/.test(v) && BigInt(v) < 2n ** 63n;
function photoLong(value: unknown): string {
  const s = String(value);
  if (!/^-?[1-9]\d{0,18}$/.test(s) || BigInt(s) < -(2n ** 63n) || BigInt(s) >= 2n ** 63n) return fail("protocol");
  return s;
}
const same = (a: Snapshot, b: Snapshot) => a.title === b.title && a.photoId === b.photoId;
function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const entries = Object.getOwnPropertyDescriptors(value), out: Record<string, unknown> = {};
  if (Reflect.ownKeys(entries).some(k => typeof k !== "string")) return fail("input");
  for (const [key, d] of Object.entries(entries)) { if (!("value" in d)) return fail("input"); out[key] = d.value; }
  return out;
}

// Same bounded container checks as the separate own-profile capability. Telegram
// reencodes the pixels; application proof is ACK identity plus fresh group state.
function container(bytes: Buffer, png: boolean): void {
  const dimensions = (w: number, h: number) => { if (!w || !h || w > 8192 || h > 8192 || w * h > 16 * 1024 * 1024) return fail("input"); };
  if (png) {
    let offset = 8, chunks = 0, data = false;
    while (offset + 12 <= bytes.length && ++chunks <= 4096) {
      const size = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
      if (size > bytes.length - offset - 12 || !/^[A-Za-z]{4}$/.test(type)) return fail("input");
      if (chunks === 1) {
        if (type !== "IHDR" || size !== 13) return fail("input");
        dimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12));
      } else if (type === "IHDR") return fail("input");
      if (type === "IDAT" && size > 0) data = true;
      offset += size + 12;
      if (type === "IEND") { if (!data || size !== 0 || offset !== bytes.length) return fail("input"); return; }
    }
    return fail("input");
  }
  let offset = 2, markers = 0, frame = false, scan = false;
  while (offset < bytes.length && ++markers <= 4096) {
    if (bytes[offset++] !== 255) return fail("input");
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217) { if (!frame || !scan || offset !== bytes.length) return fail("input"); return; }
    if (marker === undefined || marker === 0 || marker === 216 || (marker >= 208 && marker <= 215) || offset + 2 > bytes.length) return fail("input");
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || size > bytes.length - offset) return fail("input");
    if ([192,193,194].includes(marker)) {
      if (frame || size < 8) return fail("input");
      dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)); frame = true;
    }
    offset += size;
    if (marker === 218) {
      if (!frame) return fail("input"); scan = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { offset++; continue; }
        const next = bytes[offset + 1];
        if (next === 0 || (next !== undefined && next >= 208 && next <= 215)) { offset += 2; continue; }
        if (next === 255) { offset++; continue; }
        break;
      }
    }
  }
  return fail("input");
}

/** One durably reserved action on the existing sole client and exact bound peer.
 * No connection, discovery, other chat, retry, or rights modification. close
 * revokes synchronously and joins real I/O. Upload/apply uncertainty consumes the
 * lease and must poison the durable caller's subsequent mutation admissions. */
export function createStandingGroupAvatar(input: {
  client: PilotInvoker; binding: PilotBinding; peer: Api.InputPeerChat | Api.InputPeerChannel;
  self: Api.User; signal: AbortSignal;
  /** Host must reread and verify the exact selected primary, or reject. */
  revalidatePrimary(signal: AbortSignal): Promise<void>;
}) {
  const accountId = input.binding.accountId, peerId = input.binding.peerId, signal = input.signal;
  if (!positive(accountId) || !/^-[1-9]\d{0,19}$/.test(peerId) || !(input.self instanceof Api.User) ||
      input.self.self !== true || input.self.min || input.self.bot || input.self.deleted || input.self.id.toString() !== accountId ||
      !(input.peer instanceof Api.InputPeerChat || input.peer instanceof Api.InputPeerChannel) || utils.getPeerId(input.peer) !== peerId) return fail("identity");
  const peer = input.peer instanceof Api.InputPeerChat ? new Api.InputPeerChat({ chatId: bigInt(input.peer.chatId.toString()) }) :
    new Api.InputPeerChannel({ channelId: bigInt(input.peer.channelId.toString()), accessHash: bigInt(photoLong(input.peer.accessHash)) });
  const channel = peer instanceof Api.InputPeerChannel ? new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash }) : undefined;
  const invoke = input.client.invoke.bind(input.client);
  if (typeof input.revalidatePrimary !== "function") return fail("primary");
  const revalidatePrimary = input.revalidatePrimary.bind(input);
  let closed = false, consumed = false, uncertain = false;
  let pending: Promise<StandingGroupAvatarResult> | undefined, closing: Promise<void> | undefined;
  const revoke = () => { closed = true; };
  signal.addEventListener("abort", revoke, { once: true });
  const check = () => { if (closed || signal.aborted) return fail("stopped"); };
  async function primary(): Promise<void> {
    check();
    try { await revalidatePrimary(signal); } catch { check(); return fail("primary"); }
    check();
  }
  async function request(value: Api.AnyRequest, mutation = false): Promise<unknown> {
    check(); if (mutation) uncertain = true;
    let result: unknown;
    try { result = await invoke(value); } catch { return fail("transport"); }
    check(); return result;
  }
  function snapshot(value: unknown): Snapshot {
    if (!(value instanceof Api.messages.Chats) || value.chats.length !== 1) return fail("identity");
    const chat = value.chats[0];
    if (!(chat instanceof Api.Chat || chat instanceof Api.Channel) || utils.getPeerId(chat) !== peerId || chat.left ||
        (peer instanceof Api.InputPeerChat) !== (chat instanceof Api.Chat)) return fail("identity");
    if (chat instanceof Api.Chat && (chat.deactivated || chat.migratedTo)) return fail("identity");
    if (chat instanceof Api.Channel && (chat.min || chat.broadcast || (!chat.megagroup && !chat.gigagroup) ||
        chat.accessHash?.toString() !== channel!.accessHash.toString() || chat.bannedRights?.viewMessages)) return fail("identity");
    // Anonymous administrator actions cannot supply the exact own-user service
    // attribution required below. Refuse before upload rather than mutate blind.
    if (chat instanceof Api.Channel && chat.adminRights?.anonymous) return fail("rights");
    const admin = chat.creator === true || chat.adminRights?.changeInfo === true;
    if (!admin && (chat.defaultBannedRights?.changeInfo || chat.defaultBannedRights?.viewMessages ||
        chat instanceof Api.Channel && (chat.bannedRights?.changeInfo || chat.gigagroup))) return fail("rights");
    if (typeof chat.title !== "string" || Buffer.byteLength(chat.title) > 1024 || Buffer.from(chat.title).toString() !== chat.title) return fail("protocol");
    const photoId = chat.photo instanceof Api.ChatPhotoEmpty ? null : chat.photo instanceof Api.ChatPhoto ? photoLong(chat.photo.photoId) : fail("protocol");
    return { title: chat.title, photoId };
  }
  async function fresh(): Promise<Snapshot> {
    return snapshot(await request(channel ? new Api.channels.GetChannels({ id: [channel] }) :
      new Api.messages.GetChats({ id: [(peer as Api.InputPeerChat).chatId] })));
  }
  function ackPhoto(value: unknown): string {
    if (!(value instanceof Api.Updates || value instanceof Api.UpdatesCombined) || value.updates.length > 100 || value.chats.length > 100 || value.users.length > 100) return fail("protocol");
    const matches = value.updates.flatMap(update => {
      if (!(channel ? update instanceof Api.UpdateNewChannelMessage : update instanceof Api.UpdateNewMessage)) return [];
      const message = (update as Api.UpdateNewMessage | Api.UpdateNewChannelMessage).message;
      if (!(message instanceof Api.MessageService) || utils.getPeerId(message.peerId) !== peerId ||
          !(message.action instanceof Api.MessageActionChatEditPhoto)) return [];
      if (!(message.fromId instanceof Api.PeerUser) || message.fromId.userId.toString() !== accountId ||
          !Number.isSafeInteger(message.id) || message.id <= 0 || message.id > 2147483647 ||
          !(message.action.photo instanceof Api.Photo) || (message.action.photo.videoSizes?.length ?? 0) !== 0) return fail("identity");
      return [photoLong(message.action.photo.id)];
    });
    if (matches.length !== 1) return fail("protocol");
    return matches[0]!;
  }
  return Object.freeze({
    setAvatar(raw: StandingSelfProfileImage, fileId: string): Promise<StandingGroupAvatarResult> {
      let bytes: Buffer | undefined, extension: string;
      try {
        const f = fields(raw);
        if (Object.keys(f).some(k => !["bytes", "mediaType", "sha256"].includes(k)) || !positive(fileId) || types.isProxy(f.bytes) ||
            !(f.bytes instanceof Uint8Array) || f.bytes.byteLength < 8 || f.bytes.byteLength > STANDING_AVATAR_MAX_BYTES ||
            (typeof SharedArrayBuffer !== "undefined" && f.bytes.buffer instanceof SharedArrayBuffer)) return Promise.resolve({ verdict: "refused", code: "input" });
        bytes = Buffer.from(f.bytes);
        const png = f.mediaType === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const jpeg = f.mediaType === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        if ((!png && !jpeg) || typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256) || createHash("sha256").update(bytes).digest("hex") !== f.sha256) return fail("input");
        container(bytes, png); extension = png ? "png" : "jpg";
      } catch { bytes?.fill(0); return Promise.resolve({ verdict: "refused", code: "input" }); }
      const ownedBytes = bytes;
      if (closed || signal.aborted || consumed) { ownedBytes.fill(0); return Promise.resolve({ verdict: "refused", code: closed || signal.aborted ? "stopped" : "state" }); }
      consumed = true;
      pending = Promise.resolve().then(async (): Promise<StandingGroupAvatarResult> => {
        const before = await fresh(), parts = Math.ceil(ownedBytes.length / 524288), md5Checksum = createHash("md5").update(ownedBytes).digest("hex");
        for (let part = 0; part < parts; part++) {
          if (part > 0 && !same(await fresh(), before)) return fail("changed");
          if (await request(new Api.upload.SaveFilePart({ fileId: bigInt(fileId), filePart: part,
            bytes: ownedBytes.subarray(part * 524288, Math.min(ownedBytes.length, (part + 1) * 524288)) }), true) !== true) return fail("protocol");
        }
        if (!same(await fresh(), before)) return fail("changed");
        const photo = new Api.InputChatUploadedPhoto({ file: new Api.InputFile({ id: bigInt(fileId), parts, name: "group-avatar." + extension, md5Checksum }) });
        // A stable group does not prove the requesting message survived upload.
        await primary();
        const expected = ackPhoto(await request(channel ? new Api.channels.EditPhoto({ channel, photo }) :
          new Api.messages.EditChatPhoto({ chatId: (peer as Api.InputPeerChat).chatId, photo }), true));
        if (expected === before.photoId) return fail("changed");
        const after = await fresh();
        if (after.photoId !== expected || after.title !== before.title) return fail("changed");
        uncertain = false; return { verdict: "verified", code: "verified", group: { hasPhoto: true } };
      }).catch((error: unknown): StandingGroupAvatarResult => ({ verdict: uncertain ? "unknown" : "refused", code: error instanceof AvatarError ? error.code : "protocol" }))
        .finally(() => { ownedBytes.fill(0); });
      return pending;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true; signal.removeEventListener("abort", revoke);
      closing = Promise.resolve(pending).then(() => {}); return closing;
    },
  });
}
