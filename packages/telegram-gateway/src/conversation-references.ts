import { createHmac, randomBytes } from "node:crypto";

export type ConversationReferences = Readonly<{
  matches(peerId: string, accountId?: string): boolean;
  message(id: number): string;
  /** Resolve only a message previously named by trusted context/history code. */
  resolveMessage(ref: string): number | undefined;
  speaker(authorId: string): string;
  close(): void;
}>;

/** One bound Telegram connection, shared by its context packer/history reader.
 * Native process rotation keeps the same references and selected transport;
 * callback authority remains separately fenced by the native session owner.
 * A bounded recent resolution cache never changes aliases or persists raw IDs.
 * A missing/evicted ref must be read again through history before an action.
 * Resolution only locates a target; the transport still revalidates its peer.
 * The connection
 * owner closes this only after all consumers settle. A reconnect gets a fresh
 * instance; within one connection an old alias never changes its meaning. */
export function createConversationReferences(binding: { peerId: string; accountId: string }): ConversationReferences {
  const peerId = binding.peerId, accountId = binding.accountId;
  const userId = (value: string) => /^[1-9]\d{0,19}$/.test(value);
  const refuse = (): never => { throw new Error("CONVERSATION_REFERENCES_REFUSED"); };
  if (!/^-[1-9]\d{0,22}$/.test(peerId) || !userId(accountId)) return refuse();
  const key = randomBytes(32), messages = new Map<string, number>(); let closed = false;
  const requireOpen = () => { if (closed) return refuse(); };
  const label = (kind: string, id: string) => {
    requireOpen();
    return kind + "_" + createHmac("sha256", key).update(kind + ":" + id).digest("hex").slice(0, 24);
  };
  return Object.freeze({
    matches(peer: string, account?: string) { requireOpen(); return peer === peerId && (account === undefined || account === accountId); },
    message(id: number) {
      if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) return refuse();
      const ref = label("m", String(id));
      messages.delete(ref); messages.set(ref, id);
      if (messages.size > 8192) messages.delete(messages.keys().next().value!);
      return ref;
    },
    resolveMessage(ref: string) {
      requireOpen();
      if (typeof ref !== "string" || !/^m_[0-9a-f]{24}$/.test(ref)) return undefined;
      const id = messages.get(ref);
      if (id !== undefined) { messages.delete(ref); messages.set(ref, id); }
      return id;
    },
    speaker(author: string) { requireOpen(); if (!userId(author)) return refuse(); return author === accountId ? "neurobro" : label("a", author); },
    close() { closed = true; messages.clear(); key.fill(0); },
  });
}
