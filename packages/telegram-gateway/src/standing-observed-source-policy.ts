import { types } from "node:util";
import bigInt from "big-integer";
import { Api } from "telegram";

export type StandingObservedSourceRequest = Api.messages.GetHistory | Api.messages.Search;
export type StandingObservedSourcePolicy = Readonly<{
  /** The projector is trusted host code and must synchronously return a bounded,
   * validated plain projection. The raw Telegram envelope never leaves call. */
  call<T>(request: StandingObservedSourceRequest, project: (response: unknown) => T): Promise<T>;
  /** Revokes new work immediately and joins the borrowed invocation. */
  close(): Promise<void>;
}>;
export class StandingObservedSourcePolicyError extends Error {
  constructor(readonly code: "config" | "input" | "peer" | "method" | "busy" | "transport" | "projection" | "aborted") {
    super("STANDING_OBSERVED_SOURCE_" + code.toUpperCase());
    this.name = "StandingObservedSourcePolicyError";
  }
}

const MAX_LIMIT = 30;
const MAX_QUERY_BYTES = 256;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const fail = (code: StandingObservedSourcePolicyError["code"]): never => { throw new StandingObservedSourcePolicyError(code); };
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
function aborted(signal: AbortSignal): boolean {
  if (!signal || types.isProxy(signal)) return fail("config");
  return abortedGetter.call(signal) as boolean;
}
function data(value: unknown, required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("config");
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== required.length || required.some(key => !Object.hasOwn(descriptors, key)) ||
      keys.some(key => typeof key !== "string" || !required.includes(key)) ||
      Object.values(descriptors).some(descriptor => !("value" in descriptor) || !descriptor.enumerable)) return fail("config");
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function ownValue(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail("input");
  return descriptor.value;
}
function positiveLong(value: unknown): string {
  if (!bigInt.isInstance(value) || types.isProxy(value)) return fail("input");
  const text = value.toString();
  if (!/^[1-9]\d{0,18}$/u.test(text) || BigInt(text) >= 2n ** 63n) return fail("input");
  return text;
}
function signedLong(value: unknown, nonzero = false): string {
  if (!bigInt.isInstance(value) || types.isProxy(value)) return fail("input");
  const text = value.toString();
  if (!/^-?(?:0|[1-9]\d{0,18})$/u.test(text)) return fail("input");
  const number = BigInt(text);
  if (number < -(2n ** 63n) || number >= 2n ** 63n || nonzero && number === 0n) return fail("input");
  return text;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) return fail("input");
  return value as number;
}
function clean(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && !CONTROL.test(value) &&
    Buffer.byteLength(value) <= maximumBytes && Buffer.from(value).toString("utf8") === value;
}
function peerId(peer: Api.InputPeerChat | Api.InputPeerChannel): string {
  return peer instanceof Api.InputPeerChat ? "-" + peer.chatId.toString() : "-100" + peer.channelId.toString();
}
function copyPeer(value: unknown, code: "config" | "input" = "input"): Api.InputPeerChat | Api.InputPeerChannel {
  try {
    if (!value || typeof value !== "object" || types.isProxy(value)) return fail(code);
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Api.InputPeerChat.prototype) {
      const id = positiveLong(ownValue(value, "chatId"));
      return new Api.InputPeerChat({ chatId: bigInt(id) });
    }
    if (prototype === Api.InputPeerChannel.prototype) {
      const id = positiveLong(ownValue(value, "channelId")), accessHash = signedLong(ownValue(value, "accessHash"), true);
      return new Api.InputPeerChannel({ channelId: bigInt(id), accessHash: bigInt(accessHash) });
    }
    return fail(code);
  } catch (error) {
    if (error instanceof StandingObservedSourcePolicyError && error.code === code) throw error;
    return fail(code);
  }
}
function samePeer(left: Api.InputPeerChat | Api.InputPeerChannel, right: Api.InputPeerChat | Api.InputPeerChannel): boolean {
  return left instanceof Api.InputPeerChat && right instanceof Api.InputPeerChat && left.chatId.equals(right.chatId) ||
    left instanceof Api.InputPeerChannel && right instanceof Api.InputPeerChannel && left.channelId.equals(right.channelId) && left.accessHash.equals(right.accessHash);
}
function hashZero(value: unknown): void {
  if (!bigInt.isInstance(value) || types.isProxy(value) || !value.isZero()) return fail("input");
}
function copyCommon(request: object, source: Api.InputPeerChat | Api.InputPeerChannel) {
  const suppliedPeer = copyPeer(ownValue(request, "peer"));
  if (!samePeer(suppliedPeer, source)) return fail("peer");
  const offsetId = integer(ownValue(request, "offsetId"), 0, 2147483647);
  const addOffset = integer(ownValue(request, "addOffset"), -MAX_LIMIT, MAX_LIMIT);
  const limit = integer(ownValue(request, "limit"), 1, MAX_LIMIT);
  const maxId = integer(ownValue(request, "maxId"), 0, 2147483647);
  const minId = integer(ownValue(request, "minId"), 0, 2147483647);
  hashZero(ownValue(request, "hash"));
  return { peer: copyPeer(source), offsetId, addOffset, limit, maxId, minId, hash: bigInt.zero };
}
function copyRequest(value: unknown, source: Api.InputPeerChat | Api.InputPeerChannel): StandingObservedSourceRequest {
  if (!value || typeof value !== "object" || types.isProxy(value)) return fail("method");
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Api.messages.GetHistory.prototype) {
    const common = copyCommon(value, source);
    return new Api.messages.GetHistory({ ...common, offsetDate: integer(ownValue(value, "offsetDate"), 0, 2147483647) });
  }
  if (prototype === Api.messages.Search.prototype) {
    for (const name of ["flags", "fromId", "savedPeerId", "savedReaction", "topMsgId"]) if (ownValue(value, name) !== undefined) return fail("input");
    const filter = ownValue(value, "filter");
    if (!filter || typeof filter !== "object" || types.isProxy(filter) || Object.getPrototypeOf(filter) !== Api.InputMessagesFilterEmpty.prototype) return fail("input");
    const query = ownValue(value, "q"); if (!clean(query, MAX_QUERY_BYTES)) return fail("input");
    const minDate = integer(ownValue(value, "minDate"), 0, 2147483647), maxDate = integer(ownValue(value, "maxDate"), 0, 2147483647);
    if (minDate !== 0 && maxDate !== 0 && minDate > maxDate) return fail("input");
    return new Api.messages.Search({ ...copyCommon(value, source), q: query, filter: new Api.InputMessagesFilterEmpty(), minDate, maxDate });
  }
  return fail("method");
}
function discard(envelope: unknown): void {
  if (!envelope || typeof envelope !== "object" || types.isProxy(envelope)) return;
  try {
    if (envelope instanceof Api.messages.Messages || envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages) {
      envelope.messages.length = 0; envelope.users.length = 0; envelope.chats.length = 0;
    } else if (envelope instanceof Api.messages.MessagesNotModified) {
      // No message/user/chat vectors exist in this constructor.
    }
  } catch { /* A malformed transport response is discarded as far as safely possible. */ }
}

