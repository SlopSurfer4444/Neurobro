import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { assertPublicAddress, type NodeWebRequest, type PublicAddress } from '../capabilities/web.ts';

export interface GitHubResponse { status: number; headers: Record<string, string>; bytes: Uint8Array }
export type GitHubTransport = (url: URL, address: PublicAddress, options: {
  signal: AbortSignal; maxBytes: number; token?: string;
}) => Promise<GitHubResponse>;

/** GET only, fixed TLS host, pinned public DNS, no redirects/cookies/proxy or shell. */
export function createGitHubTransport(requester?: NodeWebRequest): GitHubTransport {
  return (url, address, options) => new Promise((resolve, reject) => {
    if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash ||
      !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 8 * 1024 * 1024 ||
      assertPublicAddress(address.address).family !== address.family) throw new Error('Invalid GitHub transport request');
    if (options.token !== undefined && (!options.token || options.token.length > 1024 || /[^\x21-\x7e]/u.test(options.token))) throw new Error('Invalid GitHub credential');
    const request: NodeWebRequest = requester ?? ((target, config, callback) => httpsRequest(target, config, callback));
    const req: ClientRequest = request(url, {
      method: 'GET', agent: false, signal: options.signal, family: address.family, autoSelectFamily: false,
      servername: 'api.github.com', maxHeaderSize: 16 * 1024,
      lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      headers: { 'user-agent': 'Neurobro-Personal/1.0', accept: 'application/vnd.github+json',
        'accept-encoding': 'identity', 'x-github-api-version': '2022-11-28',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    }, (response: IncomingMessage) => {
      const headers: Record<string, string> = {};
      // Only bounded status metadata is admitted; Location/Set-Cookie are never used.
      for (const key of ['content-length', 'content-encoding', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after', 'link']) {
        const value = response.headers[key]; if (typeof value === 'string' && value.length <= 4096) headers[key] = value;
      }
      if (response.statusCode !== 200) { response.destroy(); resolve({ status: response.statusCode ?? 0, headers, bytes: new Uint8Array() }); return; }
      if ((headers['content-length'] && (!/^\d+$/u.test(headers['content-length']) || Number(headers['content-length']) > options.maxBytes)) ||
        (headers['content-encoding'] && headers['content-encoding'] !== 'identity')) {
        const error = new Error('GitHub response exceeds bounds'); response.destroy(); reject(error); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) response.destroy(new Error('GitHub response exceeds bounds'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('GitHub response interrupted')));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}
export const githubTransport = createGitHubTransport();
