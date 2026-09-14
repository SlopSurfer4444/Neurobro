import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { types } from "node:util";
import { STANDING_ARTIFACT_MAX_BYTES, type StandingArtifact, type StandingArtifactAudio,
  type StandingArtifactRegistry } from "./standing-artifact.js";

export type StandingArtifactFetchInput = Readonly<{ url: string; filename: string; audio?: StandingArtifactAudio }>;
export type StandingArtifactFetchAddress = Readonly<{ address: string; family: 4 | 6 }>;
export type StandingArtifactFetchResponse = Readonly<{
  statusCode: number; rawHeaders: readonly string[]; body: AsyncIterable<Uint8Array>;
}>;
export type StandingArtifactFetchExchange = Readonly<{
  response: Promise<StandingArtifactFetchResponse>;
  /** Resolves only after request, response stream, and owned socket have closed. */
  settled: Promise<void>;
  destroy(): void;
}>;
/** Trusted host ports, never model arguments. resolve must join its work before
 * settling (including abort); request must return its ownership handle synchronously.
 * deadlineMs may only shorten the production deadline, for offline tests. */
export type StandingArtifactFetchPorts = Readonly<{
  resolve(hostname: string, signal: AbortSignal): Promise<readonly StandingArtifactFetchAddress[]>;
  request(url: URL, address: StandingArtifactFetchAddress, signal: AbortSignal): StandingArtifactFetchExchange;
  deadlineMs?: number;
}>;
type Refusal = "shape" | "url" | "filename" | "audio" | "address" | "dns" | "network" | "status" | "headers" |
  "size" | "redirect" | "aborted" | "deadline" | "closed" | "busy";
export class StandingArtifactFetchError extends Error {
  constructor(readonly code: Refusal) { super("STANDING_ARTIFACT_FETCH_" + code.toUpperCase()); this.name = "StandingArtifactFetchError"; }
}
const refuse = (code: Refusal): never => { throw new StandingArtifactFetchError(code); };
function record(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return refuse("shape");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || !allowed.includes(key)) ||
      Object.values(descriptors).some(d => !("value" in d)) || required.some(key => !Object.hasOwn(descriptors, key))) return refuse("shape");
  return Object.fromEntries(Object.entries(descriptors).map(([key, d]) => [key, d.value]));
}
function cleanText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && Buffer.from(value).toString("utf8") === value;
}
/** A deliberately conservative DNS-name URL profile matching registry provenance.
 * WHATWG parsing handles IDNA and numeric-host normalization; literals are refused. */
