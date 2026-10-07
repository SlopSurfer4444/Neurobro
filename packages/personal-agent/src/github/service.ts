import { TextDecoder } from 'node:util';
import { createHash } from 'node:crypto';
import { assertPublicAddress, systemWebResolver, type WebResolver } from '../capabilities/web.ts';
import type { ToolContext, Json } from '../contracts.ts';
import { githubTransport, type GitHubTransport } from './transport.ts';

export interface GitHubLimits { timeoutMs: number; maxResponseBytes: number; maxFileBytes: number; pageSize: number }
export interface GitHubOptions {
  owner: string; token?: string; transport?: GitHubTransport; resolver?: WebResolver;
  limits?: Partial<GitHubLimits>; now?: () => Date;
  authority?: (context: ToolContext, capability: 'github.read', resource: string) => Promise<void>;
}
export interface GitHubSource {
  url: string; fetchedAt: string | null; checkedAt: string; trust: 'untrusted_source'; authentication: 'public' | 'host_token';
  owner: string; repository?: string; commitSha?: string; blobSha?: string;
}
export type GitHubStatus = 'ok' | 'auth_missing' | 'auth_invalid' | 'owner_mismatch' | 'rate_limited' |
  'not_found_or_inaccessible' | 'access_denied' | 'unavailable' | 'invalid_response' | 'too_large' | 'unsupported_content';
export interface GitHubResult {
  status: GitHubStatus; source: GitHubSource; data?: Json; reason?: string; retryAfterSeconds?: number; rateLimitResetAt?: string;
}
class Failure extends Error {
  readonly status: GitHubStatus;
  readonly metadata: { retryAfterSeconds?: number; rateLimitResetAt?: string };
  constructor(status: GitHubStatus, message: string, metadata: { retryAfterSeconds?: number; rateLimitResetAt?: string } = {}) {
    super(message); this.status = status; this.metadata = metadata;
  }
}
const defaults: GitHubLimits = { timeoutMs: 20_000, maxResponseBytes: 4 * 1024 * 1024, maxFileBytes: 128 * 1024, pageSize: 50 };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Failure('invalid_response', 'GitHub returned an invalid object');
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Failure('invalid_response', 'GitHub returned an invalid field');
  return value;
}
function sha(value: unknown): string {
  const text = requiredString(value, 40); if (!/^[a-f0-9]{40}$/u.test(text)) throw new Failure('invalid_response', 'GitHub returned an invalid SHA'); return text;
}
export function githubOwner(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/u.test(value) || value.includes('--')) throw new Error('Invalid configured GitHub owner');
  return value;
}
export function githubRepository(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/u.test(value) || ['.', '..'].includes(value)) throw new Error('Invalid GitHub repository'); return value;
}
function filePath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\u0000-\u001f\u007f]/u.test(value) ||
    value.split('/').some(part => !part || ['.', '..'].includes(part))) throw new Error('Invalid GitHub repository path');
  return value;
}
function reference(value?: string): string | undefined {
  if (value !== undefined && (typeof value !== 'string' || !value || ['.', '..'].includes(value) || value.length > 256 || /[\u0000-\u0020\u007f]/u.test(value))) throw new Error('Invalid GitHub reference'); return value;
}
function page(value = 1): number { if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error('Invalid GitHub page'); return value; }
function encodePath(value: string): string { return value.split('/').map(encodeURIComponent).join('/'); }
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

