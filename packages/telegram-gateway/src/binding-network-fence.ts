import { MTProtoSender } from "telegram/network/MTProtoSender.js";
import type { TelegramClient } from "telegram";

// Dedicated operator CLI only: this process owns exactly one client. GramJS
// 2.26.22 calls these methods even with autoReconnect=false/reconnectRetries=0.
export function installBindingNetworkFence(client: Pick<TelegramClient, "_switchDC">, refuse: () => never): () => void {
  const reconnect = MTProtoSender.prototype.reconnect;
  const internalReconnect = MTProtoSender.prototype._reconnect;
  const switchDC = client._switchDC;
  MTProtoSender.prototype.reconnect = () => refuse();
  MTProtoSender.prototype._reconnect = async () => refuse();
  client._switchDC = async () => refuse();
  return () => {
    MTProtoSender.prototype.reconnect = reconnect;
    MTProtoSender.prototype._reconnect = internalReconnect;
    client._switchDC = switchDC;
  };
}
