import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { projectStandingOwnAction, snapshotStandingOwnActionView, type StandingOwnActionProjectionInput, type StandingOwnActionSource } from "../src/standing-own-action-projection.js";
import type { PilotRecord, PilotReply } from "../src/pilot-outbox.js";
import { createGeneratedImageRegistry } from "../src/generated-image-artifact.js";
import { generatedImageDeliveryKey, generatedImagePlanHash, type ImageDeliveryPlan, type ImageDeliveryRecord } from "../src/generated-image-outbox.js";
import { createStandingArtifactRegistry } from "../src/standing-artifact.js";
import { artifactDeliveryKey, artifactDeliveryPlanHash, type ArtifactDeliveryPlan, type ArtifactDeliveryRecord } from "../src/standing-artifact-outbox.js";
import type { StandingActionBinding, StandingActionIntent, StandingActionTerminal } from "../src/standing-action-journal.js";
import { validateStandingPollObjectEvidence, type StandingPollObjectEvidence } from "../src/standing-object-evidence.js";

const binding = { accountId: "11111111", chatId: "-100123456" }, referenceKey = "2".repeat(64), slot = "immutable_slot_1";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const jsonHash = (value: unknown) => hash(JSON.stringify(value));
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}
const input = (source: StandingOwnActionSource): StandingOwnActionProjectionInput => ({ binding, referenceKey, slot, source });
function pilot(state: PilotRecord["state"] = "verified", formatted = false): Extract<StandingOwnActionSource, { family: "pilot" }> {
  const reply: PilotReply = { chatId: binding.chatId, replyToMessageId: 987, text: "Synthetic answer", ...(formatted ? { entities: [{ type: "bold" as const, offset: 0, length: 9 }] } : {}) };
  const contentHash = formatted ? jsonHash(["DecadansNeurobro/pilot-formatted-text/v1", reply.text, reply.entities]) : hash(reply.text);
  const record: PilotRecord = { version: "pilot-outbox-v1", state, randomId: "123456789", ...binding, replyToMessageId: 987,
    contentHash, textBytes: Buffer.byteLength(reply.text), idempotencyKey: jsonHash([binding.chatId, "owner-prompt", 987, "reply", contentHash]),
    ...(state === "verified" ? { messageId: 1234 } : {}) };
  return { family: "pilot", record, reply };
}
function image(state: ImageDeliveryRecord["state"] = "verified"): Extract<StandingOwnActionSource, { family: "generated-image" }> {
  const origin = { requestRef: "request-private", threadId: "thread-private", turnId: "turn-private", itemId: "image-private" };
  const registry = createGeneratedImageRegistry({ requestRef: origin.requestRef, threadId: origin.threadId, turnId: origin.turnId });
  try {
    const artifact = registry.acceptCompleted(origin, { id: origin.itemId, type: "imageGeneration", status: "completed", result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" });
    const approved = { ...binding, replyToMessageId: 987, origin };
    const plan: ImageDeliveryPlan = { version: "generated-image-delivery-v1", generation: "completed", key: generatedImageDeliveryKey(approved), approved, artifact, caption: "Synthetic image", randomId: "123456789" };
    const terminal: ImageDeliveryRecord = { key: plan.key, planHash: generatedImagePlanHash(plan), state, ...(state === "verified" ? { messageId: 1234, photoId: "9223372036854775806" } : {}) };
    return { family: "generated-image", plan, terminal };
  } finally { registry.close(); }
}
function artifact(state: ArtifactDeliveryRecord["state"] = "verified"): Extract<StandingOwnActionSource, { family: "artifact" }> {
  const approved = { ...binding, replyToMessageId: 987, operationSlot: 0, requestRef: "request-private" }, registry = createStandingArtifactRegistry({ requestRef: approved.requestRef });
  try {
    const artifact = registry.accept({ source: { kind: "generated", reference: "private-source-reference" }, filename: "note.txt", mimeType: "text/plain", bytes: Buffer.from("Synthetic file\n") });
    const plan: ArtifactDeliveryPlan = { version: "standing-artifact-delivery-v1", key: artifactDeliveryKey(approved), approved, artifact, caption: "Synthetic file caption", randomId: "123456789" };
    const terminal: ArtifactDeliveryRecord = { key: plan.key, planHash: artifactDeliveryPlanHash(plan), state, ...(state === "verified" ? { acknowledgement: { messageId: 1234, documentId: "999999999" } } : {}),
      ...(state === "unknown" || state === "failed_terminal" ? { failure: { stage: "send" as const, reason: state === "unknown" ? "unknown" as const : "stopped" as const } } : {}) };
    return { family: "artifact", plan, terminal };
  } finally { registry.close(); }
}
function action(kind: string, state: StandingActionTerminal["state"] = "verified", extra: Record<string, string | boolean | object> = {}): Extract<StandingOwnActionSource, { family: "bound-action" }> {
  const actionBinding: StandingActionBinding = { ...binding, primaryMessageId: 987, operationSlot: 0 };
  const intent: StandingActionIntent = { requestRef: "request-private", randomId: "123456789", action: { kind, ...(kind === "set-reaction" ? { emoji: "👍", messageRef: "m_private" } : {}) } };
  const terminal: StandingActionTerminal = { state, result: { verdict: state, ...extra } as StandingActionTerminal["result"] };
  return { family: "bound-action", binding: actionBinding, intent, terminal };
}
function poll(): Extract<StandingOwnActionSource, { family: "bound-action" }> {
  const source = action("create-poll"), poll = { question: "Synthetic question?", options: ["One", "Two"], anonymous: true, type: "single" as const };
  const intent: StandingActionIntent = { ...source.intent, action: { kind: "create-poll", poll } };
  const raw: StandingPollObjectEvidence = { schema: "standing-poll-object-v1", kind: "poll", objectRef: "obj_" + "a".repeat(48), observedAt: 1789065600,
    record: { schema: "owned-bound-poll-v1", operationId: "bound-action-123456789", randomId: "123456789", ...binding, replyToMessageId: 987, messageId: 1234, pollId: "-9223372036854775808", poll } };
  const evidence = validateStandingPollObjectEvidence(raw, source.binding, intent);
  return { ...source, intent, terminal: { state: "verified", result: { verdict: "verified", code: "verified" }, privateObjectEvidence: evidence } };
}

test("verified text joins exact content evidence while retaining gaps for dates and current availability", () => {
  const source = pilot(), view = projectStandingOwnAction(input(source));
  assert.deepEqual(view.content, { kind: "text", text: source.reply!.text }); assert.equal(view.verdict, "verified"); assert.equal(view.effect, "changed");
  assert.equal(view.identityKnown, true); assert.equal(view.currentAvailability, "not-checked"); assert.equal(view.serverDate, null); assert.equal(view.observedAt, null);
  assert.deepEqual(view.gaps, ["server-date-not-retained", "current-availability-not-checked", "observation-date-not-retained"]);
  const withoutText = projectStandingOwnAction(input({ family: "pilot", record: source.record }));
  assert.deepEqual(withoutText.content, { kind: "text", text: null }); assert.ok(withoutText.gaps.includes("text-not-joined")); assert.equal(withoutText.actionRef, view.actionRef);
});

test("standalone wire evidence is accepted only on verified pilot records with an original task anchor", () => {
  const source = pilot(), detached = { ...source, record: { ...source.record, wireReplyToMessageId: null } };
  assert.equal(projectStandingOwnAction(input(detached)).verdict, "verified");
  for (const state of ["planned", "sending", "unknown", "failed_terminal"] as const) {
    const invalid = pilot(state); assert.throws(() => projectStandingOwnAction(input({ ...invalid, record: { ...invalid.record, wireReplyToMessageId: null } })));
  }
  for (const wireReplyToMessageId of [undefined, 789]) assert.throws(() => projectStandingOwnAction(input({ ...source,
    record: { ...source.record, wireReplyToMessageId } } as unknown as StandingOwnActionSource)));
});

test("UNKNOWN, incomplete and failed terminal records never project a successful effect or concrete identity", () => {
  for (const state of ["unknown", "planned", "sending", "failed_terminal"] as const) {
    for (const source of [pilot(state), ...(state === "planned" ? [] : [image(state), artifact(state)])]) {
      const view = projectStandingOwnAction(input(source)); assert.equal(view.effect, "not-proven"); assert.equal(view.identityKnown, false);
      assert.equal(view.verdict, state === "planned" || state === "sending" ? "incomplete" : state === "failed_terminal" ? "failed-terminal" : "unknown");
      assert.ok(view.gaps.includes("outcome-not-verified")); assert.ok(view.gaps.includes("identity-not-retained"));
    }
  }
  for (const state of ["unknown", "refused"] as const) { const view = projectStandingOwnAction(input(action("set-reaction", state, { code: "verified" })));
    assert.equal(view.effect, "not-proven"); assert.equal(view.verdict, state); }
});

test("text join binds content bytes, explicit entity identity and account/chat/reply routing", () => {
  const source = pilot("verified", true), good = projectStandingOwnAction(input(source)); assert.ok(good.gaps.includes("formatting-not-projected"));
  const { entities: _entities, ...unformatted } = source.reply!;
  for (const reply of [unformatted, { ...source.reply!, text: "Synthetic answeR" }, { ...source.reply!, chatId: "-42" }, { ...source.reply!, replyToMessageId: 986 },
    { ...source.reply!, entities: [{ type: "bold" as const, offset: 1, length: 9 }] }]) assert.throws(() => projectStandingOwnAction(input({ ...source, reply })));
  assert.throws(() => projectStandingOwnAction({ ...input(source), binding: { ...binding, accountId: "2" } }));
  assert.throws(() => projectStandingOwnAction(input({ ...source, record: { ...source.record, contentHash: "0".repeat(64) } })));
  assert.throws(() => projectStandingOwnAction(input({ ...source, record: { ...source.record, textBytes: 1 } })));
});

test("verified generated photo and file project descriptive metadata without reusable media capabilities", () => {
  for (const source of [image(), artifact()]) {
    const view = projectStandingOwnAction(input(source)); assert.equal(view.verdict, "verified"); assert.equal(view.identityKnown, true); assert.equal(view.currentAvailability, "not-checked");
    const text = JSON.stringify(view);
    for (const hidden of [source.plan.artifact.ref, source.plan.artifact.sha256, "request-private", "thread-private", "turn-private", "image-private", "private-source-reference", "9223372036854775806", "999999999", binding.chatId, binding.accountId]) assert.equal(text.includes(hidden), false, hidden);
    assert.equal(Object.hasOwn(view, "objectRef"), false); assert.equal(Object.hasOwn(view, "artifactRef"), false); assert.equal(Object.hasOwn(view, "bytes"), false);
    if (view.content.kind === "photo") assert.deepEqual(view.content, { kind: "photo", generation: "completed", caption: "Synthetic image", mimeType: "image/png", byteLength: source.plan.artifact.byteLength, width: 1, height: 1 });
    else { assert.equal(view.content.kind, "artifact"); if (view.content.kind === "artifact") { assert.equal(view.content.filename, "note.txt"); assert.equal(view.content.sourceKind, "generated"); assert.equal(view.content.mediaKind, "file"); } }
  }
});

test("image and artifact plans must match their terminal hashes, original binding and retained identities", () => {
  for (const source of [image(), artifact()]) {
    assert.throws(() => projectStandingOwnAction(input({ ...source, terminal: { ...source.terminal, planHash: "f".repeat(64) } } as StandingOwnActionSource)));
    assert.throws(() => projectStandingOwnAction(input({ ...source, plan: { ...source.plan, approved: { ...source.plan.approved, accountId: "2" } } } as StandingOwnActionSource)));
  }
  const i = image(); assert.throws(() => projectStandingOwnAction(input({ ...i, terminal: { ...i.terminal, state: "unknown" } })));
  const a = artifact(); assert.throws(() => projectStandingOwnAction(input({ ...a, terminal: { ...a.terminal, state: "unknown" } })));
});

test("validated persisted poll evidence alone supplies opaque object ref and observed time without raw server identity", () => {
  const source = poll(), view = projectStandingOwnAction(input(source));
  assert.equal(view.objectRef, source.terminal.privateObjectEvidence!.objectRef); assert.equal(view.observedAt, 1789065600); assert.equal(view.identityKnown, true);
  assert.equal(view.effect, "changed"); assert.equal(view.currentAvailability, "not-checked"); assert.deepEqual(view.content, { kind: "poll", question: "Synthetic question?", options: ["One", "Two"] });
  const text = JSON.stringify(view); for (const field of ["pollId", "messageId", "operationId", "randomId", "accountId", "chatId", "replyToMessageId"]) assert.equal(text.includes(field), false);
  assert.throws(() => projectStandingOwnAction(input({ ...source, intent: { ...source.intent, randomId: "42" } })));
  assert.throws(() => projectStandingOwnAction(input({ ...source, terminal: { ...source.terminal, state: "unknown" } })));
  const noEvidence = projectStandingOwnAction(input(action("create-poll", "verified", { code: "verified" })));
  assert.equal(noEvidence.objectRef, undefined); assert.equal(noEvidence.identityKnown, false); assert.deepEqual(noEvidence.content, { kind: "poll", question: null, options: [] });
  assert.ok(noEvidence.gaps.includes("object-provenance-not-retained"));
});

test("bound reactions and profile/avatar results preserve operation semantics without implying object capabilities", () => {
  const cases = [action("set-reaction", "verified", { code: "unchanged" }), action("read-reactions"), action("close-poll", "verified", { change: "already-closed" }),
    action("read-self-profile", "verified", { profile: { firstName: "Synthetic", lastName: "Name", hasPhoto: true } }),
    action("set-display-name", "verified", { code: "verified", profile: { firstName: "Updated", lastName: "Name", hasPhoto: false } }),
    action("set-avatar", "verified", { code: "verified", profile: { firstName: "Synthetic", lastName: "Name", hasPhoto: true } }),
    action("set-group-avatar", "verified", { code: "verified", group: { hasPhoto: true } })];
  const views = cases.map(source => projectStandingOwnAction(input(source)));
  assert.deepEqual(views.map(view => view.effect), ["unchanged", "observed", "unchanged", "observed", "changed", "changed", "changed"]);
  for (const view of views) { assert.equal(view.objectRef, undefined); assert.equal(view.identityKnown, false); assert.equal(view.currentAvailability, "not-checked"); }
  assert.deepEqual(views[0]!.content, { kind: "reaction", requestedEmoji: "👍" }); assert.deepEqual(views[6]!.content, { kind: "group-avatar", hasPhoto: true });
});

test("action references bind host key, slot, family and canonical terminal while ignoring property insertion order", () => {
  const source = pilot(), base = input(source), view = projectStandingOwnAction(base);
  const reordered = { ...source, record: Object.fromEntries(Object.entries(source.record).reverse()) as PilotRecord };
  assert.equal(projectStandingOwnAction(input(reordered)).actionRef, view.actionRef); assert.match(view.actionRef, /^act_[0-9a-f]{48}$/);
  for (const change of [{ referenceKey: "3".repeat(64) }, { slot: "immutable_slot_2" }]) assert.notEqual(projectStandingOwnAction({ ...base, ...change }).actionRef, view.actionRef);
  assert.notEqual(projectStandingOwnAction(input(pilot("unknown"))).actionRef, view.actionRef);
  const expected = (family: string) => "act_" + createHmac("sha256", Buffer.from(referenceKey, "hex")).update(canonical(["DecadansNeurobro/own-action-projection/v1", family, binding.accountId, binding.chatId, slot, hash(canonical(source.record))])).digest("hex").slice(0, 48);
  assert.equal(view.actionRef, expected("pilot")); assert.notEqual(view.actionRef, expected("artifact"));
});

test("executable input graphs and extra top-level or source fields refuse without invoking getters or proxies", () => {
  const source = pilot(); let invoked = 0;
  const proxy = new Proxy(source.record, { getPrototypeOf() { invoked++; throw Error("trap"); }, getOwnPropertyDescriptor() { invoked++; throw Error("trap"); } });
  const values = [{ ...input(source), get slot() { invoked++; return slot; } }, { ...input(source), source: { ...source, get record() { invoked++; return source.record; } } },
    input({ ...source, record: proxy }), { ...input(source), extra: true }, { ...input(source), source: { ...source, extra: true } },
    { ...input(source), slot: "../private-slot" }, { ...input(source), referenceKey: "bad" }];
  for (const value of values) assert.throws(() => projectStandingOwnAction(value as StandingOwnActionProjectionInput));
  assert.equal(invoked, 0);
});

test("public view snapshots are detached and deeply frozen but do not authenticate caller provenance", () => {
  const original = structuredClone(projectStandingOwnAction(input(poll()))), saved = snapshotStandingOwnActionView(original);
  assert.notEqual(saved, original); assert.notEqual(saved.content, original.content); assert.ok(Object.isFrozen(saved)); assert.ok(Object.isFrozen(saved.content)); assert.ok(Object.isFrozen(saved.gaps));
  if (original.content.kind !== "poll" || saved.content.kind !== "poll") assert.fail();
  assert.ok(Object.isFrozen(saved.content.options)); (original.content.options as string[])[0] = "modified"; assert.equal(saved.content.options[0], "One");
  (original.gaps as string[]).push("identity-not-retained"); assert.equal(saved.gaps.includes("identity-not-retained"), false);
});

test("malformed public views cannot promote UNKNOWN effects or current availability", () => {
  const view = projectStandingOwnAction(input(pilot("unknown"))); let invoked = 0;
  for (const patch of [{ effect: "changed" }, { effect: "observed" }, { currentAvailability: "available" }, { serverDate: 1789065600 },
    { actionRef: "act_bad" }, { objectRef: "obj_" + "a".repeat(48) }, { content: { kind: "photo", generation: "completed" } },
    { gaps: ["identity-not-retained", "identity-not-retained"] }, { extra: true }]) assert.throws(() => snapshotStandingOwnActionView({ ...view, ...patch }));
  assert.throws(() => snapshotStandingOwnActionView({ ...view, get content() { invoked++; return view.content; } }));
  assert.throws(() => snapshotStandingOwnActionView(new Proxy(view, { ownKeys() { invoked++; throw Error("trap"); } })));
  assert.equal(invoked, 0);
});

test("profile and reaction observations cannot claim concrete identity and photo views cannot issue object refs", () => {
  for (const source of [action("read-reactions"), action("read-self-profile", "verified", { profile: { firstName: "Synthetic", lastName: "Name", hasPhoto: true } })]) {
    const view = projectStandingOwnAction(input(source));
    assert.throws(() => snapshotStandingOwnActionView({ ...view, identityKnown: true }));
    assert.throws(() => snapshotStandingOwnActionView({ ...view, identityKnown: true, gaps: view.gaps.filter(gap => gap !== "identity-not-retained") }));
  }
  const photo = projectStandingOwnAction(input(image())); assert.throws(() => snapshotStandingOwnActionView({ ...photo, objectRef: "obj_" + "a".repeat(48) }));
  const text = projectStandingOwnAction(input(pilot())); assert.throws(() => snapshotStandingOwnActionView({ ...text, operation: "send-photo" }));
});

test("bounded snapshots refuse oversized cumulative payloads, property keys and individual strings", () => {
  const source = pilot(), base = input(source);
  for (const payload of [Array.from({ length: 10 }, () => "x".repeat(16384)), { ["k".repeat(129)]: "value" }, "x".repeat(16385)]) {
    assert.throws(() => projectStandingOwnAction({ ...base, payload } as StandingOwnActionProjectionInput));
    assert.throws(() => snapshotStandingOwnActionView({ ...projectStandingOwnAction(base), payload }));
  }
});

test("actual reaction set, replaced and removed outcomes project changed without inventing success for UNKNOWN", () => {
  for (const change of ["set", "replaced", "removed"] as const) {
    const source = action("set-reaction", "verified", { change }), intent = change === "removed" ? { ...source.intent, action: { kind: "set-reaction", emoji: null, messageRef: "m_private" } } : source.intent;
    const view = projectStandingOwnAction(input({ ...source, intent })); assert.equal(view.effect, "changed"); assert.equal(view.identityKnown, false);
    assert.deepEqual(view.content, { kind: "reaction", requestedEmoji: change === "removed" ? null : "👍" });
    const unknown = projectStandingOwnAction(input({ ...source, intent, terminal: { state: "unknown", result: { verdict: "unknown", change } } }));
    assert.equal(unknown.effect, "not-proven");
  }
});

test("legacy artifact audio metadata is projected as audio without requiring a newer mediaKind field", () => {
  const approved = { ...binding, replyToMessageId: 987, operationSlot: 0, requestRef: "request-private" }, registry = createStandingArtifactRegistry({ requestRef: approved.requestRef });
  try {
    const frame = Buffer.alloc(417); Buffer.from([0xff, 0xfb, 0x90, 0x00]).copy(frame);
    const artifact = registry.accept({ source: { kind: "generated", reference: "synthetic-mp3" }, filename: "sound.mp3", mimeType: "audio/mpeg", bytes: Buffer.concat([frame, frame, frame]), audio: { durationSeconds: 999, title: "Synthetic" } });
    assert.ok(artifact.audio!.durationSeconds > 0 && artifact.audio!.durationSeconds < 1);
    const plan: ArtifactDeliveryPlan = { version: "standing-artifact-delivery-v1", key: artifactDeliveryKey(approved), approved, artifact, caption: "Audio caption", randomId: "123456789" };
    const terminal: ArtifactDeliveryRecord = { key: plan.key, planHash: artifactDeliveryPlanHash(plan), state: "verified", acknowledgement: { messageId: 1234, documentId: "999999999" } };
    const view = projectStandingOwnAction(input({ family: "artifact", plan, terminal })); assert.equal(view.content.kind, "artifact");
    if (view.content.kind === "artifact") { assert.equal(view.content.mediaKind, "audio"); assert.equal(view.content.filename, "sound.mp3"); }
    assert.equal(view.identityKnown, true); assert.equal(view.currentAvailability, "not-checked"); assert.equal(Object.hasOwn(view, "artifactRef"), false);
  } finally { registry.close(); }
});
