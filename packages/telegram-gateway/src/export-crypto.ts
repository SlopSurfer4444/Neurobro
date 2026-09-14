import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const AAD_PREFIX = "openclaw-guarded-local-telegram-export:v1";

export interface EncryptedExportEnvelope {
  schemaVersion: 1;
  kind: "telegram-local-range-export";
  algorithm: "aes-256-gcm";
  kdf: "scrypt";
  contentType: "application/x-ndjson; charset=utf-8";
  createdAt: string;
  expiresAt: string;
  messageCount: number;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface ExportEncryptionMetadata {
  createdAt: string;
  expiresAt: string;
  messageCount: number;
}

function validatePassphrase(passphrase: string): void {
  if (passphrase.length < 16) {
    throw new Error("Export passphrase must be at least 16 characters long.");
  }
}

function aad(metadata: ExportEncryptionMetadata): Buffer {
  return Buffer.from(
    `${AAD_PREFIX}\n${metadata.createdAt}\n${metadata.expiresAt}\n${metadata.messageCount}`,
    "utf8",
  );
}

function parseEnvelope(serialized: string): EncryptedExportEnvelope {
  const raw = JSON.parse(serialized) as Partial<EncryptedExportEnvelope>;
  if (
    raw.schemaVersion !== 1 ||
    raw.kind !== "telegram-local-range-export" ||
    raw.algorithm !== "aes-256-gcm" ||
    raw.kdf !== "scrypt" ||
    raw.contentType !== "application/x-ndjson; charset=utf-8" ||
    !raw.createdAt ||
    !raw.expiresAt ||
    !Number.isSafeInteger(raw.messageCount) ||
    (raw.messageCount ?? -1) < 0 ||
    !raw.salt ||
    !raw.iv ||
    !raw.authTag ||
    !raw.ciphertext
  ) {
    throw new Error("Unsupported or malformed encrypted export file.");
  }
  if (!Number.isFinite(Date.parse(raw.createdAt)) || !Number.isFinite(Date.parse(raw.expiresAt))) {
    throw new Error("Encrypted export contains invalid retention timestamps.");
  }
  return raw as EncryptedExportEnvelope;
}

export async function encryptExport(
  plaintextJsonl: string,
  passphrase: string,
  metadata: ExportEncryptionMetadata,
): Promise<string> {
  if (!plaintextJsonl) throw new Error("Refusing to encrypt an empty export.");
  validatePassphrase(passphrase);
  if (Date.parse(metadata.expiresAt) <= Date.parse(metadata.createdAt)) {
    throw new Error("Export expiration must be later than creation time.");
  }
  if (!Number.isSafeInteger(metadata.messageCount) || metadata.messageCount < 0) {
    throw new Error("Export message count must be a non-negative safe integer.");
  }

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = (await scrypt(passphrase, salt, 32)) as Buffer;
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(metadata));
    const ciphertext = Buffer.concat([cipher.update(plaintextJsonl, "utf8"), cipher.final()]);
    const envelope: EncryptedExportEnvelope = {
      schemaVersion: 1,
      kind: "telegram-local-range-export",
      algorithm: "aes-256-gcm",
      kdf: "scrypt",
      contentType: "application/x-ndjson; charset=utf-8",
      createdAt: metadata.createdAt,
      expiresAt: metadata.expiresAt,
      messageCount: metadata.messageCount,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    return `${JSON.stringify(envelope, null, 2)}\n`;
  } finally {
    key.fill(0);
  }
}

export async function decryptExport(serialized: string, passphrase: string): Promise<string> {
  validatePassphrase(passphrase);
  const envelope = parseEnvelope(serialized);
  if (Date.parse(envelope.expiresAt) <= Date.now()) {
    throw new Error(`Encrypted export expired at ${envelope.expiresAt}; run purge-expired.`);
  }
  const metadata: ExportEncryptionMetadata = {
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
    messageCount: envelope.messageCount,
  };
  const key = (await scrypt(passphrase, Buffer.from(envelope.salt, "base64"), 32)) as Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(aad(metadata));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Export decryption failed: wrong passphrase or damaged file.");
  } finally {
    key.fill(0);
  }
}

export function readExportExpiration(serialized: string): Date {
  return new Date(parseEnvelope(serialized).expiresAt);
}
