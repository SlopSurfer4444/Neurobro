import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createStandingArtifactRegistry, type StandingArtifact, type StandingArtifactRegistry } from "./standing-artifact.js";
import type { GeneratedImageArtifact } from "./generated-image-artifact.js";
import { createStandingArtifactFetcher, type StandingArtifactFetchPorts } from "./standing-artifact-fetch.js";
import { createStandingArtifactTools, STANDING_ARTIFACT_TOOL_SPECS, type StandingArtifactSendOutcome, type StandingGeneratedImageUseTarget } from "./standing-artifact-tools.js";
import { artifactDeliveryKey, openEncryptedArtifactOutbox, runArtifactDelivery } from "./standing-artifact-outbox.js";
import type { PilotBinding, PilotPrimary } from "./pilot-telegram-adapter.js";
import type { StandingArtifactTransportLease } from "./standing-conversation-adapter.js";
import type { EpochExtraTool, EpochToolResult, EpochToolScope } from "./standing-tool-dispatcher.js";
import type { StandingSelfProfileImage } from "./standing-self-profile.js";
import { STANDING_AVATAR_MAX_BYTES } from "./standing-avatar-policy.js";

export type StandingArtifactRuntimePorts = Readonly<{
  fetch?: StandingArtifactFetchPorts;
  openOutbox?: typeof openEncryptedArtifactOutbox;
}>;
export type StandingArtifactRuntimeSelection = Readonly<{
  requestRef: string; primary: PilotPrimary; openArtifactTransport: () => StandingArtifactTransportLease;
}>;
export type StandingArtifactRuntime = Readonly<{
  handlers: readonly EpochExtraTool[]; specs: typeof STANDING_ARTIFACT_TOOL_SPECS;
  begin(selection: StandingArtifactRuntimeSelection): void;
  /** Host-only copy; valid solely during the matching admitted request. Caller zeros it. */
  copyProfileImage(requestRef: string, artifactRef: string): StandingSelfProfileImage;
  /** Host-only import from a verified encrypted image receipt. No send or profile mutation. */
  importGeneratedImage(requestRef: string, artifact: GeneratedImageArtifact, bytes: Buffer): StandingArtifact;
  /** Host-only image downloaded from the selected message or its exact reply target. */
  importInputImage(requestRef: string, messageId: number, mimeType: "image/png" | "image/jpeg", bytes: Buffer): StandingArtifact;
  /** Host-only one-shot take of the matching active request's pending generated-image use. */
  takeGeneratedImageUse(requestRef: string): StandingGeneratedImageUseTarget | undefined;
  finish(): Promise<void>; close(): Promise<void>;
  state(): Readonly<{ active: boolean; blocked: boolean; closed: boolean; operationSlots: number }>;
}>;
const fail = (): never => { throw new Error("STANDING_ARTIFACT_RUNTIME_REFUSED"); };
const unavailable = (): EpochToolResult => Object.freeze({ success: false,
  contentItems: Object.freeze([Object.freeze({ type: "inputText" as const,
    text: '{"schema":"neurobro-artifact-tool-error-v1","code":"unavailable"}' })]) as EpochToolResult["contentItems"] });
type Turn = {
  requestRef: string; control: AbortController; registry: StandingArtifactRegistry;
  fetcher: ReturnType<typeof createStandingArtifactFetcher>; tools: ReturnType<typeof createStandingArtifactTools>;
  slots: number; blocked: boolean; generatedImageUsePlanned: boolean;
  generatedImageUse: Readonly<{ target: StandingGeneratedImageUseTarget; signal: AbortSignal }> | undefined;
  closing?: Promise<void>;
};

/** One connection's stable named handlers with request-scoped ephemeral bytes.
 * Caller owns private directory ACL, sole client and conversation selection.
 * Unknown delivery blocks this runtime until close/reconciliation, never creates
 * another slot as a retry. Model may still finish its textual explanation.
 * finish/close revoke immediately, then join actual I/O before clearing bytes. */
