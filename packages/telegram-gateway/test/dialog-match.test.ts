import test from "node:test";
import assert from "node:assert/strict";
import type { Api } from "telegram";
import { findExactDialogByTitle } from "../src/telegram-client.js";
import type { DialogSummary } from "../src/types.js";

function dialog(peerId: string, title: string): DialogSummary {
  return {
    peerId,
    title,
    kind: "user",
    peer: {} as Api.TypeInputPeer,
  };
}

test("matches one exact dialog title without substring fallback", () => {
  const dialogs = [dialog("1", "Тестовый диалог"), dialog("2", "Тестовый диалог архив")];
  assert.equal(findExactDialogByTitle(dialogs, "тестовый диалог").peerId, "1");
  assert.throws(() => findExactDialogByTitle(dialogs, "Тест"), /No exact dialog/);
});

test("refuses duplicate exact dialog titles", () => {
  const dialogs = [dialog("1", "Тестовый диалог"), dialog("2", "тестовый диалог")];
  assert.throws(() => findExactDialogByTitle(dialogs, "Тестовый диалог"), /ambiguous/);
});
