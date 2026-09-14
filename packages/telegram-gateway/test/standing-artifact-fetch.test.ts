import test, { mock } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { Resolver } from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createStandingArtifactRegistry, STANDING_ARTIFACT_MAX_BYTES, StandingArtifactError } from "../src/standing-artifact.js";
import { createStandingArtifactFetcher, isStandingArtifactPublicAddress, validateStandingArtifactFetchUrl,
  StandingArtifactFetchError, type StandingArtifactFetchPorts, type StandingArtifactFetchResponse,
  type StandingArtifactFetchAddress, type StandingArtifactFetchInput } from "../src/standing-artifact-fetch.js";

const input = (): StandingArtifactFetchInput => ({ url: "https://media.wikipedia.org/song", filename: "download.bin" });
const publicAddress = Object.freeze({ address: "93.184.216.34", family: 4 as const });
const signal = () => new AbortController().signal;
const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof StandingArtifactFetchError && error.code === code);
}
function response(body: readonly Buffer[] = [Buffer.from("hello")], headers: string[] = [], statusCode = 200): StandingArtifactFetchResponse {
  return { statusCode, rawHeaders: headers, body: (async function* () { yield* body; })() };
}
function fixture(responses: StandingArtifactFetchResponse[] = [response()], addresses: readonly StandingArtifactFetchAddress[] = [publicAddress]) {
  const registry = createStandingArtifactRegistry({ requestRef: "fetch-test" });
  const calls: { url: string; address: StandingArtifactFetchAddress }[] = [];
  const dns: string[] = []; let destroyed = 0, settled = 0;
  const ports: StandingArtifactFetchPorts = {
    async resolve(hostname) { dns.push(hostname); return addresses; },
    request(url, address) {
      calls.push({ url: url.href, address });
      const result = responses[calls.length - 1]!;
      const joined = deferred<void>(); let done = false;
      return { response: Promise.resolve(result), settled: joined.promise,
        destroy() { if (!done) { done = true; destroyed++; settled++; joined.resolve(); } } };
    },
  };
  return { registry, ports, calls, dns, fetcher: createStandingArtifactFetcher(registry, ports),
    get destroyed() { return destroyed; }, get settled() { return settled; } };
}

test("public address policy parses families and CIDR boundaries, including IPv6 reserved space", () => {
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0",
    "198.17.255.255", "198.20.0.0", "223.255.255.255", "2001:4860:4860::8888", "2606:4700:4700::1111", "2a00:1450::1", "2410::1"])
    assert.equal(isStandingArtifactPublicAddress(address), true, address);
  for (const address of ["", "1.2.3", "0127.0.0.1", "2130706433", "0x7f000001", "256.1.1.1", " 8.8.8.8", "8.8.8.8%eth0",
    "0.0.0.0", "0.255.255.255", "10.1.2.3", "100.64.0.0", "100.127.255.255", "127.255.255.255", "169.254.169.254",
    "172.16.0.0", "172.31.255.255", "192.0.0.9", "192.0.2.5", "192.31.196.1", "192.52.193.1", "192.88.99.1", "192.168.1.1",
    "192.175.48.1", "198.18.0.0", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.0", "239.255.255.255", "240.0.0.0", "255.255.255.255",
    "::", "::1", "::ffff:8.8.8.8", "::ffff:808:808", "::8.8.8.8", "64:ff9b::808:808", "64:ff9b:1::1", "100::1",
    "2001::1", "2001:2::1", "2001:20::1", "2001:db8::1", "2002:808:808::1", "2620:4f:8000::1", "3fff::1", "3000::1", "3ffe::1",
    "4000::1", "fc00::1", "fe80::1", "fe80::1%eth0", "ff02::1", "2606:::1", "2606:1:1:1:1:1:1:1:1"])
    assert.equal(isStandingArtifactPublicAddress(address), false, address);
});

