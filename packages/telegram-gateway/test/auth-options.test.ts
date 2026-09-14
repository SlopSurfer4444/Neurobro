import test from "node:test";
import assert from "node:assert/strict";
import { authClientOptions } from "../src/auth.js";
import { clientOptions } from "../src/telegram-client.js";

test("authorization permits exactly one bounded resend after a Telegram DC migration", () => {
  const runtime = clientOptions();
  const auth = authClientOptions();

  assert.equal(runtime.requestRetries, 1);
  assert.equal(auth.requestRetries, 2);
  assert.equal(auth.connectionRetries, 1);
  assert.equal(auth.reconnectRetries, 0);
  assert.equal(auth.autoReconnect, false);
  assert.equal(auth.floodSleepThreshold, 0);
});