export function validateStandingArtifactFetchUrl(value: unknown): URL {
  if (!cleanText(value, 4096) || !/^https:\/\/[^/]/iu.test(value) || /[\s\\#]/u.test(value) ||
      /^[^:]+:\/\/[^/?#]*@/u.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)) return refuse("url");
  let url: URL;
  try { url = new URL(value); } catch { return refuse("url"); }
  const hostname = url.hostname;
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
      isIP(hostname.replace(/^\[|\]$/gu, "")) || hostname.length > 253 || !hostname.includes(".") || hostname.endsWith(".") ||
      !hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/u.test(hostname)) return refuse("url");
  return url;
}
function ipv4Number(address: string): bigint {
  return address.split(".").reduce((n, octet) => (n << 8n) | BigInt(octet), 0n);
}
function ipv6Number(address: string): bigint {
  const halves = address.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const parts = halves.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left;
  return parts.reduce((n, word) => (n << 16n) | BigInt("0x" + word), 0n);
}
function inPrefix(value: bigint, prefix: bigint, bits: number, width: number): boolean {
  return (value >> BigInt(width - bits)) === (prefix >> BigInt(width - bits));
}
const v4Excluded: readonly [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["192.175.48.0", 24],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
];
// Conservative IANA RIR-allocation snapshot, 2026-09-10. Newly allocated ranges
// need a reviewed source update. https://www.iana.org/assignments/ipv6-unicast-address-assignments/
const v6Allocated: readonly [string, number][] = [
  ["2001:200::", 23], ["2001:400::", 22], ["2001:800::", 21], ["2001:1200::", 23],
  ["2001:1400::", 22], ["2001:1800::", 21], ["2001:2000::", 19], ["2001:4000::", 21],
  ["2001:4800::", 22], ["2001:4c00::", 23], ["2001:5000::", 20], ["2001:8000::", 18],
  ["2003::", 18], ["2400::", 12], ["2410::", 12], ["2600::", 12], ["2610::", 23],
  ["2620::", 23], ["2630::", 12], ["2800::", 12], ["2a00::", 12], ["2a10::", 12], ["2c00::", 12],
];
/** Ordinary unicast IPv4 or allocated IPv6, minus special-purpose ranges.
 * Zones, mapped IPv4, known NAT64/transition prefixes, multicast, local and
 * documentation addresses refuse. Deployment routing must not translate an
 * otherwise public destination into a private one (RFC6052 network-specific
 * NAT64 prefixes cannot be identified from address syntax alone). */
export function isStandingArtifactPublicAddress(address: string): boolean {
  if (typeof address !== "string" || address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return !v4Excluded.some(([prefix, bits]) => inPrefix(value, ipv4Number(prefix), bits, 32));
  }
  if (family !== 6 || address.includes(".")) return false;
  const value = ipv6Number(address);
  return v6Allocated.some(([prefix, bits]) => inPrefix(value, ipv6Number(prefix), bits, 128)) &&
    !inPrefix(value, ipv6Number("2001:db8::"), 32, 128) && !inPrefix(value, ipv6Number("2620:4f:8000::"), 48, 128);
}
function snapshot(input: StandingArtifactFetchInput): StandingArtifactFetchInput {
  const data = record(input, ["url", "filename", "audio"], ["url", "filename"]);
  const url = validateStandingArtifactFetchUrl(data.url).href;
  if (!cleanText(data.filename, 255) || Buffer.byteLength(data.filename) > 255 || /[\\/:*?"<>|]/u.test(data.filename) ||
      data.filename.trim() !== data.filename || data.filename.endsWith(".") || data.filename === "." || data.filename === ".." ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(data.filename)) return refuse("filename");
  let audio: StandingArtifactAudio | undefined;
  if (data.audio !== undefined) {
    const a = record(data.audio, ["durationSeconds", "title", "performer"], ["durationSeconds"]);
    if (typeof a.durationSeconds !== "number" || !Number.isFinite(a.durationSeconds) || a.durationSeconds < 0 ||
        [a.title, a.performer].some(t => t !== undefined && (!cleanText(t, 255) || Buffer.byteLength(t as string) > 255))) return refuse("audio");
    audio = Object.freeze({ durationSeconds: a.durationSeconds,
      ...(a.title === undefined ? {} : { title: a.title as string }), ...(a.performer === undefined ? {} : { performer: a.performer as string }) });
  }
  return Object.freeze({ url, filename: data.filename, ...(audio === undefined ? {} : { audio }) });
}

async function resolvePublic(hostname: string, signal: AbortSignal): Promise<readonly StandingArtifactFetchAddress[]> {
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) return refuse("aborted");
    const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    if (signal.aborted) return refuse("aborted");
    const addresses: StandingArtifactFetchAddress[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === "fulfilled") for (const address of result.value) addresses.push({ address, family: i === 0 ? 4 : 6 });
      // No-data for one family is normal. Timeouts/errors cannot certify ALL records.
      else if ((result.reason as NodeJS.ErrnoException)?.code !== "ENODATA") return refuse("dns");
    }
    return addresses;
  } finally { signal.removeEventListener("abort", cancel); }
}

