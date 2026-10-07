import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface PersonalConfig {
  schemaVersion: 1;
  stateDirectory: string;
  account: { id: string; ownerId: string; controlPeerId: string };
  encryptionKeyEnv: string;
  hermes: { baseUrl: string; apiKeyEnv: string; requestTimeoutMs?: number; bridgeUrl?: string; registrationKeyEnv?: string; cronUrl?: string };
  telegram: { command: string; args: string[]; databaseDirectory: string; filesDirectory: string; apiIdEnv: string; apiHashEnv: string };
  computer?: { enabled: boolean; command: string; args: string[]; projects: unknown[] };
  web?: { searchEndpoint?: string; apiKeyEnv?: string };
  sourceScopes?: string[];
  tools?: { port?: number };
  artifacts?: { pythonExecutable?: string };
  /** Personal integrations are available only in the owner's private control room. */
  documents?: { enabled: boolean };
  ownerTelegram?: { readAllChats: boolean; manageFolders: boolean; joinPublicChats: boolean };
  github?: { owner: string; tokenEnv?: string };
  desktopContext?: { enabled: boolean; codexHome: string; ownerId: string; includeArchived?: boolean; scope: { allOwnerThreads?: true; threadIds?: string[]; projectRoots?: string[] } };
  images?: { baseUrl: string; apiKeyEnv: string; model: string };
  /** Explicit persistent owner grants for additional peers/features; never learned from chat content. */
  grants?: { capability: string; resources: string[] }[];
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}: expected object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`Invalid ${name}: expected nonempty string`);
  return value;
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${name}: expected string array`);
  return value.map((v) => string(v, name));
}
function absolute(value: unknown, name: string): string {
  const path = string(value, name);
  if (!isAbsolute(path)) throw new Error(`Invalid ${name}: use absolute path`);
  return resolve(path);
}
function envName(value: unknown, name: string): string {
  const nameValue = string(value, name);
  if (!/^[A-Z][A-Z0-9_]*$/.test(nameValue)) throw new Error(`Invalid ${name}: expected environment variable name`);
  return nameValue;
}
function localUrl(value: unknown, name: string): string {
  const parsed = new URL(string(value, name));
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`Invalid ${name}`);
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error(`${name}: unencrypted endpoint must be loopback`);
  return parsed.href.replace(/\/$/, '');
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

/** Credentials are referenced by name. Values never occur in configuration diagnostics. */
export function parseConfig(value: unknown): PersonalConfig {
  const root = object(value, 'config');
  if (root.schemaVersion !== 1) throw new Error('Unsupported configuration schemaVersion');
  const account = object(root.account, 'account');
  const hermes = object(root.hermes, 'hermes');
  const telegram = object(root.telegram, 'telegram');
  const config: PersonalConfig = {
    schemaVersion: 1,
    stateDirectory: absolute(root.stateDirectory, 'stateDirectory'),
    account: { id: string(account.id, 'account.id'), ownerId: string(account.ownerId, 'account.ownerId'), controlPeerId: string(account.controlPeerId, 'account.controlPeerId') },
    encryptionKeyEnv: envName(root.encryptionKeyEnv, 'encryptionKeyEnv'),
    hermes: { baseUrl: localUrl(hermes.baseUrl, 'hermes.baseUrl'), apiKeyEnv: envName(hermes.apiKeyEnv, 'hermes.apiKeyEnv') },
    telegram: {
      command: string(telegram.command, 'telegram.command'), args: strings(telegram.args, 'telegram.args'),
      databaseDirectory: absolute(telegram.databaseDirectory, 'telegram.databaseDirectory'), filesDirectory: absolute(telegram.filesDirectory, 'telegram.filesDirectory'),
      apiIdEnv: envName(telegram.apiIdEnv, 'telegram.apiIdEnv'), apiHashEnv: envName(telegram.apiHashEnv, 'telegram.apiHashEnv'),
    },
  };
  if (hermes.requestTimeoutMs !== undefined) config.hermes.requestTimeoutMs = integer(hermes.requestTimeoutMs, 'hermes.requestTimeoutMs', 100, 3_600_000);
  if (hermes.bridgeUrl !== undefined) config.hermes.bridgeUrl = localUrl(hermes.bridgeUrl, 'hermes.bridgeUrl');
  if (hermes.registrationKeyEnv !== undefined) config.hermes.registrationKeyEnv = envName(hermes.registrationKeyEnv, 'hermes.registrationKeyEnv');
  if (hermes.cronUrl !== undefined) config.hermes.cronUrl = localUrl(hermes.cronUrl, 'hermes.cronUrl');
  if (root.artifacts !== undefined) { const artifacts = object(root.artifacts, 'artifacts'); config.artifacts = {}; if (artifacts.pythonExecutable !== undefined) config.artifacts.pythonExecutable = absolute(artifacts.pythonExecutable, 'artifacts.pythonExecutable'); }
  if (root.documents !== undefined) {
    const documents = object(root.documents, 'documents');
    if (typeof documents.enabled !== 'boolean') throw new Error('Invalid documents.enabled');
    config.documents = { enabled: documents.enabled };
  }
  if (root.ownerTelegram !== undefined) {
    const telegram = object(root.ownerTelegram, 'ownerTelegram');
    for (const key of ['readAllChats','manageFolders','joinPublicChats']) if(typeof telegram[key] !== 'boolean') throw new Error(`Invalid ownerTelegram.${key}`);
    config.ownerTelegram = { readAllChats: telegram.readAllChats as boolean, manageFolders: telegram.manageFolders as boolean, joinPublicChats: telegram.joinPublicChats as boolean };
  }
  if (root.github !== undefined) {
    const github = object(root.github, 'github'), owner = string(github.owner, 'github.owner');
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(owner)) throw new Error('Invalid GitHub owner');
    config.github = { owner, ...(github.tokenEnv === undefined ? {} : { tokenEnv: envName(github.tokenEnv, 'github.tokenEnv') }) };
  }
  if (root.desktopContext !== undefined) {
    const desktop = object(root.desktopContext, 'desktopContext'), scope = object(desktop.scope, 'desktopContext.scope');
    if (typeof desktop.enabled !== 'boolean' || (scope.allOwnerThreads !== undefined && scope.allOwnerThreads !== true)) throw new Error('Invalid desktopContext scope');
    if (desktop.includeArchived !== undefined && typeof desktop.includeArchived !== 'boolean') throw new Error('Invalid desktopContext.includeArchived');
    const ownerId = string(desktop.ownerId, 'desktopContext.ownerId');
    if (ownerId !== config.account.ownerId) throw new Error('Desktop context owner differs from profile owner');
    const threadIds = scope.threadIds === undefined ? undefined : strings(scope.threadIds, 'desktopContext.scope.threadIds');
    const projectRoots = scope.projectRoots === undefined ? undefined : strings(scope.projectRoots, 'desktopContext.scope.projectRoots').map(path => absolute(path, 'desktopContext project root'));
    if (scope.allOwnerThreads !== true && !threadIds?.length && !projectRoots?.length) throw new Error('Desktop context requires an explicit readable scope');
    config.desktopContext = { enabled: desktop.enabled, codexHome: absolute(desktop.codexHome, 'desktopContext.codexHome'), ownerId,
      ...(desktop.includeArchived === undefined ? {} : { includeArchived: desktop.includeArchived as boolean }),
      scope: { ...(scope.allOwnerThreads === true ? { allOwnerThreads: true as const } : {}), ...(threadIds ? { threadIds } : {}), ...(projectRoots ? { projectRoots } : {}) } };
  }
  if (root.images !== undefined) {
    const images = object(root.images, 'images');
    const baseUrl = localUrl(images.baseUrl, 'images.baseUrl');
    if (!baseUrl.startsWith('https://')) throw new Error('images.baseUrl must use HTTPS');
    config.images = { baseUrl, apiKeyEnv: envName(images.apiKeyEnv, 'images.apiKeyEnv'), model: string(images.model, 'images.model') };
  }
  if (root.sourceScopes !== undefined) config.sourceScopes = [...new Set(strings(root.sourceScopes, 'sourceScopes'))];
  if (root.computer !== undefined) {
    const computer = object(root.computer, 'computer');
    if (typeof computer.enabled !== 'boolean' || !Array.isArray(computer.projects)) throw new Error('Invalid computer configuration');
    config.computer = { enabled: computer.enabled, command: string(computer.command, 'computer.command'), args: strings(computer.args, 'computer.args'), projects: computer.projects };
  }
  if (root.web !== undefined) {
    const web = object(root.web, 'web'); config.web = {};
    if (web.searchEndpoint !== undefined) {
      const url = new URL(string(web.searchEndpoint, 'web.searchEndpoint'));
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('web.searchEndpoint must use HTTPS without credentials');
      config.web.searchEndpoint = url.href;
    }
    if (web.apiKeyEnv !== undefined) config.web.apiKeyEnv = envName(web.apiKeyEnv, 'web.apiKeyEnv');
  }
  if (root.tools !== undefined) {
    const toolConfig = object(root.tools, 'tools'); config.tools = {};
    if (toolConfig.port !== undefined) config.tools.port = integer(toolConfig.port, 'tools.port', 0, 65535);
  }
  if (root.grants !== undefined) {
    if (!Array.isArray(root.grants)) throw new Error('Invalid grants');
    config.grants = root.grants.map((value) => {
      const grant = object(value, 'grant');
      return { capability: string(grant.capability, 'grant.capability'), resources: strings(grant.resources, 'grant.resources') };
    });
  }
  return config;
}
export function loadConfig(path: string): PersonalConfig { return parseConfig(JSON.parse(readFileSync(path, 'utf8'))); }
export function requiredSecret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value) throw new Error(`Required environment variable is absent: ${name}`);
  return value;
}
export function encryptionKey(config: PersonalConfig, env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const encoded = requiredSecret(config.encryptionKeyEnv, env);
  const bytes = /^[0-9a-fA-F]{64}$/.test(encoded) ? Buffer.from(encoded, 'hex') : Buffer.from(encoded, 'base64');
  if (bytes.length !== 32 || (!/^[0-9a-fA-F]{64}$/.test(encoded) && bytes.toString('base64') !== encoded)) throw new Error(`${config.encryptionKeyEnv} must encode exactly 32 bytes (hex or base64)`);
  return bytes;
}