test("URL profile canonicalizes IDNA/default port and refuses numeric/credential/normalization bypasses", () => {
  assert.equal(validateStandingArtifactFetchUrl("HTTPS://MEDIA.WIKIPEDIA.ORG:443/a?q=x").href, "https://media.wikipedia.org/a?q=x");
  assert.equal(validateStandingArtifactFetchUrl("https://пример.рф/путь").hostname, "xn--e1afmkfd.xn--p1ai");
  for (const url of ["http://wikipedia.org/", "https:wikipedia.org/", "https:////@wikipedia.org/", "https://wikipedia.org:8443/", "https://u:p@wikipedia.org/", "https://@wikipedia.org/",
    "https://wikipedia.org/#", "https://wikipedia.org/#x", "https://wiki\npedia.org/", "https://wikipedia.org\\@localhost/", "https://wikipedia.org/%0A",
    "https://wikipedia.org/%1f", "https://wikipedia.org/%7F", "https://wikipedia.org/a b", "https://localhost/", "https://foo.internal/", "https://foo.local/",
    "https://foo.onion/", "https://foo.example/", "https://wikipedia.org./", "https://-bad.wikipedia.org/", "https://bad_.wikipedia.org/",
    "https://2130706433/", "https://0x7f000001/", "https://0177.0.0.1/", "https://127.1/", "https://%31%32%37.0.0.1/", "https://[::ffff:127.0.0.1]/"])
    assert.throws(() => validateStandingArtifactFetchUrl(url), StandingArtifactFetchError, url);
});

test("generic document bytes stay in registry; MIME is normalized metadata, filename explicit", async () => {
  const f = fixture([response([Buffer.from("<html>document</html>")], ["Content-Type", "Text/HTML; charset=utf-8", "Content-Length", "21"])]);
  const artifact = await f.fetcher.fetch(input(), signal());
  assert.equal(artifact.mimeType, "text/html"); assert.equal(artifact.filename, "download.bin");
  assert.equal(f.registry.copyBytes(artifact.ref).toString(), "<html>document</html>");
  assert.equal("bytes" in artifact, false); assert.equal(artifact.source.reference, input().url);
  assert.equal(f.destroyed, 1); assert.equal(f.settled, 1); assert.deepEqual(f.dns, ["media.wikipedia.org"]);
  assert.deepEqual(f.calls[0]!.address, publicAddress); assert.ok(Object.isFrozen(f.calls[0]!.address));
  await f.fetcher.close(); f.registry.close();
});

test("arguments and audio captured before first await; getters/proxies never execute", async () => {
  const bytes = Buffer.alloc(417); bytes.set([255, 251, 144, 0]);
  const f = fixture([response([bytes], ["Content-Type", "audio/mpeg"])]);
  const mutable = { ...input(), audio: { durationSeconds: 0, title: "Original" } };
  const pending = f.fetcher.fetch(mutable, signal()); mutable.url = "https://localhost/"; mutable.filename = "../bad"; mutable.audio.title = "Changed";
  const artifact = await pending;
  assert.equal(artifact.audio!.title, "Original"); assert.equal(artifact.audio!.durationSeconds, 1152 / 44100); assert.equal(artifact.filename, "download.bin");
  let calls = 0;
  await rejects(f.fetcher.fetch(Object.defineProperty(input(), "url", { get() { calls++; return "https://wikipedia.org/"; } }), signal()), "shape");
  await rejects(f.fetcher.fetch(new Proxy(input(), { ownKeys() { calls++; return []; } }), signal()), "shape");
  assert.equal(calls, 0); assert.equal(f.calls.length, 1); await f.fetcher.close(); f.registry.close();
});

test("filename/audio invalid metadata refuses before DNS; MP3 spoof fails checked registry admission", async () => {
  const f = fixture([response([Buffer.from("not MP3")], ["Content-Type", "audio/mpeg"])]);
  for (const filename of ["../file", "C:\\file", "a:b", "NUL.mp3", "a.", "..", " a", "x\n", "я".repeat(128)])
    await rejects(f.fetcher.fetch({ ...input(), filename }, signal()), "filename");
  await rejects(f.fetcher.fetch({ ...input(), audio: { durationSeconds: -1 } }, signal()), "audio");
  assert.equal(f.dns.length, 0);
  await assert.rejects(f.fetcher.fetch({ ...input(), audio: { durationSeconds: 0 } }, signal()), StandingArtifactError);
  assert.equal(f.destroyed, 1); await f.fetcher.close(); f.registry.close();
});

test("all DNS answers checked before any dial; family mismatch and empty/oversize lists refuse", async () => {
  for (const addresses of [[], [publicAddress, { address: "127.0.0.1", family: 4 as const }],
    [publicAddress, { address: "::ffff:7f00:1", family: 6 as const }], [{ address: "8.8.8.8", family: 6 as const }], Array(65).fill(publicAddress)]) {
    const f = fixture(undefined, addresses); await rejects(f.fetcher.fetch(input(), signal()), "address");
    assert.equal(f.calls.length, 0); await f.fetcher.close(); f.registry.close();
  }
});