function requestPinned(url: URL, address: StandingArtifactFetchAddress, signal: AbortSignal): StandingArtifactFetchExchange {
  let resolveResponse!: (value: StandingArtifactFetchResponse) => void;
  let rejectResponse!: (error: unknown) => void;
  const response = new Promise<StandingArtifactFetchResponse>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  // Cancellation may occur before the caller starts awaiting response.
  void response.catch(() => {});
  let resolveSettled!: () => void;
  const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
  let requestClosed = false, socketClosed = true, responseClosed = true, responseReceived = false;
  let message: import("node:http").IncomingMessage | undefined;
  let socket: import("node:net").Socket | undefined;
  const finish = () => {
    if (requestClosed && socketClosed && responseClosed) { signal.removeEventListener("abort", destroy); resolveSettled(); }
  };
  // Host and TLS servername remain the DNS name. Only lookup is replaced; the
  // approved address is copied and never re-resolved, with no pooling/proxy.
  const req = httpsRequest(url, {
    // An explicit nonzero family also disables Node's automatic family selection.
    method: "GET", agent: false, family: address.family, maxHeaderSize: 16_384, insecureHTTPParser: false,
    servername: url.hostname, rejectUnauthorized: true,
    // Wikimedia and other public sources require an identifiable client.
    // This fixed honest identity is not a browser impersonation or caller header.
    headers: { "user-agent": "DecadansNeurobro/1.0 (Telegram assistant; public media fetch)", "accept-encoding": "identity", connection: "close" },
    lookup(_host, _options, callback) { callback(null, address.address, address.family); },
  });
  const destroy = () => { message?.destroy(); req.destroy(); socket?.destroy(); rejectResponse(new StandingArtifactFetchError("aborted")); };
  req.on("socket", assigned => {
    socket = assigned; socketClosed = false;
    assigned.once("close", () => { socketClosed = true; finish(); });
    if (signal.aborted) assigned.destroy();
  });
  req.on("response", incoming => {
    message = incoming; responseClosed = false; responseReceived = true;
    incoming.on("error", () => {});
    incoming.once("close", () => { responseClosed = true; finish(); });
    if (signal.aborted) { destroy(); return; }
    resolveResponse({ statusCode: incoming.statusCode ?? 0, rawHeaders: incoming.rawHeaders, body: incoming });
  });
  req.on("error", () => { rejectResponse(new StandingArtifactFetchError("network")); });
  req.once("close", () => {
    requestClosed = true;
    if (!responseReceived) rejectResponse(new StandingArtifactFetchError("network"));
    finish();
  });
  signal.addEventListener("abort", destroy, { once: true });
  if (signal.aborted) destroy(); else req.end();
  return Object.freeze({ response, settled, destroy });
}
const defaultPorts: StandingArtifactFetchPorts = Object.freeze({ resolve: resolvePublic, request: requestPinned });
function headerMap(raw: readonly string[]): Map<string, string[]> {
  if (!Array.isArray(raw) || raw.length % 2 || raw.length > 512) return refuse("headers");
  const result = new Map<string, string[]>();
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]!, value = raw[i + 1]!;
    if (typeof name !== "string" || typeof value !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
        /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value)) return refuse("headers");
    const key = name.toLowerCase(); result.set(key, [...(result.get(key) ?? []), key === "location" ? value : value.trim()]);
  }
  return result;
}
function singleHeader(headers: Map<string, string[]>, name: string): string | undefined {
  const values = headers.get(name); if (values && values.length !== 1) return refuse("headers"); return values?.[0];
}

/** Request-scoped, single-flight downloader. close revokes admission and joins
 * in-flight DNS and every owned exchange; registry lifetime belongs to its owner.
 * Fixed error codes never expose URL query secrets or upstream bodies/errors. */
