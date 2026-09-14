#!/usr/bin/env node
import path from "node:path";
import { loadConfig } from "./config.js";
import { loadAuthConfig } from "./auth-config.js";
import { bindExistingAccount } from "./account-binding.js";
import { authorize } from "./auth.js";
import { runDoctor } from "./doctor.js";
import { StateStore } from "./state-store.js";
import { GuardedExecutor } from "./guardrails.js";
import {
  createAuthorizedClient,
  discoverDialogs,
  findExactDialogByTitle,
  resolveConfiguredSources,
} from "./telegram-client.js";
import { readExportPassphrase, readSessionPassphrase } from "./prompt.js";
import { acquireProcessLock } from "./process-lock.js";
import { TelegramIngestor } from "./ingestor.js";
import { GuardrailStopError, safeErrorSummary } from "./errors.js";
import {
  decryptExportForLocalView,
  exportRange,
  parseBoundedDateRange,
  purgeExpiredExports,
  type PurgeResult,
} from "./range-export.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing required option ${name}.`);
  return value;
}

function reportPurge(result: PurgeResult): void {
  for (const deleted of result.deleted) console.log(`PURGED expired encrypted export: ${deleted}`);
  for (const retained of result.retainedMalformed) {
    console.warn(`WARN retained malformed export for manual review: ${retained}`);
  }
}

async function connectedCommand(
  configPath: string,
  operation: "probe" | "discover" | "find-dialog" | "export-range" | "sync" | "watch",
): Promise<void> {
  const config = await loadConfig(configPath);
  const release = await acquireProcessLock(config.lockFile);
  const store = new StateStore(config.stateFile);
  const guard = new GuardedExecutor(config.limits, store);
  let client: Awaited<ReturnType<typeof createAuthorizedClient>> | undefined;
  try {
    const passphrase = await readSessionPassphrase(config.account.sessionPassphraseEnv);
    client = await createAuthorizedClient(config, passphrase, guard);
    if (operation === "probe") {
      console.log("CONNECT READY: encrypted session accepted and Telegram updates state was read.");
      return;
    }
    const dialogs = await discoverDialogs(client, guard, config.limits.dialogDiscoveryLimit);
    if (operation === "discover") {
      for (const dialog of dialogs) {
        console.log(`${dialog.peerId}\t${dialog.kind}\t${dialog.title.replace(/[\r\n\t]/g, " ")}`);
      }
      console.log(`Listed ${dialogs.length} dialogs (bounded maximum ${config.limits.dialogDiscoveryLimit}).`);
      return;
    }

    if (operation === "find-dialog") {
      const dialog = findExactDialogByTitle(dialogs, requiredOption("--title"));
      console.log(`EXACT DIALOG MATCH\t${dialog.peerId}\t${dialog.kind}\t${dialog.title.replace(/[\r\n\t]/g, " ")}`);
      return;
    }

    const sources = resolveConfiguredSources(config, dialogs);
    if (sources.length === 0) throw new Error("No sources are enabled; refusing an unbounded run.");
    if (operation === "export-range") {
      const sourceId = requiredOption("--source");
      const resolved = sources.find((entry) => entry.source.id === sourceId);
      if (!resolved) throw new Error(`Source ${JSON.stringify(sourceId)} is not explicitly enabled.`);
      const range = parseBoundedDateRange(
        requiredOption("--from"),
        requiredOption("--to"),
        config.limits.lookbackDays,
      );
      const exportPassphrase = await readExportPassphrase(config.output.exportPassphraseEnv, true);
      const result = await exportRange(config, client, guard, resolved, range, exportPassphrase);
      reportPurge(result.purge);
      console.log(`ENCRYPTED RANGE READY: ${result.messageCount} message(s) at ${result.filePath}`);
      console.log(`Retention: ${config.output.retentionDays} day(s); plaintext was not written to disk.`);
      return;
    }
    const ingestor = new TelegramIngestor(config, client, guard, store, sources);
    if (operation === "sync") {
      const result = await ingestor.syncAll();
      for (const [source, count] of Object.entries(result)) console.log(`${source}: ${count} message(s) exported.`);
      return;
    }

    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(`Watching ${sources.length} exact allowlisted source(s). Press Ctrl+C to stop.`);
    await ingestor.watch(controller.signal);
  } finally {
    await client?.disconnect().catch(() => undefined);
    await release();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const configPath = path.resolve(option("--config") ?? "config.json");
  const commands = [
    "bind-account",
    "doctor",
    "auth",
    "probe",
    "discover",
    "find-dialog",
    "export-range",
    "view-export",
    "purge-expired",
    "sync",
    "watch",
  ];
  if (!command || !commands.includes(command)) {
    console.error(
      "Usage: node dist/src/cli.js <doctor|auth|probe|discover|find-dialog|export-range|view-export|purge-expired|sync|watch> --config PATH",
    );
    process.exitCode = 2;
    return;
  }
  if (command === "bind-account") {
    await bindExistingAccount(await loadAuthConfig(configPath), requiredOption("--title"), path.resolve(requiredOption("--binding")));
    return;
  }
  if (command === "auth") {
    const config = has("--auth-only") ? await loadAuthConfig(configPath) : await loadConfig(configPath);
    await authorize(config, has("--replace-session"));
    return;
  }
  if (command === "doctor") {
    const config = await loadConfig(configPath);
    process.exitCode = await runDoctor(config);
    return;
  }
  if (command === "purge-expired") {
    const config = await loadConfig(configPath);
    const result = await purgeExpiredExports(config.output.directory);
    reportPurge(result);
    console.log(`Purge complete: deleted=${result.deleted.length} retained-malformed=${result.retainedMalformed.length}.`);
    return;
  }
  if (command === "view-export") {
    const config = await loadConfig(configPath);
    const exportPassphrase = await readExportPassphrase(config.output.exportPassphraseEnv);
    const plaintext = await decryptExportForLocalView(
      config.output.directory,
      requiredOption("--file"),
      exportPassphrase,
    );
    process.stdout.write(plaintext);
    return;
  }
  await connectedCommand(
    configPath,
    command as "probe" | "discover" | "find-dialog" | "export-range" | "sync" | "watch",
  );
}

main().catch((error: unknown) => {
  if (error instanceof GuardrailStopError) {
    console.error(`STOP ${error.code}: ${error.message}`);
    process.exitCode = 3;
    return;
  }
  console.error(`FAIL: ${safeErrorSummary(error)}`);
  process.exitCode = 1;
});
