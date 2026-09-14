import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const AAD = Buffer.from("openclaw-guarded-mtproto-session:v1", "utf8");

interface EncryptedSessionEnvelope {
  schemaVersion: 1;
  algorithm: "aes-256-gcm";
  kdf: "scrypt";
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

function validatePassphrase(passphrase: string): void {
  if (passphrase.length < 16) {
    throw new Error("Session passphrase must be at least 16 characters long.");
  }
}

export async function encryptSession(sessionString: string, passphrase: string): Promise<string> {
  if (!sessionString) throw new Error("Refusing to encrypt an empty session.");
  validatePassphrase(passphrase);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = (await scrypt(passphrase, salt, 32)) as Buffer;
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(sessionString, "utf8"), cipher.final()]);
  const envelope: EncryptedSessionEnvelope = {
    schemaVersion: 1,
    algorithm: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  key.fill(0);
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export async function decryptSession(serialized: string, passphrase: string): Promise<string> {
  validatePassphrase(passphrase);
  const raw = JSON.parse(serialized) as Partial<EncryptedSessionEnvelope>;
  if (
    raw.schemaVersion !== 1 ||
    raw.algorithm !== "aes-256-gcm" ||
    raw.kdf !== "scrypt" ||
    !raw.salt ||
    !raw.iv ||
    !raw.authTag ||
    !raw.ciphertext
  ) {
    throw new Error("Unsupported or malformed encrypted session file.");
  }

  const salt = Buffer.from(raw.salt, "base64");
  const iv = Buffer.from(raw.iv, "base64");
  const key = (await scrypt(passphrase, salt, 32)) as Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(raw.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(raw.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Session decryption failed: wrong passphrase or damaged file.");
  } finally {
    key.fill(0);
  }
}
