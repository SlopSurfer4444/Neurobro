import test from "node:test";
import assert from "node:assert/strict";
import { createStandingNamedToolDispatcher, createStandingToolDispatcher, StandingToolDispatchError, type EpochExtraTool } from "../src/standing-tool-dispatcher.js";

const result = (value: unknown) => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] });
const scope = () => ({ requestRef: "synthetic-request", callRef: "synthetic-call", signal: new AbortController().signal });
const names = ["neurobro_analysis_material", "neurobro_analysis_notes", "neurobro_analysis_commit"];
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test("isolated named scope exposes exactly registered analysis tools, while legacy keeps implicit history", async () => {
  const seen: string[] = [];
  const tools = names.map(name => ({ name, async call() { seen.push(name); return result({ name }); } }));
  const isolated = createStandingNamedToolDispatcher(tools);
  assert.deepEqual(isolated.names, names);
  for (const name of names) assert.equal((await isolated.call(name, {}, scope())).success, true);
  await assert.rejects(isolated.call("neurobro_read_history", {}, scope()), StandingToolDispatchError);
  assert.deepEqual(seen, names);
  let historyCalls = 0;
  const legacy = createStandingToolDispatcher({ async call() { historyCalls++; return result({ history: true }); } }, tools);
  assert.deepEqual(legacy.names, ["neurobro_read_history", ...names]);
  await legacy.call("neurobro_read_history", {}, scope()); assert.equal(historyCalls, 1);
  await isolated.close(); await legacy.close();
});

test("named scopes retain result byte guards and canonical frozen results", async () => {
  let output: unknown = result({ body: "initial" });
  const dispatcher = createStandingNamedToolDispatcher([{ name: names[0]!, async call() { return output; } }]);
  const accepted = await dispatcher.call(names[0]!, {}, scope());
  (output as ReturnType<typeof result>).contentItems[0]!.text = "changed";
  assert.equal(accepted.contentItems[0].text, JSON.stringify({ body: "initial" })); assert.ok(Object.isFrozen(accepted.contentItems[0]));
  output = result({ body: "a".repeat(65536) });
  await assert.rejects(dispatcher.call(names[0]!, {}, scope()), StandingToolDispatchError);
  output = { success: true, contentItems: [{ type: "inputText", text: "not JSON" }] };
  await assert.rejects(dispatcher.call(names[0]!, {}, scope()), StandingToolDispatchError);
  await dispatcher.close();
});

test("bounded decoded material survives the existing double-encoded tool-result envelope", async () => {
  const overhead = Buffer.byteLength(JSON.stringify({ schema: "synthetic-material", text: "" }));
  // Backslashes expand once in the decoded view and again in the tool envelope.
  const count = Math.floor((49152 - overhead) / 2);
  const material = { schema: "synthetic-material", text: "\\".repeat(count) };
  const decoded = JSON.stringify(material);
  assert.ok(Buffer.byteLength(decoded) <= 49152);
  assert.ok(Buffer.byteLength(decoded) >= 49150);
  const dispatcher = createStandingNamedToolDispatcher([{ name: names[0]!, async call() { return result(material); } }]);
  const sent = await dispatcher.call(names[0]!, {}, scope());
  assert.equal(sent.contentItems[0].text, decoded);
  assert.deepEqual(JSON.parse(sent.contentItems[0].text), material);
  const wireBytes = Buffer.byteLength(JSON.stringify(sent));
  assert.ok(wireBytes > 49152); assert.ok(wireBytes <= 131584);
  await dispatcher.close();
});

test("close joins an actual named handler and refuses its late result without admitting another call", async () => {
  const entered = gate(), finish = gate(); let count = 0;
  const dispatcher = createStandingNamedToolDispatcher([{ name: names[0]!, async call() {
    count++; entered.resolve(); await finish.promise; return result({ done: true });
  } }]);
  const pending = dispatcher.call(names[0]!, {}, scope()); const rejected = assert.rejects(pending, StandingToolDispatchError);
  await entered.promise;
  await assert.rejects(dispatcher.call(names[0]!, {}, scope()), StandingToolDispatchError);
  let closed = false; const closing = dispatcher.close().then(() => { closed = true; });
  await new Promise<void>(done => setImmediate(done)); assert.equal(closed, false);
  finish.resolve(); await closing; await rejected; assert.equal(count, 1);
  await assert.rejects(dispatcher.call(names[0]!, {}, scope()), StandingToolDispatchError);
});

test("named registration rejects empty, duplicate and accessor entries before any handler", () => {
  assert.throws(() => createStandingNamedToolDispatcher([]), StandingToolDispatchError);
  const entry: EpochExtraTool = { name: names[0]!, async call() { throw Error("must not run"); } };
  assert.throws(() => createStandingNamedToolDispatcher([entry, entry]), StandingToolDispatchError);
  let accessed = 0;
  const hostile = Object.defineProperty({ name: names[0]! }, "call", { get() { accessed++; return entry.call; } });
  assert.throws(() => createStandingNamedToolDispatcher([hostile as EpochExtraTool]), StandingToolDispatchError);
  assert.equal(accessed, 0);
});

 test("large material result requires explicit analysis purpose and retains escaped bytes", async () => {
  const size=1088*1024, text="{}"+"\t".repeat(size-2);
  const tools=[{name:names[0]!,async call(){return {success:true,contentItems:[{type:"inputText",text}]};}}];
  const analysis=createStandingNamedToolDispatcher(tools,"history-analysis");
  const value=await analysis.call(names[0]!,{},scope());
  assert.equal(value.contentItems[0].text,text);
  assert.ok(Buffer.byteLength(JSON.stringify(value))>2*1024*1024);
  await assert.rejects(createStandingNamedToolDispatcher(tools).call(names[0]!,{},scope()),StandingToolDispatchError);
  await assert.rejects(createStandingToolDispatcher({async call(){return {}; }},tools).call(names[0]!,{},scope()),StandingToolDispatchError);
  const over=createStandingNamedToolDispatcher([{name:names[0]!,async call(){return {success:true,contentItems:[{type:"inputText",text:text+" "}]};}}],"history-analysis");
  await assert.rejects(over.call(names[0]!,{},scope()),StandingToolDispatchError);
});
