import { createHmac } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";
import {
  type StandingHistoryPeriodChronicleStore, type StandingHistoryPeriodChronicleRequest, type StandingHistoryPeriodChronicleNote,
  type StandingHistoryPeriodChronicleGeneration, standingHistoryPeriodChronicleBinding,
  periodChronicleFields as fields, periodChronicleSnapshot as snapshot, periodChronicleFail as fail,
  periodChronicleDigest as digest, periodChronicleCanonical as canonical, periodChronicleEqual as equal,
  portableStandingHistoryPeriodChronicleOutput, reboundStandingHistoryPeriodChronicleOutput, admitStandingHistoryPeriodChronicleNote,
} from "./standing-history-period-chronicle.js";

const DOMAIN = "DecadansNeurobro/standing-history-period-chronicle/v1";
const MAX_PLAIN = 65536, MAX_CIPHER = 131072, MAX_ENTRIES = 1024;
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
function generationCopy(value: unknown): StandingHistoryPeriodChronicleGeneration {
  const g = fields(value, ["purpose", "inputHash", "requestRef", "epochId", "modelOutcome"], ["resourcesSettled", "workRelease"]);
  if (g.purpose !== "neutral-period-notes" || !digest(g.inputHash) || typeof g.requestRef !== "string" || !/^[^\s\x00-\x1f\x7f]{1,256}$/u.test(g.requestRef) ||
      typeof g.epochId !== "string" || !/^[0-9a-f]{32}$/u.test(g.epochId) || g.modelOutcome !== "observed" || Object.hasOwn(g, "resourcesSettled") === Object.hasOwn(g, "workRelease")) return fail();
  if (Object.hasOwn(g, "resourcesSettled")) { if (g.resourcesSettled !== true) return fail(); }
  else {
    const r = fields(g.workRelease, ["schema", "nativeBinding", "workRef", "releaseAcknowledged", "callbacksJoined"]), b = fields(r.nativeBinding, ["epochId", "requestRef", "purpose"]);
    if (r.schema !== "standing-analysis-work-release-v1" || b.epochId !== g.epochId || b.requestRef !== g.requestRef || b.purpose !== "history-analysis" ||
        typeof r.workRef !== "string" || !/^hwork_[0-9a-f]{48}$/u.test(r.workRef) || r.releaseAcknowledged !== true || r.callbacksJoined !== true) return fail();
  }
  return snapshot(g) as StandingHistoryPeriodChronicleGeneration;
}

/** Optional, encrypted, task-independent neutral period notes. The host owns
 * neutral generation authorization and actual worker settlement; this store
 * never dispatches model work. Reads require a newly prepared source selection,
 * so notes cannot serve unseen, changed or deleted rows. Namespace/content keys
 * bind account, internal peer, requester, source workspace/peer, calendar period,
 * timezone and producer. A new query or task-local alias alone does not miss.
 * At most 1024 immutable notes; no eviction, overwriting or automatic archive
 * pass. Missing, corrupt or inaccessible derived data is an optional miss.
 */
