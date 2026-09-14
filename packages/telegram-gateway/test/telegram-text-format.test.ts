import test from "node:test";
import assert from "node:assert/strict";
import { Api } from "telegram";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import bigInt from "big-integer";
import {
  TelegramTextFormatError, copyTelegramTextEntities, fromTelegramEntities,
  renderTelegramText, toTelegramEntities, type TelegramTextEntity,
} from "../src/telegram-text-format.js";

const refused = (error: unknown) => error instanceof TelegramTextFormatError && error.message === "TELEGRAM_TEXT_FORMAT_REFUSED";
const plain = (value: readonly TelegramTextEntity[]) => value.map(entity => ({ ...entity }));

test("renders common assistant Markdown into plain wire text and normalized entities", () => {
  const value = renderTelegramText("**жирный** *курсив* ~~нет~~ `x < y` [сайт](https://example.test/a?q=1)");
  assert.equal(value.text, "жирный курсив нет x < y сайт");
  assert.deepEqual(plain(value.entities), [
    { type: "bold", offset: 0, length: 6 },
    { type: "italic", offset: 7, length: 6 },
    { type: "strike", offset: 14, length: 3 },
    { type: "code", offset: 18, length: 5 },
    { type: "textUrl", offset: 24, length: 4, url: "https://example.test/a?q=1" },
  ]);
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.entities) && value.entities.every(Object.isFrozen));
});

test("UTF-16 offsets count emoji as two units and nested styles are canonical", () => {
  const value = renderTelegramText("🙂 **bold *и 🙂* [link](https://e.test)**");
  assert.equal(value.text, "🙂 bold и 🙂 link");
  assert.deepEqual(plain(value.entities), [
    { type: "bold", offset: 3, length: 14 },
    { type: "italic", offset: 8, length: 4 },
    { type: "textUrl", offset: 13, length: 4, url: "https://e.test" },
  ]);
});

test("triple marker creates equal bold and italic spans", () => {
  const value = renderTelegramText("***важно***");
  assert.equal(value.text, "важно");
  assert.deepEqual(plain(value.entities), [
    { type: "bold", offset: 0, length: 5 },
    { type: "italic", offset: 0, length: 5 },
  ]);
});

test("multiline quotes become a single expanded blockquote with UTF16 inline styles", () => {
  const value = renderTelegramText("До 🙂\n> **А🙂**\n> второй\nПосле\n> ещё");
  assert.equal(value.text, "До 🙂\nА🙂\nвторой\nПосле\nещё");
  assert.deepEqual(plain(value.entities), [
    { type: "blockquote", offset: 6, length: 10 },
    { type: "bold", offset: 6, length: 3 },
    { type: "blockquote", offset: 23, length: 3 },
  ]);
});

test("quote recognition is line-based, preserves nesting markers and prioritizes quotes over code", () => {
  const value = renderTelegramText("x > ordinary\n> > nested\n> `x🙂` [link](https://e.test)");
  assert.equal(value.text, "x > ordinary\n> nested\nx🙂 link");
  assert.deepEqual(plain(value.entities), [
    { type: "blockquote", offset: 13, length: 17 },
    { type: "textUrl", offset: 26, length: 4, url: "https://e.test" },
  ]);
  assert.deepEqual(plain(renderTelegramText("```txt\n> literal\n```").entities),
    [{ type: "pre", offset: 0, length: 10, language: "txt" }]);
  assert.equal(renderTelegramText(">\n> text\n\n> next").text, "\ntext\n\nnext");
});

