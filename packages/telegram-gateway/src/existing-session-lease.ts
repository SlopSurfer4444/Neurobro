import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { decryptSession } from "./session-crypto.js";

const MAX_ENCRYPTED_SESSION_BYTES = 65_536;
const MAX_DECRYPTED_SESSION_CHARACTERS = 4_096;

export type ExistingStringSessionMaterial = {
  version: "rm0017-existing-string-session-v1";
  kind: "existing-string-session";
  value: string;
};

export type GatewayExistingEncryptedSessionLease = Readonly<{
  kind: "existing-encrypted-session";
  material: ExistingStringSessionMaterial;
  release(): Promise<void>;
}>;

export async function openExistingEncryptedSessionLease(input: Readonly<{
  reference: string;
  passphrase: string;
}>): Promise<GatewayExistingEncryptedSessionLease> {
  if (typeof input.reference !== "string" || input.reference.length === 0 || input.reference.length > 2_048 ||
      !isAbsolute(input.reference)) {
    throw new Error("session-reference-refused");
  }
  const pathMetadata = await lstat(input.reference);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || pathMetadata.size <= 0 || pathMetadata.size > MAX_ENCRYPTED_SESSION_BYTES) {
    throw new Error("session-reference-refused");
  }
  const handle = await open(input.reference, "r");
  let encrypted: string;
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile() || openedMetadata.size !== pathMetadata.size || openedMetadata.dev !== pathMetadata.dev ||
        openedMetadata.ino !== pathMetadata.ino) {
      throw new Error("session-reference-refused");
    }
    const encryptedBytes = await handle.readFile();
    if (encryptedBytes.length <= 0 || encryptedBytes.length > MAX_ENCRYPTED_SESSION_BYTES ||
        encryptedBytes.length !== openedMetadata.size) {
      throw new Error("session-reference-refused");
    }
    encrypted = encryptedBytes.toString("utf8");
    if (!Buffer.from(encrypted, "utf8").equals(encryptedBytes)) throw new Error("session-reference-refused");
  } finally {
    await handle.close();
  }
  const value = await decryptSession(encrypted, input.passphrase);
  if (value.length === 0 || value.length > MAX_DECRYPTED_SESSION_CHARACTERS) throw new Error("session-material-refused");
  const material: ExistingStringSessionMaterial = {
    version: "rm0017-existing-string-session-v1",
    kind: "existing-string-session",
    value,
  };
  let released = false;
  return Object.freeze({
    kind: "existing-encrypted-session",
    material,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      material.value = "";
    },
  });
}
