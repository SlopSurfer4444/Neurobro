import { stdin, stdout } from "node:process";

export async function ask(prompt: string): Promise<string> {
  if (!stdin.isTTY) throw new Error(`${prompt.trim()} requires an interactive terminal.`);
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

export async function askHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error(`${prompt.trim()} requires an interactive TTY or an environment variable.`);
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Input cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) stdout.write("\b \b");
          value = value.slice(0, -1);
          continue;
        }
        if (character === "\u0015") {
          stdout.write("\b \b".repeat(value.length));
          value = "";
          continue;
        }
        if (character >= " ") {
          value += character;
          stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

export async function readSessionPassphrase(envName: string, confirm = false): Promise<string> {
  const fromEnvironment = process.env[envName];
  if (fromEnvironment) return fromEnvironment;
  const first = await askHidden("Session encryption passphrase: ");
  if (first.length < 16) throw new Error("Session passphrase must be at least 16 characters long.");
  if (confirm) {
    const second = await askHidden("Confirm session passphrase: ");
    if (first !== second) throw new Error("Session passphrases do not match.");
  }
  return first;
}

export async function readExportPassphrase(envName: string, confirm = false): Promise<string> {
  const fromEnvironment = process.env[envName];
  if (fromEnvironment) return fromEnvironment;
  const first = await askHidden("Local export encryption passphrase: ");
  if (first.length < 16) throw new Error("Export passphrase must be at least 16 characters long.");
  if (confirm) {
    const second = await askHidden("Confirm export passphrase: ");
    if (first !== second) throw new Error("Export passphrases do not match.");
  }
  return first;
}