test("redirects fresh-resolve each hop, join abandoned body, record final URL without forwarding state", async () => {
  const f = fixture([response([], ["Location", "/step", "Set-Cookie", "secret=1"], 302),
    response([], ["Location", "https://upload.wikimedia.org/final?q=1"], 307), response([Buffer.from([0, 1, 2])])]);
  const artifact = await f.fetcher.fetch(input(), signal());
  assert.equal(artifact.source.reference, "https://upload.wikimedia.org/final?q=1");
  assert.deepEqual(f.dns, ["media.wikipedia.org", "media.wikipedia.org", "upload.wikimedia.org"]);
  assert.equal(f.destroyed, 3); assert.equal(f.calls.length, 3); await f.fetcher.close(); f.registry.close();
});

test("redirect loops, fourth redirect and every unsafe Location refuse and settle", async () => {
  for (const location of ["http://wikipedia.org/", "https://127.1/", "https://u:p@wikipedia.org/", "https://@wikipedia.org/", "//@wikipedia.org/",
    "https:////@wikipedia.org/", "///@wikipedia.org/", " https://wikipedia.org/", "https://wikipedia.org/ ",
    "https:wikipedia.org/", "https://wikipedia.org:444/", "https://wikipedia.org/#", "https://wiki\npedia.org/", "https://wikipedia.org/%0a", "\\localhost\\a", input().url]) {
    const f = fixture([response([], ["Location", location], 302)]);
    await rejects(f.fetcher.fetch(input(), signal()), location.includes("\n") ? "headers" : "redirect");
    assert.equal(f.destroyed, 1); await f.fetcher.close(); f.registry.close();
  }
  const f = fixture([1, 2, 3, 4].map(n => response([], ["Location", "/hop" + n], 301)));
  await rejects(f.fetcher.fetch(input(), signal()), "redirect"); assert.equal(f.calls.length, 4); assert.equal(f.destroyed, 4);
  await f.fetcher.close(); f.registry.close();
});

test("same-host DNS rebind to private address on redirect refuses before second dial", async () => {
  const f = fixture([response([], ["Location", "/second"], 308)]); let lookups = 0;
  const fetcher = createStandingArtifactFetcher(f.registry, { ...f.ports, async resolve() {
    return ++lookups === 1 ? [publicAddress] : [{ address: "169.254.169.254", family: 4 }];
  } });
  await rejects(fetcher.fetch(input(), signal()), "address"); assert.equal(f.calls.length, 1); assert.equal(f.destroyed, 1);
  await fetcher.close(); f.registry.close();
});

test("statuses, identity encoding and unambiguous framing enforced", async () => {
  for (const headers of [["Content-Encoding", "gzip"], ["Content-Encoding", "br"], ["Content-Length", "5", "content-length", "5"],
    ["Content-Length", "5", "Transfer-Encoding", "chunked"], ["Transfer-Encoding", "gzip, chunked"], ["Content-Type", "not-a-mime"],
    ["Content-Type", "text/plain", "content-type", "text/html"], ["Content-Encoding", "identity", "content-encoding", "identity"]]) {
    const f = fixture([response(undefined, headers)]); await rejects(f.fetcher.fetch(input(), signal()), "headers");
    assert.equal(f.destroyed, 1); await f.fetcher.close(); f.registry.close();
  }
  for (const status of [201, 204, 206, 304, 400, 500]) {
    const f = fixture([response(undefined, [], status)]); await rejects(f.fetcher.fetch(input(), signal()), "status");
    assert.equal(f.destroyed, 1); await f.fetcher.close(); f.registry.close();
  }
  const f = fixture([response(undefined, ["Transfer-Encoding", "chunked", "Content-Encoding", "IDENTITY"])]);
  assert.equal((await f.fetcher.fetch(input(), signal())).byteLength, 5); await f.fetcher.close(); f.registry.close();
});

test("declared length bounded/equal to actual; streamed overflow and empty bodies refuse", async () => {
  for (const length of ["-1", "+5", "5.0", "05", "999999999999999999999", String(STANDING_ARTIFACT_MAX_BYTES + 1), "4", "6", "0"]) {
    const f = fixture([response(undefined, ["Content-Length", length])]); await rejects(f.fetcher.fetch(input(), signal()), "size");
    assert.equal(f.destroyed, 1); await f.fetcher.close(); f.registry.close();
  }
  const f = fixture([response([Buffer.alloc(STANDING_ARTIFACT_MAX_BYTES), Buffer.from([1])])]);
  await rejects(f.fetcher.fetch(input(), signal()), "size"); assert.equal(f.destroyed, 1); await f.fetcher.close(); f.registry.close();
  const empty = fixture([response([])]); await rejects(empty.fetcher.fetch(input(), signal()), "size"); await empty.fetcher.close(); empty.registry.close();
});

