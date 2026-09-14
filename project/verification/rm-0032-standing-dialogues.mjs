// Explicit owner-requested operator view. No Telegram client, model or session read.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BUILD = 'C:/Neurobro/build';
const PRIVATE = 'C:/Neurobro/state';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readStandingDialogues(options, ports) {
  assert.ok(options && Object.keys(options).every(key => ['limit', 'fromDate', 'toDate'].includes(key)));
  const { limit = 10, fromDate, toDate } = options;
  assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 20);
  for (const date of [fromDate, toDate]) assert.ok(date === undefined || Number.isSafeInteger(date) && date > 0);
  assert.ok(fromDate === undefined || toDate === undefined || fromDate <= toDate);
  const prepared = await ports.prepare();
  let credentials, journal;
  try {
    credentials = { ...await ports.credentials() };
    journal = await ports.journal({ directory: prepared.directory, binding: prepared.binding, passphrase: credentials.passphrase, readOnly: true });
    const selected = await journal.read({ limit, scanLimit: 100, ...(fromDate === undefined ? {} : { fromDate }), ...(toDate === undefined ? {} : { toDate }) });
    const dialogues = selected.dialogues.map((row, index) => ({
      reference: index + 1,
      author: row.question.source?.displayName ?? null,
      messageAt: row.question.source?.date ?? null,
      recordedAt: row.recordedAt,
      question: row.question.primary.text,
      modelAdmitted: row.modelAdmission !== null,
      status: row.status,
      answer: row.outcome?.answer ?? null,
      answerKind: row.outcome?.kind ?? null,
      delivery: row.outcome?.delivery ?? null,
      deliveryDiagnostic: row.outcome?.deliveryDiagnostic ?? null,
      // Counts show submitted formatting without exposing link targets or
      // pretending the stored plaintext is a screenshot of Telegram.
      formatting: row.outcome?.entities === undefined ? null : {
        basis: row.outcome.delivery === 'verified' ? 'verified-entities' : 'submitted-entities',
        counts: row.outcome.entities.reduce((counts, entity) => { counts[entity.type] = (counts[entity.type] ?? 0) + 1; return counts; }, {}),
      },
    }));
    const output = { schema: 'neurobro-operator-dialogues-v1', scope: 'selected-addressed-requests', contextRecorded: false,
      completeChatHistory: false, pendingDoesNotProveRunning: true, dialogues, scanned: selected.scanned, hasOlder: selected.hasOlder };
    assert.ok(Buffer.byteLength(JSON.stringify(output), 'utf8') <= 262144);
    return output;
  } finally {
    try { journal?.close(); }
    finally { if (credentials) { credentials.apiId = 0; credentials.apiHash = ''; credentials.passphrase = ''; } }
  }
}

export async function operatorPorts(expectedHash) {
  assert.match(expectedHash, /^[a-f0-9]{64}$/);
  // Pin all imported build files BEFORE importing their code. Full verifier then
  // checks the exact complete file set, dependency hashes and directory shape.
  const manifestBytes = readFileSync(resolve(PRIVATE, 'standing-build-v36.json'));
  assert.equal(sha(manifestBytes), expectedHash);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.ok(Array.isArray(manifest) && manifest.length > 0 && manifest.length < 10000);
  for (const entry of manifest) {
    assert.equal(typeof entry.path, 'string');
    assert.ok(!entry.path.includes('\\') && !entry.path.includes(':') && entry.path.split('/').every(p => p && p !== '.' && p !== '..'));
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    const path = resolve(BUILD, entry.path), stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(sha(readFileSync(path)), entry.sha256);
  }
  for (const name of ['standing-host.mjs', 'standing-dialogues.mjs', 'src/standing-dialogue-journal.js', 'src/windows-credential-vault.js']) {
    assert.equal(manifest.filter(entry => entry.path === name).length, 1);
  }
  const host = await import(pathToFileURL(resolve(BUILD, 'standing-host.mjs')).href);
  host.verifyStandingBuild(BUILD, manifestBytes, expectedHash);
  const vaultModule = await import(pathToFileURL(resolve(BUILD, 'src/windows-credential-vault.js')).href);
  const journalModule = await import(pathToFileURL(resolve(BUILD, 'src/standing-dialogue-journal.js')).href);
  return {
    async prepare() {
      host.checkPrivateAcl();
      const b = host.readMetadata(resolve(PRIVATE, 'gateway-binding-v4.json'), 8192);
      assert.deepEqual(Object.keys(b).sort(), ['version', 'accountId', 'peerId', 'title', 'sessionReference', 'ownerLock', 'checkedAt', 'serving'].sort());
      assert.equal(b.version, 'telegram-account-binding-v1'); assert.equal(b.serving, false);
      assert.match(b.accountId, /^[1-9]\d{0,19}$/); assert.match(b.peerId, /^-[1-9]\d{0,19}$/);
      assert.equal(resolve(b.sessionReference), resolve(PRIVATE, 'session.enc'));
      assert.equal(resolve(b.ownerLock), resolve(PRIVATE, 'session.enc.owner.lock'));
      return { directory: resolve(PRIVATE, 'standing-state-v1/dialogues'), binding: { accountId: b.accountId, peerId: b.peerId } };
    },
    credentials: () => vaultModule.createWindowsCredentialVault({ path: resolve(PRIVATE, 'windows-credentials-v1.json') }).load(),
    journal: journalModule.openStandingDialogueJournal,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.ok(process.argv.length >= 3 && process.argv.length <= 6);
    const [hash, limit = '10', from, to] = process.argv.slice(2);
    const options = { limit: Number(limit), ...(from === undefined ? {} : { fromDate: Number(from) }), ...(to === undefined ? {} : { toDate: Number(to) }) };
    const output = await readStandingDialogues(options, await operatorPorts(hash));
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch { process.stdout.write('STANDING_DIALOGUE_READ_UNAVAILABLE\n'); process.exitCode = 1; }
}
