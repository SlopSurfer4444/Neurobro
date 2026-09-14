import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createStandingArtifactRegistry, validateStandingArtifact, StandingArtifactError,
  STANDING_ARTIFACT_MAX_BYTES, type StandingArtifactInput } from "../src/standing-artifact.js";

const input = (bytes: Buffer = Buffer.from([0, 255, 81, 7])): StandingArtifactInput => ({
  source: { kind: "download", reference: "https://MEDIA.wikipedia.org:443/file?q=1" }, filename: "report.custom", mimeType: "application/x-custom", bytes,
});
// MPEG1 Layer III,128kb/s,44.1kHz, stereo. Zero side information has no
// reservoir reference and zero coded samples; padding completes each frame.
function mp3(frames = 3): Buffer {
  return Buffer.concat(Array.from({ length: frames }, () => {
    const frame = Buffer.alloc(417); frame.set([255, 251, 144, 0]); return frame;
  }));
}
const audioInput = (bytes = mp3()): StandingArtifactInput => ({ ...input(bytes), filename: "sound.mp3", mimeType: "audio/mpeg",
  audio: { durationSeconds: 900, title: "Sound", performer: "Artist" } });
function rejected(fn: () => unknown, code?: string): void {
  assert.throws(fn, (error: unknown) => error instanceof StandingArtifactError && (code === undefined || error.code === code));
}
test("generic bytes preserved; metadata, normalized provenance and references frozen", () => {
  const registry = createStandingArtifactRegistry({ requestRef: "request1" }), source = input();
  const artifact = registry.accept(source);
  assert.match(artifact.ref, /^art_[a-f0-9]{48}$/u);
  assert.equal(artifact.requestRef, "request1"); assert.equal(artifact.mimeType, "application/x-custom");
  assert.equal(artifact.source.reference, "https://media.wikipedia.org/file?q=1");
  assert.equal(artifact.sha256, createHash("sha256").update(source.bytes).digest("hex"));
  assert.ok(Object.isFrozen(artifact)); assert.ok(Object.isFrozen(artifact.source));
  assert.equal(registry.get(artifact.ref), artifact); assert.deepEqual(registry.copyBytes(artifact.ref), source.bytes);
  source.bytes.fill(9); const copy = registry.copyBytes(artifact.ref); copy.fill(4);
  assert.deepEqual(registry.copyBytes(artifact.ref), Buffer.from([0, 255, 81, 7]));
  registry.close(); registry.close(); rejected(() => registry.get(artifact.ref), "closed");
  rejected(() => registry.copyBytes(artifact.ref), "closed"); rejected(() => registry.accept(input()), "closed");
});
test("accepted metadata is compatible with Telegram document/audio admission", () => {
  const registry = createStandingArtifactRegistry({ requestRef: "metadata-boundary" });
  const accepted = registry.accept({ ...input(), filename: "я".repeat(125) + ".txt", mimeType: "APPLICATION/X-CUSTOM" });
  assert.equal(accepted.mimeType, "application/x-custom"); assert.ok(Buffer.byteLength(accepted.filename) <= 255);
  rejected(() => registry.accept({ ...input(), filename: "я".repeat(126) + ".txt" }), "filename");
  rejected(() => registry.accept({ ...input(), mimeType: "application/" + "x".repeat(116) }), "mime");
  rejected(() => registry.accept({ ...input(), mimeType: "application/x%custom" }), "mime");
  rejected(() => registry.accept(input(Buffer.alloc(0))), "size");
  for (const field of ["title", "performer"] as const) {
    rejected(() => registry.accept({ ...audioInput(), audio: { durationSeconds: 1, [field]: "я".repeat(128) } }), "audio");
  }
  const audio = registry.accept({ ...audioInput(), mimeType: "Audio/MPEG", audio: { durationSeconds: 1, title: "я".repeat(127) } });
  assert.equal(audio.mimeType, "audio/mpeg"); registry.close();
});
test("MP3 duration derived from complete frames, survives checked reopen", () => {
  const registry = createStandingArtifactRegistry({ requestRef: "request" }), bytes = mp3();
  const artifact = registry.accept(audioInput(bytes));
  assert.equal(artifact.audio!.durationSeconds, 3 * 1152 / 44100);
  assert.ok(Object.isFrozen(artifact.audio));
  assert.deepEqual(validateStandingArtifact(artifact, bytes), artifact);
  rejected(() => validateStandingArtifact({ ...artifact, audio: { durationSeconds: 123 } }, bytes), "binding");
  rejected(() => validateStandingArtifact({ ...artifact, byteLength: 2 }, bytes), "binding");
  rejected(() => validateStandingArtifact({ ...artifact, sha256: "0".repeat(64) }, bytes), "binding");
  rejected(() => validateStandingArtifact({ ...artifact, ref: "art_wrong" }, bytes));
  registry.close();
});
test("generic binary MIME becomes audio only after explicit complete MP3 validation", () => {
  const registry = createStandingArtifactRegistry({requestRef:"binary-audio"}), bytes=mp3();
  const audio=registry.accept({...audioInput(bytes),mimeType:"application/octet-stream"});
  assert.equal(audio.mimeType,"audio/mpeg"); assert.equal(audio.audio!.durationSeconds,3456/44100);
  assert.deepEqual(validateStandingArtifact(audio,bytes),audio);
  rejected(()=>validateStandingArtifact({...audio,mimeType:"application/octet-stream"},bytes),"binding");
  const plain=registry.accept({...input(bytes),filename:"sound.mp3",mimeType:"application/octet-stream"});
  assert.equal(plain.mimeType,"application/octet-stream"); assert.equal(plain.audio,undefined);
  rejected(()=>registry.accept({...audioInput(Buffer.from("<html>not audio</html>")),mimeType:"application/octet-stream"}),"audio");
  rejected(()=>registry.accept({...audioInput(),mimeType:"text/html"}),"audio");
  rejected(()=>registry.accept({...audioInput(mp3().subarray(0,-1)),mimeType:"application/octet-stream"}),"audio");
  registry.close();
});

