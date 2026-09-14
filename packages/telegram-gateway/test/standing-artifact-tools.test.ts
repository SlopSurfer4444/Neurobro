import test from "node:test";
import assert from "node:assert/strict";
import { createStandingArtifactRegistry, StandingArtifactError, type StandingArtifact } from "../src/standing-artifact.js";
import { createStandingArtifactFetcher, StandingArtifactFetchError } from "../src/standing-artifact-fetch.js";
import { createStandingArtifactTools, STANDING_ARTIFACT_TOOL_SPECS, type StandingArtifactToolPorts, type StandingArtifactSendOutcome } from "../src/standing-artifact-tools.js";
import { createStandingToolDispatcher, type EpochToolResult, type EpochToolScope } from "../src/standing-tool-dispatcher.js";

const decode = (value: EpochToolResult) => JSON.parse(value.contentItems[0].text) as Record<string, unknown>;
const fetchArgs = () => ({ url: "https://en.wikipedia.org/file", filename: "file.bin" });
function fixture() {
  const controller = new AbortController(), registry = createStandingArtifactRegistry({ requestRef: "request1" });
  const artifact = registry.accept({ source: { kind: "generated", reference: "source1" }, filename: "file.bin", mimeType: "application/octet-stream", bytes: Buffer.from([1, 2, 3]) });
  const scope: EpochToolScope = Object.freeze({ requestRef: "request1", callRef: "call1", signal: controller.signal });
  let fetches = 0, creates = 0, sends = 0, planAttempts = 0, plannedTarget: string | undefined, lastSend: string | undefined;
  const ports: StandingArtifactToolPorts = { signal: controller.signal, get: ref => registry.get(ref),
    async fetch() { fetches++; return artifact; },
    createText(request, scoped) { creates++; assert.equal(scoped.requestRef, scope.requestRef); return registry.accept({ source: { kind: "generated", reference: "created" + creates },
      filename: request.filename, mimeType: request.mimeType, bytes: Buffer.from(request.text) }); },
    planGeneratedImageUse(target, scoped) { planAttempts++; assert.equal(scoped.requestRef, scope.requestRef); plannedTarget = target; return true; },
    async send(request, scoped) { sends++; lastSend = request.artifactRef; assert.equal(scoped.requestRef, scope.requestRef); return { verdict: "verified", messageId: 12 }; } };
  return { ports, scope, artifact, controller, registry, fetches: () => fetches, creates: () => creates, sends: () => sends,
    planAttempts: () => planAttempts, plannedTarget: () => plannedTarget, lastSend: () => lastSend };
}
test("exact four named specs and actual dispatcher create, plan and send", async () => {
  const f = fixture(), tools = createStandingArtifactTools(f.ports);
  assert.deepEqual(STANDING_ARTIFACT_TOOL_SPECS.map(s => s.name), ["neurobro_fetch_artifact", "neurobro_send_artifact", "neurobro_create_text_file", "neurobro_plan_generated_image_use"]);
  for (const spec of STANDING_ARTIFACT_TOOL_SPECS) { assert.equal(spec.inputSchema.additionalProperties, false); assert.ok(Object.isFrozen(spec.inputSchema)); }
  const dispatcher = createStandingToolDispatcher({ call: async () => { throw Error("unused"); } }, tools.handlers);
  const fetched = await dispatcher.call("neurobro_fetch_artifact", fetchArgs(), f.scope);
  assert.equal(fetched.success, true); const metadata = decode(fetched);
  assert.equal(metadata.artifactRef, f.artifact.ref); assert.equal(metadata.byteLength, 3);
  for (const key of ["bytes", "source", "requestRef", "chatId", "accountId", "path"]) assert.equal(Object.hasOwn(metadata, key), false);
  const created = await dispatcher.call("neurobro_create_text_file", { filename: "notes.md", text: "# Привет\n\nvalue,\t1\r\n" }, f.scope);
  assert.equal(created.success, true); const createdMetadata = decode(created);
  assert.equal(createdMetadata.schema, "neurobro-artifact-create-text-v1"); assert.equal(createdMetadata.filename, "notes.md");
  assert.equal(createdMetadata.mimeType, "text/markdown"); assert.equal(createdMetadata.byteLength, Buffer.byteLength("# Привет\n\nvalue,\t1\r\n"));
  for (const key of ["bytes", "text", "source", "requestRef", "chatId", "accountId", "path"]) assert.equal(Object.hasOwn(createdMetadata, key), false);
  const planned = await dispatcher.call("neurobro_plan_generated_image_use", { target: "self-avatar" }, f.scope);
  assert.deepEqual({ success: planned.success, ...decode(planned) }, { success: true, schema: "neurobro-generated-image-use-v1", status: "pending", target: "self-avatar" });
  assert.equal(f.fetches(), 1); assert.equal(f.creates(), 1); assert.equal(f.sends(), 0); assert.equal(f.plannedTarget(), "self-avatar");
  const sent = await dispatcher.call("neurobro_send_artifact", { artifactRef: createdMetadata.artifactRef, caption: "Here" }, f.scope);
  assert.equal(sent.success, true); assert.equal(decode(sent).verdict, "verified"); assert.equal(decode(sent).messageId, 12);
  assert.equal(f.lastSend(), createdMetadata.artifactRef); assert.equal(f.fetches(), 1); assert.equal(f.creates(), 1); assert.equal(f.sends(), 1); assert.equal(f.planAttempts(), 1);
  await dispatcher.close(); await tools.close(); f.registry.close();
});
test("forbidden selectors, credentials and malformed args never call ports", async () => {
  const f = fixture(), tools = createStandingArtifactTools(f.ports);
  const fetch = tools.handlers[0]!.call, send = tools.handlers[1]!.call, create = tools.handlers[2]!.call, plan = tools.handlers[3]!.call;
  for (const args of [{ ...fetchArgs(), headers: {} }, { ...fetchArgs(), cookie: "private" }, { ...fetchArgs(), authorization: "secret" },
    { ...fetchArgs(), filename: "../x" }, { ...fetchArgs(), url: "https://user:pass@en.wikipedia.org/file" },
    { ...fetchArgs(), audio: null }, { ...fetchArgs(), audio: { durationSeconds: NaN } },
    { ...fetchArgs(), audio: { durationSeconds: 0, title: "я".repeat(128) } }])
    assert.equal(decode(await fetch(args, f.scope)).code, "invalid-arguments");
  for (const extra of [{ chatId: "-100123" }, { accountId: "42" }, { path: "C:/x" }, { operationSlot: 1 }, { mediaKind: "photo" }])
    assert.equal(decode(await send({ artifactRef: f.artifact.ref, caption: "", ...extra }, f.scope)).code, "invalid-arguments");
  for (const args of [
    { filename: "../x.txt", text: "x" }, { filename: "CON.txt", text: "x" }, { filename: "x.exe", text: "x" },
    { filename: "x.txt", text: "" }, { filename: "x.txt", text: "a\0b" }, { filename: "x.txt", text: "a\u0001b" }, { filename: "x.txt", text: "a\u0085b" },
    { filename: "x.txt", text: "\ud800" }, { filename: "x.txt", text: "я".repeat(32769) }, { filename: "x.txt", text: "a".repeat(65537) },
    { filename: "x.json", text: "{broken" }, { filename: "x.txt", text: "x", path: "C:/private" },
  ]) assert.equal(decode(await create(args, f.scope)).code, "invalid-arguments");
  for (const args of [{}, { target: "chat-avatar" }, { target: "self-avatar", chatId: "-100" }, { target: null }])
    assert.equal(decode(await plan(args, f.scope)).code, "invalid-arguments");
  assert.equal(f.fetches(), 0); assert.equal(f.creates(), 0); assert.equal(f.sends(), 0); assert.equal(f.planAttempts(), 0); await tools.close(); f.registry.close();
});
test("text creation derives the four supported MIME types and preserves exact UTF-8 text", async () => {
  const f = fixture(), tools = createStandingArtifactTools(f.ports), create = tools.handlers[2]!.call;
  for (const [filename, text, mimeType] of [["a.TXT", "plain\n", "text/plain"], ["a.md", "# title\n", "text/markdown"],
    ["a.csv", "x,y\r\n1,2\r\n", "text/csv"], ["a.json", "{\"ok\":true}", "application/json"]] as const) {
    const result = await create({ filename, text }, f.scope), metadata = decode(result);
    assert.equal(result.success, true); assert.equal(metadata.mimeType, mimeType);
    assert.deepEqual(f.registry.copyBytes(metadata.artifactRef as string), Buffer.from(text));
  }
  assert.equal(f.creates(), 4); await tools.close(); f.registry.close();
});
test("legacy fetch-send hosts without optional create or plan ports refuse only those tools", async () => {
  const f = fixture(), { createText: _createOmitted, planGeneratedImageUse: _planOmitted, ...legacy } = f.ports, tools = createStandingArtifactTools(legacy);
  assert.deepEqual(decode(await tools.handlers[2]!.call({ filename: "x.txt", text: "x" }, f.scope)),
    { schema: "neurobro-artifact-tool-error-v1", code: "unavailable" });
  assert.deepEqual(decode(await tools.handlers[3]!.call({ target: "self-avatar" }, f.scope)),
    { schema: "neurobro-artifact-tool-error-v1", code: "unavailable" });
  assert.equal((await tools.handlers[0]!.call(fetchArgs(), f.scope)).success, true);
  assert.equal((await tools.handlers[1]!.call({ artifactRef: f.artifact.ref, caption: "x" }, f.scope)).success, true);
  await tools.close(); f.registry.close();
});
test("snapshot rejects proxy and getters without invoking caller code", async () => {
  const f = fixture(), tools = createStandingArtifactTools(f.ports); let called = 0;
  const bad = { ...fetchArgs(), get url() { called++; return "https://en.wikipedia.org"; } };
  assert.equal(decode(await tools.handlers[0]!.call(bad, f.scope)).code, "invalid-arguments");
  const proxy = new Proxy(fetchArgs(), { getPrototypeOf() { called++; throw Error(); }, ownKeys() { called++; throw Error(); } });
  assert.equal(decode(await tools.handlers[0]!.call(proxy, f.scope)).code, "invalid-arguments");
  const nested = { ...fetchArgs(), audio: { get durationSeconds() { called++; return 0; } } };
  assert.equal(decode(await tools.handlers[0]!.call(nested, f.scope)).code, "invalid-arguments");
  const target = { get target() { called++; return "self-avatar"; } };
  assert.equal(decode(await tools.handlers[3]!.call(target, f.scope)).code, "invalid-arguments");
  const scope = new Proxy(f.scope, { getPrototypeOf() { called++; throw Error(); } });
  assert.equal(decode(await tools.handlers[0]!.call(fetchArgs(), scope)).code, "invalid-scope");
  assert.equal(called, 0); await tools.close(); f.registry.close();
});
test("generated-image plan is immutable and every repeat or target change is refused", async () => {
  const f = fixture(), tools = createStandingArtifactTools(f.ports), plan = tools.handlers[3]!.call;
  assert.equal((await plan({ target: "group-avatar" }, f.scope)).success, true);
  for (const target of ["group-avatar", "self-avatar"])
    assert.deepEqual(decode(await plan({ target }, f.scope)), { schema: "neurobro-artifact-tool-error-v1", code: "unavailable" });
  assert.equal(f.plannedTarget(), "group-avatar"); assert.equal(f.planAttempts(), 1);
  assert.equal(f.fetches(), 0); assert.equal(f.creates(), 0); assert.equal(f.sends(), 0); await tools.close(); f.registry.close();
});
test("cross-request and forged registry references never send", async () => {
  const f = fixture(), tools = createStandingArtifactTools(f.ports);
  assert.equal((await tools.handlers[1]!.call({ artifactRef: f.artifact.ref, caption: "x" }, { ...f.scope, requestRef: "other" })).success, false);
  assert.equal((await tools.handlers[1]!.call({ artifactRef: "art_" + "0".repeat(48), caption: "x" }, f.scope)).success, false);
  assert.equal((await tools.handlers[1]!.call({ artifactRef: f.artifact.ref, caption: "x", mediaKind: "audio" }, f.scope)).success, false);
  assert.equal(f.sends(), 0); await tools.close(); f.registry.close();
  const g = fixture(), forged = createStandingArtifactTools({ ...g.ports, get: () => ({ ...g.artifact, requestRef: "other" }) });
  assert.equal((await forged.handlers[0]!.call(fetchArgs(), g.scope)).success, false); await forged.close(); g.registry.close();
});
test("fetch detached arguments survive mutation and registry corroborates fetched result", async () => {
  const f = fixture(); let received: unknown;
  const tools = createStandingArtifactTools({ ...f.ports, fetch: async request => { received = request; return f.artifact; } });
  const args = { ...fetchArgs(), audio: { durationSeconds: 0, title: "first" } };
  const work = tools.handlers[0]!.call(args, f.scope); args.filename = "changed.bin"; args.audio.title = "changed";
  assert.equal((await work).success, true); assert.deepEqual(received, { ...fetchArgs(), audio: { durationSeconds: 0, title: "first" } });
  assert.ok(Object.isFrozen(received)); await tools.close();
  const mismatch = createStandingArtifactTools({ ...f.ports, fetch: async () => ({ ...f.artifact, sha256: "0".repeat(64) }) });
  assert.equal((await mismatch.handlers[0]!.call(fetchArgs(), f.scope)).success, false); await mismatch.close(); f.registry.close();
});
test("send preserves verdicts and never leaks raw errors or port extras", async () => {
  for (const verdict of ["verified", "unknown", "refused", "failed_terminal"] as const) {
    const f = fixture(), tools = createStandingArtifactTools({ ...f.ports, send: async () => ({ verdict }) });
    const result = await tools.handlers[1]!.call({ artifactRef: f.artifact.ref, caption: "x" }, f.scope);
    assert.equal(result.success, verdict === "verified"); assert.equal(decode(result).verdict, verdict); await tools.close(); f.registry.close();
  }
  for (const send of [async () => { throw Error("C:/private token=secret"); }, async () => ({ verdict: "verified", private: "secret" }) as StandingArtifactSendOutcome,
    async () => ({ verdict: "unknown", messageId: 123 }) as StandingArtifactSendOutcome]) {
    const f = fixture(), tools = createStandingArtifactTools({ ...f.ports, send });
    const result = await tools.handlers[1]!.call({ artifactRef: f.artifact.ref, caption: "x" }, f.scope);
    assert.equal(result.success, false); assert.equal(result.contentItems[0].text.includes("secret"), false); await tools.close(); f.registry.close();
  }
});
test("singleflight and close join actual delayed send settlement after abort", async () => {
  const f = fixture(); let release!: () => void, entered!: () => void, joined = false, observedSignal: AbortSignal | undefined;
  const pending = new Promise<void>(r => { release = r; }), began = new Promise<void>(r => { entered = r; });
  const tools = createStandingArtifactTools({ ...f.ports, send: async (_request, scope) => { observedSignal = scope.signal; entered(); await pending; return { verdict: "verified" }; } });
  const active = tools.handlers[1]!.call({ artifactRef: f.artifact.ref, caption: "x" }, f.scope); await began;
  assert.equal(decode(await tools.handlers[0]!.call(fetchArgs(), f.scope)).code, "busy");
  const closed = tools.close().then(() => { joined = true; }); await Promise.resolve();
  assert.equal(observedSignal!.aborted, true); assert.equal(joined, false);
  assert.equal(decode(await tools.handlers[0]!.call(fetchArgs(), f.scope)).code, "stopped");
  release(); const result = await active; await closed;
  assert.equal(result.success, false); assert.equal(decode(result).code, "stopped"); assert.equal(joined, true); f.registry.close();
});
test("scope abort forwards cancellation and blocks result until fetch settles", async () => {
  const f = fixture(), scopeStop = new AbortController(); let release!: (value: StandingArtifact) => void, entered!: () => void, signal: AbortSignal | undefined, finished = false;
  const pending = new Promise<StandingArtifact>(r => { release = r; }), began = new Promise<void>(r => { entered = r; });
  const tools = createStandingArtifactTools({ ...f.ports, fetch: async (_request, s) => { signal = s; entered(); return pending; } });
  const work = tools.handlers[0]!.call(fetchArgs(), { ...f.scope, signal: scopeStop.signal }).then(v => { finished = true; return v; }); await began;
  scopeStop.abort(); await Promise.resolve(); assert.equal(signal!.aborted, true); assert.equal(finished, false);
  release(f.artifact); assert.equal(decode(await work).code, "stopped"); await tools.close(); f.registry.close();
});
test("pre-stopped signals never invoke either port", async () => {
  const f = fixture(); f.controller.abort(); const tools = createStandingArtifactTools(f.ports);
  for (const handler of tools.handlers) assert.equal(decode(await handler.call({}, f.scope)).code, "stopped");
  assert.equal(f.fetches(), 0); assert.equal(f.creates(), 0); assert.equal(f.sends(), 0); assert.equal(f.planAttempts(), 0); await tools.close(); f.registry.close();
});

