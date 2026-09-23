import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseAuthConfig, type AuthConfig } from "./auth-config.js";
import { assertAstraReady, type GreetingPaths, type GreetingPrepared } from "./pilot-greeting.js";
import { assertPilotPrivateDirectory, type PilotDirectoryInspection } from "./pilot-outbox.js";
import type { PilotBinding } from "./pilot-telegram-adapter.js";

export type StandingWorkspaceTarget = Readonly<{ accountId: string; peerId: string; title: string }>;
export type StandingWorkspaceInput = Readonly<{
  workspaceId: string;
  target: StandingWorkspaceTarget;
  accountCustodyRoot: string;
  appRoot: string;
  authConfigPath: string;
  bindingPath: string;
  modelReceiptPath: string;
  attemptDirectory: string;
  killSwitchPath: string;
  stateDirectory: string;
}>;
export type StandingWorkspace = Readonly<{
  workspaceId: string;
  target: StandingWorkspaceTarget;
  accountCustodyRoot: string;
  appRoot: string;
  stateDirectory: string;
  paths: GreetingPaths;
}>;
export type PreparedStandingWorkspace = GreetingPrepared & Readonly<{
  workspaceId: string;
  target: StandingWorkspaceTarget;
  accountCustodyRoot: string;
  appRoot: string;
  stateDirectory: string;
}>;

