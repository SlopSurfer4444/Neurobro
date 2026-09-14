import { createHash } from "node:crypto";
import { types } from "node:util";
import { Api } from "telegram";
import bigInt from "big-integer";
import type { PilotBinding, PilotInvoker } from "./pilot-telegram-adapter.js";
import { STANDING_AVATAR_MAX_BYTES } from "./standing-avatar-policy.js";

export type StandingSelfProfileView = Readonly<{ firstName: string; lastName: string; hasPhoto: boolean }>;
export type StandingSelfProfileResult = Readonly<{
  verdict: "verified" | "refused" | "unknown";
  code: "verified" | "unchanged" | "input" | "state" | "stopped" | "identity" | "protocol" | "transport" | "changed" | "primary";
  profile?: StandingSelfProfileView;
}>;
/** Host resolves an admitted artifact. Container checks are not pixel decoding;
 * Telegram acceptance and exact fresh photo identity establish application. */
export type StandingSelfProfileAvatar = Readonly<{ bytes: Uint8Array; mediaType: "image/png" | "image/jpeg"; sha256: string }>;
export type StandingSelfProfileImage = StandingSelfProfileAvatar;
type Snapshot = { firstName: string; lastName: string; username: string | null; photoId: string | null };
class ProfileError extends Error { constructor(readonly code: StandingSelfProfileResult["code"]) { super("SELF_PROFILE_" + code); } }
const fail = (code: StandingSelfProfileResult["code"]): never => { throw new ProfileError(code); };
const absent = (value: unknown) => value === undefined || value === null;
const positive = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) < 2n ** 63n;
const photoLong = (value: unknown): string => {
  const s = String(value);
  if (!/^-?[1-9]\d{0,18}$/.test(s) || BigInt(s) < -(2n ** 63n) || BigInt(s) >= 2n ** 63n) return fail("protocol");
  return s;
};
const validText = (s: unknown, max: number): s is string => typeof s === "string" && Buffer.byteLength(s) <= max &&
  !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(s) && Buffer.from(s).toString() === s;
const nameText = (s: unknown): s is string => validText(s, 256) && s.length <= 64 && s.trim() === s;
function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const entries = Object.getOwnPropertyDescriptors(value), out: Record<string, unknown> = {};
  if (Reflect.ownKeys(entries).some(k => typeof k !== "string")) return fail("input");
  for (const [key, d] of Object.entries(entries)) { if (!("value" in d)) return fail("input"); out[key] = d.value; }
  return out;
}
function snapshot(value: unknown, accountId: string): Snapshot {
  if (!(value instanceof Api.User) || value.self !== true || value.min || value.bot || value.deleted || value.id.toString() !== accountId) return fail("identity");
  const firstName = value.firstName ?? "", lastName = value.lastName ?? "", username = value.username ?? null;
  if (!validText(firstName, 1024) || !validText(lastName, 1024) || (username !== null && !/^[A-Za-z0-9_]{1,64}$/.test(username))) return fail("protocol");
  const photoId = value.photo instanceof Api.UserProfilePhoto ? photoLong(value.photo.photoId) :
    absent(value.photo) || value.photo instanceof Api.UserProfilePhotoEmpty ? null : fail("protocol");
  return { firstName, lastName, username, photoId };
}
const view = (s: Snapshot): StandingSelfProfileView => Object.freeze({ firstName: s.firstName, lastName: s.lastName, hasPhoto: s.photoId !== null });
const same = (a: Snapshot, b: Snapshot) => a.firstName === b.firstName && a.lastName === b.lastName && a.username === b.username && a.photoId === b.photoId;
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

/** Sole connected-client capability: no connection, retry, DC switch or hidden
 * task. The host reserves durable intent before either mutation, owns upload
 * fileId, and must suppress later operations after unknown. One mutation consumes
 * this lease even on refusal; close revokes immediately and joins actual I/O.
 * Telegram reencodes avatars; verified means ACK photo ID matches fresh self,
 * not a byte-for-byte server image. No @username mutation is exposed. */
