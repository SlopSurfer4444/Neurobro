import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, lstat, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { absolute, assertFreshStatePath, hashFile, noLinks, OpsError, walkFiles, within } from './paths.ts';
import { PROFILE_MARKER, readProfile, requireStopped, type SettlementProof, type IsolatedProfile } from './profile.ts';

interface BackupEntry { path: string; blob: string; bytes: number; sha256: string; encryptedSha256: string; iv: string; tag: string }
export interface BackupManifest {
  schemaVersion: 1; profileId: string; createdAt: string; encryption: 'aes-256-gcm';
  sourceStateDirectory: string; settlement: SettlementProof; entries: BackupEntry[];
}
function backupKey(key: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new OpsError('backup_key_must_be_32_bytes'); return Buffer.from(key);
}
function safeRelative(path: string): boolean {
  return !!path && !path.includes('\\') && !path.includes('\0') && !path.startsWith('/') && !path.includes(':') && path.split('/').every(p => !!p && p !== '.' && p !== '..');
}
async function freshDestination(path: string): Promise<string> {
  const root = absolute(path); await noLinks(root);
  if (dirname(root) === root) throw new OpsError('filesystem_root_forbidden');
  try { await lstat(root); throw new OpsError('destination_already_exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return root;
}
/** Caller supplies settlement from bound process handles. A STOP file alone is not process proof. */
export async function backupStoppedProfile(stateDirectory: string, destination: string, options: {
  key: Uint8Array; settlement: SettlementProof; maxBytes?: number; maxFiles?: number;
}): Promise<{ files: number; bytes: number; manifestPath: string }> {
  const profile = await readProfile(stateDirectory); await requireStopped(profile, options.settlement);
  const key = backupKey(options.key);
  const target = await freshDestination(assertFreshStatePath(destination));
  if (within(profile.stateDirectory, target) || within(target, profile.stateDirectory)) throw new OpsError('backup_destination_overlaps_state');
  // Host start uses the same lease name and refuses admission while backup owns it.
  const lease = join(profile.stateDirectory, '.ops.lock');
  await writeFile(lease, 'backup\n', { flag: 'wx', mode: 0o600 });
  const stage = `${target}.partial-${randomBytes(8).toString('hex')}`;
  try {
    const files = (await walkFiles(profile.stateDirectory, options.maxFiles ?? 100_000)).filter(p => p !== lease);
    const manifest: BackupManifest = { schemaVersion: 1, profileId: profile.profileId, sourceStateDirectory: profile.stateDirectory,
      createdAt: new Date().toISOString(), encryption: 'aes-256-gcm', settlement: options.settlement, entries: [] };
    const maxBytes = options.maxBytes ?? 8 * 1024 ** 3;
    let total = 0;
    await mkdir(join(stage, 'blobs'), { recursive: true, mode: 0o700 });
    for (const file of files) {
      const bytes = (await lstat(file)).size; total += bytes;
      if (total > maxBytes) throw new OpsError('backup_byte_limit');
      const path = relative(profile.stateDirectory, file).split(sep).join('/');
      if (!safeRelative(path)) throw new OpsError('backup_path_invalid');
      const sha256 = await hashFile(file);
      const iv = randomBytes(12), blob = `blobs/${manifest.entries.length}.gcm`;
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      // Binding path/size/content to AEAD prevents swapping encrypted file entries.
      cipher.setAAD(Buffer.from(`${path}\n${bytes}\n${sha256}`));
      await pipeline(createReadStream(file), cipher, createWriteStream(join(stage, blob), { flags: 'wx', mode: 0o600 }));
      if (await hashFile(file) !== sha256 || (await lstat(file)).size !== bytes) throw new OpsError('source_changed_during_backup');
      manifest.entries.push({ path, blob, bytes, sha256, encryptedSha256: await hashFile(join(stage, blob)), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') });
    }
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    // Encrypt manifest too: filenames/account state location are operational data.
    const manifestIv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, manifestIv);
    cipher.setAAD(Buffer.from('neurobro-backup-manifest-v1'));
    await pipeline(createReadStream(join(stage, 'manifest.json')), cipher, createWriteStream(join(stage, 'manifest.gcm'), { flags: 'wx', mode: 0o600 }));
    await unlink(join(stage, 'manifest.json'));
    await writeFile(join(stage, 'envelope.json'), JSON.stringify({ schemaVersion: 1, algorithm: 'aes-256-gcm', iv: manifestIv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), sha256: await hashFile(join(stage, 'manifest.gcm')) }), { flag: 'wx', mode: 0o600 });
    await rename(stage, target);
    return { files: files.length, bytes: total, manifestPath: join(target, 'envelope.json') };
  } finally { key.fill(0); await unlink(lease); }
  // An unsuccessful .partial-* is deliberately retained for inspection; no recursive delete.
}
async function readManifest(root: string, key: Buffer): Promise<BackupManifest> {
  let envelope: { schemaVersion: number; algorithm: string; iv: string; tag: string; sha256: string };
  try { envelope = JSON.parse(await readFile(join(root, 'envelope.json'), 'utf8')); }
  catch { throw new OpsError('backup_envelope_invalid'); }
  if (envelope.schemaVersion !== 1 || envelope.algorithm !== 'aes-256-gcm' || !/^[a-f0-9]{24}$/.test(envelope.iv) || !/^[a-f0-9]{32}$/.test(envelope.tag) || !/^[a-f0-9]{64}$/.test(envelope.sha256)) throw new OpsError('backup_envelope_invalid');
  if ((await lstat(join(root, 'manifest.gcm'))).size > 16 * 1024 ** 2) throw new OpsError('backup_manifest_limit');
  if (await hashFile(join(root, 'manifest.gcm')) !== envelope.sha256) throw new OpsError('backup_hash_mismatch');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
    decipher.setAAD(Buffer.from('neurobro-backup-manifest-v1')); decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    const clear = Buffer.concat([decipher.update(await readFile(join(root, 'manifest.gcm'))), decipher.final()]);
    const manifest = JSON.parse(clear.toString('utf8')) as BackupManifest; clear.fill(0);
    if (manifest.schemaVersion !== 1 || manifest.encryption !== 'aes-256-gcm' || !Array.isArray(manifest.entries) || manifest.entries.length > 100_000) throw new OpsError('backup_manifest_invalid');
    return manifest;
  } catch { throw new OpsError('backup_authentication_failed'); }
}
/** Restore is additive, leaves STOP, and requires effect reconciliation before admission. */
export async function restoreStoppedProfile(backupDirectory: string, destination: string, options: {
  key: Uint8Array; maxBytes?: number;
}): Promise<{ files: number; stateDirectory: string; reconciliationRequired: true }> {
  const source = absolute(backupDirectory); await noLinks(source);
  const target = await freshDestination(assertFreshStatePath(destination));
  if (within(source, target) || within(target, source)) throw new OpsError('restore_destination_overlaps_backup');
  const key = backupKey(options.key), stage = `${target}.partial-${randomBytes(8).toString('hex')}`;
  try {
    const manifest = await readManifest(source, key);
    const paths = new Set<string>(); let total = 0;
    for (const entry of manifest.entries) {
      const folded = entry.path?.toLowerCase();
      if (typeof entry.path !== 'string' || !safeRelative(entry.path) || paths.has(folded) || !/^blobs\/[0-9]+\.gcm$/.test(entry.blob) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^[a-f0-9]{64}$/.test(entry.encryptedSha256) || !/^[a-f0-9]{24}$/.test(entry.iv) || !/^[a-f0-9]{32}$/.test(entry.tag) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new OpsError('backup_entry_invalid');
      paths.add(folded); total += entry.bytes;
      if (total > (options.maxBytes ?? 8 * 1024 ** 3)) throw new OpsError('restore_byte_limit');
      if (await hashFile(join(source, entry.blob)) !== entry.encryptedSha256) throw new OpsError('backup_hash_mismatch');
    }
    if (!paths.has(PROFILE_MARKER) || !paths.has('stop')) throw new OpsError('backup_profile_marker_missing');
    await mkdir(stage, { recursive: true, mode: 0o700 });
    for (const entry of manifest.entries) {
      const output = resolve(stage, entry.path); if (!within(stage, output)) throw new OpsError('restore_path_escape');
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'hex'));
      decipher.setAAD(Buffer.from(`${entry.path}\n${entry.bytes}\n${entry.sha256}`)); decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
      try { await pipeline(createReadStream(join(source, entry.blob)), decipher, createWriteStream(output, { flags: 'wx', mode: 0o600 })); }
      catch { throw new OpsError('backup_authentication_failed'); }
      if (await hashFile(output) !== entry.sha256 || (await lstat(output)).size !== entry.bytes) throw new OpsError('restore_hash_mismatch');
    }
    const profile = JSON.parse(await readFile(join(stage, PROFILE_MARKER), 'utf8')) as IsolatedProfile;
    if (profile.profileId !== manifest.profileId || profile.stateDirectory !== manifest.sourceStateDirectory) throw new OpsError('backup_profile_binding_invalid');
    for (const field of ['hermesHome', 'telegramDatabase', 'telegramFiles', 'workspaces', 'artifacts', 'logs', 'temp'] as const) {
      if (typeof profile[field] !== 'string' || !within(manifest.sourceStateDirectory, profile[field]) || profile[field] === manifest.sourceStateDirectory) throw new OpsError('backup_profile_path_invalid');
      profile[field] = resolve(target, relative(manifest.sourceStateDirectory, profile[field]));
    }
    profile.stateDirectory = target;
    await writeFile(join(stage, PROFILE_MARKER), JSON.stringify(profile, null, 2), { mode: 0o600 });
    for (const field of ['hermesHome', 'telegramDatabase', 'telegramFiles', 'workspaces', 'artifacts', 'logs', 'temp'] as const) await mkdir(resolve(stage, relative(target, profile[field])), { recursive: true, mode: 0o700 });
    await writeFile(join(stage, '.neurobro-reconciliation-required.json'), JSON.stringify({ schemaVersion: 1, profileId: manifest.profileId, restoredAt: new Date().toISOString(), reason: 'restore_does_not_undo_external_effects', admissionBlocked: true }), { mode: 0o600 });
    await rename(stage, target);
    return { files: manifest.entries.length, stateDirectory: target, reconciliationRequired: true };
  } finally { key.fill(0); }
}