type Data = Record<string, unknown>;
const refused = (): never => { throw new Error("STANDING_WORKSPACE_REFUSED"); };
function exact(value: unknown, keys: readonly string[]): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refused();
  const record = value as Data;
  if (Object.keys(record).sort().join("|") !== [...keys].sort().join("|")) return refused();
  return record;
}
function pathValue(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value)) return refused();
  return resolve(value);
}
function directChild(path: string, parent: string): boolean { return dirname(path) === parent; }
function inside(path: string, parent: string): boolean {
  const suffix = relative(parent, path);
  return suffix.length > 0 && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
function overlaps(left: string, right: string): boolean {
  return left === right || inside(left, right) || inside(right, left);
}
function validTarget(raw: unknown): StandingWorkspaceTarget {
  const target = exact(raw, ["accountId", "peerId", "title"]);
  if (typeof target.accountId !== "string" || !/^[1-9]\d{0,19}$/u.test(target.accountId) ||
      typeof target.peerId !== "string" || !/^-[1-9]\d{0,19}$/u.test(target.peerId) ||
      typeof target.title !== "string" || target.title !== target.title.trim() || !target.title.length || target.title.length > 256 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(target.title)) return refused();
  return Object.freeze({ accountId: target.accountId, peerId: target.peerId, title: target.title });
}

/** Normalizes host-owned paths without probing or creating either root. */
export function normalizeStandingWorkspace(raw: StandingWorkspaceInput): StandingWorkspace {
  const input = exact(raw, ["workspaceId", "target", "accountCustodyRoot", "appRoot", "authConfigPath", "bindingPath",
    "modelReceiptPath", "attemptDirectory", "killSwitchPath", "stateDirectory"]);
  if (typeof input.workspaceId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(input.workspaceId)) return refused();
  const target = validTarget(input.target);
  const accountCustodyRoot = pathValue(input.accountCustodyRoot);
  const appRoot = pathValue(input.appRoot);
  if (overlaps(accountCustodyRoot, appRoot)) return refused();
  const authConfigPath = pathValue(input.authConfigPath);
  const bindingPath = pathValue(input.bindingPath);
  const modelReceiptPath = pathValue(input.modelReceiptPath);
  const attemptDirectory = pathValue(input.attemptDirectory);
  const killSwitchPath = pathValue(input.killSwitchPath);
  const stateDirectory = pathValue(input.stateDirectory);
  if (!directChild(authConfigPath, accountCustodyRoot) ||
      ![bindingPath, modelReceiptPath, attemptDirectory, killSwitchPath, stateDirectory].every(path => directChild(path, appRoot))) return refused();
  const allPaths = [accountCustodyRoot, appRoot, authConfigPath, bindingPath, modelReceiptPath, attemptDirectory, killSwitchPath, stateDirectory];
  if (new Set(allPaths).size !== allPaths.length) return refused();
  const paths: GreetingPaths = Object.freeze({ authConfigPath, bindingPath, modelReceiptPath, attemptDirectory, killSwitchPath });
  return Object.freeze({ workspaceId: input.workspaceId, target, accountCustodyRoot, appRoot, stateDirectory, paths });
}

export function assertStandingWorkspaceStateDirectory(workspace: StandingWorkspace, rawStateDirectory: string): void {
  const normalized = normalizeStandingWorkspace({
    workspaceId: workspace.workspaceId, target: workspace.target, accountCustodyRoot: workspace.accountCustodyRoot, appRoot: workspace.appRoot,
    authConfigPath: workspace.paths.authConfigPath, bindingPath: workspace.paths.bindingPath, modelReceiptPath: workspace.paths.modelReceiptPath,
    attemptDirectory: workspace.paths.attemptDirectory, killSwitchPath: workspace.paths.killSwitchPath, stateDirectory: rawStateDirectory,
  });
  if (normalized.stateDirectory !== workspace.stateDirectory) return refused();
}

async function privateJson(path: string, maxBytes: number): Promise<unknown> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes) return refused();
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return refused();
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) return refused();
    try { return JSON.parse(bytes.toString("utf8")); } catch { return refused(); }
  } finally { await handle.close(); }
}
async function absent(path: string): Promise<void> {
  try { await lstat(path); return refused(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function canonicalRoot(root: string, inspection?: PilotDirectoryInspection): Promise<void> {
  await assertPilotPrivateDirectory(root, inspection);
  if (inspection && resolve(await inspection.realpath(root)) !== root) return refused();
  if (!inspection && resolve(await realpath(root)) !== root) return refused();
}

/**
 * Reuses only auth configuration and the encrypted Telegram session from account
 * custody. Binding, readiness, attempts, STOP and standing state remain rooted in
 * the distinct application workspace. Nothing is copied or created here.
 */
export async function prepareStandingWorkspace(raw: StandingWorkspaceInput, inspection?: PilotDirectoryInspection): Promise<PreparedStandingWorkspace> {
  const workspace = normalizeStandingWorkspace(raw);
  await canonicalRoot(workspace.accountCustodyRoot, inspection);
  await canonicalRoot(workspace.appRoot, inspection);
  await absent(workspace.paths.killSwitchPath);
  await absent(workspace.paths.attemptDirectory);
  assertAstraReady(await privateJson(workspace.paths.modelReceiptPath, 65_536));
  const config: AuthConfig = parseAuthConfig(await privateJson(workspace.paths.authConfigPath, 8_192), workspace.paths.authConfigPath);
  const session = resolve(config.account.sessionFile);
  if (!isAbsolute(config.account.sessionFile) || !directChild(session, workspace.accountCustodyRoot)) return refused();
  const sessionMetadata = await lstat(session);
  if (!sessionMetadata.isFile() || sessionMetadata.isSymbolicLink() || sessionMetadata.size < 1 || sessionMetadata.size > 65_536) return refused();
  const ownerLock = `${session}.owner.lock`;
  const rawBinding = exact(await privateJson(workspace.paths.bindingPath, 8_192), ["version", "workspaceId", "accountId", "peerId", "title",
    "sessionReference", "ownerLock", "checkedAt", "serving"]);
  if (rawBinding.version !== "telegram-workspace-binding-v1" || rawBinding.workspaceId !== workspace.workspaceId ||
      rawBinding.accountId !== workspace.target.accountId || rawBinding.peerId !== workspace.target.peerId || rawBinding.title !== workspace.target.title ||
      typeof rawBinding.sessionReference !== "string" || !isAbsolute(rawBinding.sessionReference) || resolve(rawBinding.sessionReference) !== session ||
      rawBinding.ownerLock !== ownerLock || rawBinding.serving !== false || typeof rawBinding.checkedAt !== "string" ||
      !Number.isFinite(Date.parse(rawBinding.checkedAt)) || Object.values(workspace.paths).includes(session) || Object.values(workspace.paths).includes(ownerLock)) return refused();
  const binding: PilotBinding = Object.freeze({ accountId: workspace.target.accountId, peerId: workspace.target.peerId });
  return Object.freeze({ ...workspace, config, binding, ownerLock });
}