/** Exact-peer, read-only closure over a borrowed sole-account invoker. Account
 * rights are not a safety barrier: the constructor allowlist and peer copy are.
 * It has no client creation/close, updates, source-observer or mutation port. */
export function createStandingObservedSourcePolicy(inputValue: Readonly<{
  client: Readonly<{ invoke(request: Api.AnyRequest): Promise<unknown> }>;
  binding: Readonly<{ accountId: string; peerId: string }>;
  peer: Api.InputPeerChat | Api.InputPeerChannel;
  signal: AbortSignal;
}>): StandingObservedSourcePolicy {
  let input: Record<string, unknown>, binding: Record<string, unknown>, source: Api.InputPeerChat | Api.InputPeerChannel;
  try {
    input = data(inputValue, ["client", "binding", "peer", "signal"]); binding = data(input.binding, ["accountId", "peerId"]);
    source = copyPeer(input.peer, "config");
    if (typeof binding.accountId !== "string" || !/^[1-9]\d{0,19}$/u.test(binding.accountId) ||
        typeof binding.peerId !== "string" || binding.peerId !== peerId(source) || !input.client || typeof input.client !== "object" ||
        types.isProxy(input.client) || typeof (input.client as { invoke?: unknown }).invoke !== "function") return fail("config");
    aborted(input.signal as AbortSignal);
  } catch (error) { if (error instanceof StandingObservedSourcePolicyError) throw error; return fail("config"); }
  const signal = input.signal as AbortSignal, client = input.client as { invoke(request: Api.AnyRequest): Promise<unknown> };
  const invoke = client.invoke.bind(client);
  const frozenBinding = Object.freeze({ accountId: binding.accountId as string, peerId: binding.peerId as string });
  let revoked = false, pending: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  const check = () => {
    if (frozenBinding.peerId !== peerId(source)) return fail("peer");
    if (revoked || aborted(signal)) return fail("aborted");
  };
  return Object.freeze({
    call<T>(request: StandingObservedSourceRequest, project: (response: unknown) => T): Promise<T> {
      let copied: StandingObservedSourceRequest;
      try {
        check();
        if (typeof project !== "function" || types.isProxy(project)) return Promise.reject(new StandingObservedSourcePolicyError("projection"));
        copied = copyRequest(request, source);
        if (pending) return Promise.reject(new StandingObservedSourcePolicyError("busy"));
      } catch (error) { return Promise.reject(error instanceof StandingObservedSourcePolicyError ? error : new StandingObservedSourcePolicyError("input")); }
      let envelope: unknown, stage: "invoke" | "project" = "invoke";
      const task = Promise.resolve().then(async (): Promise<T> => {
        try {
          check();
          try { envelope = await invoke(copied); }
          catch { return fail("transport"); }
          check(); stage = "project";
          let result: T;
          try { result = project(envelope); }
          catch { return fail("projection"); }
          if (types.isPromise(result) || result === envelope) return fail("projection");
          check(); return result;
        } catch (error) {
          if (error instanceof StandingObservedSourcePolicyError) throw error;
          return fail(stage === "invoke" ? "transport" : "projection");
        } finally { discard(envelope); }
      });
      pending = task;
      void task.then(() => { if (pending === task) pending = undefined; }, () => { if (pending === task) pending = undefined; });
      return task;
    },
    close(): Promise<void> {
      if (closing) return closing;
      revoked = true;
      closing = Promise.resolve(pending).then(() => undefined, () => undefined);
      return closing;
    },
  });
}
