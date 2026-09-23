import { randomUUID } from "node:crypto";
import type { StandingIdleHistoryTicket } from "./standing-conversation-adapter.js";
import type { StandingCommunitySettingsStore, StandingCommunityPolicy } from "./standing-community-settings.js";
import type { StandingCommunityObserverState, StandingCommunityObserverHostCheckpoint, StandingCommunityPendingRow, StandingCommunityProcessingDisposition } from "./standing-community-observer-state.js";
import type { StandingCommunityAlertOutbox } from "./standing-community-alert-outbox.js";
import type { StandingObservedSourceItem } from "./standing-observed-source-reader.js";
import { snapshotStandingCommunityAssessmentInput, parseStandingCommunityAssessmentDecision, type StandingCommunityAssessmentDecision } from "./standing-community-assessment-contract.js";

export type StandingCommunityObserverStatus = Readonly<{
  schema: "standing-community-observer-status-v1";
  phase: "idle" | "reading" | "assessing" | "sending" | "disabled" | "backoff" | "outbox-full" | "closed";
  policyRevision: number | null; observationEnabled: boolean | null; alertsEnabled: boolean | null;
  pendingRows: number; readCycle: "idle" | "catching-up" | "capacity-paused";
  outbox: Readonly<{ used: number; maximum: 256; full: boolean }> | null;
  coverage: StandingCommunityObserverHostCheckpoint["coverage"] | null;
  processing: StandingCommunityObserverHostCheckpoint["processing"]["totals"] | null;
  lastOutcome: "none" | "read" | "alerts-disabled" | "policy-suppressed" | "material-too-large" | "silent" | "alert" | "unknown" | "unavailable";
  lastReadAtMs: number | null;
  error: "operation-unavailable" | "assessment-timeout" | "settlement-unknown" | null;
  nextDueAtMs: number; completeHistory: false;
}>;
export class StandingCommunityObserverError extends Error {
  constructor(readonly code: "INPUT" | "BUSY" | "SETTLEMENT_UNKNOWN") { super("STANDING_COMMUNITY_OBSERVER_" + code); }
}
export type StandingCommunityObserverInput = Readonly<{
  settings: StandingCommunitySettingsStore; state: StandingCommunityObserverState; outbox: StandingCommunityAlertOutbox;
  /** Resolves or rejects only after joined native settlement. The exception is
   * code SETTLEMENT_UNKNOWN, which must stop the shared owner. */
  assess(ref: string, body: string, signal: AbortSignal): Promise<StandingCommunityAssessmentDecision>;
  signal: AbortSignal; now?(): number; onVerified?(): void; onStatus?(status: StandingCommunityObserverStatus): void;
}>;
const SCAN_MS = 60_000;
const fatal = (): never => { throw new StandingCommunityObserverError("SETTLEMENT_UNKNOWN"); };
const unsafe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
function render(answer: string): string {
  const source = "Наблюдение сообщества:\n" + answer.replace(unsafe, " ").trim(), suffix = "\n[Сокращено]";
  if (source.length <= 900 && Buffer.byteLength(source) <= 4096) return source;
  let result = "";
  for (const point of source) {
    if (result.length + point.length + suffix.length > 900 || Buffer.byteLength(result + point + suffix) > 4096) break;
    result += point;
  }
  return result.trimEnd() + suffix;
}
function item(row: StandingCommunityPendingRow): StandingObservedSourceItem {
  return { ref: row.ref, date: row.date, displayName: row.displayName, text: row.text, truncated: row.truncated,
    media: row.media, ...(row.forwarded ? { forwarded: row.forwarded } : {}) };
}
function policyView(policy: StandingCommunityPolicy) {
  return { revision: policy.revision, observationEnabled: policy.observationEnabled,
    alertsEnabled: policy.alertsEnabled, observedSourcePeerId: policy.observedSourcePeerId };
}

/** One serial background participant, borrowing all stores and the caller's
 * unused sole-client ticket. Read and processing use different quanta. */
