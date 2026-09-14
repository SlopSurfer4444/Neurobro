import test from "node:test";
import assert from "node:assert/strict";
import { stdin, stdout } from "node:process";
import { askHidden } from "../src/prompt.js";

test("hidden paste, correction and Ctrl+U show masks without revealing input", async () => {
  const tty = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  const rawMode = Object.getOwnPropertyDescriptor(stdin, "setRawMode");
  const write = stdout.write;
  let shown = "";
  Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(stdin, "setRawMode", { value: () => stdin, configurable: true });
  stdout.write = ((chunk: string | Uint8Array) => { shown += chunk.toString(); return true; }) as typeof stdout.write;
  try {
    const pending = askHidden("Fixture: ");
    stdin.emit("data", "wrong\u0015fixturz\b e\b\b e\r");
    assert.equal(await pending, "fixtur e");
    assert.equal(shown.includes("wrong"), false);
    assert.equal(shown.includes("fixtur"), false);
    assert.ok(shown.startsWith("Fixture: *****"));
    assert.ok(shown.includes("\b \b".repeat(5)));
    assert.ok(shown.endsWith("\n"));
  } finally {
    stdout.write = write;
    if (tty) Object.defineProperty(stdin, "isTTY", tty); else Reflect.deleteProperty(stdin, "isTTY");
    if (rawMode) Object.defineProperty(stdin, "setRawMode", rawMode); else Reflect.deleteProperty(stdin, "setRawMode");
  }
});
