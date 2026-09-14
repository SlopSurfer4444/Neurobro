import { randomBytes } from "node:crypto";
import { BrokerError, BrokerFramer, decodeFrame, encodeFrame, exactKeys, requireBroker, sessionOptions, type BrokerMethod, type BrokerSession, type FrameCore, type Json } from "./wsl-broker-contract.js";

export interface BrokerExchange { exchange(frame: Uint8Array, signal: AbortSignal): Promise<Uint8Array>; close?(): void }
/** Key remains in this trusted transport closure; model consumers receive request only. */
export function createWslBrokerGuest(input: BrokerSession, transport: BrokerExchange) {
  const session = sessionOptions(input); let sequence = 0; let busy = false; let closed = false; let usedBytes = 0;
  return Object.freeze({
    async request(method: BrokerMethod, args: Json): Promise<Json> {
      requireBroker(!busy && !closed && sequence < session.limits.maxCalls, "session-unavailable"); busy = true;
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const core: FrameCore = { version: 1, kind: "request", keyId: session.keyId, sessionId: session.sessionId, id: randomBytes(16).toString("hex"), sequence: ++sequence, deadlineMs: session.now() + session.limits.maxDeadlineMs, body: { method, args } };
        const frame = encodeFrame(core, session); requireBroker(usedBytes + frame.length + 1024 <= session.limits.maxSessionBytes, "session-budget"); usedBytes += frame.length;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BrokerError("transport-unknown")); }, session.limits.maxDeadlineMs); });
        const bytes = await Promise.race([transport.exchange(frame, controller.signal), timeout]);
        requireBroker(!closed && !controller.signal.aborted, "transport-unknown");
        const response = decodeFrame(bytes, session, "response");
        requireBroker(response.id === core.id && response.sequence === core.sequence && response.deadlineMs === core.deadlineMs && session.now() < core.deadlineMs, "response-mismatch");
        usedBytes += bytes.length; requireBroker(usedBytes <= session.limits.maxSessionBytes, "session-budget");
        exactKeys(response.body, ["outcome", "value"]); requireBroker(["ok", "refused", "unknown"].includes(response.body.outcome as string), "response-invalid");
        if (response.body.outcome !== "ok") {
          const value = response.body.value;
          if (response.body.outcome === "unknown" || (value !== null && typeof value === "object" && !Array.isArray(value) && value.code === "session-budget")) { closed = true; try { transport.close?.(); } catch { /* Preserve the authenticated outcome; session stays closed. */ } }
          throw new BrokerError(response.body.outcome === "unknown" ? "transport-unknown" : "request-refused");
        }
        return response.body.value as Json;
      } catch (error) { if (!(error instanceof BrokerError) || error.code !== "request-refused") { closed = true; controller.abort(); try { transport.close?.(); } catch { /* Remains terminal unknown. */ } } throw error instanceof BrokerError ? error : new BrokerError("transport-unknown"); }
      finally { if (timer !== undefined) clearTimeout(timer); busy = false; }
    },
    close: (): void => { closed = true; transport.close?.(); },
  });
}
/** Sequential pipe exchange with one outstanding frame and no retries. */
export function createBrokerPipeExchange(input: AsyncIterable<Uint8Array>, write: (frame: Uint8Array) => Promise<void>, closePipes: () => void): BrokerExchange {
  const iterator = input[Symbol.asyncIterator](); const framer = new BrokerFramer(); let ended = false; let busy = false;
  const close = () => { if (!ended) { ended = true; try { closePipes(); } catch { /* Cannot make this terminal transport reusable. */ } } };
  return { close, async exchange(frame, signal) {
    requireBroker(!ended && !busy && !signal.aborted, "transport-unknown"); busy = true;
    const abort = () => { close(); }; signal.addEventListener("abort", abort, { once: true });
    try {
      await write(frame);
      while (!ended && !signal.aborted) { const next = await iterator.next(); if (next.done) { framer.end(); close(); break; } const frames = framer.push(next.value); requireBroker(frames.length <= 1 && !(frames.length === 1 && framer.hasPending()), "unexpected-response"); if (frames[0]) return frames[0]; }
      throw new BrokerError("transport-unknown");
    } catch { close(); throw new BrokerError("transport-unknown"); }
    finally { signal.removeEventListener("abort", abort); busy = false; }
  } };
}
