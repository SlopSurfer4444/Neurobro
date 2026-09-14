import { createHash } from "node:crypto";
import { types } from "node:util";
import type { PilotRecord, PilotReply, PilotStore } from "./pilot-outbox.js";
import type { GeneratedImageMediaStore, ImageDeliveryPlan, ImageDeliveryRecord } from "./generated-image-outbox.js";
import type { ArtifactDeliveryPlan, ArtifactDeliveryRecord, ArtifactDeliveryStore } from "./standing-artifact-outbox.js";
import { snapshotStandingActionJson, standingActionKey, type StandingActionBinding, type StandingActionIntent, type StandingActionJournal, type StandingActionTerminal } from "./standing-action-journal.js";
import { projectStandingOwnAction, type StandingOwnActionSource } from "./standing-own-action-projection.js";

/** Host-only persisted facts. They prove neither transport settlement nor current
 * remote availability. Publish to model context only after the owning operation
 * joins. Cold readers use these same canonical slots; no new disk authority. */
export type StandingOwnActionCaptureEvent = Readonly<{ slot: string; source: StandingOwnActionSource }>;
export type StandingOwnActionCaptureObserver = (event: StandingOwnActionCaptureEvent) => void;

/** Capture is optional: rejected metadata never changes the underlying operation.
 * Copy only inert, bounded JSON; Buffers, getters and proxies are never retained. */
function snapshot<T>(value: T): T | undefined {
  try {
    let budget = 65536, nodes = 0;
    const charge = (n: number) => { if ((budget -= n) < 0) throw new Error("capture-size"); };
    const copy = (v: unknown, depth: number): unknown => {
      if (++nodes > 8192 || depth > 14) throw new Error("capture-depth");
      if (v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) { charge(JSON.stringify(v).length); return v; }
      if (typeof v === "string") { if (v.length > 16384) throw new Error("capture-string"); charge(Buffer.byteLength(JSON.stringify(v))); return v; }
      if (!v || typeof v !== "object" || types.isProxy(v)) throw new Error("capture-object");
      const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
      if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error("capture-prototype");
      const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
      if (keys.length > 8193) throw new Error("capture-keys");
      if (array) {
        const length = Object.getOwnPropertyDescriptor(v, "length")!.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > 8192 || keys.length !== length + 1) throw new Error("capture-array");
        charge(2 + Math.max(0, length - 1)); const result: unknown[] = [];
        for (let i = 0; i < length; i++) { const d = ds[String(i)]; if (!d || !("value" in d) || !d.enumerable) throw new Error("capture-descriptor"); result.push(copy(d.value, depth + 1)); }
        return Object.freeze(result);
      }
      charge(2 + Math.max(0, keys.length - 1)); const result: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        if (typeof key !== "string" || key.length > 128 || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("capture-key");
        charge(Buffer.byteLength(JSON.stringify(key)) + 1); const d = ds[key]!;
        if (!("value" in d) || !d.enumerable) throw new Error("capture-descriptor"); result[key] = copy(d.value, depth + 1);
      }
      // Owning validators require ordinary data objects, not capabilities.
      return Object.freeze({ ...result });
    };
    return copy(value, 0) as T;
  } catch { return undefined; }
}

function publish(emit: StandingOwnActionCaptureObserver, slot: string, source: StandingOwnActionSource): void {
  try {
    const binding = source.family === "pilot" ? source.record : source.family === "bound-action" ? source.binding : source.plan.approved;
    // Recheck source correspondence, including exact content/plan hashes. The
    // successful owning store write supplies provenance, not this shape check.
    projectStandingOwnAction({ binding: { accountId: binding.accountId, chatId: binding.chatId }, referenceKey: "0".repeat(64), slot, source });
    // A synchronous host observer must not launch asynchronous work.
    if (typeof emit !== "function" || types.isProxy(emit) || types.isAsyncFunction(emit) || types.isGeneratorFunction(emit)) return;
    emit(Object.freeze({ slot, source: Object.freeze(source) }));
  } catch { /* Observation cannot alter a durable verdict or create a retry. */ }
}

/** Keep the complete store surface (including inspection and closure) and bind
 * forwarded methods to the original receiver. No store getter runs at wrapping. */
