import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ExportedMessage } from "./types.js";

export class JsonlSink {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  append(messages: ExportedMessage[]): Promise<void> {
    if (messages.length === 0) return Promise.resolve();
    const sourceId = messages[0]?.sourceId;
    if (!sourceId || messages.some((message) => message.sourceId !== sourceId)) {
      return Promise.reject(new Error("A JSONL append batch must contain exactly one source."));
    }
    const target = path.join(this.directory, `${sourceId}.jsonl`);
    const payload = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
    this.pending = this.pending.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(target, payload, { encoding: "utf8", mode: 0o600 });
    });
    return this.pending;
  }

  flush(): Promise<void> {
    return this.pending;
  }
}
