import { Api } from "telegram";
import { isProxy } from "node:util/types";

type SimpleEntityType = "bold" | "italic" | "strike" | "code" | "blockquote";
type SimpleEntity = Readonly<{ type: SimpleEntityType; offset: number; length: number }>;
type PreEntity = Readonly<{ type: "pre"; offset: number; length: number; language: string }>;
type TextUrlEntity = Readonly<{ type: "textUrl"; offset: number; length: number; url: string }>;
export type TelegramTextEntity = SimpleEntity | PreEntity | TextUrlEntity;
export type RenderedTelegramText = Readonly<{ text: string; entities: readonly TelegramTextEntity[] }>;

export class TelegramTextFormatError extends Error {
  constructor() { super("TELEGRAM_TEXT_FORMAT_REFUSED"); }
}

const fail = (): never => { throw new TelegramTextFormatError(); };
const SIMPLE = new Set<SimpleEntityType>(["bold", "italic", "strike", "code", "blockquote"]);
const ESCAPABLE = new Set(["\\", "*", "~", "`", "[", "]", "(", ")"]);
const TYPE_ORDER: Readonly<Record<TelegramTextEntity["type"], number>> = Object.freeze({
  blockquote: 0, textUrl: 1, bold: 2, italic: 3, strike: 4, code: 5, pre: 6,
});

function validUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (++i >= value.length) return false;
      const next = value.charCodeAt(i);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && validUnicode(value) &&
    Buffer.from(value, "utf8").toString("utf8") === value && Buffer.byteLength(value, "utf8") <= 4096;
}

function boundary(text: string, offset: number): boolean {
  return offset === 0 || offset === text.length ||
    !(text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff &&
      text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff);
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && "value" in descriptor && descriptor.enumerable;
  });
}

function exactOwnData(value: object, keys: readonly string[]): value is Record<string, unknown> {
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && "value" in descriptor && descriptor.enumerable;
  });
}

function safeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0 && parsed.username === "" && parsed.password === "";
  } catch { return false; }
}