test("single flight; close revokes and waits for late response/request/socket settlement", async () => {
  const registry = createStandingArtifactRegistry({ requestRef: "late-settlement" });
  const arrival = deferred<StandingArtifactFetchResponse>(), settlement = deferred<void>(); let destroys = 0, acceptCalls = 0;
  const fetcher = createStandingArtifactFetcher({ ...registry, accept(value) { acceptCalls++; return registry.accept(value); } }, {
    async resolve() { return [publicAddress]; }, request(_url, _address, abort) {
      abort.addEventListener("abort", () => arrival.reject(Error("https://secret.invalid/?token=private")), { once: true });
      return { response: arrival.promise, settled: settlement.promise, destroy() { destroys++; } };
    },
  });
  const pending = fetcher.fetch(input(), signal()); const failure = rejects(pending, "closed"); await tick();
  await rejects(fetcher.fetch(input(), signal()), "busy");
  let closed = false, returned = false; void pending.then(() => {}, () => { returned = true; });
  const close = fetcher.close().then(() => { closed = true; }); await tick();
  assert.equal(closed, false); assert.equal(returned, false); assert.equal(destroys, 1); assert.equal(acceptCalls, 0);
  settlement.resolve(); await close; await failure;
  assert.equal(closed, true); assert.equal(returned, true); await rejects(fetcher.fetch(input(), signal()), "closed"); registry.close();
});

test("abort after complete body but before settlement cannot admit artifact", async () => {
  const registry = createStandingArtifactRegistry({ requestRef: "late-abort" }), settlement = deferred<void>(); let destroyed = false;
  const abort = new AbortController();
  const fetcher = createStandingArtifactFetcher(registry, { async resolve() { return [publicAddress]; }, request() {
    return { response: Promise.resolve(response()), settled: settlement.promise, destroy() { destroyed = true; } };
  } });
  const pending = fetcher.fetch(input(), abort.signal); const failure = rejects(pending, "aborted");
  await tick(); assert.equal(destroyed, true); abort.abort(); settlement.resolve(); await failure; await fetcher.close(); registry.close();
});

test("deadline spans DNS and joins its cancellation before returning; pre-aborted does no DNS", async () => {
  const registry = createStandingArtifactRegistry({ requestRef: "dns-deadline" }), finished = deferred<readonly StandingArtifactFetchAddress[]>();
  let canceled = false, resolutions = 0, requests = 0;
  const fetcher = createStandingArtifactFetcher(registry, { deadlineMs: 10,
    async resolve(_hostname, abort) { resolutions++; abort.addEventListener("abort", () => { canceled = true; }); return finished.promise; },
    request() { requests++; throw Error("must not dial"); } });
  const pending = fetcher.fetch(input(), signal()); const failure = rejects(pending, "deadline");
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(canceled, true);
  let returned = false; void pending.catch(() => { returned = true; }); await tick(); assert.equal(returned, false);
  finished.resolve([publicAddress]); await failure; assert.equal(requests, 0);
  const abort = new AbortController(); abort.abort(); await rejects(fetcher.fetch(input(), abort.signal), "aborted");
  assert.equal(resolutions, 1); await fetcher.close(); registry.close();
});

