import test from "node:test";
import assert from "node:assert/strict";
import { MTProtoSender } from "telegram/network/MTProtoSender.js";
import { installBindingNetworkFence } from "../src/binding-network-fence.js";

test("pinned sender reentry and DC switch refuse before any original network method", async () => {
  const original = MTProtoSender.prototype.reconnect;
  const internal = MTProtoSender.prototype._reconnect;
  let dcCalls = 0;
  const client = { _switchDC: async (_dc: number) => { dcCalls++; return true; } };
  const restore = installBindingNetworkFence(client, () => { throw new Error("FIXED_REFUSAL"); });
  try {
    assert.throws(() => MTProtoSender.prototype.reconnect(), /FIXED_REFUSAL/);
    await assert.rejects(MTProtoSender.prototype._reconnect(), /FIXED_REFUSAL/);
    await assert.rejects(client._switchDC(2), /FIXED_REFUSAL/);
    assert.equal(dcCalls, 0);
  } finally { restore(); }
  assert.equal(MTProtoSender.prototype.reconnect, original);
  assert.equal(MTProtoSender.prototype._reconnect, internal);
  assert.equal(await client._switchDC(2), true);
});
