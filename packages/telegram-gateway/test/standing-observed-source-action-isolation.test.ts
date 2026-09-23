import test from "node:test";
import assert from "node:assert/strict";
import bigInt from "big-integer";
import { Api } from "telegram";
import { createBoundActionTools, type BoundActionRequest } from "../src/bound-action-tools.js";
import { createBoundActionTransportLease } from "../src/bound-action-transport.js";
import { createConversationReferences } from "../src/conversation-references.js";
import { projectStandingObservedSourcePage } from "../src/standing-observed-source-reader.js";
import type { BoundActionTransportRequest } from "../src/standing-bound-action-runtime.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";

const binding = Object.freeze({ accountId: "789", peerId: "-100123" });
const primary = Object.freeze({ chatId: binding.peerId, ownerId: "456", messageId: 91, text: "Internal request" });
const internalPeer = () => new Api.InputPeerChannel({ channelId: bigInt(123), accessHash: bigInt(456) });
const sourcePeer = () => new Api.PeerChannel({ channelId: bigInt(222) });
const decode = (value: EpochToolResult) => JSON.parse(value.contentItems[0].text) as Record<string, unknown>;

function observedRef(): string {
  const page = projectStandingObservedSourcePage(new Api.messages.Messages({
    messages: [new Api.Message({ id: primary.messageId, peerId: sourcePeer(), fromId: new Api.PeerUser({ userId: bigInt(777) }),
      date: 1_700_000_000, message: "Quoted source row with the same numeric ID" })],
    users: [new Api.User({ id: bigInt(777), firstName: "Source author" })], chats: [],
  }), { sourceRef: "community", title: "Example Community", peerId: "-100222", limit: 30 });
  assert.equal(page.items[0]!.date, 1_700_000_000);
  return page.items[0]!.ref;
}

test("projected source refs cannot resolve through internal bound-action transports even when numeric message IDs collide", async () => {
  const ref = observedRef();
  assert.match(ref, /^obs_[0-9a-f]{24}$/u);
  const references = createConversationReferences(binding);
  const internalRef = references.message(primary.messageId);
  assert.match(internalRef, /^m_[0-9a-f]{24}$/u);
  assert.notEqual(ref, internalRef);
  assert.equal(references.resolveMessage(ref), undefined);

  let invokes = 0;
  const requests: readonly BoundActionTransportRequest[] = [
    { kind: "read-poll", messageRef: ref },
    { kind: "close-poll", messageRef: ref },
    { kind: "read-reactions", messageRef: ref },
    { kind: "set-reaction", messageRef: ref, emoji: "👍" },
  ];
  for (const request of requests) {
    const lease = createBoundActionTransportLease({
      client: { async invoke() { invokes++; throw new Error("source ref reached Telegram"); } },
      binding, peer: internalPeer(), self: new Api.User({ id: bigInt(binding.accountId), self: true }),
      selected: primary, references, signal: new AbortController().signal, isSelectionActive: () => true,
      revalidatePrimary: async () => primary,
    });
    try {
      const result = await lease.execute(request, "123456");
      assert.deepEqual(result.outcome, { verdict: "refused", code: "unknown-message-reference" });
    } finally { await lease.close(); }
  }
  assert.equal(invokes, 0);
  references.close();
});

test("public bound-action handlers reject source refs before opening an internal action lease", async () => {
  const ref = observedRef(), signal = new AbortController();
  const executed: BoundActionRequest[] = [];
  const tools = createBoundActionTools({ signal: signal.signal, async execute(request) {
    executed.push(request); return { verdict: "verified" };
  } });
  const cases = [
    ["neurobro_read_poll", { messageRef: ref }],
    ["neurobro_close_poll", { messageRef: ref }],
    ["neurobro_read_reactions", { messageRef: ref }],
    ["neurobro_set_reaction", { messageRef: ref, emoji: "👍" }],
  ] as const;
  try {
    for (const [name, args] of cases) {
      const handler = tools.handlers.find(value => value.name === name)!;
      const result = await handler.call(args, { requestRef: "internal-request", callRef: name, signal: signal.signal }) as EpochToolResult;
      assert.equal(result.success, false);
      assert.equal(decode(result).code, "invalid-arguments");
    }
    assert.deepEqual(executed, []);
  } finally { await tools.close(); }
});