export function createStandingArtifactRuntime(input: Readonly<{
  signal: AbortSignal; stateDirectory: string; passphrase: string; binding: PilotBinding;
  killed(): boolean; ports?: StandingArtifactRuntimePorts;
}>): StandingArtifactRuntime {
  if (!isAbsolute(input.stateDirectory) || resolve(input.stateDirectory) !== input.stateDirectory ||
      typeof input.passphrase !== "string" || input.passphrase.length < 16 || input.passphrase.length > 4096) return fail();
  const directory = join(input.stateDirectory, "artifact-outbox"), binding = Object.freeze({ accountId: input.binding.accountId, peerId: input.binding.peerId });
  // Reuse durable approval validation; no authority derives from requestRef.
  artifactDeliveryKey({ accountId: binding.accountId, chatId: binding.peerId, replyToMessageId: 1, operationSlot: 0, requestRef: "runtime-validation" });
  const hostSignal = input.signal, killed = input.killed.bind(input), fetchPorts = input.ports?.fetch;
  const openOutbox = input.ports?.openOutbox ?? openEncryptedArtifactOutbox;
  let passphrase = input.passphrase, current: Turn | undefined, closed = false, blocked = false, closing: Promise<void> | undefined;
  const stopped = () => { try { return closed || hostSignal.aborted || killed() !== false; } catch { return true; } };
  const poison = (turn: Turn) => { blocked = true; turn.blocked = true; };
  function joinTurn(turn: Turn): Promise<void> {
    if (turn.closing) return turn.closing;
    turn.generatedImageUse = undefined;
    turn.control.abort();
    turn.closing = (async () => {
      try { await turn.tools.close(); } catch { poison(turn); }
      try { await turn.fetcher.close(); } catch { poison(turn); }
      finally { turn.registry.close(); if (current === turn) current = undefined; }
    })();
    return turn.closing;
  }
  const abort = () => { if (current) void joinTurn(current); };
  hostSignal.addEventListener("abort", abort, { once: true });
  const handlers = Object.freeze(STANDING_ARTIFACT_TOOL_SPECS.map(spec => Object.freeze<EpochExtraTool>({ name: spec.name,
    async call(args: unknown, scope: EpochToolScope) {
      const turn = current;
      if (!turn || turn.closing || turn.blocked || blocked || stopped() || scope.requestRef !== turn.requestRef) return unavailable();
      const handler = turn.tools.handlers.find(value => value.name === spec.name)!;
      return handler.call(args, scope);
    },
  })));
  return Object.freeze({ handlers, specs: STANDING_ARTIFACT_TOOL_SPECS,
    takeGeneratedImageUse(requestRef: string): StandingGeneratedImageUseTarget | undefined {
      const turn = current;
      if (!turn || turn.requestRef !== requestRef || turn.closing || turn.blocked || blocked || stopped() || turn.control.signal.aborted) return undefined;
      const pending = turn.generatedImageUse;
      if (!pending || pending.signal.aborted) { turn.generatedImageUse = undefined; return undefined; }
      turn.generatedImageUse = undefined;
      return pending.target;
    },
    importGeneratedImage(requestRef: string, artifact: GeneratedImageArtifact, bytes: Buffer): StandingArtifact {
      const turn = current;
      if (!turn || turn.requestRef !== requestRef || turn.closing || turn.blocked || blocked || stopped() ||
          artifact.mimeType !== "image/png" || !/^img_[a-f0-9]{48}$/.test(artifact.ref) ||
          !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 8 * 1024 * 1024 ||
          artifact.byteLength !== bytes.length || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) return fail();
      return turn.registry.accept({ source: { kind: "generated", reference: artifact.ref },
        filename: "neurobro-generated.png", mimeType: "image/png", bytes });
    },
    importInputImage(requestRef: string, messageId: number, mimeType: "image/png" | "image/jpeg", bytes: Buffer): StandingArtifact {
      const turn = current;
      if (!turn || turn.requestRef !== requestRef || turn.closing || turn.blocked || blocked || stopped() ||
          !Number.isSafeInteger(messageId) || messageId <= 0 || !["image/png", "image/jpeg"].includes(mimeType) ||
          !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 8 * 1024 * 1024) return fail();
      return turn.registry.accept({ source: { kind: "attachment", reference: `telegram_image_${messageId}` },
        filename: mimeType === "image/png" ? "telegram-image.png" : "telegram-image.jpg", mimeType, bytes });
    },
    copyProfileImage(requestRef: string, artifactRef: string): StandingSelfProfileImage {
      const turn = current;
      if (!turn || turn.requestRef !== requestRef || turn.closing || turn.blocked || blocked || stopped()) return fail();
      const artifact = turn.registry.get(artifactRef);
      if (artifact.requestRef !== requestRef || artifact.byteLength > STANDING_AVATAR_MAX_BYTES ||
          !["image/png", "image/jpeg"].includes(artifact.mimeType)) return fail();
      return Object.freeze({ bytes: turn.registry.copyBytes(artifactRef),
        mediaType: artifact.mimeType as "image/png" | "image/jpeg", sha256: artifact.sha256 });
    },
    begin(selection: StandingArtifactRuntimeSelection) {
      if (current || closing || stopped() || blocked || typeof selection.openArtifactTransport !== "function" || selection.primary.chatId !== binding.peerId) return fail();
      const requestRef = selection.requestRef, messageId = selection.primary.messageId;
      artifactDeliveryKey({ accountId: binding.accountId, chatId: binding.peerId, replyToMessageId: messageId, operationSlot: 0, requestRef });
      const openTransport = selection.openArtifactTransport.bind(selection);
      const control = new AbortController(), signal = AbortSignal.any([hostSignal, control.signal]);
      const registry = createStandingArtifactRegistry({ requestRef });
      const fetcher = createStandingArtifactFetcher(registry, fetchPorts);
      let turn: Turn;
      const tools = createStandingArtifactTools({ signal,
        fetch: (request, callSignal) => fetcher.fetch(request, callSignal),
        createText(request, scope) {
          if (current !== turn || turn.closing || turn.blocked || blocked || stopped() || signal.aborted || scope.signal.aborted || scope.requestRef !== requestRef) return fail();
          let bytes: Buffer | undefined = Buffer.from(request.text, "utf8");
          try {
            const reference = "text_" + createHash("sha256").update(scope.callRef).update("\0").update(request.filename).update("\0").update(bytes).digest("hex").slice(0, 48);
            return registry.accept({ source: { kind: "generated", reference }, filename: request.filename, mimeType: request.mimeType, bytes });
          } finally { bytes?.fill(0); bytes = undefined; }
        },
        planGeneratedImageUse(target, scope) {
          if (current !== turn || turn.closing || turn.blocked || blocked || stopped() || signal.aborted || scope.signal.aborted ||
              scope.requestRef !== requestRef || turn.generatedImageUsePlanned) return false;
          turn.generatedImageUsePlanned = true;
          turn.generatedImageUse = Object.freeze({ target, signal: scope.signal });
          return true;
        },
        get: ref => { try { return registry.get(ref); } catch { return undefined; } },
        async send(request, scope): Promise<StandingArtifactSendOutcome> {
          if (current !== turn || turn.closing || turn.blocked || blocked || stopped() || signal.aborted || scope.signal.aborted || scope.requestRef !== requestRef || turn.slots >= 32) return { verdict: "refused" };
          const artifact = registry.get(request.artifactRef);
          if (artifact.requestRef !== requestRef) return { verdict: "refused" };
          const approved = Object.freeze({ accountId: binding.accountId, chatId: binding.peerId, replyToMessageId: messageId, requestRef, operationSlot: turn.slots++ });
          let lease: StandingArtifactTransportLease | undefined, store: Awaited<ReturnType<typeof openEncryptedArtifactOutbox>> | undefined;
          let outcome: StandingArtifactSendOutcome = { verdict: "unknown" };
          try {
            lease = openTransport();
            store = await openOutbox({ directory, passphrase, approved });
            const result = await runArtifactDelivery({ approved, registry, artifactRef: request.artifactRef, caption: request.caption,
              mediaKind: request.mediaKind, store, transport: lease.transport, signal: scope.signal,
              killSwitchEngaged: () => stopped() || current !== turn || turn.blocked });
            if (result.delivery === "unknown" || result.failure?.reason === "consumed") poison(turn);
            await result.settlement;
            outcome = { verdict: result.delivery, ...(result.delivery === "verified" && result.acknowledgement ? { messageId: result.acknowledgement.messageId } : {}) };
          } catch { poison(turn); outcome = { verdict: "unknown" }; }
          finally {
            try { await lease?.close(); } catch { poison(turn); outcome = { verdict: "unknown" }; }
            try { store?.close(); } catch { poison(turn); outcome = { verdict: "unknown" }; }
          }
          return Object.freeze(outcome);
        },
      });
      turn = { requestRef, control, registry, fetcher, tools, slots: 0, blocked: false,
        generatedImageUsePlanned: false, generatedImageUse: undefined }; current = turn;
      if (hostSignal.aborted) void joinTurn(turn);
    },
    async finish() { if (current) await joinTurn(current); },
    close() {
      if (closing) return closing;
      closed = true; hostSignal.removeEventListener("abort", abort);
      closing = (async () => { try { if (current) await joinTurn(current); } finally { passphrase = ""; } })();
      return closing;
    },
    state() { return Object.freeze({ active: current !== undefined, blocked, closed, operationSlots: current?.slots ?? 0 }); },
  });
}
