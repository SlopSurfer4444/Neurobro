import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import { createBoundActionTransportLease } from "../src/bound-action-transport.js";
import { createStandingBoundActionRuntime } from "../src/standing-bound-action-runtime.js";
import { createStandingArtifactRuntime } from "../src/standing-artifact-runtime.js";
import { createConversationReferences } from "../src/conversation-references.js";
import { createGeneratedImageRegistry } from "../src/generated-image-artifact.js";
import { applyGeneratedImageUse } from "../src/standing-generated-image-use.js";
import { createStandingSelfProfile } from "../src/standing-self-profile.js";
import { createStandingGroupAvatar } from "../src/standing-group-avatar.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const photo = () => new Api.Photo({ id: bigInt(77), accessHash: bigInt(88), fileReference: Buffer.alloc(0), date: 1, sizes: [], dcId: 1 });
const outcome = (result: EpochToolResult) => JSON.parse(result.contentItems[0].text) as { verdict: string; code?: string };

for (const route of ["direct", "generated-plan"] as const) {
  for (const target of ["self-avatar", "group-avatar"] as const) {
    for (const basic of target === "self-avatar" ? [true] : [true, false]) {
      for (const mode of ["unchanged", "edited", "deleted", "lost-ack"] as const) {
        test(`${route} ${target} ${basic ? "chat" : "channel"}: ${mode} during upload`, async t => {
          const directory = await mkdtemp(join(tmpdir(), "neurobro-avatar-primary-"));
          const signal = new AbortController(), requestRef = "avatar-request";
          const peer = basic ? new Api.InputPeerChat({ chatId: bigInt(123) }) : new Api.InputPeerChannel({ channelId: bigInt(123), accessHash: bigInt(987) });
          const binding = { peerId: utils.getPeerId(peer), accountId: "789" };
          const selected = { chatId: binding.peerId, ownerId: "456", messageId: 91, text: "Set avatar" };
          let primary = { ...selected }, deleted = false, primaryReads = 0, applied = false, uploads = 0;
          const requests: Api.AnyRequest[] = [];
          const self = () => new Api.User({ id: bigInt(789), self: true, firstName: "Bro",
            ...(applied ? { photo: new Api.UserProfilePhoto({ photoId: bigInt(77), dcId: 1 }) } : {}) });
          const references = createConversationReferences(binding);
          const settings = { binding, stateDirectory: directory, passphrase: "private synthetic avatar primary test", signal: signal.signal, killed: () => false };
          const actions = createStandingBoundActionRuntime(settings), artifacts = createStandingArtifactRuntime(settings);
          const origin = { requestRef, threadId: "image-thread", turnId: "image-turn", itemId: "image-item" };
          const generated = createGeneratedImageRegistry({ requestRef, threadId: origin.threadId, turnId: origin.turnId });
          const artifact = generated.acceptCompleted(origin, { id: origin.itemId, type: "imageGeneration", status: "completed", result: png.toString("base64") });
          const openActions = () => createBoundActionTransportLease({ binding, peer, self: self(), selected, references, signal: signal.signal,
            // An edited/deleted Telegram message does not abort the selection's local signal.
            isSelectionActive: () => true,
            revalidatePrimary: async () => { primaryReads++; if (deleted) throw Error("message missing"); return { ...primary }; },
            resolveAvatar: ref => artifacts.copyProfileImage(requestRef, ref), client: { async invoke(request) {
              requests.push(request);
              if (request instanceof Api.users.GetUsers) return [self()];
              if (request instanceof Api.messages.GetChats || request instanceof Api.channels.GetChannels) {
                const p = applied ? new Api.ChatPhoto({ photoId: bigInt(77), dcId: 1 }) : new Api.ChatPhotoEmpty();
                const chat = basic ? new Api.Chat({ id: bigInt(123), title: "Group", photo: p, participantsCount: 2, date: 1, version: 1 }) :
                  new Api.Channel({ id: bigInt(123), title: "Group", photo: p, date: 1, megagroup: true, accessHash: bigInt(987) });
                return new Api.messages.Chats({ chats: [chat] });
              }
              if (request instanceof Api.upload.SaveFilePart) {
                uploads++; await Promise.resolve();
                if (mode === "edited") primary = { ...primary, text: "Do not set avatar" };
                if (mode === "deleted") deleted = true;
                return true;
              }
              if (request instanceof Api.photos.UploadProfilePhoto || request instanceof Api.messages.EditChatPhoto || request instanceof Api.channels.EditPhoto) {
                applied = true;
                if (mode === "lost-ack") throw Error("acknowledgement lost after mutation");
                if (request instanceof Api.photos.UploadProfilePhoto) return new Api.photos.Photo({ photo: photo(), users: [] });
                const message = new Api.MessageService({ id: 100, date: 1, fromId: new Api.PeerUser({ userId: bigInt(789) }),
                  peerId: basic ? new Api.PeerChat({ chatId: bigInt(123) }) : new Api.PeerChannel({ channelId: bigInt(123) }),
                  action: new Api.MessageActionChatEditPhoto({ photo: photo() }) });
                return new Api.Updates({ updates: [basic ? new Api.UpdateNewMessage({ message, pts: 1, ptsCount: 1 }) :
                  new Api.UpdateNewChannelMessage({ message, pts: 1, ptsCount: 1 })], users: [], chats: [], date: 1, seq: 1 });
              }
              throw Error("unexpected transport request");
            } } });
          t.after(async () => { await actions.close(); await artifacts.close(); generated.close(); references.close(); await rm(directory, { recursive: true, force: true }); });
          actions.begin({ requestRef, primary: selected, openActions });
          artifacts.begin({ requestRef, primary: selected, openArtifactTransport: () => { throw Error("No image delivery required"); } });
          const name = target === "self-avatar" ? "neurobro_set_avatar" : "neurobro_set_group_avatar";
          if (route === "direct") {
            const imported = artifacts.importInputImage(requestRef, 91, "image/png", Buffer.from(png));
            const result = outcome(await actions.handlers.find(h => h.name === name)!.call({ artifactRef: imported.ref },
              { requestRef, callRef: "direct-avatar", signal: signal.signal }) as EpochToolResult);
            assert.equal(result.verdict, mode === "unchanged" ? "verified" : "unknown");
            if (mode === "edited" || mode === "deleted") assert.equal(result.code, "primary");
          } else {
            const planned = await artifacts.handlers.find(h => h.name === "neurobro_plan_generated_image_use")!.call({ target },
              { requestRef, callRef: "plan-avatar", signal: signal.signal }) as EpochToolResult;
            assert.equal(planned.success, true);
            assert.equal(artifacts.takeGeneratedImageUse(requestRef), target);
            const text = await applyGeneratedImageUse({ target, requestRef, completed: { kind: "image", answer: null,
              image: { artifact, registry: generated, close() {} } }, artifacts, actions, signal: signal.signal });
            assert.equal(text.includes("проверил результат в Telegram"), mode === "unchanged");
            if (mode !== "unchanged") assert.match(text, /повторно действие не запускал/);
          }
          assert.equal(primaryReads, 2, "the actual production lease rechecks the primary after upload");
          assert.equal(uploads, 1);
          assert.equal(applied, mode === "unchanged" || mode === "lost-ack");
          assert.equal(actions.state().blocked, mode !== "unchanged");
          const mutationCount = requests.filter(r => r instanceof Api.photos.UploadProfilePhoto || r instanceof Api.messages.EditChatPhoto || r instanceof Api.channels.EditPhoto).length;
          assert.equal(mutationCount, applied ? 1 : 0);
          await actions.close();
          const reopened = createStandingBoundActionRuntime(settings);
          try {
            reopened.begin({ requestRef: "reopened", primary: selected, openActions });
            const result = outcome(await reopened.handlers.find(h => h.name === name)!.call({ artifactRef: "art_" + "a".repeat(48) },
              { requestRef: "reopened", callRef: "reopen-check", signal: signal.signal }) as EpochToolResult);
            assert.equal(result.verdict, "refused");
            assert.equal(uploads, 1, "durable consumed slot never repeats the upload");
          } finally { await reopened.close(); }
        });
      }
    }
  }
}

