import { isAbsolute, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import type { StandingIdleHistoryTicket, StandingIdleHistoryLease } from "./standing-conversation-adapter.js";
import { openStandingHistoryTaskControlStore, type StandingHistoryTaskControlStore } from "./standing-history-task-control-store.js";
import { openStandingHistoryTaskStore, snapshotStandingHistoryTaskIntent, snapshotStandingHistoryTaskPage,
  type StandingHistoryTaskIntent, type StandingHistoryTaskStatus, type StandingHistoryTaskStore } from "./standing-history-task-store.js";

export type StandingHistoryReadStepResult = Readonly<{ kind: "committed"; read: StandingHistoryTaskStatus } | { kind: "cancelled" } | { kind: "stale" }>;
export type StandingHistoryReadStepInput = Readonly<{
  intent: StandingHistoryTaskIntent; directories: Readonly<{ pages: string; control: string }>; passphrase: string;
  ticket: StandingIdleHistoryTicket; expectedSourceHead: string; expectedControlHead: string; signal: AbortSignal;
}>;
export class StandingHistoryReadStepError extends Error {
  constructor(readonly code: "input" | "storage" | "lease" | "read" | "close") { super("STANDING_HISTORY_READ_STEP_" + code.toUpperCase()); }
}
const fail = (code: StandingHistoryReadStepError["code"]): never => { throw new StandingHistoryReadStepError(code); };
function data(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(ds);
  if (keys.some(k => !Object.hasOwn(ds, k)) || names.some(k => typeof k !== "string" || !keys.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(names.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
function method(value: unknown): (...args: never[]) => unknown {
  if (typeof value !== "function" || types.isProxy(value)) return fail("input"); return value as (...args: never[]) => unknown;
}

/** One host-admitted read, with no retry, model call, send or client creation.
 * Existing stores authenticate intent; the actual adapter ticket owns Telegram
 * authority. Fresh reopen is necessary because store handles cache their heads.
 * The host serializes task commit admission and revokes signal on cancellation.
 * Separate control/page files are not an atomic transaction: cancellation after
 * append admission may leave a committed page and a failed return. Such failures
 * propagate; cancelled never asserts that an admitted write was rolled back. */
export async function runStandingHistoryReadStep(value: StandingHistoryReadStepInput): Promise<StandingHistoryReadStepResult> {
  const args = data(value, ["intent", "directories", "passphrase", "ticket", "expectedSourceHead", "expectedControlHead", "signal"]);
  let intent: StandingHistoryTaskIntent;
  try { intent = snapshotStandingHistoryTaskIntent(args.intent); } catch { return fail("input"); }
  const dirs = data(args.directories, ["pages", "control"]), ticket = data(args.ticket, ["openHistoryTask"], ["openTaskReply"]), openTask = method(ticket.openHistoryTask);
  // The shared ticket may also offer final delivery. Validate that inert member,
  // but borrow only the read capability; this step never admits a send.
  if (Object.hasOwn(ticket, "openTaskReply")) method(ticket.openTaskReply);
  for (const path of Object.values(dirs)) if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) return fail("input");
  const directories = Object.freeze({ pages: dirs.pages as string, control: dirs.control as string });
  for (const [a, b] of [[directories.pages, directories.control], [directories.control, directories.pages]] as const) {
    const rel = relative(a, b); if (!rel || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)) return fail("input");
  }
  if (typeof args.passphrase !== "string" || args.passphrase.length < 16 || !args.passphrase.trim() || args.passphrase.includes("\0") ||
      Buffer.byteLength(args.passphrase) > 4096 || Buffer.from(args.passphrase).toString("utf8") !== args.passphrase ||
      typeof args.expectedSourceHead !== "string" || !/^[0-9a-f]{64}$/u.test(args.expectedSourceHead) ||
      typeof args.expectedControlHead !== "string" || !/^[0-9a-f]{64}$/u.test(args.expectedControlHead) ||
      types.isProxy(args.signal) || !(args.signal instanceof AbortSignal)) return fail("input");
  const expectedSourceHead = args.expectedSourceHead, expectedControlHead = args.expectedControlHead, signal = args.signal;
  let passphrase = args.passphrase, control: StandingHistoryTaskControlStore | undefined, pages: StandingHistoryTaskStore | undefined;
  let closeTask: (() => Promise<void>) | undefined, closingTask: Promise<void> | undefined, appendAdmitted = false;
  let phase: StandingHistoryReadStepError["code"] = "storage";
  const cancelled = (): StandingHistoryReadStepResult => Object.freeze({ kind: "cancelled" });
  const stale = (): StandingHistoryReadStepResult => Object.freeze({ kind: "stale" });
  const closeLease = (): Promise<void> => {
    if (!closeTask) return Promise.resolve();
    if (!closingTask) {
      try { closingTask = Promise.resolve(closeTask()); } catch { closingTask = Promise.reject(new StandingHistoryReadStepError("close")); }
      void closingTask.catch(() => {});
    }
    return closingTask;
  };
  const abort = () => { void closeLease(); };
  const closeStores = async () => {
    const owned = [control, pages]; control = undefined; pages = undefined;
    const result = await Promise.allSettled(owned.map(store => store?.close()));
    if (result.some(v => v.status === "rejected")) return fail("close");
  };
  async function reopen(): Promise<StandingHistoryTaskStatus | StandingHistoryReadStepResult> {
    if (signal.aborted) return cancelled();
    control = await openStandingHistoryTaskControlStore({ directory: directories.control, passphrase, intent, mode: "open", signal });
    const state = await control.status();
    if (signal.aborted) return cancelled();
    if (state.storage !== "ready") return stale();
    if (state.state === "cancelled") return cancelled();
    if (state.headHash !== expectedControlHead) return stale();
    pages = await openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: "open", signal });
    const read = await pages.status();
    if (signal.aborted) return cancelled();
    if (read.storage !== "ready" || read.readProgress.chainHash !== expectedSourceHead || read.readProgress.checkpoint.status !== "more" || read.limits.pageQuotaReached) return stale();
    return read;
  }
  try {
    const initial = await reopen(); if ("kind" in initial) return initial;
    if (signal.aborted) return cancelled();
    phase = "lease";
    const leaseValue: unknown = Reflect.apply(openTask, args.ticket, [{ intent, checkpoint: initial.readProgress.checkpoint, signal }]);
    const lease = data(leaseValue, ["readTaskPage", "close"]), close = method(lease.close), read = method(lease.readTaskPage);
    closeTask = () => Reflect.apply(close, leaseValue, []) as ReturnType<StandingIdleHistoryLease["close"]>;
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return cancelled();
    phase = "read";
    const result = snapshotStandingHistoryTaskPage(await Reflect.apply(read, leaseValue, []));
    phase = "close"; await closeLease(); await closeStores();
    phase = "storage";
    const current = await reopen(); if ("kind" in current) return current;
    if (signal.aborted) return cancelled();
    appendAdmitted = true;
    const committed = await pages!.appendPage({ expectedCheckpoint: current.readProgress.checkpoint, result });
    return Object.freeze({ kind: "committed", read: committed });
  } catch (error) {
    if (!appendAdmitted && signal.aborted && phase !== "close") return cancelled();
    if (error instanceof StandingHistoryReadStepError) throw error;
    return fail(phase);
  } finally {
    try { await closeLease(); }
    catch { return fail("close"); }
    finally { signal.removeEventListener("abort", abort); try { await closeStores(); } finally { passphrase = ""; } }
  }
}
