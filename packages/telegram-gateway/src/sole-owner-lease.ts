import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-file.js";
import { ProcessLockAdmissionDeniedError, acquireProcessLock } from "./process-lock.js";

export const GATEWAY_STICKY_OWNER_REQUEST = Object.freeze({
  version: "gateway-sticky-owner-request-v1",
  reason: "child-exit-unconfirmed",
  releaseCondition: "separately-authorized-os-absence-proof",
} as const);

export const GATEWAY_STICKY_OWNER_CONFIRMED = Object.freeze({
  version: "gateway-sticky-owner-confirmation-v1",
  state: "admission-blocking-until-os-absence-proof",
} as const);

const STICKY_BYTES = `${JSON.stringify(GATEWAY_STICKY_OWNER_CONFIRMED)}\n`;

export type CompatibleSoleOwnerLease = Readonly<{
  exclusive: true;
  compatibleSoleOwner: true;
  capability: "admitted-sole-owner-gateway";
}>;

export interface CompatibleSoleOwnerSurface {
  acquireExclusive(): Promise<CompatibleSoleOwnerLease | null>;
  release(lease: CompatibleSoleOwnerLease): Promise<void>;
  retainStickyUntilOsAbsenceProof(
    lease: CompatibleSoleOwnerLease,
    request: typeof GATEWAY_STICKY_OWNER_REQUEST,
  ): Promise<typeof GATEWAY_STICKY_OWNER_CONFIRMED>;
}

async function stickyPresent(path: string): Promise<boolean> {
  try {
    return await readFile(path, "utf8") === STICKY_BYTES;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function createCompatibleSoleOwnerSurface(lockPath: string): CompatibleSoleOwnerSurface {
  const stickyPath = `${lockPath}.sticky`;
  const releases = new WeakMap<object, () => Promise<void>>();
  const retained = new WeakSet<object>();

  return Object.freeze({
    async acquireExclusive(): Promise<CompatibleSoleOwnerLease | null> {
      if (await stickyPresent(stickyPath)) return null;
      let releaseLock: (() => Promise<void>) | null = null;
      try {
        releaseLock = await acquireProcessLock(lockPath);
      } catch (error) {
        if (error instanceof ProcessLockAdmissionDeniedError) return null;
        throw error;
      }
      if (await stickyPresent(stickyPath)) {
        await releaseLock();
        return null;
      }
      const lease: CompatibleSoleOwnerLease = Object.freeze({
        exclusive: true,
        compatibleSoleOwner: true,
        capability: "admitted-sole-owner-gateway",
      });
      releases.set(lease, releaseLock);
      return lease;
    },

    async release(lease: CompatibleSoleOwnerLease): Promise<void> {
      const releaseLock = releases.get(lease);
      if (releaseLock === undefined || retained.has(lease)) return;
      releases.delete(lease);
      await releaseLock();
    },

    async retainStickyUntilOsAbsenceProof(
      lease: CompatibleSoleOwnerLease,
      request: typeof GATEWAY_STICKY_OWNER_REQUEST,
    ): Promise<typeof GATEWAY_STICKY_OWNER_CONFIRMED> {
      if (request !== GATEWAY_STICKY_OWNER_REQUEST || !releases.has(lease)) throw new Error("owner-lease-refused");
      await writeFileAtomic(stickyPath, STICKY_BYTES);
      if (!await stickyPresent(stickyPath)) throw new Error("sticky-owner-readback-failed");
      retained.add(lease);
      return GATEWAY_STICKY_OWNER_CONFIRMED;
    },
  });
}