export function createStandingArtifactFetcher(registry: StandingArtifactRegistry, ports: StandingArtifactFetchPorts = defaultPorts): Readonly<{
  fetch(input: StandingArtifactFetchInput, signal: AbortSignal): Promise<StandingArtifact>;
  close(): Promise<void>;
}> {
  const deadlineMs = ports.deadlineMs ?? 60_000;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) return refuse("shape");
  let closed = false, active: Promise<StandingArtifact> | undefined, cancel: (() => void) | undefined;
  return Object.freeze({
    fetch(input, signal) {
      if (closed) return Promise.reject(new StandingArtifactFetchError("closed"));
      if (active) return Promise.reject(new StandingArtifactFetchError("busy"));
      let captured: StandingArtifactFetchInput;
      try { captured = snapshot(input); } catch (error) { return Promise.reject(error); }
      const controller = new AbortController();
      let stopReason: Refusal = "aborted";
      const stopWith = (reason: Refusal) => { if (!controller.signal.aborted) { stopReason = reason; controller.abort(); } };
      const stop = () => stopWith("aborted");
      cancel = () => stopWith("closed");
      const deadlineAt = performance.now() + deadlineMs;
      const check = () => {
        if (!controller.signal.aborted && performance.now() >= deadlineAt) stopWith("deadline");
        if (controller.signal.aborted) return refuse(stopReason);
      };
      const timer = setTimeout(() => stopWith("deadline"), deadlineMs);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      const run = async (): Promise<StandingArtifact> => {
        let url = new URL(captured.url);
        const visited = new Set<string>();
        for (let hop = 0; ; hop++) {
          check();
          if (visited.has(url.href)) return refuse("redirect"); visited.add(url.href);
          let resolved: readonly StandingArtifactFetchAddress[];
          try { resolved = await ports.resolve(url.hostname, controller.signal); } catch { check(); return refuse("dns"); }
          check();
          if (!Array.isArray(resolved) || resolved.length < 1 || resolved.length > 64) return refuse("address");
          const addresses = resolved.map(item => Object.freeze({ address: item.address, family: item.family }));
          if (!addresses.every(item => (item.family === 4 || item.family === 6) && isIP(item.address) === item.family &&
              isStandingArtifactPublicAddress(item.address))) return refuse("address");
          check();
          let exchange: StandingArtifactFetchExchange;
          try { exchange = ports.request(new URL(url.href), addresses[0]!, controller.signal); } catch { check(); return refuse("network"); }
          let storage: Buffer | undefined;
          let bytes: Buffer | undefined, nextUrl: URL | undefined, mimeType = "application/octet-stream";
          try {
            const response = await exchange.response; check();
            const headers = headerMap(response.rawHeaders);
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
              if (hop >= 3) return refuse("redirect");
              const location = singleHeader(headers, "location");
              if (!location || !cleanText(location, 4096) || /[\s\\#]/u.test(location) || /^(?:https:)?\/{3}/iu.test(location) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(location) ||
                  /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*@/iu.test(location) ||
                  (/^[a-z][a-z0-9+.-]*:/iu.test(location) && !/^https:\/\//iu.test(location))) return refuse("redirect");
              try { nextUrl = validateStandingArtifactFetchUrl(new URL(location, url).href); } catch { return refuse("redirect"); }
            } else {
              if (response.statusCode !== 200) return refuse("status");
              const encoding = singleHeader(headers, "content-encoding");
              if (encoding !== undefined && encoding.toLowerCase() !== "identity") return refuse("headers");
              const length = singleHeader(headers, "content-length");
              const transfer = singleHeader(headers, "transfer-encoding");
              if (transfer !== undefined && (transfer.toLowerCase() !== "chunked" || length !== undefined)) return refuse("headers");
              if (length !== undefined && (!/^(?:0|[1-9][0-9]*)$/u.test(length) || length.length > 10 || Number(length) > STANDING_ARTIFACT_MAX_BYTES)) return refuse("size");
              const contentType = singleHeader(headers, "content-type");
              if (contentType !== undefined) {
                mimeType = contentType.split(";", 1)[0]!.trim().toLowerCase();
                if (mimeType.length > 127 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mimeType)) return refuse("headers");
              }
              let total = 0;
              // Fixed byte custody avoids unbounded per-chunk allocation overhead
              // when an upstream supplies millions of one-byte/empty chunks.
              storage = Buffer.alloc(length === undefined ? STANDING_ARTIFACT_MAX_BYTES : Number(length));
              for await (const chunk of response.body) {
                check();
                if (!(chunk instanceof Uint8Array)) return refuse("network");
                if (chunk.byteLength > STANDING_ARTIFACT_MAX_BYTES - total) return refuse("size");
                if (length !== undefined && total + chunk.byteLength > Number(length)) return refuse("size");
                storage.set(chunk, total); total += chunk.byteLength;
              }
              check();
              if (!total || (length !== undefined && total !== Number(length))) return refuse("size");
              bytes = Buffer.from(storage.subarray(0, total));
            }
          } catch (error) {
            check();
            if (error instanceof StandingArtifactFetchError) throw error;
            return refuse("network");
          } finally {
            exchange.destroy();
            try { await exchange.settled; } catch { bytes?.fill(0); return refuse("network"); }
            finally { storage?.fill(0); }
          }
          try {
            check();
            if (nextUrl) { url = nextUrl; continue; }
            if (!bytes) return refuse("network");
            return registry.accept({ source: { kind: "download", reference: url.href }, filename: captured.filename,
              mimeType, bytes, ...(captured.audio === undefined ? {} : { audio: captured.audio }) });
          } finally { bytes?.fill(0); }
        }
      };
      // Schedule after active is installed, so trusted port reentry cannot race it.
      const operation = Promise.resolve().then(run).finally(() => {
        clearTimeout(timer); signal.removeEventListener("abort", stop); active = undefined; cancel = undefined;
      });
      active = operation; return operation;
    },
    async close() { closed = true; cancel?.(); await active?.then(() => {}, () => {}); },
  });
}
