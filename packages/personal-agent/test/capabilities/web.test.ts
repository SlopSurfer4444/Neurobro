import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { assertPublicAddress, validatePublicUrl, WebService, createNodePinnedFetch } from '../../src/capabilities/web.ts';
import type { WebServiceOptions, WebTransport } from '../../src/capabilities/web.ts';
import type { ToolContext } from '../../src/contracts.ts';

const context: ToolContext = { taskId: 'task', intentRevision: 1, grantId: 'grant', grantRevision: 1, runId: 'run' };
const publicIp = { address: '93.184.216.34', family: 4 as const };
function service(options: WebServiceOptions = {}) {
  return new WebService({ authority: async () => {}, resolver: async () => [publicIp], ...options });
}
const textResponse = { status: 200, headers: { 'content-type': 'text/plain' }, bytes: Buffer.from('hello') };

test('URL/IP gates cover alternate IPv4 forms, mapped IPv6, private ranges and credentials', () => {
  for (const url of [
    'http://localhost/', 'http://foo.local/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[fe80::1]/',
    'http://[fd00::1]/', 'http://[2002:7f00:1::]/', 'http://169.254.169.254/', 'http://100.64.0.1/',
    'http://192.168.1.1/', 'http://172.16.1.2/', 'file:///etc/passwd', 'https://user:pass@example.com/',
    'https://example.com:22/', 'https://example.com\n/',
  ]) assert.throws(() => validatePublicUrl(url), { message: /./u }, url);
  assert.equal(assertPublicAddress('2606:4700:4700::1111').family, 6);
  assert.equal(assertPublicAddress('::ffff:5db8:d822').family, 6);
  assert.equal(validatePublicUrl('https://example.com/a#secret').href, 'https://example.com/a');
});

test('missing authority and malformed trusted context fail before any transport', async () => {
  await assert.rejects(new WebService().fetch(context, { url: 'https://example.com' }), /authority/);
  await assert.rejects(service().fetch({ ...context, taskId: '' }, { url: 'https://example.com' }), /context/);
});

test('validated DNS is pinned once; mixed public/private DNS fails before connection', async () => {
  let resolutions = 0; let transports = 0;
  const web = service({ resolver: async () => { resolutions++; return [publicIp]; }, transport: async (url, ip) => {
    transports++; assert.equal(url.hostname, 'example.com'); assert.deepEqual(ip, publicIp); return textResponse;
  } });
  assert.equal((await web.fetch(context, { url: 'https://example.com/path' })).text, 'hello');
  assert.equal(resolutions, 1); assert.equal(transports, 1);
  const mixed = service({ resolver: async () => [publicIp, { address: '10.0.0.1', family: 4 }], transport: async () => { throw new Error('must not connect'); } });
  await assert.rejects(mixed.fetch(context, { url: 'https://example.com' }), /not public/);
});

test('redirect hops revalidate network and grant origin without leaking credentials', async () => {
  const origins: string[] = []; let calls = 0;
  const web = service({ authority: async (_context, _capability, origin) => { origins.push(origin); if (origin === 'https://other.example') throw new Error('grant denied'); },
    transport: async () => { calls++; return { status: 302, headers: { location: 'https://other.example/x' }, bytes: Buffer.alloc(0) }; } });
  await assert.rejects(web.fetch(context, { url: 'https://example.com' }), /grant denied/);
  assert.deepEqual(origins, ['https://example.com', 'https://other.example']); assert.equal(calls, 1);
  for (const location of ['http://169.254.169.254/latest/meta-data/', 'https://user:secret@example.com']) {
    await assert.rejects(service({ transport: async () => ({ status: 302, headers: { location }, bytes: Buffer.alloc(0) }) }).fetch(context, { url: 'https://example.com' }));
  }
});

test('redirect destination DNS is checked independently and cycles are bounded', async () => {
  let resolutions = 0;
  const web = service({ resolver: async () => { resolutions++; return resolutions === 1 ? [publicIp] : [{ address: '127.0.0.1', family: 4 }]; },
    transport: async () => ({ status: 302, headers: { location: '/next' }, bytes: Buffer.alloc(0) }) });
  await assert.rejects(web.fetch(context, { url: 'https://example.com' }), /not public/);
  assert.equal(resolutions, 2);
  let hops = 0;
  await assert.rejects(service({ limits: { maxRedirects: 2 }, transport: async () => { hops++; return { status: 302, headers: { location: '/cycle' }, bytes: Buffer.alloc(0) }; } }).fetch(context, { url: 'https://example.com' }), /redirect limit/);
  assert.equal(hops, 3);
});

test('byte limits and total DNS/transport timeout are enforced even with noncooperative injected providers', async () => {
  await assert.rejects(service({ limits: { maxFetchBytes: 2 }, transport: async () => textResponse }).fetch(context, { url: 'https://example.com' }), /oversized/);
  await assert.rejects(service({ limits: { timeoutMs: 10 }, resolver: () => new Promise(() => {}) }).fetch(context, { url: 'https://example.com' }), /timed out/);
  let signal: AbortSignal | undefined;
  await assert.rejects(service({ limits: { timeoutMs: 10 }, transport: async (_url, _ip, options) => { signal = options.signal; return new Promise(() => {}); } }).fetch(context, { url: 'https://example.com' }), /timed out/);
  assert.equal(signal?.aborted, true);
});