test("bounded ID3 prefix and footer, ID3v1 suffix accepted", () => {
  const registry = createStandingArtifactRegistry({ requestRef: "req" });
  const prefix = Buffer.from([73,68,51,4,0,0,0,0,0,2,0,0]);
  const tail = Buffer.alloc(128); tail.write("TAG");
  assert.equal(registry.accept(audioInput(Buffer.concat([prefix, mp3(), tail]))).audio!.durationSeconds, 3456 / 44100);
  const header = Buffer.from([73,68,51,4,0,16,0,0,0,0]);
  const footer = Buffer.from(header); footer.write("3DI");
  assert.ok(registry.accept(audioInput(Buffer.concat([header, footer, mp3()]))).audio);
  registry.close();
});
test("MP3 rejects spoofs, truncated bodies, extra bytes and invalid tags", () => {
  const registry = createStandingArtifactRegistry({ requestRef: "req" });
  const badHeader = mp3(); badHeader[2] = 0;
  for (const bytes of [Buffer.alloc(0), Buffer.from("not mp3"), mp3().subarray(0, 416),
    Buffer.concat([mp3(), Buffer.from([0])]), badHeader,
    Buffer.from([73,68,51,4,0,0,127,127,127,127]), Buffer.from([73,68,51,4,0,0,128,0,0,0]),
    Buffer.concat([Buffer.from([73,68,51,4,0,16,0,0,0,0]), mp3()])]) rejected(() => registry.accept(audioInput(bytes)), bytes.length ? "audio" : "size");
  rejected(() => registry.accept({ ...audioInput(), mimeType: "audio/wav" }), "audio");
  // MIME alone stays unverified metadata for generic document delivery.
  assert.ok(registry.accept({ ...input(Buffer.from("not mp3")), mimeType: "audio/mpeg" }));
  registry.close();
});
test("wrong refs and scopes cannot cross registries", () => {
  const a = createStandingArtifactRegistry({ requestRef: "a" }), b = createStandingArtifactRegistry({ requestRef: "b" });
  const item = a.accept(input()); rejected(() => b.get(item.ref), "reference");
  rejected(() => a.copyBytes("art_unknown"), "reference");
  rejected(() => a.accept({ ...input(), requestRef: "b" } as StandingArtifactInput), "shape");
  a.close(); b.close();
});
test("filename path/traversal/control rejection", () => {
  const r = createStandingArtifactRegistry({ requestRef: "req" });
  for (const filename of ["../a", "..\\a", "/tmp/a", "C:\\a", "a:b", "..", ".", "a\n", "a\u0000", "NUL.txt", "a.", " a"])
    rejected(() => r.accept({ ...input(), filename }), "filename");
  assert.ok(r.accept({ ...input(), filename: "Отчёт 2026.bin" })); r.close();
});
test("download provenance rejects credentials/local addresses and fragments", () => {
  const r = createStandingArtifactRegistry({ requestRef: "req" });
  for (const reference of ["file:///C:/a", "http://wikipedia.org/a", "https://user:pass@wikipedia.org/a", "https://127.0.0.1/a",
    "https://[::1]/a", "https://2130706433/a", "https://localhost/a", "https://x.local/a", "https://x.internal/a",
    "https://@wikipedia.org/a", "https:wikipedia.org/a", "https://wikipedia.org/a#", "https://wikipedia.org/a#b", "https://wikipedia.org:8443/a", "https://wikipedia.org/%0A", "https://wiki\npedia.org/"])
    rejected(() => r.accept({ ...input(), source: { kind: "download", reference } }), "source");
  for (const kind of ["generated", "attachment"] as const) {
    assert.ok(r.accept({ ...input(), source: { kind, reference: "source_123" } }));
    rejected(() => r.accept({ ...input(), source: { kind, reference: "C:/file" } }), "source");
  }
  r.close();
});
test("descriptor getters/proxies are never invoked, hostile buffer overrides ignored", () => {
  const r = createStandingArtifactRegistry({ requestRef: "req" }); let called = 0;
  rejected(() => r.accept({ ...input(), get filename() { called++; return "x"; } }), "shape");
  const source = Object.defineProperty({}, "kind", { get() { called++; return "download"; }, enumerable: true });
  rejected(() => r.accept({ ...input(), source } as StandingArtifactInput), "shape");
  rejected(() => r.accept(new Proxy(input(), { ownKeys() { called++; return []; } })), "shape");
  const bytes = Buffer.from([4, 5]); Object.defineProperty(bytes, "buffer", { get() { called++; throw Error(); } });
  assert.deepEqual(r.copyBytes(r.accept(input(bytes)).ref), Buffer.from([4, 5]));
  assert.equal(called, 0); r.close();
});
test("shared storage rejected; oversized files and count/aggregate budgets enforced", () => {
  const r = createStandingArtifactRegistry({ requestRef: "req" });
  rejected(() => r.accept(input(Buffer.from(new SharedArrayBuffer(1)))), "shape");
  rejected(() => r.accept(input(Buffer.alloc(STANDING_ARTIFACT_MAX_BYTES + 1))), "size");
  const bytes = Buffer.alloc(STANDING_ARTIFACT_MAX_BYTES, 3);
  r.accept(input(bytes)); r.accept(input(bytes)); rejected(() => r.accept(input(Buffer.from([1]))), "capacity"); r.close();
  const count = createStandingArtifactRegistry({ requestRef: "req" });
  for (let i = 0; i < 8; i++) count.accept(input(Buffer.alloc(1)));
  rejected(() => count.accept(input(Buffer.alloc(1))), "capacity"); count.close();
});