export function createStandingSelfProfile(input: { client: PilotInvoker; binding: PilotBinding; self: Api.User; signal: AbortSignal;
  /** Host must reread and verify the exact selected primary, or reject. */
  revalidatePrimary(signal: AbortSignal): Promise<void>;
}) {
  const accountId = input.binding.accountId, signal = input.signal;
  if (!positive(accountId) || !/^-[1-9]\d{0,19}$/.test(input.binding.peerId)) return fail("identity");
  snapshot(input.self, accountId);
  if (typeof input.revalidatePrimary !== "function") return fail("primary");
  const revalidatePrimary = input.revalidatePrimary.bind(input);
  const invoke = input.client.invoke.bind(input.client);
  let closed = false, consumed = false, busy = false, uncertain = false;
  let pending: Promise<StandingSelfProfileResult> | undefined, closing: Promise<void> | undefined;
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
  async function fresh(): Promise<Snapshot> {
    const users = await request(new Api.users.GetUsers({ id: [new Api.InputUserSelf()] }));
    if (!Array.isArray(users) || users.length !== 1) return fail("identity");
    try { return snapshot(users[0], accountId); } finally { users.length = 0; }
  }
  function run(mutation: boolean, task: () => Promise<StandingSelfProfileResult>): Promise<StandingSelfProfileResult> {
    if (closed || signal.aborted) return Promise.resolve({ verdict: "refused", code: "stopped" });
    if (busy || (mutation && consumed) || uncertain) return Promise.resolve({ verdict: "refused", code: "state" });
    busy = true; if (mutation) consumed = true;
    pending = Promise.resolve().then(task).catch((error: unknown): StandingSelfProfileResult => ({
      verdict: uncertain ? "unknown" : "refused", code: error instanceof ProfileError ? error.code : "protocol",
    })).finally(() => { busy = false; });
    return pending;
  }
  return Object.freeze({
    inspect(): Promise<StandingSelfProfileResult> {
      return run(false, async () => ({ verdict: "verified", code: "verified", profile: view(await fresh()) }));
    },
    setDisplayName(raw: Readonly<{ firstName: string; lastName?: string }>): Promise<StandingSelfProfileResult> {
      // Snapshot untrusted names before the first await; getters are not run.
      let names: { firstName: string; lastName?: string };
      try {
        const f = fields(raw);
        if (Object.keys(f).some(k => k !== "firstName" && k !== "lastName") || !nameText(f.firstName) || !f.firstName ||
            (Object.hasOwn(f, "lastName") && !nameText(f.lastName))) return Promise.resolve({ verdict: "refused", code: "input" });
        names = { firstName: f.firstName, ...(Object.hasOwn(f, "lastName") ? { lastName: f.lastName as string } : {}) };
      } catch { return Promise.resolve({ verdict: "refused", code: "input" }); }
      return run(true, async () => {
        const before = await fresh(), desired = { ...before, firstName: names.firstName, lastName: names.lastName ?? before.lastName };
        if (same(before, desired)) return { verdict: "verified", code: "unchanged", profile: view(before) };
        await primary();
        const ack = snapshot(await request(new Api.account.UpdateProfile({ firstName: desired.firstName, lastName: desired.lastName }), true), accountId);
        if (!same(ack, desired)) return fail("changed");
        const after = await fresh(); if (!same(after, desired)) return fail("changed");
        uncertain = false;
        return { verdict: "verified", code: "verified", profile: view(after) };
      });
    },
    setAvatar(raw: StandingSelfProfileAvatar, fileId: string): Promise<StandingSelfProfileResult> {
      let bytes: Buffer | undefined, extension: string;
      try {
        const f = fields(raw);
        if (Object.keys(f).some(k => !["bytes", "mediaType", "sha256"].includes(k)) || !positive(fileId) || types.isProxy(f.bytes) ||
            !(f.bytes instanceof Uint8Array) || f.bytes.byteLength < 8 || f.bytes.byteLength > STANDING_AVATAR_MAX_BYTES ||
            (typeof SharedArrayBuffer !== "undefined" && f.bytes.buffer instanceof SharedArrayBuffer)) return Promise.resolve({ verdict: "refused", code: "input" });
        bytes = Buffer.from(f.bytes);
        const png = f.mediaType === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const jpeg = f.mediaType === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        if ((!png && !jpeg) || typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256) || createHash("sha256").update(bytes).digest("hex") !== f.sha256) {
          bytes.fill(0); return Promise.resolve({ verdict: "refused", code: "input" });
        }
        container(bytes, png);
        extension = png ? "png" : "jpg";
      } catch { bytes?.fill(0); return Promise.resolve({ verdict: "refused", code: "input" }); }
      const ownedBytes = bytes;
      return run(true, async () => {
        const before = await fresh(), parts = Math.ceil(ownedBytes.length / 524288), md5Checksum = createHash("md5").update(ownedBytes).digest("hex");
        for (let part = 0; part < parts; part++) {
          if (part > 0 && !same(await fresh(), before)) return fail("changed");
          const ack = await request(new Api.upload.SaveFilePart({ fileId: bigInt(fileId), filePart: part,
            bytes: ownedBytes.subarray(part * 524288, Math.min(ownedBytes.length, (part + 1) * 524288)) }), true);
          if (ack !== true) return fail("protocol");
        }
        if (!same(await fresh(), before)) return fail("changed");
        // Upload may be slow; the original request can change independently of
        // the profile. Preserve consumed uncertainty if its fresh proof fails.
        await primary();
        const ack = await request(new Api.photos.UploadProfilePhoto({ file: new Api.InputFile({ id: bigInt(fileId), parts, name: "avatar." + extension, md5Checksum }) }), true);
        if (!(ack instanceof Api.photos.Photo) || !(ack.photo instanceof Api.Photo) || (ack.photo.videoSizes?.length ?? 0) !== 0) return fail("protocol");
        const expected = photoLong(ack.photo.id);
        if (expected === before.photoId) return fail("changed");
        const after = await fresh();
        if (after.photoId !== expected || after.firstName !== before.firstName || after.lastName !== before.lastName || after.username !== before.username) return fail("changed");
        uncertain = false;
        return { verdict: "verified", code: "verified", profile: view(after) };
      }).finally(() => { ownedBytes.fill(0); });
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true; signal.removeEventListener("abort", revoke);
      closing = Promise.resolve(pending).then(() => {}); return closing;
    },
  });
}