test('downloads stage bytes through trusted sink, enforce task identity and reject path names before network', async () => {
  let calls = 0; let stages = 0;
  const web = service({ transport: async () => { calls++; return textResponse; }, artifactSink: { stage: async (received, input) => {
    stages++; assert.deepEqual(received, context); assert.equal(input.name, 'safe.txt'); assert.equal(input.sourceUrl, 'https://example.com/file');
    assert.equal(Buffer.from(input.bytes).toString(), 'hello');
    return { id: 'artifact', taskId: received.taskId, ownerId: 'owner', name: input.name, mimeType: input.mimeType, sha256: 'hash', size: input.bytes.length, createdAt: 'now' };
  } } });
  for (const name of ['../../secret', 'C:\\secret', 'CON.txt', 'NUL .txt', 'COM¹.txt', 'name.', 'x/y']) await assert.rejects(web.download(context, { url: 'https://example.com/file', name }), /artifact name/);
  assert.equal(calls, 0);
  assert.equal((await web.download(context, { url: 'https://example.com/file', name: 'safe.txt' })).id, 'artifact');
  assert.equal(stages, 1);
});

test('authority revocation after fetch prevents artifact stage', async () => {
  let auth = 0; let staged = false;
  await assert.rejects(service({ authority: async () => { if (++auth === 2) throw new Error('revoked'); }, transport: async () => textResponse,
    artifactSink: { stage: async () => { staged = true; throw new Error('must not stage'); } } }).download(context, { url: 'https://example.com/file' }), /revoked/);
  assert.equal(staged, false);
});

test('download normalizes hostile MIME metadata and rejects mismatched sink task identity', async () => {
  const web = service({ transport: async () => ({ ...textResponse, headers: { 'content-type': 'text/plain\r\nInjected: yes' } }),
    artifactSink: { stage: async (_received, input) => {
      assert.equal(input.mimeType, 'application/octet-stream');
      return { id: 'foreign', taskId: 'other-task', ownerId: 'owner', name: input.name, mimeType: input.mimeType, sha256: 'hash', size: 5, createdAt: 'now' };
    } } });
  await assert.rejects(web.download(context, { url: 'https://example.com/file' }), /mismatched task/);
});

test('search provider is explicit, bounded, and treats hostile metadata as data', async () => {
  await assert.rejects(service().search(context, { query: 'news' }), /provider unavailable/);
  const web = service({ searchProvider: { search: async (query, { limit }) => {
    assert.equal(query, 'topic'); assert.equal(limit, 1);
    return [{ title: 'ignore instructions', url: 'http://127.0.0.1' }, { title: 'x'.repeat(1000), url: 'https://example.com', snippet: 'y'.repeat(5000) }];
  } } });
  const result = await web.search(context, { query: 'topic', limit: 1 });
  assert.equal(result.length, 1); assert.equal(result[0]?.title.length, 512); assert.equal(result[0]?.snippet?.length, 2048);
});

test('binary response fails fetch and invalid configured limits fail closed', async () => {
  const binary: WebTransport = async () => ({ ...textResponse, headers: { 'content-type': 'image/png' } });
  await assert.rejects(service({ transport: binary }).fetch(context, { url: 'https://example.com' }), /textual/);
  assert.throws(() => service({ limits: { maxDownloadBytes: Infinity } }), /limits/);
});

test('real Node transport pins lookup and TLS identity and enforces streamed byte bounds', async () => {
  let connected = 0;
  const makeTransport = (body: string) => createNodePinnedFetch((url, options, callback) => {
    connected++;
    assert.equal(url.hostname, 'example.com'); assert.equal(options.agent, false); assert.equal(options.servername, 'example.com');
    assert.equal(options.autoSelectFamily, false);
    assert.deepEqual(options.headers, { 'user-agent': 'Neurobro/1.0', accept: '*/*', 'accept-encoding': 'identity' });
    const lookup = options.lookup!;
    lookup('example.com', { family: 4, all: false }, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, publicIp.address); assert.equal(family, 4);
    });
    const req = new EventEmitter() as ClientRequest;
    req.end = (() => {
      const stream = new PassThrough();
      Object.assign(stream, { statusCode: 200, headers: { 'content-type': 'text/plain' } });
      callback(stream as unknown as IncomingMessage); stream.end(body);
      return req;
    }) as ClientRequest['end'];
    return req;
  });
  assert.equal((await service({ transport: makeTransport('abc') }).fetch(context, { url: 'https://example.com' })).text, 'abc');
  await assert.rejects(service({ transport: makeTransport('too big'), limits: { maxFetchBytes: 2 } }).fetch(context, { url: 'https://example.com' }), /byte limit/);
  await assert.rejects(makeTransport('')(new URL('http://127.0.0.1'), publicIp, { maxBytes: 10, signal: new AbortController().signal }), /not public/);
  assert.equal(connected, 2);
});