function forward<T extends object>(store: T, overrides: Record<string, unknown>): T {
  const wrapped = Object.create(Object.getPrototypeOf(store));
  const seen = new Set<PropertyKey>();
  for (let current: object | null = store; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
    for (const key of Reflect.ownKeys(current)) {
      if (seen.has(key) || key === "constructor") continue; seen.add(key);
      const d = Object.getOwnPropertyDescriptor(current, key)!;
      Object.defineProperty(wrapped, key, "value" in d ? { value: typeof d.value === "function" ? d.value.bind(store) : d.value, enumerable: d.enumerable === true, configurable: true } :
        { ...(d.get ? { get: () => d.get!.call(store) } : {}), ...(d.set ? { set: (value: unknown) => d.set!.call(store, value) } : {}), enumerable: d.enumerable === true, configurable: true });
    }
  }
  for (const [key, value] of Object.entries(overrides)) Object.defineProperty(wrapped, key, { value, enumerable: true, configurable: true });
  return Object.freeze(wrapped) as T;
}

export function wrapPilotStore<T extends PilotStore>(store: T, reply: PilotReply, emit: StandingOwnActionCaptureObserver): T {
  const ownedReply = snapshot(reply); let planned: PilotRecord | undefined, terminalAttempted = false;
  return forward(store, {
    async reserve(record: PilotRecord) { const owned = snapshot(record); await store.reserve(record); planned = owned; },
    async append(record: PilotRecord) {
      const owned = snapshot(record), terminal = !!owned && ["verified", "unknown", "failed_terminal"].includes(owned.state), capture = terminal && !terminalAttempted;
      if (terminal) terminalAttempted = true;
      await store.append(record);
      if (!capture || !owned || !planned || planned.state !== "planned" || owned.idempotencyKey !== planned.idempotencyKey || owned.randomId !== planned.randomId) return;
      const slot = createHash("sha256").update(JSON.stringify(["DecadansNeurobro/own-pilot-source/v1", planned.idempotencyKey, planned.randomId])).digest("hex");
      publish(emit, slot, { family: "pilot", record: owned, ...(ownedReply ? { reply: ownedReply } : {}) });
    },
  });
}

function wrapMedia<T extends GeneratedImageMediaStore | ArtifactDeliveryStore>(store: T, family: "generated-image" | "artifact", emit: StandingOwnActionCaptureObserver): T {
  let plan: ImageDeliveryPlan | ArtifactDeliveryPlan | undefined, terminalAttempted = false;
  return forward(store, {
    async reserve(value: ImageDeliveryPlan & ArtifactDeliveryPlan, bytes: Buffer) { const owned = snapshot(value); await store.reserve(value, bytes); plan = owned; },
    async append(value: ImageDeliveryRecord & ArtifactDeliveryRecord) {
      const owned = snapshot(value), terminal = !!owned && ["verified", "unknown", "failed_terminal"].includes(owned.state), capture = terminal && !terminalAttempted;
      if (terminal) terminalAttempted = true;
      await store.append(value);
      if (!capture || !owned || !plan) return;
      publish(emit, plan.key, family === "generated-image" ? { family, plan: plan as ImageDeliveryPlan, terminal: owned } : { family, plan: plan as ArtifactDeliveryPlan, terminal: owned });
    },
  });
}
export function wrapImageStore<T extends GeneratedImageMediaStore>(store: T, emit: StandingOwnActionCaptureObserver): T { return wrapMedia(store, "generated-image", emit); }
export function wrapArtifactStore<T extends ArtifactDeliveryStore>(store: T, emit: StandingOwnActionCaptureObserver): T { return wrapMedia(store, "artifact", emit); }

export function wrapActionJournal<T extends StandingActionJournal>(journal: T, binding: StandingActionBinding, emit: StandingOwnActionCaptureObserver): T {
  const ownedBinding = snapshot(binding); let intent: StandingActionIntent | undefined, terminalAttempted = false;
  return forward(journal, {
    async reserve(value: Parameters<StandingActionJournal["reserve"]>[0]) {
      let owned: StandingActionIntent | undefined;
      try { const inert = snapshot(value); if (inert) owned = Object.freeze({ requestRef: inert.requestRef, randomId: inert.randomId, action: snapshotStandingActionJson(inert.action) }); } catch { /* optional metadata */ }
      await journal.reserve(value); intent = owned;
    },
    async append(value: Parameters<StandingActionJournal["append"]>[0]) {
      const owned = snapshot(value) as StandingActionTerminal | undefined, capture = !terminalAttempted; terminalAttempted = true;
      await journal.append(value);
      if (capture && owned && ownedBinding && intent) {
        try { publish(emit, standingActionKey(ownedBinding), { family: "bound-action", binding: ownedBinding, intent, terminal: owned }); } catch { /* optional metadata */ }
      }
    },
  });
}
