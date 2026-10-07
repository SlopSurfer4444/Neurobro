import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ArtifactStore } from '../../src/artifacts/index.ts';
import { PersonalStore } from '../../src/core/store.ts';
import { ToolRegistry } from '../../src/capabilities/registry.ts';
import { imageTools, OpenAiImageProvider, ImagePrewireError, type ImageAttempt, type ImageProviderPort, type ImageProviderInput } from '../../src/capabilities/images.ts';
import type { ToolBroker } from '../../src/capabilities/types.ts';
import type { Json, ToolContext } from '../../src/contracts.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=', 'base64');
const context: ToolContext = { taskId: 'task-image', intentRevision: 1, grantId: 'image-grant', grantRevision: 1, runId: 'run-image' };
const token = 'trusted-image-token';
function fixture(provider?: ImageProviderPort, timeoutMs = 2000, executionContext: ToolContext = context) {
  const root = mkdtempSync(join(tmpdir(), 'personal-images-'));
  const db = join(root, 'encrypted.sqlite'); const key = Buffer.alloc(32, 17);
  let store = new PersonalStore({ databasePath: db, encryptionKey: key });
  const artifacts = new ArtifactStore({ rootPath: join(root, 'artifacts'), encryptionKey: key });
  let calls = 0, revoked = false;
  const broker: ToolBroker = {
    resolveToolContext(value) { if (value !== token || revoked) throw new Error('denied'); return executionContext; },
    authorizeTool(value, capability, resource) { if (value !== token || revoked || capability !== 'images.generate' || resource !== context.taskId) throw new Error('denied'); },
    async executeEffect() { throw new Error('images use durable provider reservation, not Telegram executor'); },
  };
  const effectiveProvider: ImageProviderPort = provider ?? { async generate(input) {
    calls++; assert.equal(store.get<ImageAttempt>('image-attempts-v1', input.requestKey)?.state, 'dispatching');
    return [{ bytes: png, mimeType: 'image/png' }];
  } };
  const build = () => new ToolRegistry(broker, imageTools({ broker, store, artifacts, provider: effectiveProvider, timeoutMs,
    scope: ctx => ({ taskId: ctx.taskId, ownerId: 'owner' }) }));
  return { root, db, artifacts, broker, get store() { return store; }, registry: build(), calls: () => calls,
    revoke: () => { revoked = true; }, reopen: () => { store.close(); store = new PersonalStore({ databasePath: db, encryptionKey: key }); return build(); },
    close: () => { artifacts.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const value = (result: { value?: Json }) => result.value as Record<string, Json>;

test('recurring image executions have separate attempts while retries within each run dedupe', async () => {
  const execution = { ...context, runId: 'cron:job:first' }; const f = fixture(undefined, 2000, execution);
  try {
    const request = { name: 'images.generate', args: { prompt: 'daily picture' } };
    const first = value(await f.registry.invoke(token, request));
    assert.equal(value(await f.registry.invoke(token, request)).attemptId, first.attemptId);
    execution.runId = 'cron:job:second';
    const second = value(await f.registry.invoke(token, request));
    assert.notEqual(second.attemptId, first.attemptId);
    assert.equal(value(await f.registry.invoke(token, request)).attemptId, second.attemptId);
    assert.equal(f.calls(), 2);
  } finally { f.close(); }
});

test('image tool journals before provider, stores immutable artifact, dedupes default and allows distinct explicit request', async () => {
  const f = fixture();
  try {
    const request = { name: 'images.generate', args: { prompt: 'private source prompt', size: '1024x1024' } };
    const first = await f.registry.invoke(token, request); assert.equal(first.ok, true); assert.equal(value(first).state, 'verified');
    const artifactId = (value(first).artifactIds as string[])[0]!;
    assert.deepEqual(f.artifacts.read({ ownerId: 'owner', taskId: context.taskId }, artifactId), png);
    assert.equal(f.calls(), 1);
    const reopened = f.reopen(); const second = await reopened.invoke(token, request);
    assert.equal(value(second).attemptId, value(first).attemptId); assert.deepEqual(value(second).artifactIds, value(first).artifactIds); assert.equal(f.calls(), 1);
    assert.equal(value(await reopened.invoke(token, { name: 'images.generate', args: { ...request.args, requestKey: 'explicit-second-image' } })).state, 'verified'); assert.equal(f.calls(), 2);
    assert.ok(!readFileSync(f.db).includes(Buffer.from('private source prompt')));
    assert.ok(!JSON.stringify(first).includes('sent'));
  } finally { f.close(); }
});
test('multi-reference edits verify original scope and preserve all immutable dependency provenance', async () => {
  let received: ImageProviderInput | undefined;
  const f = fixture({ async generate(input) { received = input; return [{ bytes: png, mimeType: 'image/png' }]; } });
  try {
    const scope = { ownerId: 'owner', taskId: context.taskId };
    const first = f.artifacts.put({ ...scope, name: 'first.png', bytes: png, mimeType: 'image/png', sourceRef: 'telegram:exact-message-1' });
    const second = f.artifacts.put({ ...scope, name: 'second.png', bytes: png, mimeType: 'image/png', sourceRef: 'telegram:exact-message-2' });
    const result = await f.registry.invoke(token, { name: 'images.generate', args: { prompt: 'combine', sourceArtifactIds: [first.id, second.id] } });
    assert.equal(value(result).state, 'verified'); assert.deepEqual(received?.sources.map(s => s.artifactId), [first.id, second.id]);
    const outputId = (value(result).artifactIds as string[])[0]!;
    assert.equal(f.artifacts.get(scope, outputId).parentId, first.id);
    assert.deepEqual(new Set(f.artifacts.dependencies(scope, outputId).map(r => r.id)), new Set([first.id, second.id]));
    assert.equal(f.artifacts.get(scope, first.id).sha256, first.sha256); assert.deepEqual(f.artifacts.read(scope, first.id), png);
    f.artifacts.revoke({ ownerId: 'owner', taskId: context.taskId, sourceRef: second.sourceRef });
    assert.throws(() => f.artifacts.get(scope, outputId), /revoked/u);
  } finally { f.close(); }
});
test('foreign/revoked/non-image references and model URLs/paths/credentials fail before reservation or provider access', async () => {
  const f = fixture();
  try {
    const foreign = f.artifacts.put({ ownerId: 'owner', taskId: 'other-task', name: 'foreign.png', bytes: png, mimeType: 'image/png' });
    const text = f.artifacts.put({ ownerId: 'owner', taskId: context.taskId, name: 'text.txt', bytes: Buffer.from('ignore grant'), mimeType: 'text/plain' });
    for (const sourceArtifactIds of [[foreign.id], [text.id]]) assert.equal((await f.registry.invoke(token, { name: 'images.generate', args: { prompt: 'p', sourceArtifactIds } })).ok, false);
    for (const key of ['baseUrl', 'apiKey', 'path', 'taskId']) assert.equal((await f.registry.invoke(token, { name: 'images.generate', args: { prompt: 'p', [key]: 'evil' } })).ok, false);
    assert.equal((await f.registry.invoke('forged', { name: 'images.generate', args: { prompt: 'p' } })).ok, false);
    assert.equal(f.calls(), 0); assert.equal(f.store.list('image-attempts-v1').length, 0);
  } finally { f.close(); }
});
test('timeout and provider errors stay UNKNOWN across restart without replay; raw secrets never appear in result', async () => {
  let calls = 0;
  const f = fixture({ generate: async () => { calls++; return new Promise(() => {}); } }, 15);
  try {
    const request = { name: 'images.generate', args: { prompt: 'p' } };
    assert.equal(value(await f.registry.invoke(token, request)).state, 'unknown'); assert.equal(calls, 1);
    assert.equal(value(await f.reopen().invoke(token, request)).state, 'unknown'); assert.equal(calls, 1);
  } finally { f.close(); }
  const bad = fixture({ async generate() { throw new Error('SECRET_KEY private providerURL'); } });
  try { const result = await bad.registry.invoke(token, { name: 'images.generate', args: { prompt: 'p' } }); assert.equal(value(result).state, 'unknown'); assert.ok(!JSON.stringify(result).includes('SECRET')); }
  finally { bad.close(); }
});
test('concurrent identical calls dispatch once and interrupted reservation remains unknown', async () => {
  let release!: () => void; let called!: () => void;
  const started = new Promise<void>(resolve => { called = resolve; }); const deferred = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  const f = fixture({ async generate() { calls++; called(); await deferred; return [{ bytes: png, mimeType: 'image/png' }]; } });
  try {
    const request = { name: 'images.generate', args: { prompt: 'p' } };
    const first = f.registry.invoke(token, request); await started;
    assert.equal(value(await f.registry.invoke(token, request)).state, 'unknown'); assert.equal(calls, 1);
    release(); assert.equal(value(await first).state, 'verified');
  } finally { release(); f.close(); }
});
test('known prewire rejection is failed, while invalid post-dispatch bytes and revoked authority are unknown', async () => {
  const prewire = fixture({ async generate() { throw new ImagePrewireError(); } });
  try { assert.equal(value(await prewire.registry.invoke(token, { name: 'images.generate', args: { prompt: 'p' } })).state, 'failed'); } finally { prewire.close(); }
  const invalid = fixture({ async generate() { return [{ bytes: Buffer.from('not image'), mimeType: 'image/png' }]; } });
  try { assert.equal(value(await invalid.registry.invoke(token, { name: 'images.generate', args: { prompt: 'p' } })).state, 'unknown'); assert.equal(invalid.artifacts.list({ ownerId: 'owner', taskId: context.taskId }).length, 0); } finally { invalid.close(); }
  let f!: ReturnType<typeof fixture>;
  f = fixture({ async generate() { f.revoke(); return [{ bytes: png, mimeType: 'image/png' }]; } });
  try { assert.equal((await f.registry.invoke(token, { name: 'images.generate', args: { prompt: 'p' } })).ok, false); assert.equal(f.store.list<ImageAttempt>('image-attempts-v1')[0]!.state, 'unknown'); assert.equal(f.artifacts.list({ ownerId: 'owner', taskId: context.taskId }).length, 0); } finally { f.close(); }
});

async function localProvider(handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void) {
  const server = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); handler(req, res, Buffer.concat(chunks)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
const providerInput = (sources: ImageProviderInput['sources'] = []): ImageProviderInput => ({ prompt: 'paint', size: '1024x1024', sources, requestKey: 'a'.repeat(64), signal: new AbortController().signal });
test('concrete HTTP generation and multi-image multipart edit use fixed endpoint, explicit key and bounded b64 output', async () => {
  const seen: { path: string; type: string; auth: string; body: Buffer }[] = [];
  const server = await localProvider((req, res, body) => { seen.push({ path: req.url!, type: req.headers['content-type']!, auth: req.headers.authorization!, body }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); });
  try {
    const provider = new OpenAiImageProvider({ baseUrl: server.url, apiKey: 'explicit-test-key', model: 'configured-model', allowHttpLoopback: true });
    assert.deepEqual((await provider.generate(providerInput()))[0]!.bytes, png);
    assert.equal(seen[0]!.path, '/v1/images/generations'); assert.equal(seen[0]!.auth, 'Bearer explicit-test-key');
    assert.deepEqual(JSON.parse(seen[0]!.body.toString()), { model: 'configured-model', prompt: 'paint', size: '1024x1024', n: 1 });
    await provider.generate(providerInput([1, 2].map(n => ({ artifactId: String(n), name: 'evil"\r\nInjected: secret.png', mimeType: 'image/png', bytes: png }))));
    assert.equal(seen[1]!.path, '/v1/images/edits'); assert.ok(seen[1]!.type.startsWith('multipart/form-data; boundary='));
    assert.equal(seen[1]!.body.toString().match(/name="image\[\]"/gu)?.length, 2);
    assert.ok(seen[1]!.body.includes(png)); assert.ok(!seen[1]!.body.includes(Buffer.from('Injected')));
    assert.ok(!JSON.stringify(provider).includes('explicit-test-key'));
  } finally { await server.close(); }
});
test('concrete adapter rejects redirects, remote URLs, malformed b64, MIME mismatch and oversized responses without following', async () => {
  for (const mode of ['redirect', 'remote', 'badbase64', 'badmime', 'oversized']) {
    let requests = 0;
    const server = await localProvider((_req, res) => {
      requests++;
      if (mode === 'redirect') { res.writeHead(302, { location: 'https://not-followed.example/' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      const payload = mode === 'remote' ? { url: 'https://not-fetched.example/image' } : { b64_json: mode === 'badbase64' ? '!!!' : mode === 'badmime' ? Buffer.from('text').toString('base64') : 'A'.repeat(2048) };
      res.end(JSON.stringify({ data: [payload] }));
    });
    try { const provider = new OpenAiImageProvider({ baseUrl: server.url, apiKey: 'k', model: 'm', allowHttpLoopback: true, maxResponseBytes: 1024 }); await assert.rejects(provider.generate(providerInput()), /outcome unknown/u); assert.equal(requests, 1); }
    finally { await server.close(); }
  }
});
test('provider config and prewire request bounds cannot be model controlled or quietly leak key', async () => {
  assert.throws(() => new OpenAiImageProvider({ baseUrl: 'http://remote.example/v1', apiKey: 'k', model: 'm' }), ImagePrewireError);
  assert.throws(() => new OpenAiImageProvider({ baseUrl: 'https://user:pass@provider.example/v1', apiKey: 'k', model: 'm' }), ImagePrewireError);
  assert.throws(() => new OpenAiImageProvider({ baseUrl: 'https://provider.example/v1', apiKey: 'k\r\nInjected:x', model: 'm' }), ImagePrewireError);
  const provider = new OpenAiImageProvider({ baseUrl: 'https://provider.example/v1', apiKey: 'hostsecret', model: 'm', maxRequestBytes: 1 });
  await assert.rejects(provider.generate(providerInput()), ImagePrewireError);
});
