import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ToolRequest } from '../contracts.ts';
import type { ToolRegistry } from './registry.ts';

export interface ToolServer { address: string; close(): Promise<void> }
export async function createToolServer(registry: ToolRegistry, options: { host?: '127.0.0.1'; port?: number; maxBytes?: number; routeHandler?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean> } = {}): Promise<ToolServer> {
  if (options.host && options.host !== '127.0.0.1') throw new Error('tool server requires IPv4 loopback');
  // Covers the existing 256 KiB artifact content limit, including JSON escaping
  // and UTF-8 overhead. Individual tool schemas and content budgets remain enforced.
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 4 * 1024 * 1024) throw new Error('invalid tool request bound');
  const send = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    // Origin requests and browser preflights cannot use this local credential endpoint.
    if (request.headers.origin !== undefined || request.headers['access-control-request-method'] !== undefined) return send(response, 403, { ok: false, error: 'request denied' });
    const credential = request.headers.authorization;
    if (!credential || !/^Bearer [A-Za-z0-9._~-]{16,2048}$/u.test(credential)) return send(response, 401, { ok: false, error: 'credential required' });
    const token = credential.slice(7);
    const bound = server.address();
    if (!bound || typeof bound === 'string' || request.headers.host !== `127.0.0.1:${bound.port}`) return send(response, 403, { ok: false, error: 'request denied' });
    if (options.routeHandler) {
      try { if (await options.routeHandler(request, response)) return; }
      catch { return send(response, 500, { ok: false, error: 'route failed' }); }
    }
    if (request.method === 'GET' && request.url === '/tools/list') {
      try { return send(response, 200, { ok: true, value: registry.listForToken(token) }); }
      catch { return send(response, 403, { ok: false, error: 'request denied' }); }
    }
    if (request.method !== 'POST' || request.url !== '/tools/call') return send(response, 404, { ok: false, error: 'unknown endpoint' });
    if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return send(response, 415, { ok: false, error: 'JSON required' });
    const declared = request.headers['content-length'];
    if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) return send(response, 413, { ok: false, error: 'request too large' });
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const raw of request) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
        size += chunk.length;
        if (size > maxBytes) { send(response, 413, { ok: false, error: 'request too large' }); request.resume(); return; }
        chunks.push(chunk);
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ToolRequest;
      const result = await registry.invoke(token, parsed);
      // Only registry-owned, fixed public classifications cross this boundary.
      // Arbitrary exception text can contain data paths, grant values or credentials.
      send(response, 200, result.ok ? result : { ok: false, error: result.failure?.message ?? 'tool request rejected', ...(result.failure ? { failure: result.failure } : {}) });
    } catch {
      send(response, 400, { ok: false, error: 'invalid tool request' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('tool server missing address');
  return { address: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