/** Owner-bound read service. API data and README instructions never acquire authority. */
export class GitHubService {
  readonly owner: string; readonly resource: string; readonly limits: Readonly<GitHubLimits>;
  #options: Omit<GitHubOptions, 'token'>; #token?: string;
  constructor(options: GitHubOptions) {
    this.owner = githubOwner(options.owner); this.resource = `github:${this.owner.toLowerCase()}`;
    if (options.token !== undefined && (!options.token || options.token.length > 1024 || /[^\x21-\x7e]/u.test(options.token))) throw new Error('Invalid GitHub credential');
    const { token, ...rest } = options; this.#token = token; this.#options = rest;
    const limits = { ...defaults, ...options.limits };
    for (const [key, max] of Object.entries({ timeoutMs: 60_000, maxResponseBytes: 8 * 1024 * 1024, maxFileBytes: 512 * 1024, pageSize: 100 })) {
      if (!Number.isSafeInteger(limits[key as keyof GitHubLimits]) || limits[key as keyof GitHubLimits] < 1 || limits[key as keyof GitHubLimits] > max) throw new Error('Invalid GitHub limits');
    }
    this.limits = Object.freeze(limits);
  }
  private clean(value: string): string { return this.#token ? value.split(this.#token).join('[redacted]') : value; }
  private source(url: string, repository?: string, commitSha?: string, blobSha?: string): GitHubSource {
    const checkedAt = (this.#options.now?.() ?? new Date()).toISOString();
    return { url, fetchedAt: checkedAt, checkedAt, trust: 'untrusted_source',
      authentication: this.#token ? 'host_token' : 'public', owner: this.owner,
      ...(repository ? { repository } : {}), ...(commitSha ? { commitSha } : {}), ...(blobSha ? { blobSha } : {}) };
  }
  private repoUrl(repo: string): string { return `https://github.com/${encodeURIComponent(this.owner)}/${encodeURIComponent(repo)}`; }
  private prefix(repo: string): string { return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(repo)}`; }
  private async authorize(context: ToolContext): Promise<void> {
    if (!context || [context.taskId, context.grantId, context.runId].some(value => typeof value !== 'string' || !value || value.length > 256) ||
      !Number.isSafeInteger(context.intentRevision) || context.intentRevision < 0 || !Number.isSafeInteger(context.grantRevision) || context.grantRevision < 0) throw new Error('Invalid trusted GitHub context');
    if (!this.#options.authority) throw new Error('GitHub authority unavailable');
    await this.#options.authority(context, 'github.read', this.resource);
  }
  private async run(context: ToolContext, url: string, repo: string | undefined, work: (signal: AbortSignal) => Promise<GitHubResult>): Promise<GitHubResult> {
    await this.authorize(context);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Failure('unavailable', 'GitHub read timed out')); }, this.limits.timeoutMs);
      });
      const result = await Promise.race([work(controller.signal), timeoutPromise]);
      await this.authorize(context);
      // Defense in depth: a provider can echo the host credential in any projected field.
      return JSON.parse(this.clean(JSON.stringify(result))) as GitHubResult;
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      await this.authorize(context);
      return JSON.parse(this.clean(JSON.stringify({ status: error.status, source: { ...this.source(url, repo), fetchedAt: null }, reason: error.message, ...error.metadata }))) as GitHubResult;
    } finally { clearTimeout(timeout); controller.abort(); }
  }
  private async get(context: ToolContext, path: string, signal: AbortSignal): Promise<{ body: unknown; hasNext: boolean }> {
    await this.authorize(context); signal.throwIfAborted();
    const url = new URL(path, 'https://api.github.com');
    if (url.origin !== 'https://api.github.com' || !path.startsWith('/')) throw new Error('Invalid internal GitHub endpoint');
    let response;
    try {
      const addresses = await (this.#options.resolver ?? systemWebResolver)('api.github.com');
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32) throw new Error('Invalid GitHub DNS');
      for (const address of addresses) if (assertPublicAddress(address.address).family !== address.family) throw new Error('Invalid DNS family');
      signal.throwIfAborted(); await this.authorize(context);
      response = await (this.#options.transport ?? githubTransport)(url, addresses[0]!, { signal, maxBytes: this.limits.maxResponseBytes, ...(this.#token ? { token: this.#token } : {}) });
    } catch (error) {
      if (signal.aborted) throw new Failure('unavailable', 'GitHub read timed out');
      // Neither credential-bearing provider exceptions nor response bodies enter tool errors.
      if (error instanceof Error && error.message === 'GitHub response exceeds bounds') throw new Failure('too_large', 'GitHub API response exceeds configured byte limit');
      throw new Failure('unavailable', 'GitHub network read failed');
    }
    await this.authorize(context); signal.throwIfAborted();
    if (!response || !(response.bytes instanceof Uint8Array) || !Number.isInteger(response.status) || !response.headers) throw new Failure('invalid_response', 'GitHub returned an invalid response');
    if (response.bytes.byteLength > this.limits.maxResponseBytes) throw new Failure('too_large', 'GitHub API response exceeds configured byte limit');
    const headers = response.headers;
    if (response.status === 429 || (response.status === 403 && (headers['x-ratelimit-remaining'] === '0' || headers['retry-after'] !== undefined))) {
      const metadata: { retryAfterSeconds?: number; rateLimitResetAt?: string } = {};
      const retry = headers['retry-after']; const reset = headers['x-ratelimit-reset'];
      if (retry && /^\d{1,8}$/u.test(retry)) metadata.retryAfterSeconds = Number(retry);
      if (reset && /^\d{1,12}$/u.test(reset)) metadata.rateLimitResetAt = new Date(Number(reset) * 1000).toISOString();
      throw new Failure('rate_limited', 'GitHub rate limit reached; no automatic retry', metadata);
    }
    if (response.status === 401) throw new Failure(this.#token ? 'auth_invalid' : 'auth_missing', 'GitHub authentication is unavailable or rejected');
    if (response.status === 403) throw new Failure('access_denied', 'GitHub denied this read');
    if (response.status === 404) throw new Failure('not_found_or_inaccessible', 'GitHub resource is absent or inaccessible; existence is not proven');
    if (response.status !== 200) throw new Failure('unavailable', 'GitHub did not return a readable resource; redirects are not followed');
    try { return { body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)), hasNext: /rel="next"/u.test(headers.link ?? '') }; }
    catch { throw new Failure('invalid_response', 'GitHub returned invalid JSON'); }
  }
  private repoMetadata(value: unknown, expectedRepo?: string): Json {
    const record = object(value); const login = requiredString(object(record.owner).login, 39); const name = githubRepository(requiredString(record.name, 100));
    if (login.toLowerCase() !== this.owner.toLowerCase() || (expectedRepo && name.toLowerCase() !== expectedRepo.toLowerCase())) throw new Failure('invalid_response', 'GitHub repository identity does not match configured scope');
    return asJson({ name, fullName: `${this.owner}/${name}`, url: this.repoUrl(name),
      description: typeof record.description === 'string' ? this.clean(record.description.slice(0, 4096)) : null,
      private: record.private === true, archived: record.archived === true, fork: record.fork === true,
      defaultBranch: typeof record.default_branch === 'string' ? this.clean(record.default_branch.slice(0, 256)) : null,
      language: typeof record.language === 'string' ? this.clean(record.language.slice(0, 128)) : null,
      pushedAt: typeof record.pushed_at === 'string' ? this.clean(record.pushed_at.slice(0, 64)) : null,
      updatedAt: typeof record.updated_at === 'string' ? this.clean(record.updated_at.slice(0, 64)) : null });
  }
  async repos(context: ToolContext, input: { page?: number } = {}): Promise<GitHubResult> {
    const current = page(input.page); const endpoint = this.#token ? '/user/repos?affiliation=owner' : `/users/${encodeURIComponent(this.owner)}/repos?type=owner`;
    const path = `${endpoint}&sort=updated&per_page=${this.limits.pageSize}&page=${current}`;
    return this.run(context, `https://api.github.com${path}`, undefined, async signal => {
      if (this.#token) {
        const identity = object((await this.get(context, '/user', signal)).body);
        if (requiredString(identity.login, 39).toLowerCase() !== this.owner.toLowerCase()) throw new Failure('owner_mismatch', 'Host credential account does not match configured owner');
      }
      const result = await this.get(context, path, signal);
      if (!Array.isArray(result.body) || result.body.length > this.limits.pageSize) throw new Failure('invalid_response', 'GitHub returned an invalid repository page');
      const repositories = result.body.map(value => this.repoMetadata(value));
      return { status: 'ok', source: this.source(`https://api.github.com${path}`), data: asJson({ repositories, page: current,
        nextPage: result.hasNext && current < 1000 ? current + 1 : null, complete: !result.hasNext,
        visibility: this.#token ? 'token_accessible_owned_repositories' : 'public_only' }) };
    });
  }
  async repository(context: ToolContext, input: { repository: string }): Promise<GitHubResult> {
    const repo = githubRepository(input.repository); const path = this.prefix(repo);
    return this.run(context, `https://api.github.com${path}`, repo, async signal => {
      const data = this.repoMetadata((await this.get(context, path, signal)).body, repo);
      return { status: 'ok', source: this.source(this.repoUrl(repo), repo), data };
    });
  }
  private async commit(context: ToolContext, repo: string, ref: string | undefined, signal: AbortSignal): Promise<string> {
    if (!ref) {
      const metadata = object((await this.get(context, this.prefix(repo), signal)).body);
      this.repoMetadata(metadata, repo); ref = reference(requiredString(metadata.default_branch, 256));
    }
    return sha(object((await this.get(context, `${this.prefix(repo)}/commits/${encodeURIComponent(ref!)}`, signal)).body).sha);
  }
  async file(context: ToolContext, input: { repository: string; path?: string; ref?: string }, readme = false): Promise<GitHubResult> {
    const repo = githubRepository(input.repository); const path = readme ? undefined : filePath(input.path!); const ref = reference(input.ref);
    const endpoint = `${this.prefix(repo)}/${readme ? 'readme' : `contents/${encodePath(path!)}`}`;
    return this.run(context, `https://api.github.com${endpoint}`, repo, async signal => {
      const commitSha = await this.commit(context, repo, ref, signal);
      const record = object((await this.get(context, `${endpoint}?ref=${commitSha}`, signal)).body);
      const actualPath = filePath(requiredString(record.path, 1024));
      if ((!readme && actualPath !== path) || record.type !== 'file' || record.submodule_git_url !== undefined || record.encoding !== 'base64') throw new Failure('unsupported_content', 'Only in-repository text files are supported; directories, submodules and symlinks are not followed');
      if (typeof record.size !== 'number' || !Number.isSafeInteger(record.size) || record.size < 0) throw new Failure('invalid_response', 'GitHub returned an invalid file size');
      if (record.size > this.limits.maxFileBytes) throw new Failure('too_large', 'GitHub file exceeds configured whole-file byte limit');
      if (typeof record.content !== 'string') throw new Failure('invalid_response', 'GitHub did not provide file bytes');
      const encoded = record.content.replace(/\n/gu, '');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded || bytes.length !== record.size) throw new Failure('invalid_response', 'GitHub file encoding or size is inconsistent');
      if (bytes.length > this.limits.maxFileBytes) throw new Failure('too_large', 'GitHub file exceeds configured whole-file byte limit');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.includes('\u0000')) throw new Error(); }
      catch { throw new Failure('unsupported_content', 'GitHub file is not UTF-8 text'); }
      const blobSha = sha(record.sha);
      if (createHash('sha1').update(`blob ${bytes.length}\u0000`).update(bytes).digest('hex') !== blobSha) throw new Failure('invalid_response', 'GitHub blob SHA does not match file bytes');
      const sourceUrl = `${this.repoUrl(repo)}/blob/${commitSha}/${encodePath(actualPath)}`;
      return { status: 'ok', source: this.source(sourceUrl, repo, commitSha, blobSha),
        data: asJson({ path: this.clean(actualPath), text: this.clean(text), bytes: bytes.length, startLine: 1, endLine: text.split('\n').length, complete: true }) };
    });
  }
  async tree(context: ToolContext, input: { repository: string; ref?: string; page?: number }): Promise<GitHubResult> {
    const repo = githubRepository(input.repository); const ref = reference(input.ref); const current = page(input.page);
    return this.run(context, `${this.repoUrl(repo)}`, repo, async signal => {
      const commitSha = await this.commit(context, repo, ref, signal); const endpoint = `${this.prefix(repo)}/git/trees/${commitSha}?recursive=1`;
      const record = object((await this.get(context, endpoint, signal)).body);
      if (!Array.isArray(record.tree) || typeof record.truncated !== 'boolean') throw new Failure('invalid_response', 'GitHub returned an invalid tree');
      const resolvedTreeSha = sha(record.sha);
      const start = (current - 1) * this.limits.pageSize; const entries = record.tree.slice(start, start + this.limits.pageSize).map(value => {
        const entry = object(value); const path = filePath(requiredString(entry.path, 1024)); const blobSha = sha(entry.sha);
        if (!['blob', 'tree', 'commit'].includes(String(entry.type))) throw new Failure('invalid_response', 'GitHub returned an invalid tree entry');
        const mode = requiredString(entry.mode, 6);
        if (!/^(?:100644|100755|120000|160000|040000)$/u.test(mode)) throw new Failure('invalid_response', 'GitHub returned an invalid tree mode');
        return { path: this.clean(path), type: entry.type, sha: blobSha, mode,
          url: `${this.repoUrl(repo)}/${entry.type === 'tree' ? 'tree' : 'blob'}/${commitSha}/${encodePath(path)}` };
      });
      return { status: 'ok', source: this.source(`https://api.github.com${endpoint}`, repo, commitSha),
        data: asJson({ entries, page: current, nextPage: start + entries.length < record.tree.length && current < 1000 ? current + 1 : null,
          returnedTreeEntries: record.tree.length, treeSha: resolvedTreeSha, upstreamTruncated: record.truncated, complete: !record.truncated && start + entries.length >= record.tree.length,
          continuationRef: commitSha }) };
    });
  }
  async search(context: ToolContext, input: { repository: string; query: string; page?: number }): Promise<GitHubResult> {
    const repo = githubRepository(input.repository); const current = page(input.page);
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 256 || !/^[\p{L}\p{N} _.\/-]+$/u.test(input.query)) throw new Error('GitHub search accepts text terms only, without scope qualifiers');
    const params = new URLSearchParams({ q: `"${input.query.trim()}" repo:${this.owner}/${repo}`, per_page: String(this.limits.pageSize), page: String(current) });
    const endpoint = `/search/code?${params}`;
    return this.run(context, `https://api.github.com${endpoint}`, repo, async signal => {
      if (!this.#token) throw new Failure('auth_missing', 'GitHub code search requires a host credential; public repository, README, file and tree reads remain available');
      const record = object((await this.get(context, endpoint, signal)).body);
      if (!Array.isArray(record.items) || record.items.length > this.limits.pageSize || typeof record.incomplete_results !== 'boolean' || !Number.isSafeInteger(record.total_count)) throw new Failure('invalid_response', 'GitHub returned an invalid search page');
      const matches = record.items.map(value => {
        const item = object(value); this.repoMetadata(item.repository, repo); const path = filePath(requiredString(item.path, 1024)); const blobSha = sha(item.sha);
        return { path: this.clean(path), blobSha, sourceUrl: `https://api.github.com${this.prefix(repo)}/git/blobs/${blobSha}` };
      });
      const total = Number(record.total_count); const more = current * this.limits.pageSize < Math.min(total, 1000);
      return { status: 'ok', source: this.source(`https://api.github.com${endpoint}`, repo),
        data: asJson({ matches, totalCount: total, page: current, nextPage: more ? current + 1 : null,
          incomplete: record.incomplete_results || total > 1000, complete: !record.incomplete_results && total <= 1000 && !more,
          freshness: 'GitHub indexed default branch; read each matching file to obtain current commit-bound evidence' }) };
    });
  }
}