test("profile and group factories require a primary proof callback", () => {
  const binding = { accountId: "789", peerId: "-123" }, self = new Api.User({ id: bigInt(789), self: true });
  const common = { binding, self, signal: new AbortController().signal, client: { async invoke() { throw Error("must not dispatch"); } } };
  // Deliberately exercise non-TypeScript callers omitting the required capability.
  assert.throws(() => createStandingSelfProfile(common as unknown as Parameters<typeof createStandingSelfProfile>[0]), /primary/);
  assert.throws(() => createStandingGroupAvatar({ ...common, peer: new Api.InputPeerChat({ chatId: bigInt(123) }) } as unknown as Parameters<typeof createStandingGroupAvatar>[0]), /primary/);
});

for (const mode of ["unchanged", "edited", "deleted", "lost-ack"] as const) {
  test(`display name checks primary after self read: ${mode}`, async () => {
    const binding = { peerId: "-123", accountId: "789" }, peer = new Api.InputPeerChat({ chatId: bigInt(123) });
    const selected = { chatId: binding.peerId, ownerId: "456", messageId: 91, text: "Rename yourself" };
    const references = createConversationReferences(binding), signal = new AbortController();
    let primary = { ...selected }, deleted = false, name = "Old", primaryReads = 0, mutations = 0;
    const self = () => new Api.User({ id: bigInt(789), self: true, firstName: name });
    const lease = createBoundActionTransportLease({ binding, peer, self: self(), selected, references, signal: signal.signal,
      isSelectionActive: () => true, revalidatePrimary: async () => { primaryReads++; if (deleted) throw Error("missing request"); return primary; },
      client: { async invoke(request) {
        if (request instanceof Api.users.GetUsers) {
          if (mode === "edited") primary = { ...primary, text: "Keep your name" };
          if (mode === "deleted") deleted = true;
          return [self()];
        }
        if (request instanceof Api.account.UpdateProfile) {
          mutations++; name = request.firstName!;
          if (mode === "lost-ack") throw Error("lost acknowledgement");
          return self();
        }
        throw Error("unexpected request");
      } } });
    try {
      const result = await lease.execute({ kind: "set-display-name", firstName: "Bro" }, "123456");
      assert.equal(primaryReads, 2);
      assert.equal(result.outcome.verdict, mode === "unchanged" ? "verified" : mode === "lost-ack" ? "unknown" : "refused");
      if (mode === "edited" || mode === "deleted") assert.equal(result.outcome.code, "primary");
      assert.equal(mutations, mode === "unchanged" || mode === "lost-ack" ? 1 : 0);
      assert.equal((await lease.execute({ kind: "set-display-name", firstName: "Retry" }, "123457")).outcome.verdict, "refused");
    } finally { await lease.close(); references.close(); }
  });
}