export async function openStandingHistoryPeriodChronicleStore(input: Readonly<{ directory: string; passphrase: string }>): Promise<StandingHistoryPeriodChronicleStore> {
  const a = fields(input, ["directory", "passphrase"]);
  if (typeof a.directory !== "string" || !isAbsolute(a.directory) || resolve(a.directory) !== a.directory || dirname(a.directory) === a.directory ||
      typeof a.passphrase !== "string" || a.passphrase.length < 16 || Buffer.byteLength(a.passphrase) > 4096 || a.passphrase.includes("\0")) return fail();
  const directory: string = a.directory, parent = dirname(directory); let passphrase: string = a.passphrase;
  const key = createHmac("sha256", passphrase).update(DOMAIN + "/index").digest();
  let root: BigIntStats | undefined, closed = false, active: Promise<unknown> | undefined;
  const statDirectory = async (path: string) => { await assertPilotPrivateDirectory(path); const s = await lstat(path, { bigint: true }); if (!s.isDirectory() || s.isSymbolicLink()) return fail(); return s; };
  const parentIdentity = await statDirectory(parent);
  try { root = await statDirectory(directory); } catch (e) { if (!missing(e)) { key.fill(0); passphrase = ""; throw e; } }
  const guard = async () => {
    if (!same(parentIdentity, await statDirectory(parent))) return fail();
    if (root) { if (!same(root, await statDirectory(directory))) return fail(); }
    else { try { await lstat(directory); return fail(); } catch (e) { if (!missing(e)) throw e; } }
  };
  const entryRef = (request: StandingHistoryPeriodChronicleRequest) => {
    const p = standingHistoryPeriodChronicleBinding(request);
    return createHmac("sha256", key).update(canonical([DOMAIN, p.scope, p.contentHash])).digest("hex");
  };
  const read = async (name: string): Promise<unknown> => {
    await guard(); const path = join(directory, name), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CIPHER)) return fail();
    const handle = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) return fail();
      bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { const got = await handle.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
      if (count !== Number(before.size) || stamp(await handle.stat({ bigint: true })) !== stamp(before) || stamp(await lstat(path, { bigint: true })) !== stamp(before)) return fail();
      const plain = await decryptSession(bytes.subarray(0, count).toString("utf8"), passphrase); if (Buffer.byteLength(plain) > MAX_PLAIN) return fail();
      const value = snapshot(JSON.parse(plain)); await guard();
      // Decryption is asynchronous; check the same file after that await too.
      if (stamp(await lstat(path, { bigint: true })) !== stamp(before)) return fail(); return value;
    } finally { bytes?.fill(0); await handle.close(); }
  };
  const decode = (value: unknown, request: StandingHistoryPeriodChronicleRequest, name: string): StandingHistoryPeriodChronicleNote => {
    const p = standingHistoryPeriodChronicleBinding(request), e = fields(value, ["domain", "scope", "contentHash", "producerHash", "period", "coverage", "provenance", "output"]);
    if (e.domain !== DOMAIN || !equal(e.scope, p.scope) || e.contentHash !== p.contentHash || e.producerHash !== p.producerHash || !equal(e.period, request.period) || !equal(e.coverage, request.coverage)) return fail();
    const provenance = fields(e.provenance, ["kind", "claimsStatus", "cacheRef", "contentHash", "producerHash", "originTaskRef", "generation", "capturedAt"]), generation = generationCopy(provenance.generation);
    if (provenance.kind !== "neutral-period-analysis" || provenance.claimsStatus !== "model-authored-unverified" || provenance.cacheRef !== "hpnote_" + name || provenance.contentHash !== p.contentHash ||
        provenance.producerHash !== p.producerHash || typeof provenance.originTaskRef !== "string" || !/^htask_[0-9a-f]{48}$/u.test(provenance.originTaskRef) ||
        !Number.isSafeInteger(provenance.capturedAt) || provenance.capturedAt < 0) return fail();
    return admitStandingHistoryPeriodChronicleNote({ schema: "standing-history-period-chronicle-note-v1", purpose: "neutral-period-notes", period: request.period,
      coverage: request.coverage, output: reboundStandingHistoryPeriodChronicleOutput(e.output, request),
      provenance: { ...provenance, generation } as StandingHistoryPeriodChronicleNote["provenance"] }, request);
  };
  const run = <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    if (closed || active) return Promise.resolve(fallback);
    const operation = Promise.resolve().then(work).catch(() => fallback); active = operation;
    return operation.finally(() => { if (active === operation) active = undefined; });
  };
  return Object.freeze<StandingHistoryPeriodChronicleStore>({
    lookup(request) {
      standingHistoryPeriodChronicleBinding(request);
      return run(async () => { if (!root) return undefined; const name = entryRef(request); return decode(await read(name + ".enc"), request, name); }, undefined);
    },
    remember(value) {
      const v = fields(value, ["request", "output", "generation", "capturedAt"]), request = v.request as StandingHistoryPeriodChronicleRequest, p = standingHistoryPeriodChronicleBinding(request);
      const generation = generationCopy(v.generation);
      if (generation.inputHash !== request.inputHash || !Number.isSafeInteger(v.capturedAt) || v.capturedAt < 0) return fail();
      const output = portableStandingHistoryPeriodChronicleOutput(v.output, request);
      return run(async () => {
        await guard(); const name = entryRef(request), filename = name + ".enc";
        const provenance: StandingHistoryPeriodChronicleNote["provenance"] = { kind: "neutral-period-analysis", claimsStatus: "model-authored-unverified", cacheRef: "hpnote_" + name,
          contentHash: p.contentHash, producerHash: p.producerHash, originTaskRef: p.intent.taskId, generation, capturedAt: v.capturedAt };
        const envelope = { domain: DOMAIN, scope: p.scope, contentHash: p.contentHash, producerHash: p.producerHash, period: request.period, coverage: request.coverage, provenance, output };
        const plain = JSON.stringify(envelope); if (Buffer.byteLength(plain) > MAX_PLAIN) return undefined;
        // Optional capture must fit its own budget and reader before creating state.
        decode(snapshot(JSON.parse(plain)), request, name);
        const cipher = await encryptSession(plain, passphrase); if (Buffer.byteLength(cipher) > MAX_CIPHER) return undefined;
        if (!root) { await mkdir(directory, { mode: 0o700 }); root = await statDirectory(directory); }
        await guard();
        try { return decode(await read(filename), request, name); } catch (e) { if (!missing(e)) return undefined; }
        const listing = await opendir(directory, { bufferSize: 1 }); let count = 0;
        try { for (;;) { const entry = await listing.read(); if (!entry) break; if (++count >= MAX_ENTRIES || !entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.enc$/u.test(entry.name)) return undefined; } } finally { await listing.close(); }
        await guard(); const handle = await open(join(directory, filename), "wx", 0o600);
        try { await handle.writeFile(cipher); await handle.sync(); } finally { await handle.close(); }
        return decode(await read(filename), request, name);
      }, undefined);
    },
    async close() { closed = true; try { await active; } finally { key.fill(0); passphrase = ""; } },
  });
}