function normalized(text: string, entities: readonly TelegramTextEntity[]): readonly TelegramTextEntity[] {
  if (!validText(text) || !Array.isArray(entities) || isProxy(entities) || Reflect.ownKeys(entities).length !== entities.length + 1) return fail();
  const result: TelegramTextEntity[] = [];
  for (let index = 0; index < entities.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(entities, String(index));
    if (!descriptor || !("value" in descriptor)) return fail();
    const entity = descriptor.value as unknown;
    if (!entity || typeof entity !== "object" || isProxy(entity)) return fail();
    const typeDescriptor = Object.getOwnPropertyDescriptor(entity, "type");
    if (!typeDescriptor || !("value" in typeDescriptor) || !typeDescriptor.enumerable) return fail();
    const type = typeDescriptor.value;
    const keys = type === "pre" ? ["type", "offset", "length", "language"] :
      type === "textUrl" ? ["type", "offset", "length", "url"] : ["type", "offset", "length"];
    if (!exactRecord(entity, keys) || !(SIMPLE.has(type as SimpleEntityType) || type === "pre" || type === "textUrl")) return fail();
    const offset = entity.offset, length = entity.length;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || (offset as number) < 0 || (length as number) <= 0 ||
        (offset as number) + (length as number) > text.length || !boundary(text, offset as number) || !boundary(text, (offset as number) + (length as number))) return fail();
    if (type === "pre") {
      if (typeof entity.language !== "string" || !/^[A-Za-z0-9_+.#-]{0,32}$/u.test(entity.language)) return fail();
      result.push(Object.freeze({ type, offset: offset as number, length: length as number, language: entity.language }));
    } else if (type === "textUrl") {
      if (!safeUrl(entity.url)) return fail();
      result.push(Object.freeze({ type, offset: offset as number, length: length as number, url: entity.url }));
    } else {
      result.push(Object.freeze({ type: type as SimpleEntityType, offset: offset as number, length: length as number }));
    }
  }
  result.sort((a, b) => a.offset - b.offset || b.length - a.length || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
  for (let i = 0; i < result.length; i++) {
    const left = result[i]!;
    for (let j = i + 1; j < result.length; j++) {
      const right = result[j]!;
      if (right.offset >= left.offset + left.length) break;
      const rightEnd = right.offset + right.length, leftEnd = left.offset + left.length;
      const nested = rightEnd <= leftEnd;
      if (!nested || left.type === "code" || left.type === "pre" || right.type === "code" || right.type === "pre" ||
          left.type === "textUrl" && right.type === "textUrl" ||
          left.type === "blockquote" && right.type === "blockquote" ||
          left.offset === right.offset && left.length === right.length && left.type === right.type) return fail();
    }
  }
  return Object.freeze(result);
}

function overlap(left: { offset: number; length: number }, right: { offset: number; length: number }): boolean {
  return left.offset < right.offset + right.length && right.offset < left.offset + left.length;
}

/** Markdown permits styles around code, while Telegram forbids those entity
 * overlaps. Rendering keeps the literal text and the code span, splitting only
 * the surrounding visual style. A labeled HTTPS link takes priority over code
 * inside its label so the requested href is never silently lost. Expanded
 * quotes likewise retain their container and literal code text while dropping
 * the overlapping code entity under the existing conservative overlap rule. */
function telegramCompatible(entities: readonly MutableEntity[]): TelegramTextEntity[] {
  const links = entities.filter(entity => entity.type === "textUrl" || entity.type === "blockquote");
  const atomic = entities.filter(entity => (entity.type === "code" || entity.type === "pre") && !links.some(link => overlap(entity, link)));
  const result: MutableEntity[] = entities.filter(entity => entity.type === "textUrl" || entity.type === "blockquote" || entity.type === "code" || entity.type === "pre")
    .filter(entity => entity.type === "textUrl" || entity.type === "blockquote" || atomic.includes(entity));
  for (const entity of entities) {
    if (entity.type !== "bold" && entity.type !== "italic" && entity.type !== "strike") continue;
    let spans = [{ offset: entity.offset, length: entity.length }];
    for (const code of atomic) {
      const next: { offset: number; length: number }[] = [];
      for (const span of spans) {
        if (!overlap(span, code)) { next.push(span); continue; }
        const spanEnd = span.offset + span.length, codeEnd = code.offset + code.length;
        if (span.offset < code.offset) next.push({ offset: span.offset, length: code.offset - span.offset });
        if (codeEnd < spanEnd) next.push({ offset: codeEnd, length: spanEnd - codeEnd });
      }
      spans = next;
    }
    for (const span of spans) if (span.length > 0) result.push({ type: entity.type, ...span });
  }
  return result as TelegramTextEntity[];
}

export function copyTelegramTextEntities(text: string, entities: readonly TelegramTextEntity[]): readonly TelegramTextEntity[] {
  return normalized(text, entities);
}

export function toTelegramEntities(text: string, entities: readonly TelegramTextEntity[]): Api.TypeMessageEntity[] {
  return normalized(text, entities).map(entity => {
    const position = { offset: entity.offset, length: entity.length };
    switch (entity.type) {
      case "bold": return new Api.MessageEntityBold(position);
      case "italic": return new Api.MessageEntityItalic(position);
      case "strike": return new Api.MessageEntityStrike(position);
      case "code": return new Api.MessageEntityCode(position);
      case "blockquote": {
        const args = { flags: 0, collapsed: false, ...position };
        return new Api.MessageEntityBlockquote(args);
      }
      case "pre": return new Api.MessageEntityPre({ ...position, language: entity.language });
      case "textUrl": return new Api.MessageEntityTextUrl({ ...position, url: entity.url });
    }
  });
}

type TlEntityConstructor = Readonly<{ prototype: object; CONSTRUCTOR_ID: number; SUBCLASS_OF_ID: number; className: string }>;
const TL_BASE_KEYS = ["CONSTRUCTOR_ID", "SUBCLASS_OF_ID", "className", "classType", "originalArgs"] as const;

function tlArguments(entity: object, constructor: TlEntityConstructor, argumentKeys: readonly string[]): Record<string, unknown> {
  const keys = [...TL_BASE_KEYS, ...argumentKeys];
  if (Object.getPrototypeOf(entity) !== constructor.prototype || !exactOwnData(entity, keys)) return fail();
  const value = entity as Record<string, unknown>, args = value.originalArgs;
  if (value.CONSTRUCTOR_ID !== constructor.CONSTRUCTOR_ID || value.SUBCLASS_OF_ID !== constructor.SUBCLASS_OF_ID ||
      value.className !== constructor.className || value.classType !== "constructor" || !exactRecord(args, argumentKeys)) return fail();
  for (const key of argumentKeys) if (value[key] !== args[key]) return fail();
  return args;
}

function validTlSpan(text: string, args: Record<string, unknown>): { offset: number; length: number } {
  const offset = args.offset, length = args.length;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || (offset as number) < 0 || (length as number) <= 0 ||
      (offset as number) + (length as number) > text.length || !boundary(text, offset as number) || !boundary(text, (offset as number) + (length as number))) return fail();
  return { offset: offset as number, length: length as number };
}

export function fromTelegramEntities(text: string, entities: readonly Api.TypeMessageEntity[]): readonly TelegramTextEntity[] {
  if (!validText(text) || !Array.isArray(entities) || isProxy(entities) || Reflect.ownKeys(entities).length !== entities.length + 1) return fail();
  const projected: TelegramTextEntity[] = [];
  for (const entity of entities) {
    if (!entity || typeof entity !== "object" || isProxy(entity)) return fail();
    let constructor: TlEntityConstructor | undefined, keys: readonly string[] = ["offset", "length"];
    let type: TelegramTextEntity["type"] | "automatic" | undefined;
    if (entity instanceof Api.MessageEntityBold) { constructor = Api.MessageEntityBold; type = "bold"; }
    else if (entity instanceof Api.MessageEntityItalic) { constructor = Api.MessageEntityItalic; type = "italic"; }
    else if (entity instanceof Api.MessageEntityStrike) { constructor = Api.MessageEntityStrike; type = "strike"; }
    else if (entity instanceof Api.MessageEntityCode) { constructor = Api.MessageEntityCode; type = "code"; }
    else if (entity instanceof Api.MessageEntityBlockquote) { constructor = Api.MessageEntityBlockquote; type = "blockquote"; keys = ["flags", "collapsed", "offset", "length"]; }
    else if (entity instanceof Api.MessageEntityPre) { constructor = Api.MessageEntityPre; type = "pre"; keys = ["offset", "length", "language"]; }
    else if (entity instanceof Api.MessageEntityTextUrl) { constructor = Api.MessageEntityTextUrl; type = "textUrl"; keys = ["offset", "length", "url"]; }
    else if (entity instanceof Api.MessageEntityUrl) { constructor = Api.MessageEntityUrl; type = "automatic"; }
    else if (entity instanceof Api.MessageEntityEmail) { constructor = Api.MessageEntityEmail; type = "automatic"; }
    else if (entity instanceof Api.MessageEntityMention) { constructor = Api.MessageEntityMention; type = "automatic"; }
    else if (entity instanceof Api.MessageEntityHashtag) { constructor = Api.MessageEntityHashtag; type = "automatic"; }
    else if (entity instanceof Api.MessageEntityCashtag) { constructor = Api.MessageEntityCashtag; type = "automatic"; }
    else if (entity instanceof Api.MessageEntityBotCommand) { constructor = Api.MessageEntityBotCommand; type = "automatic"; }
    else if (entity instanceof Api.MessageEntityPhone) { constructor = Api.MessageEntityPhone; type = "automatic"; }
    if (!constructor || !type) return fail();
    const args = tlArguments(entity, constructor, keys), position = validTlSpan(text, args);
    if (type === "blockquote" && (args.flags !== 0 || args.collapsed !== false)) return fail();
    if (type === "automatic") continue;
    if (type === "pre") projected.push({ type, ...position, language: args.language as string });
    else if (type === "textUrl") projected.push({ type, ...position, url: args.url as string });
    else projected.push({ type, ...position });
  }
  return normalized(text, projected);
}

type MutableEntity = { type: TelegramTextEntity["type"]; offset: number; length: number; language?: string; url?: string };
type Builder = { text: string; entities: MutableEntity[] };

function append(builder: Builder, value: string): void { builder.text += value; }

function unescapedAt(source: string, index: number): boolean {
  let slashes = 0;
  for (let at = index - 1; at >= 0 && source[at] === "\\"; at--) slashes++;
  return slashes % 2 === 0;
}

function findDelimiter(source: string, delimiter: string, from: number, end: number): number {
  for (let at = source.indexOf(delimiter, from); at >= 0 && at < end; at = source.indexOf(delimiter, at + 1)) {
    if (unescapedAt(source, at)) return at;
  }
  return -1;
}

function linkAt(source: string, start: number, end: number): { labelEnd: number; urlStart: number; close: number; url: string } | undefined {
  let depth = 1, labelEnd = -1;
  for (let at = start + 1; at < end; at++) {
    if (source[at] === "\\" && at + 1 < end) { at++; continue; }
    if (source[at] === "[") depth++;
    else if (source[at] === "]" && --depth === 0) { labelEnd = at; break; }
  }
  if (labelEnd <= start + 1 || source[labelEnd + 1] !== "(") return;
  let parentheses = 1;
  for (let at = labelEnd + 2; at < end; at++) {
    if (source[at] === "\\") return;
    if (source[at] === "(") parentheses++;
    else if (source[at] === ")" && --parentheses === 0) {
      const url = source.slice(labelEnd + 2, at);
      if (!safeUrl(url)) return;
      return { labelEnd, urlStart: labelEnd + 2, close: at, url };
    }
  }
}

function fragment(source: string, start: number, end: number, builder: Builder): void {
  for (let at = start; at < end;) {
    const current = source[at]!;
    // Only top-level line markers form a quote. Consecutive quoted lines share
    // one entity; recursive inline parsing never creates nested blockquotes.
    if (start === 0 && end === source.length && (at === 0 || source[at - 1] === "\n") && current === ">") {
      let cursor = at, content = "";
      while (cursor < end && source[cursor] === ">") {
        let contentStart = cursor + 1;
        if (source[contentStart] === " " || source[contentStart] === "\t") contentStart++;
        const newline = source.indexOf("\n", contentStart);
        const lineEnd = newline < 0 || newline >= end ? end : newline;
        content += source.slice(contentStart, lineEnd);
        cursor = lineEnd;
        if (cursor < end && source[cursor + 1] === ">") { content += "\n"; cursor++; }
        else break;
      }
      const offset = builder.text.length;
      // Prefixing a sentinel keeps the inline parser out of its block mode.
      fragment(" " + content, 1, content.length + 1, builder);
      if (builder.text.length > offset) builder.entities.push({ type: "blockquote", offset, length: builder.text.length - offset });
      at = cursor; continue;
    }
    if (current === "\\" && at + 1 < end && ESCAPABLE.has(source[at + 1]!)) {
      append(builder, source[at + 1]!); at += 2; continue;
    }
    if (source.startsWith("```", at)) {
      const lineEnd = source.indexOf("\n", at + 3);
      const languageEnd = lineEnd > 0 && source[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
      const language = lineEnd >= 0 && lineEnd < end ? source.slice(at + 3, languageEnd) : "";
      const close = lineEnd >= 0 && lineEnd < end && /^[A-Za-z0-9_+.#-]{0,32}$/u.test(language)
        ? findDelimiter(source, "```", lineEnd + 1, end) : -1;
      if (close >= 0) {
        const offset = builder.text.length;
        append(builder, source.slice(lineEnd + 1, close));
        if (builder.text.length > offset) builder.entities.push({ type: "pre", offset, length: builder.text.length - offset, language });
        at = close + 3; continue;
      }
      append(builder, "```"); at += 3; continue;
    }
    if (current === "`") {
      const close = findDelimiter(source, "`", at + 1, end);
      if (close > at + 1) {
        const offset = builder.text.length;
        append(builder, source.slice(at + 1, close));
        builder.entities.push({ type: "code", offset, length: builder.text.length - offset });
        at = close + 1; continue;
      }
      append(builder, current); at++; continue;
    }
    if (current === "[") {
      const link = linkAt(source, at, end);
      if (link) {
        const offset = builder.text.length;
        fragment(source, at + 1, link.labelEnd, builder);
        if (builder.text.length > offset) builder.entities.push({ type: "textUrl", offset, length: builder.text.length - offset, url: link.url });
        at = link.close + 1; continue;
      }
    }
    if (source.startsWith("***", at)) {
      const close = findDelimiter(source, "***", at + 3, end);
      if (close > at + 3) {
        const offset = builder.text.length;
        fragment(source, at + 3, close, builder);
        const length = builder.text.length - offset;
        if (length > 0) builder.entities.push({ type: "bold", offset, length }, { type: "italic", offset, length });
        at = close + 3; continue;
      }
    }
    const marker = source.startsWith("**", at) ? "**" : source.startsWith("~~", at) ? "~~" : current === "*" ? "*" : undefined;
    if (marker) {
      const close = findDelimiter(source, marker, at + marker.length, end);
      if (close > at + marker.length) {
        const offset = builder.text.length;
        fragment(source, at + marker.length, close, builder);
        const length = builder.text.length - offset;
        if (length > 0) builder.entities.push({ type: marker === "**" ? "bold" : marker === "~~" ? "strike" : "italic", offset, length });
        at = close + marker.length; continue;
      }
    }
    append(builder, current); at++;
  }
}

export function renderTelegramText(markdown: string): RenderedTelegramText {
  if (typeof markdown !== "string" || Buffer.byteLength(markdown, "utf8") > 16384 || markdown.includes("\0") || !validUnicode(markdown)) return fail();
  const builder: Builder = { text: "", entities: [] };
  fragment(markdown, 0, markdown.length, builder);
  if (!validText(builder.text)) return fail();
  const entities = normalized(builder.text, telegramCompatible(builder.entities));
  return Object.freeze({ text: builder.text, entities });
}
