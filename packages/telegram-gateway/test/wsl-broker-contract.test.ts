import assert from "node:assert/strict";
import test from "node:test";
import { BrokerError, BrokerFramer, canonicalJson, decodeFrame, encodeFrame, exactKeys, sessionOptions, type BrokerSession, type FrameCore } from "../src/wsl-broker-contract.js";

const session: BrokerSession = { key: Buffer.alloc(32, 19), keyId: "fixture", sessionId: "a".repeat(32), now: () => 1000 };
const core = (): FrameCore => ({ version: 1, kind: "request", keyId: session.keyId, sessionId: session.sessionId, id: "b".repeat(32), sequence: 1, deadlineMs: 2000, body: { method: "snapshot.list", args: { prefix: "", limit: 2 } } });
const code = (wanted: string) => (error: unknown) => error instanceof BrokerError && error.code === wanted;

test("authenticated frame roundtrip preserves Unicode and primary whitespace", () => {
  const request = core(); request.body = { text: "  источник\n🦍\tend  " };
  const frame = encodeFrame(request, session);
  assert.equal(decodeFrame(frame, session, "request").body && canonicalJson(decodeFrame(frame, session, "request").body), canonicalJson(request.body));
  assert.equal(frame.at(-1), 10);
});
test("canonicalization refuses ambiguous JSON values and prototype keys", () => {
  assert.throws(() => exactKeys({ "limit|prefix": null }, ["limit", "prefix"]), BrokerError);
  assert.throws(() => exactKeys({ "a|b": null, c: null }, ["a", "b|c"]), BrokerError);
  for (const value of [NaN, Infinity, 1.5, undefined, new Date(), { x: "\ud800" }, JSON.parse('{"__proto__":1}'), { constructor: 1 }, { x: "\0" }]) assert.throws(() => canonicalJson(value), BrokerError);
  assert.equal(canonicalJson({ z: 1, a: [true, null] }), '{"a":[true,null],"z":1}');
  let deep: unknown = null; for (let i = 0; i < 14; i++) deep = [deep];
  assert.throws(() => canonicalJson(deep), code("json-budget"));
  assert.throws(() => canonicalJson(Array(4097).fill(null)), code("json-budget"));
});
test("MAC tamper, wrong key/session and reflected response are refused", () => {
  const encoded = encodeFrame(core(), session), parsed = JSON.parse(encoded.toString());
  parsed.body.args.limit = 1;
  assert.throws(() => decodeFrame(Buffer.from(canonicalJson(parsed) + "\n"), session, "request"), code("authentication-failed"));
  assert.throws(() => decodeFrame(encoded, { ...session, key: Buffer.alloc(32, 20) }, "request"), code("authentication-failed"));
  assert.throws(() => decodeFrame(encoded, { ...session, sessionId: "c".repeat(32) }, "request"), code("wrong-session"));
  assert.throws(() => decodeFrame(encoded, session, "response"), code("wrong-session"));
});
test("duplicate keys, whitespace, BOM, CRLF and invalid UTF8 never authenticate", () => {
  const raw = encodeFrame(core(), session).toString();
  for (const bytes of [Buffer.from(raw.replace('"version":1', '"version":1,"version":1')), Buffer.from(" " + raw), Buffer.from("\ufeff" + raw), Buffer.from(raw.replace(/\n$/, "\r\n")), Buffer.from([0xc0, 0xaf, 10])]) assert.throws(() => decodeFrame(bytes, session, "request"), BrokerError);
});
test("body and frame budgets apply independently on encode and decode", () => {
  const request = core(); request.body = { text: "x".repeat(100) };
  assert.throws(() => encodeFrame(request, { ...session, limits: { maxBodyBytes: 30 } }), code("body-budget"));
  assert.throws(() => encodeFrame(request, { ...session, limits: { maxFrameBytes: 150 } }), code("frame-budget"));
  assert.throws(() => decodeFrame(encodeFrame(request, session), { ...session, limits: { maxBodyBytes: 30 } }, "request"), code("body-budget"));
});
test("limits cannot expand and keys are copied", () => {
  for (const limits of [{ maxCalls: 33 }, { maxCalls: 0 }, { maxTextBytes: 1.5 }, { unexpected: 1 }]) assert.throws(() => sessionOptions({ ...session, limits }), BrokerError);
  const key = Buffer.alloc(32, 2), options = sessionOptions({ ...session, key }); key.fill(8); assert.equal(options.key[0], 2);
  assert.throws(() => sessionOptions({ ...session, key: Buffer.alloc(16) }), code("invalid-session"));
});
test("framer survives UTF8 byte splits and coalesced frames", () => {
  const encoded = encodeFrame(core(), session), f = new BrokerFramer();
  const frames = [...f.push(encoded.subarray(0, 1)), ...f.push(encoded.subarray(1, -1)), ...f.push(Buffer.concat([encoded.subarray(-1), encoded]))];
  assert.deepEqual(frames, [encoded, encoded]); f.end();
});
test("framer failures are sticky and truncated EOF refuses", () => {
  const f = new BrokerFramer(4); assert.deepEqual(f.push(Buffer.from("1234")), []);
  assert.throws(() => f.push(Buffer.from("5")), code("frame-budget")); assert.throws(() => f.push(Buffer.from("{}\n")), code("framer-closed"));
  const t = new BrokerFramer(); t.push(Buffer.from("{")); assert.throws(() => t.end(), code("truncated-frame"));
  assert.throws(() => new BrokerFramer().push(Buffer.from("\n")), code("empty-frame"));
});
