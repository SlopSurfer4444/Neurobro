import test from "node:test";
import assert from "node:assert/strict";
import { checkAccountBinding } from "../src/account-binding.js";

function fixture() {
  const calls: string[] = [];
  const ports = {
    account: async () => { calls.push("account"); return { id: "123", label: "fixture account", usable: true }; },
    chats: async () => { calls.push("chats"); return [{ id: "-456", title: "fixture chat", usable: true }]; },
    confirm: async (_label: string) => { calls.push("confirm"); return true; },
    disconnect: async () => { calls.push("disconnect"); },
    save: async (_binding: unknown) => { calls.push("save"); },
  };
  return { calls, ports };
}

test("binding is saved only after both owner confirmations and disconnect", async () => {
  const { calls, ports } = fixture();
  await checkAccountBinding("fixture chat", ports);
  assert.deepEqual(calls, ["account", "confirm", "chats", "confirm", "disconnect", "save"]);
});

test("account rejection prevents dialog lookup and persistence", async () => {
  const { calls, ports } = fixture();
  ports.confirm = async () => false;
  await assert.rejects(checkAccountBinding("fixture chat", ports), /ACCOUNT_NOT_CONFIRMED/);
  assert.deepEqual(calls, ["account", "disconnect"]);
});

test("missing, ambiguous or unusable chat cannot create a binding", async () => {
  const candidate = { id: "-456", title: "fixture chat", usable: true };
  for (const chats of [[], [candidate, candidate], [{ ...candidate, usable: false }], [{ ...candidate, id: "789" }]]) {
    const { calls, ports } = fixture();
    ports.chats = async () => chats;
    await assert.rejects(checkAccountBinding("fixture chat", ports));
    assert.equal(calls.includes("save"), false);
    assert.equal(calls.at(-1), "disconnect");
  }
});

test("chat rejection, account failure and disconnect failure prevent saving", async () => {
  for (const reason of ["chat", "account", "disconnect"]) {
    const { calls, ports } = fixture();
    let count = 0;
    if (reason === "chat") ports.confirm = async () => ++count === 1;
    if (reason === "account") ports.account = async () => { throw new Error("fixture failure"); };
    if (reason === "disconnect") ports.disconnect = async () => { throw new Error("fixture failure"); };
    await assert.rejects(checkAccountBinding("fixture chat", ports));
    assert.equal(calls.includes("save"), false);
  }
});