test("production Node ports pin lookup, preserve TLS/Host, and join socket close without real network", async () => {
  const a = mock.method(Resolver.prototype, "resolve4", async () => ["93.184.216.34"]);
  const aaaa = mock.method(Resolver.prototype, "resolve6", async () => ["2606:4700:4700::1111"]);
  const socketClosed = deferred<void>(); let socketDestroyed = false, observedOptions: https.RequestOptions | undefined;
  let lookupValue: unknown[] = [], requestUrl = "", requestCloses = 0;
  const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
  const socket = new EventEmitter() as EventEmitter & { destroy(): void };
  socket.destroy = () => { socketDestroyed = true; };
  req.destroy = () => { if (requestCloses++ === 0) req.emit("close"); };
  req.end = () => queueMicrotask(() => {
    req.emit("socket", socket);
    const message = Readable.from([Buffer.from("hello")]);
    Object.assign(message, { statusCode: 200, rawHeaders: ["Content-Length", "5"] });
    req.emit("response", message);
  });
  const request = mock.method(https, "request", ((url: URL, options: https.RequestOptions) => {
    requestUrl = url.href; observedOptions = options;
    const callback = (...args: unknown[]) => { lookupValue = args; };
    (options.lookup as Function)(url.hostname, { family: 4 }, callback);
    // Repeated lookup never invokes a resolver again, so DNS cannot rebind.
    (options.lookup as Function)(url.hostname, { family: 4 }, callback);
    return req;
  }) as typeof https.request);
  syncBuiltinESMExports();
  const registry = createStandingArtifactRegistry({ requestRef: "node-default" });
  try {
    const fetcher = createStandingArtifactFetcher(registry); let returned = false;
    const pending = fetcher.fetch(input(), signal()).then(value => { returned = true; return value; });
    await tick(); assert.equal(returned, false); assert.equal(socketDestroyed, true);
    assert.equal(requestUrl, input().url); assert.equal(observedOptions!.agent, false); assert.equal(observedOptions!.servername, "media.wikipedia.org");
    assert.equal(observedOptions!.rejectUnauthorized, true); assert.equal(observedOptions!.method, "GET");
    assert.equal(observedOptions!.maxHeaderSize, 16_384); assert.equal(observedOptions!.insecureHTTPParser, false);
    assert.deepEqual(observedOptions!.headers, { "user-agent": "DecadansNeurobro/1.0 (Telegram assistant; public media fetch)", "accept-encoding": "identity", connection: "close" });
    assert.deepEqual(lookupValue, [null, "93.184.216.34", 4]); assert.equal(a.mock.callCount(), 1); assert.equal(aaaa.mock.callCount(), 1);
    socket.emit("close"); socketClosed.resolve(); await socketClosed.promise;
    assert.equal((await pending).byteLength, 5); await fetcher.close();
  } finally { registry.close(); request.mock.restore(); a.mock.restore(); aaaa.mock.restore(); syncBuiltinESMExports(); }
});

test("exact maximum bytes admitted; no-length stream is bounded without chunk-count amplification", async () => {
  const body = Buffer.alloc(STANDING_ARTIFACT_MAX_BYTES, 7);
  const f = fixture([response([Buffer.alloc(0), body], ["Content-Length", String(STANDING_ARTIFACT_MAX_BYTES)])]);
  const artifact = await f.fetcher.fetch(input(), signal());
  assert.equal(artifact.byteLength, STANDING_ARTIFACT_MAX_BYTES); assert.equal(f.registry.copyBytes(artifact.ref)[artifact.byteLength - 1], 7);
  await f.fetcher.close(); f.registry.close();
});

test("deadline aborts streaming and still joins delayed transport settlement", async () => {
  const registry = createStandingArtifactRegistry({ requestRef: "stream-deadline" });
  const more = deferred<void>(), settlement = deferred<void>(); let aborted = false, destroyed = false;
  const fetcher = createStandingArtifactFetcher(registry, { deadlineMs: 10,
    async resolve() { return [publicAddress]; }, request(_url, _address, abort) {
      abort.addEventListener("abort", () => { aborted = true; more.reject(Error("private upstream data")); });
      return { response: Promise.resolve({ statusCode: 200, rawHeaders: [], body: (async function* () {
        yield Buffer.from([1]); await more.promise; yield Buffer.from([2]);
      })() }), settled: settlement.promise, destroy() { destroyed = true; } };
    } });
  const pending = fetcher.fetch(input(), signal()), failure = rejects(pending, "deadline");
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(aborted, true); assert.equal(destroyed, true);
  let returned = false; void pending.catch(() => { returned = true; }); await tick(); assert.equal(returned, false);
  settlement.resolve(); await failure; await fetcher.close(); registry.close();
});

