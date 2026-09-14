import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { Api, TelegramClient, utils } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { LogLevel } from "telegram/extensions/Logger.js";
import bigInt from "big-integer";
import { openExistingEncryptedSessionLease } from "./existing-session-lease.js";
import { acquireProcessLock } from "./process-lock.js";
import { ask, askHidden, readSessionPassphrase } from "./prompt.js";
import { clientOptions } from "./telegram-client.js";
import type { AuthConfig } from "./auth-config.js";
import { installBindingNetworkFence } from "./binding-network-fence.js";

type Account = { id: string; label: string; usable: boolean };
type Chat = { id: string; title: string; usable: boolean };
type Binding = { version: "telegram-account-binding-v1"; accountId: string; peerId: string; title: string };

export async function checkAccountBinding(title: string, ports: {
  account(): Promise<Account>;
  chats(): Promise<Chat[]>;
  confirm(label: string): Promise<boolean>;
  disconnect(): Promise<void>;
  save(binding: Binding): Promise<void>;
}): Promise<void> {
  let binding: Binding;
  try {
    const account = await ports.account();
    if (!account.usable || !/^[1-9]\d*$/.test(account.id)) throw new Error("ACCOUNT_REFUSED");
    if (!await ports.confirm(`Use this additional account: ${account.label} (ID ${account.id})?`)) throw new Error("ACCOUNT_NOT_CONFIRMED");
    const matches = (await ports.chats()).filter(chat => chat.title === title);
    if (matches.length !== 1) throw new Error("EXACT_CHAT_NOT_UNIQUE_IN_BOUNDED_RESPONSE");
    const chat = matches[0]!;
    if (!chat.usable || !/^-[1-9]\d*$/.test(chat.id)) throw new Error("CHAT_MEMBERSHIP_REFUSED");
    if (!await ports.confirm(`Bind this exact chat: ${chat.title} (ID ${chat.id})?`)) throw new Error("CHAT_NOT_CONFIRMED");
    binding = { version: "telegram-account-binding-v1", accountId: account.id, peerId: chat.id, title };
  } finally {
    await ports.disconnect();
  }
  await ports.save(binding);
}

const localLabel = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 256);

export async function bindExistingAccount(config: AuthConfig, title: string, output: string): Promise<void> {
  if (!title.trim() || title.length > 256 || !path.isAbsolute(output)) throw new Error("BINDING_ARGUMENTS_REFUSED");
  try { await access(output); throw new Error("BINDING_ALREADY_EXISTS"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const releaseLock = await acquireProcessLock(`${config.account.sessionFile}.owner.lock`);
  let lease: Awaited<ReturnType<typeof openExistingEncryptedSessionLease>> | undefined;
  let client: TelegramClient | undefined;
  let settled = true;
  let restoreFence: (() => void) | undefined;
  try {
    const apiId = Number(process.env[config.account.apiIdEnv] || await ask("Telegram api_id: "));
    const apiHash = process.env[config.account.apiHashEnv] || await askHidden("Telegram api_hash: ");
    if (!Number.isSafeInteger(apiId) || apiId <= 0 || !/^[a-fA-F0-9]{32}$/.test(apiHash)) throw new Error("API_CREDENTIAL_FORMAT_REFUSED");
    lease = await openExistingEncryptedSessionLease({ reference: config.account.sessionFile, passphrase: await readSessionPassphrase(config.account.sessionPassphraseEnv) });
    client = new TelegramClient(new StringSession(lease.material.value), apiId, apiHash, {
      ...clientOptions(), requestRetries: 1, connectionRetries: 1, reconnectRetries: 0, autoReconnect: false,
    });
    client.setLogLevel(LogLevel.WARN);
    restoreFence = installBindingNetworkFence(client, () => {
      console.error("BINDING_NETWORK_REENTRY_REFUSED: process stopping; owner lock preserved.");
      process.exit(74);
    });
    const ownedClient = client;
    settled = false;
    await checkAccountBinding(title, {
      async account() {
        await ownedClient.connect();
        const me = await ownedClient.getMe();
        return { id: me.id.toString(), label: localLabel([me.firstName, me.lastName, me.username].filter(Boolean).join(" ")), usable: Boolean(me.self && !me.bot && !me.deleted) };
      },
      async chats() {
        // One response only. Discard accompanying top-message bodies; no history request.
        const envelope = await ownedClient.invoke(new Api.messages.GetDialogs({ offsetDate: 0, offsetId: 0, offsetPeer: new Api.InputPeerEmpty(), limit: 100, hash: bigInt.zero }));
        if (!("chats" in envelope)) throw new Error("DIALOG_RESPONSE_REFUSED");
        if (envelope.dialogs.length > 100) throw new Error("DIALOG_LIMIT_REFUSED");
        const dialogIds = new Set(envelope.dialogs.filter(dialog => dialog instanceof Api.Dialog).map(dialog => utils.getPeerId(dialog.peer)));
        const chats = envelope.chats.filter(entity => dialogIds.has(utils.getPeerId(entity))).map(entity => {
          if (entity instanceof Api.Chat) return { id: utils.getPeerId(entity), title: entity.title, usable: !entity.left && !entity.deactivated && !entity.migratedTo };
          if (entity instanceof Api.Channel) return { id: utils.getPeerId(entity), title: entity.title, usable: !entity.left && Boolean(entity.megagroup || entity.gigagroup) && !entity.min && !entity.bannedRights?.viewMessages };
          return { id: "", title: "title" in entity ? entity.title : "", usable: false };
        });
        envelope.messages.length = 0;
        envelope.users.length = 0;
        return chats;
      },
      confirm: async label => (await ask(`${localLabel(label)} Type YES to confirm: `)) === "YES",
      async disconnect() { await ownedClient.destroy(); settled = true; },
      async save(binding) {
        await writeFile(output, JSON.stringify({ ...binding, sessionReference: config.account.sessionFile, ownerLock: `${config.account.sessionFile}.owner.lock`, checkedAt: new Date().toISOString(), serving: false }), { flag: "wx", mode: 0o600 });
      },
    });
    console.log("BINDING SAVED: account and exact chat confirmed; connection closed. No serving runtime started.");
  } finally {
    await lease?.release();
    // An unconfirmed disconnect preserves the lock for OS reconciliation.
    if (settled) { restoreFence?.(); await releaseLock(); }
  }
}
