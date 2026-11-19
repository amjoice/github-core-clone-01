// app.ts — the HTTP server: healthz, REST v3, GraphQL, MCP, and git smart HTTP.
// No dependencies, no git binary at runtime. Token-gated everywhere except /healthz.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { store, VIEWER_LOGIN } from './store.ts';
import { handleRest, jsonResponse, errorResponse, unauthorized, notFound, type RestContext, type Query } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleLsRefs, handleFetch, handleReceivePack } from './git.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const OWNER = VIEWER_LOGIN;

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter}`;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/.exec(header);
  return m ? m[1] : null;
}

function tokenValid(token: string | null): boolean {
  if (token === null || token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true; // no shop token configured (local dev): any non-empty bearer token
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': requestId(),
    'X-Oauth-Scopes': 'repo, read:org',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'X-GitHub-Request-Id': requestId(),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseQuery(url: URL): Query {
  const q: Query = {};
  for (const [k, v] of url.searchParams) q[k] = v;
  return q;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);
  const method = (req.method ?? 'GET').toUpperCase();

  // Health check: no auth.
  if (pathname === '/healthz') {
    if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' });
    return sendJson(res, 200, { ok: true });
  }

  // Everything else needs a valid bearer token.
  const token = bearerToken(req);
  if (!tokenValid(token)) {
    return sendJson(res, 401, { message: 'Bad credentials' });
  }

  // GraphQL.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
    }
    const result = executeGraphQL(OWNER, body);
    return sendJson(res, 200, result);
  }

  // MCP.
  if (pathname === '/mcp') {
    if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
    const raw = await readBody(req);
    const result = handleMcp(OWNER, raw);
    if (result.body === null) {
      res.writeHead(result.status, { 'X-GitHub-Request-Id': requestId() });
      return res.end();
    }
    return sendJson(res, result.status, result.body);
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const restPath = pathname === '/api/v3' ? '' : pathname.slice('/api/v3/'.length);
    const segments = restPath === '' ? [] : restPath.split('/').map((s) => decodeURIComponent(s));
    const query = parseQuery(url);
    let body: unknown = undefined;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          return sendJson(res, 400, { message: 'Problems parsing JSON' });
        }
      }
    }
    const ctx: RestContext = { method, segments, query, body, token, baseUrl: `http://${req.headers.host ?? '127.0.0.1'}`, owner: OWNER };
    const result = handleRest(ctx);
    if (result.status === 204) {
      res.writeHead(204, result.headers);
      return res.end();
    }
    return sendJson(res, result.status, result.body, result.headers);
  }

  // Git smart HTTP: /{owner}/{repo}.git/{service}
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch) {
    const owner = gitMatch[1];
    const repoName = gitMatch[2];
    const service = gitMatch[3];
    if (owner !== OWNER) return sendJson(res, 404, { message: 'Not Found' });
    const repo = store.getRepo(owner, repoName);
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    const gitProtocol = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
    if (service === 'info/refs') {
      if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' });
      const serviceParam = url.searchParams.get('service');
      if (serviceParam !== 'git-upload-pack' && serviceParam !== 'git-receive-pack') {
        return sendJson(res, 400, { message: 'Missing service parameter' });
      }
      const out = handleInfoRefs(repo, serviceParam, gitProtocol);
      return sendRaw(res, 200, out.contentType, out.body);
    }
    if (service === 'git-upload-pack') {
      if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
      const raw = await readBody(req);
      // Distinguish ls-refs from fetch by the first command line.
      const firstLine = raw.subarray(0, Math.min(raw.length, 200)).toString('utf8');
      if (firstLine.includes('command=ls-refs')) {
        if (gitProtocol !== 2) {
          return sendJson(res, 400, { message: 'ls-refs requires protocol v2' });
        }
        return sendRaw(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, raw));
      }
      const out = handleFetch(repo, raw, gitProtocol);
      return sendRaw(res, 200, out.contentType, out.body);
    }
    if (service === 'git-receive-pack') {
      if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
      const raw = await readBody(req);
      const out = handleReceivePack(repo, raw);
      return sendRaw(res, 200, out.contentType, out.body);
    }
  }

  return sendJson(res, 404, { message: 'Not Found' });
}

export function createApp(): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      // Never leak a stack; never answer HTML.
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } else {
        res.end();
      }
      // eslint-disable-next-line no-console
      console.error('request error', err);
    });
  });
  return server;
}

// Re-export the helpers the route handlers use, so the module surface is explicit.
export const _rest = { handleRest, jsonResponse, errorResponse, unauthorized, notFound };