test("expanded blockquotes round-trip through installed GramJS binary with exact flag identity", () => {
  const rendered = renderTelegramText("> **🙂 quote**\n> second");
  const wire = toTelegramEntities(rendered.text, rendered.entities);
  assert.ok(wire[0] instanceof Api.MessageEntityBlockquote);
  assert.deepEqual(plain(fromTelegramEntities(rendered.text, wire)), plain(rendered.entities));
  const request = new Api.messages.SendMessage({ peer: new Api.InputPeerSelf(), message: rendered.text,
    randomId: bigInt.one, entities: wire, noWebpage: true });
  const reader = new BinaryReader(request.getBytes()), decoded = reader.tgReadObject();
  assert.ok(decoded instanceof Api.messages.SendMessage);
  assert.equal(reader.tellPosition(), request.getBytes().length);
  assert.deepEqual(plain(fromTelegramEntities(decoded.message, decoded.entities!)), plain(rendered.entities));
  const collapsed = new BinaryReader(new Api.MessageEntityBlockquote({ offset: 0, length: 2, collapsed: true }).getBytes()).tgReadObject();
  assert.throws(() => fromTelegramEntities("xx", [collapsed]), refused);
  assert.throws(() => copyTelegramTextEntities("a🙂bc", [{ type: "blockquote", offset: 2, length: 2 }]), refused);
  assert.throws(() => copyTelegramTextEntities("abcde", [
    { type: "blockquote", offset: 0, length: 5 }, { type: "blockquote", offset: 1, length: 2 },
  ]), refused);
  assert.throws(() => copyTelegramTextEntities("abcde", [
    { type: "blockquote", offset: 0, length: 3 }, { type: "bold", offset: 2, length: 3 },
  ]), refused);
  assert.throws(() => copyTelegramTextEntities("abcde", [
    { type: "blockquote", offset: 0, length: 5 }, { type: "code", offset: 1, length: 2 },
  ]), refused);
});

test("fenced code preserves literal Markdown and language; inline code is never recursively parsed", () => {
  const value = renderTelegramText("До\n```ts\nconst x = '**raw** <tag>';\n```\nи `[*raw*](https://x.test)`");
  assert.equal(value.text, "До\nconst x = '**raw** <tag>';\n\nи [*raw*](https://x.test)");
  assert.deepEqual(plain(value.entities), [
    { type: "pre", offset: 3, length: 27, language: "ts" },
    { type: "code", offset: 33, length: 23 },
  ]);
});

test("common Markdown around code is downgraded without losing text or valid Telegram entities", () => {
  const styled = renderTelegramText("**Use `foo` now**");
  assert.equal(styled.text, "Use foo now");
  assert.deepEqual(plain(styled.entities), [
    { type: "bold", offset: 0, length: 4 },
    { type: "code", offset: 4, length: 3 },
    { type: "bold", offset: 7, length: 4 },
  ]);
  const linked = renderTelegramText("[`foo`](https://example.org)");
  assert.equal(linked.text, "foo");
  assert.deepEqual(plain(linked.entities), [{ type: "textUrl", offset: 0, length: 3, url: "https://example.org" }]);
});

test("style splitting around code uses Telegram UTF-16 boundaries", () => {
  const value = renderTelegramText("**🙂 `x🙂` z**");
  assert.equal(value.text, "🙂 x🙂 z");
  assert.deepEqual(plain(value.entities), [
    { type: "bold", offset: 0, length: 3 },
    { type: "code", offset: 3, length: 3 },
    { type: "bold", offset: 6, length: 2 },
  ]);
});

test("escapes remove only recognized Markdown escaping and leave prompts ordinary", () => {
  const value = renderTelegramText(String.raw`ПРОМПТ \*literal\* \[x\]\(y\) \\ **ok**`);
  assert.equal(value.text, "ПРОМПТ *literal* [x](y) \\ ok");
  assert.deepEqual(plain(value.entities), [{ type: "bold", offset: 26, length: 2 }]);
});

test("malformed and unsafe Markdown stays readable instead of becoming markup", () => {
  for (const source of ["**open", "`open", "```ts\nopen", "[label](http://example.test)", "[label](https://user:pass@example.test)", "[](<x>)"]) {
    const value = renderTelegramText(source);
    assert.equal(value.text, source);
    assert.deepEqual(value.entities, []);
  }
  const html = renderTelegramText("<b>literal</b> &amp;");
  assert.equal(html.text, "<b>literal</b> &amp;"); assert.deepEqual(html.entities, []);
});