test("real fetcher status refusal reaches the model as actionable bounded failure metadata", async () => {
  const f = fixture(); let settled = false, sends = 0;
  const fetcher = createStandingArtifactFetcher(f.registry, {
    async resolve() { return [{address:"93.184.216.34", family:4}]; },
    request() { return { response: Promise.resolve({statusCode:403,rawHeaders:[],body:(async function*(){yield Buffer.from("upstream secret");})()}),
      settled: Promise.resolve().then(() => {settled = true;}), destroy() {} }; },
  });
  const tools = createStandingArtifactTools({...f.ports, fetch:(args,signal)=>fetcher.fetch(args,signal), send:async()=>{sends++;return {verdict:"unknown"};}});
  try {
    const result = await tools.handlers[0]!.call(fetchArgs(), f.scope), value = decode(result);
    assert.equal(result.success,false); assert.equal(value.code,"unavailable"); assert.equal(value.reason,"status");
    assert.equal(value.operation,"fetch"); assert.match(String(value.nextAction),/another direct public file/);
    assert.equal(result.contentItems[0].text.includes("upstream secret"),false);
    assert.equal(sends,0); assert.equal(settled,true);
  } finally { await tools.close(); await fetcher.close(); f.registry.close(); }
});

test("fetch reasons distinguish network, source, format and capacity without leaking thrown fields", async () => {
  for (const [error, reason] of [
    [new StandingArtifactFetchError("dns"),"dns"], [new StandingArtifactFetchError("deadline"),"deadline"],
    [new StandingArtifactFetchError("size"),"size"], [new StandingArtifactFetchError("address"),"address"],
    [new StandingArtifactError("audio"),"audio-format"], [new StandingArtifactError("capacity"),"capacity"],
  ] as const) {
    const f=fixture(), tools=createStandingArtifactTools({...f.ports,fetch:async()=>{throw Object.assign(error,{private:"secret",url:"https://private/?token=secret"});}});
    const result=await tools.handlers[0]!.call(fetchArgs(),f.scope);
    assert.equal(decode(result).reason,reason); assert.equal(result.contentItems[0].text.includes("secret"),false);
    assert.equal(result.success,false); await tools.close(); f.registry.close();
  }
});

test("arbitrary exceptions, proxy or getter diagnostics cannot fabricate a known fetch failure", async () => {
  let traps=0;
  const getter=new StandingArtifactFetchError("status"); Object.defineProperty(getter,"code",{get(){traps++;return "status";}});
  const errors=[new Error("secret"),{code:"status"},getter,new Proxy(new StandingArtifactFetchError("status"),{getPrototypeOf(){traps++;throw Error();}})];
  for (const error of errors) {
    const f=fixture(),tools=createStandingArtifactTools({...f.ports,fetch:async()=>{throw error;}});
    assert.deepEqual(decode(await tools.handlers[0]!.call(fetchArgs(),f.scope)),{schema:"neurobro-artifact-tool-error-v1",code:"unavailable"});
    await tools.close(); f.registry.close();
  }
  assert.equal(traps,0);
});