export function createStandingCommunityObserver(input: StandingCommunityObserverInput) {
  if (!input || typeof input.assess !== "function" || !(input.signal instanceof AbortSignal)) throw new StandingCommunityObserverError("INPUT");
  const now = input.now ?? Date.now;
  const clock = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 1 || value > 253402300799999) throw new StandingCommunityObserverError("INPUT"); return value; };
  clock();
  let closed = false, settlementUnknown = false, generation = 0, nextDue = 0, nextScan = 0, active: Promise<void> | undefined, closing: Promise<void> | undefined;
  let control: AbortController | undefined, closeLease: (() => Promise<void>) | undefined, leaseClosing: Promise<void> | undefined;
  let status: StandingCommunityObserverStatus = Object.freeze({ schema: "standing-community-observer-status-v1", phase: "idle",
    policyRevision: null, observationEnabled: null, alertsEnabled: null, pendingRows: 0, readCycle: "idle", outbox: null,
    coverage: null, processing: null, lastOutcome: "none", lastReadAtMs: null, error: null, nextDueAtMs: 0, completeHistory: false });
  const publish = (patch: Partial<StandingCommunityObserverStatus> = {}) => {
    status = Object.freeze({ ...status, ...patch, nextDueAtMs: nextDue });
    try { input.onStatus?.(status); } catch { /* Optional status cannot change admission. */ }
  };
  const checkpointView = (value: StandingCommunityObserverHostCheckpoint) => {
    publish({ pendingRows: value.recent.pendingRows, readCycle: value.cycle.status, coverage: value.coverage, processing: value.processing.totals });
  };
  const releaseLease = () => {
    if (closeLease && !leaseClosing) { leaseClosing = Promise.resolve().then(closeLease).catch(() => {
      closed = true; settlementUnknown = true; publish({ phase: "backoff", error: "settlement-unknown" }); return fatal();
    }); void leaseClosing.catch(() => {}); }
    return leaseClosing;
  };
  const adopt = <T extends { close(): Promise<void> }>(lease: T, signal: AbortSignal): T => {
    closeLease = lease.close.bind(lease); leaseClosing = undefined;
    if (signal.aborted) void releaseLease();
    return Object.freeze({ ...lease, close: () => releaseLease() ?? Promise.resolve() }) as T;
  };
  const changed = () => { generation++; nextDue = 0; control?.abort(); void releaseLease()?.catch(() => {}); publish(); };
  const close = (): Promise<void> => {
    if (!closing) {
      closed = true; input.signal.removeEventListener("abort", stopped); control?.abort(); void releaseLease()?.catch(() => {});
      closing = (async () => {
        let failure: unknown; try { await active; } catch (error) { failure = error; }
        await releaseLease(); if (settlementUnknown) fatal(); publish({ phase: "closed" }); if (failure) throw failure;
      })();
    }
    return closing;
  };
  const stopped = () => { void close().catch(() => {}); };
  input.signal.addEventListener("abort", stopped, { once: true });
  if (input.signal.aborted) stopped();
  const due = () => !closed && !input.signal.aborted && !active && clock() >= nextDue;
  const step = (ticket: StandingIdleHistoryTicket, suppliedSignal: AbortSignal): Promise<void> => {
    if (closed || input.signal.aborted || suppliedSignal.aborted) return Promise.resolve();
    if (active) return Promise.reject(new StandingCommunityObserverError("BUSY"));
    if (!due()) return Promise.resolve();
    const enteredGeneration = generation; control = new AbortController();
    const signal = AbortSignal.any([input.signal, suppliedSignal, control.signal]);
    closeLease = undefined; leaseClosing = undefined;
    const revoked = () => closed || signal.aborted || enteredGeneration !== generation;
    const abortLease = () => { void releaseLease()?.catch(() => {}); };
    signal.addEventListener("abort", abortLease, { once: true });
    active = Promise.resolve().then(async () => {
      let reserved: { revision: number; throughSequence: number } | undefined;
      const finish = async (disposition: "silent" | "alert" | "unknown") => {
        if (!reserved) return;
        const saved = reserved; reserved = undefined;
        const updated = await input.state.markProcessed({ expectedRevision: saved.revision, throughSequence: saved.throughSequence, disposition });
        checkpointView(updated.checkpoint);
      };
      const schedule = (checkpoint: StandingCommunityObserverHostCheckpoint, policy: StandingCommunityPolicy) => {
        nextDue = enteredGeneration !== generation ? 0 : !policy.observationEnabled ? clock() + SCAN_MS :
          checkpoint.recent.pendingRows > 0 || checkpoint.cycle.status === "catching-up" ? 0 : Math.max(nextScan, clock());
      };
      try {
        if (revoked()) return;
        publish({ error: null });
        let policy = await input.settings.policy(); if (revoked()) return;
        publish({ policyRevision: policy.revision, observationEnabled: policy.observationEnabled, alertsEnabled: policy.alertsEnabled });
        let checkpoint = await input.state.checkpoint(); checkpointView(checkpoint); if (revoked()) return;
        // A cold reserved attempt is consumed, never a new model/send budget.
        if (checkpoint.processing.last?.disposition === "attempt-reserved") {
          const resolved = await input.state.markProcessed({ expectedRevision: checkpoint.revision,
            throughSequence: checkpoint.processing.last.throughSequence, disposition: "unknown" });
          checkpoint = resolved.checkpoint; checkpointView(checkpoint); schedule(checkpoint, policy); publish({ phase: "idle", lastOutcome: "unknown" }); return;
        }
        const capacity = await input.outbox.status(); publish({ outbox: capacity }); if (revoked()) return;
        if (checkpoint.recent.pendingRows > 0) {
          const pending = await input.state.readPending({ limit: 30 }); if (revoked()) return;
          if (!pending.items.length) throw Error("pending");
          const recent = await input.outbox.recent({ limit: 8 }); if (revoked()) return;
          // Outbox times are milliseconds; source observation times are seconds.
          const lastPotentialSend = recent.filter(value => value.state === "verified" || value.state === "unknown").reduce((maximum, value) => Math.max(maximum, value.settledAt), 0);
          const cooling = lastPotentialSend > 0 && clock() - lastPotentialSend < policy.minAlertIntervalSeconds * 1000;
          const suppressed = !policy.observationEnabled || capacity.full || cooling;
          if (!policy.alertsEnabled || suppressed) {
            const disposition: StandingCommunityProcessingDisposition = suppressed ? "policy-suppressed" : "alerts-disabled";
            checkpoint = (await input.state.markProcessed({ expectedRevision: checkpoint.revision,
              throughSequence: pending.items.at(-1)!.sequence, disposition })).checkpoint;
            checkpointView(checkpoint); schedule(checkpoint, policy); publish({ phase: capacity.full ? "outbox-full" : policy.observationEnabled ? "idle" : "disabled", lastOutcome: disposition }); return;
          }
          const assessmentRef = "community-" + randomUUID().replaceAll("-", "");
          const recentAlertSummary = JSON.stringify(recent.map(value => ({ caseKey: value.caseKey, state: value.state, settledAt: value.settledAt })));
          const base = { schema: "community-assessment-v1", assessmentRef, policyRevision: policy.revision, guidance: policy.alertGuidance, recentAlertSummary };
          let packet: ReturnType<typeof snapshotStandingCommunityAssessmentInput> | undefined, throughSequence = 0;
          const observations: StandingObservedSourceItem[] = [];
          for (const row of pending.items) {
            try { const candidate = snapshotStandingCommunityAssessmentInput({ ...base, observations: [...observations, item(row)] });
              packet = candidate; observations.push(item(row)); throughSequence = row.sequence;
            } catch { break; }
          }
          if (!packet) {
            // Source text remains intact in the encrypted recent store. An
            // exceptionally escape-heavy row may not fit even alone in the
            // assessment packet. Record that it was NOT analysed and advance
            // only this row, rather than retrying it forever or cutting text.
            checkpoint = (await input.state.markProcessed({ expectedRevision: checkpoint.revision,
              throughSequence: pending.items[0]!.sequence, disposition: "material-too-large" })).checkpoint;
            checkpointView(checkpoint); schedule(checkpoint, policy);
            publish({ phase: "idle", lastOutcome: "material-too-large" }); return;
          }
          const refreshed = await input.settings.policy(); if (revoked()) return;
          if (refreshed.revision !== policy.revision || !refreshed.alertsEnabled || !refreshed.observationEnabled) {
            policy = refreshed;
            publish({ policyRevision: policy.revision, observationEnabled: policy.observationEnabled, alertsEnabled: policy.alertsEnabled });
            checkpoint = (await input.state.markProcessed({ expectedRevision: checkpoint.revision, throughSequence, disposition: "policy-suppressed" })).checkpoint;
            checkpointView(checkpoint); schedule(checkpoint, policy); publish({ phase: policy.observationEnabled ? "idle" : "disabled", lastOutcome: "policy-suppressed" }); return;
          }
          checkpoint = (await input.state.markProcessed({ expectedRevision: checkpoint.revision, throughSequence, disposition: "attempt-reserved" })).checkpoint;
          reserved = { revision: checkpoint.revision, throughSequence }; checkpointView(checkpoint);
          if (revoked()) { await finish("unknown"); return; }
          publish({ phase: "assessing" });
          const returned = await input.assess(assessmentRef, JSON.stringify(packet), signal);
          const decision = parseStandingCommunityAssessmentDecision(JSON.stringify(returned), packet);
          if (revoked()) { await finish("unknown"); return; }
          if (decision.decision === "silent") { await finish("silent"); publish({ phase: "idle", lastOutcome: "silent" }); }
          else {
            const current = await input.settings.policy(); if (revoked()) { await finish("unknown"); return; }
            if (current.revision !== policy.revision || !current.observationEnabled || !current.alertsEnabled ||
                (await input.outbox.inspect(decision.caseKey)).state !== "absent") {
              policy = current;
              await finish("silent"); publish({ phase: policy.observationEnabled ? "idle" : "disabled", lastOutcome: "policy-suppressed",
                policyRevision: policy.revision, observationEnabled: policy.observationEnabled, alertsEnabled: policy.alertsEnabled });
            } else {
              if (!ticket.openCommunityAlert) throw Error("alert-unavailable");
              publish({ phase: "sending" });
              const outcome = await input.outbox.deliver({ caseKey: decision.caseKey, policyRevision: policy.revision, text: render(decision.answer), signal,
                openAlert: value => adopt(ticket.openCommunityAlert!(value), signal), refreshPolicy: async () => {
                  policy = await input.settings.policy();
                  publish({ policyRevision: policy.revision, observationEnabled: policy.observationEnabled, alertsEnabled: policy.alertsEnabled });
                  return policyView(policy);
                } });
              if (outcome.reason === "close-unknown") fatal();
              // Reflect the newly reserved case for every settled outcome.
              // An optional capacity read must not erase a verified receipt.
              try { publish({ outbox: await input.outbox.status() }); }
              catch { publish({ outbox: null, error: "operation-unavailable" }); }
              if (outcome.state === "not-sent" && !["policy-disabled", "policy-changed", "cancelled"].includes(outcome.reason)) {
                // An unavailable/refused transport or policy read is an
                // operational failure, not an ordinary decision to stay quiet.
                // Consume only this reserved batch and stop immediate churn.
                await finish("unknown");
                nextDue = enteredGeneration === generation ? clock() + SCAN_MS : 0;
                publish({ phase: "backoff", lastOutcome: "unknown", error: "operation-unavailable" }); return;
              }
              await finish(outcome.state === "verified" ? "alert" : outcome.state === "unknown" ? "unknown" : "silent");
              if (outcome.state === "verified") { try { input.onVerified?.(); } catch { /* An observation cannot change delivery. */ } }
              publish({ phase: policy.observationEnabled ? "idle" : "disabled", lastOutcome: outcome.state === "verified" ? "alert" : outcome.state === "unknown" ? "unknown" : "policy-suppressed" });
            }
          }
          checkpoint = await input.state.checkpoint(); checkpointView(checkpoint); schedule(checkpoint, policy); publish(); return;
        }
        if (!policy.observationEnabled) { nextDue = clock() + SCAN_MS; publish({ phase: "disabled" }); return; }
        if (clock() < nextScan && checkpoint.cycle.status === "idle") { nextDue = nextScan; publish({ phase: capacity.full ? "outbox-full" : "idle" }); return; }
        if (!ticket.openObservedSource) throw Error("source-unavailable");
        publish({ phase: "reading" });
        const source = adopt(ticket.openObservedSource({ signal }), signal);
        let page: Awaited<ReturnType<typeof source.readHistory>>;
        try { page = await source.readHistory({ limit: 30, ...(checkpoint.read.beforeMessageId === null ? {} : { beforeMessageId: checkpoint.read.beforeMessageId }) }); }
        finally { await releaseLease(); }
        if (revoked()) return;
        checkpoint = (await input.state.commitPage({ expectedRevision: checkpoint.revision, observedAt: Math.floor(clock() / 1000), page })).checkpoint;
        nextScan = clock() + SCAN_MS; checkpointView(checkpoint); schedule(checkpoint, policy); publish({ phase: capacity.full ? "outbox-full" : "idle", lastOutcome: "read", lastReadAtMs: clock() });
      } catch (error) {
        if ((error as { code?: unknown })?.code === "SETTLEMENT_UNKNOWN") { closed = true; settlementUnknown = true; publish({ phase: "backoff", error: "settlement-unknown" }); fatal(); }
        // The assess port guarantees settlement for every non-fatal rejection.
        // Reserve remains consumed even when final local persistence fails.
        const hadReservation = reserved !== undefined;
        try { await finish("unknown"); } catch { /* Never turn a failed final write into replay authority. */ }
        nextDue = enteredGeneration === generation ? clock() + SCAN_MS : 0;
        publish({ phase: "backoff", lastOutcome: hadReservation ? "unknown" : "unavailable",
          error: (error as { code?: unknown })?.code === "COMMUNITY_ASSESSMENT_TIMEOUT" ? "assessment-timeout" : "operation-unavailable" });
      } finally {
        signal.removeEventListener("abort", abortLease); await releaseLease();
        if (enteredGeneration !== generation) nextDue = 0;
      }
    });
    const pending = active; void pending.then(() => { if (active === pending) active = undefined; control = undefined; publish(); },
      () => { if (active === pending) active = undefined; control = undefined; });
    return pending;
  };
  return Object.freeze({ due, step, close, policyChanged: changed, status: () => status, snapshot: () => status });
}