for (const group of [false, true]) {
  test(`${group ? "group" : "self"} avatar close joins pending primary proof and suppresses apply`, async () => {
    let enter!: () => void, finish!: () => void, settled = false;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
    const binding = { peerId: "-123", accountId: "789" }, self = new Api.User({ id: bigInt(789), self: true });
    const requests: Api.AnyRequest[] = [], peer = new Api.InputPeerChat({ chatId: bigInt(123) });
    const input = { binding, self, signal: new AbortController().signal,
      revalidatePrimary: async () => { enter(); await gate; settled = true; },
      client: { async invoke(request: Api.AnyRequest) {
        requests.push(request);
        if (request instanceof Api.users.GetUsers) return [self];
        if (request instanceof Api.messages.GetChats) return new Api.messages.Chats({ chats: [new Api.Chat({ id: bigInt(123), title: "Group", date: 1,
          participantsCount: 1, version: 1, photo: new Api.ChatPhotoEmpty() })] });
        if (request instanceof Api.upload.SaveFilePart) return true;
        throw Error("apply must be suppressed");
      } } };
    const transport = group ? createStandingGroupAvatar({ ...input, peer }) : createStandingSelfProfile(input);
    const { createHash } = await import("node:crypto");
    const work = transport.setAvatar({ bytes: Buffer.from(png), mediaType: "image/png", sha256: createHash("sha256").update(png).digest("hex") }, "123456");
    await entered;
    let closed = false;
    const closing = transport.close().then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false); assert.equal(settled, false);
    finish();
    assert.deepEqual(await work, { verdict: "unknown", code: "stopped" });
    await closing; assert.equal(settled, true);
    assert.equal(requests.some(r => r instanceof Api.photos.UploadProfilePhoto || r instanceof Api.messages.EditChatPhoto), false);
  });
}