test("production DNS cancels both families and joins their completion without dialing", async () => {
  const v4 = deferred<string[]>(), v6 = deferred<string[]>(); let canceled = false, dialed = false;
  const a = mock.method(Resolver.prototype, "resolve4", () => v4.promise);
  const aaaa = mock.method(Resolver.prototype, "resolve6", () => v6.promise);
  const cancel = mock.method(Resolver.prototype, "cancel", () => { canceled = true; });
  const request = mock.method(https, "request", (() => { dialed = true; throw Error("no dial"); }) as typeof https.request);
  syncBuiltinESMExports();
  const registry = createStandingArtifactRegistry({ requestRef: "node-dns-cancel" });
  try {
    const fetcher = createStandingArtifactFetcher(registry), abort = new AbortController();
    const pending = fetcher.fetch(input(), abort.signal), failure = rejects(pending, "aborted"); await tick(); abort.abort();
    assert.equal(canceled, true); let returned = false; void pending.catch(() => { returned = true; });
    v4.reject(Object.assign(Error("secret DNS error"), { code: "ECANCELLED" })); await tick(); assert.equal(returned, false);
    v6.reject(Object.assign(Error("secret DNS error"), { code: "ECANCELLED" })); await failure;
    assert.equal(dialed, false); await fetcher.close();
  } finally { registry.close(); request.mock.restore(); cancel.mock.restore(); a.mock.restore(); aaaa.mock.restore(); syncBuiltinESMExports(); }
});

test("production DNS incomplete-family errors refuse even with a public answer", async () => {
  const a = mock.method(Resolver.prototype, "resolve4", async () => [publicAddress.address]);
  const aaaa = mock.method(Resolver.prototype, "resolve6", async () => { throw Object.assign(Error("private DNS details"), { code: "ETIMEOUT" }); });
  let dialed = false;
  const request = mock.method(https, "request", (() => { dialed = true; throw Error("no dial"); }) as typeof https.request);
  syncBuiltinESMExports();
  const registry = createStandingArtifactRegistry({ requestRef: "node-dns-incomplete" });
  try {
    const fetcher = createStandingArtifactFetcher(registry); await rejects(fetcher.fetch(input(), signal()), "dns");
    assert.equal(dialed, false); await fetcher.close();
  } finally { registry.close(); request.mock.restore(); a.mock.restore(); aaaa.mock.restore(); syncBuiltinESMExports(); }
});

test("production request errors sanitize upstream details and wait for request close", async () => {
  const a = mock.method(Resolver.prototype, "resolve4", async () => [publicAddress.address]);
  const aaaa = mock.method(Resolver.prototype, "resolve6", async () => { throw Object.assign(Error("no v6"), { code: "ENODATA" }); });
  const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
  req.end = () => queueMicrotask(() => req.emit("error", Error("private URL token"))); req.destroy = () => {};
  const request = mock.method(https, "request", (() => req) as unknown as typeof https.request); syncBuiltinESMExports();
  const registry = createStandingArtifactRegistry({ requestRef: "node-request-error" });
  try {
    const fetcher = createStandingArtifactFetcher(registry); const pending = fetcher.fetch(input(), signal());
    const failure = rejects(pending, "network"); let returned = false; void pending.catch(() => { returned = true; });
    await tick(); assert.equal(returned, false); req.emit("close"); await failure; await fetcher.close();
  } finally { registry.close(); request.mock.restore(); a.mock.restore(); aaaa.mock.restore(); syncBuiltinESMExports(); }
});

test("first abort reason survives later close and deadline while joining late cleanup", async () => {
  const registry = createStandingArtifactRegistry({ requestRef: "first-abort" }), settlement = deferred<void>();
  const arrival = deferred<StandingArtifactFetchResponse>();
  const fetcher = createStandingArtifactFetcher(registry, { deadlineMs: 10, async resolve() { return [publicAddress]; },
    request(_url, _address, abort) {
      abort.addEventListener("abort", () => arrival.reject(Error("aborted")));
      return { response: arrival.promise, settled: settlement.promise, destroy() {} };
    } });
  const abort = new AbortController(), pending = fetcher.fetch(input(), abort.signal), failure = rejects(pending, "aborted");
  await tick(); abort.abort(); const close = fetcher.close(); await new Promise(resolve => setTimeout(resolve, 25));
  settlement.resolve(); await failure; await close; registry.close();
});

test("production close before response rejects immediately even without an error event", async () => {
  const a = mock.method(Resolver.prototype, "resolve4", async () => [publicAddress.address]);
  const aaaa = mock.method(Resolver.prototype, "resolve6", async () => []);
  const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
  req.end = () => queueMicrotask(() => req.emit("close")); req.destroy = () => {};
  const request = mock.method(https, "request", (() => req) as unknown as typeof https.request); syncBuiltinESMExports();
  const registry = createStandingArtifactRegistry({ requestRef: "node-early-close" });
  try {
    const fetcher = createStandingArtifactFetcher(registry); await rejects(fetcher.fetch(input(), signal()), "network"); await fetcher.close();
  } finally { registry.close(); request.mock.restore(); a.mock.restore(); aaaa.mock.restore(); syncBuiltinESMExports(); }
});