test("normalized spans convert through installed GramJS TL binary and round-trip", () => {
  const rendered = renderTelegramText("**A🙂** *B* ~~C~~ `D`\n```js\nE\n``` [F](https://e.test/p)");
  const entities = toTelegramEntities(rendered.text, rendered.entities);
  assert.ok(entities[0] instanceof Api.MessageEntityBold);
  const request = new Api.messages.SendMessage({ peer: new Api.InputPeerSelf(), message: rendered.text, randomId: bigInt.one,
    entities, noWebpage: true });
  const reader = new BinaryReader(request.getBytes());
  const decoded = reader.tgReadObject();
  assert.ok(decoded instanceof Api.messages.SendMessage); assert.equal(reader.tellPosition(), request.getBytes().length);
  assert.equal(decoded.message, rendered.text);
  assert.deepEqual(plain(fromTelegramEntities(decoded.message, decoded.entities ?? [])), plain(rendered.entities));
});

test("fresh Telegram automatic entities are ignored after exact shape and UTF-16 validation", () => {
  const text = "** no markup https://example.org";
  const actual = [
    new Api.MessageEntityBold({ offset: 0, length: 2 }),
    new Api.MessageEntityUrl({ offset: 13, length: 19 }),
  ];
  assert.deepEqual(plain(fromTelegramEntities(text, actual)), [{ type: "bold", offset: 0, length: 2 }]);
  assert.deepEqual(plain(fromTelegramEntities("x", [new Api.MessageEntityTextUrl({ offset: 0, length: 1, url: "https://e.test" })])),
    [{ type: "textUrl", offset: 0, length: 1, url: "https://e.test" }]);
  assert.throws(() => fromTelegramEntities("x", [new Api.MessageEntityUnderline({ offset: 0, length: 1 })]), refused);
});

test("copy snapshots caller records and returns canonical order", () => {
  const source: TelegramTextEntity[] = [
    { type: "italic", offset: 0, length: 3 }, { type: "bold", offset: 0, length: 3 },
  ];
  const copied = copyTelegramTextEntities("abc", source);
  source[0] = { type: "code", offset: 0, length: 1 };
  assert.deepEqual(plain(copied), [{ type: "bold", offset: 0, length: 3 }, { type: "italic", offset: 0, length: 3 }]);
});

test("validation rejects malformed spans, surrogate splits, unsafe URLs and crossing/code overlaps", () => {
  const text = "a🙂bcdef";
  const bad: unknown[] = [
    [{ type: "bold", offset: 2, length: 1 }],
    [{ type: "bold", offset: 0, length: 4 }, { type: "italic", offset: 3, length: 3 }],
    [{ type: "code", offset: 0, length: 4 }, { type: "bold", offset: 0, length: 1 }],
    [{ type: "textUrl", offset: 0, length: 1, url: "javascript:alert(1)" }],
    [{ type: "pre", offset: 0, length: 1 }],
    [{ type: "bold", offset: 0, length: 1, extra: true }],
    [{ type: "bold", offset: 0, length: 1 }, { type: "bold", offset: 0, length: 1 }],
  ];
  for (const entities of bad) assert.throws(() => copyTelegramTextEntities(text, entities as TelegramTextEntity[]), refused);
  assert.throws(() => fromTelegramEntities("x", [new Api.MessageEntityUnderline({ offset: 0, length: 1 })]), refused);
});

test("hostile entity proxies and accessors are refused without executing user code", () => {
  let traps = 0;
  const proxy = new Proxy({}, {
    get() { traps++; throw new Error("executed"); },
    ownKeys() { traps++; throw new Error("executed"); },
    getOwnPropertyDescriptor() { traps++; throw new Error("executed"); },
    getPrototypeOf() { traps++; throw new Error("executed"); },
  });
  assert.throws(() => copyTelegramTextEntities("x", [proxy] as TelegramTextEntity[]), refused);
  assert.equal(traps, 0);
  let getters = 0;
  const accessor = { offset: 0, length: 1 } as Record<string, unknown>;
  Object.defineProperty(accessor, "type", { enumerable: true, get() { getters++; return "bold"; } });
  assert.throws(() => copyTelegramTextEntities("x", [accessor] as TelegramTextEntity[]), refused);
  assert.equal(getters, 0);
});

test("input, output and Unicode bounds fail closed", () => {
  assert.throws(() => renderTelegramText("x".repeat(4097)), refused);
  assert.throws(() => renderTelegramText("*".repeat(16385)), refused);
  assert.throws(() => renderTelegramText("bad\ud800"), refused);
  assert.throws(() => renderTelegramText("bad\0text"), refused);
});
