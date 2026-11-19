// mcp.ts — MCP over streamable HTTP (JSON-RPC 2.0) for the forge.
// Methods: server/discover, initialize, notifications/initialized, tools/list,
// tools/call. The six required tools act on the same store as REST/GraphQL.

import { store, VIEWER_LOGIN, VIEWER_ID } from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';
import { repoJson, issueJson, pullJson, filesAtCommit, pullFiles, computeMergeable } from './rest.ts';

export const MCP_SERVER_NAME = 'makefun-git-forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (must be the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(data: unknown, text?: string): Record<string, unknown> {
  const payload = text ?? JSON.stringify(data, null, 2);
  return {
    content: [{ type: 'text', text: payload }],
    structuredContent: data,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function getRepo(args: Record<string, unknown>, owner: string): Repo | string {
  const repoName = typeof args.repo === 'string' ? args.repo : typeof args.repository === 'string' ? args.repository : '';
  const ownerArg = typeof args.owner === 'string' ? args.owner : owner;
  if (ownerArg !== owner) return `Repository ${ownerArg}/${repoName} not found`;
  const repo = store.getRepo(ownerArg, repoName);
  if (!repo) return `Repository ${ownerArg}/${repoName} not found`;
  return repo;
}

function callTool(owner: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return rpcError(null, -32602, `Unknown tool: ${name}`);
  }
  // Required-argument check.
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return toolError(`Missing required argument(s): ${missing.join(', ')}`);
  }

  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (!/^[A-Za-z0-9._-]+$/.test(repoName)) return toolError(`Invalid repository name: ${repoName}`);
    if (store.getRepo(owner, repoName)) return toolError(`Repository ${owner}/${repoName} already exists`);
    const repo = store.createRepo(owner, repoName, {
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
    });
    return toolResult(repoJson(repo));
  }

  if (name === 'get_repo') {
    const repoOrErr = getRepo(args, owner);
    if (typeof repoOrErr === 'string') return toolError(repoOrErr);
    return toolResult(repoJson(repoOrErr));
  }

  if (name === 'create_issue') {
    const repoOrErr = getRepo(args, owner);
    if (typeof repoOrErr === 'string') return toolError(repoOrErr);
    const repo = repoOrErr;
    const title = String(args.title);
    const body = typeof args.body === 'string' ? args.body : '';
    const ts = store.nowIso();
    const issue: Issue = {
      id: store.nextEntityId++,
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels: [],
      user: { login: owner, id: VIEWER_ID },
      created_at: ts,
      updated_at: ts,
      closed_at: null,
      comments: [],
      seq: repo.nextIssueNumber,
    };
    repo.issues.push(issue);
    return toolResult(issueJson(issue));
  }

  if (name === 'list_issues') {
    const repoOrErr = getRepo(args, owner);
    if (typeof repoOrErr === 'string') return toolError(repoOrErr);
    const repo = repoOrErr;
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues];
    if (state !== 'all') issues = issues.filter((i) => i.state === state);
    issues.sort((a, b) => b.number - a.number);
    return toolResult(issues.map(issueJson));
  }

  if (name === 'create_pull_request') {
    const repoOrErr = getRepo(args, owner);
    if (typeof repoOrErr === 'string') return toolError(repoOrErr);
    const repo = repoOrErr;
    const head = String(args.head);
    const base = String(args.base);
    const title = String(args.title);
    const body = typeof args.body === 'string' ? args.body : '';
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (!headTip) return toolError(`Head branch ${head} does not exist`);
    if (!baseTip) return toolError(`Base branch ${base} does not exist`);
    const ts = store.nowIso();
    const pull: Pull = {
      id: store.nextEntityId++,
      number: repo.nextPullNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      user: { login: owner, id: VIEWER_ID },
      created_at: ts,
      updated_at: ts,
      seq: repo.nextPullNumber,
    };
    repo.pulls.push(pull);
    return toolResult(pullJson(repo, pull));
  }

  if (name === 'merge_pull_request') {
    const repoOrErr = getRepo(args, owner);
    if (typeof repoOrErr === 'string') return toolError(repoOrErr);
    const repo = repoOrErr;
    const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
    const pull = repo.pulls.find((p) => p.number === pullNumber);
    if (!pull) return toolError(`Pull request #${pullNumber} not found`);
    if (pull.merged) return toolError('Pull request already merged');
    if (pull.state !== 'open') return toolError('Pull request is closed');
    if (!computeMergeable(repo, pull)) return toolError('Merge conflict');
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const mergeBase = store.mergeBase(repo, headTip, baseTip) ?? baseTip;
    const baseFiles = filesAtCommit(repo, mergeBase);
    const headFiles = filesAtCommit(repo, headTip);
    const currentFiles = filesAtCommit(repo, baseTip);
    const merged = new Map(currentFiles);
    for (const path of new Set([...baseFiles.keys(), ...headFiles.keys()])) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      if ((h?.oid ?? null) !== (b?.oid ?? null)) {
        if (h) merged.set(path, h);
        else merged.delete(path);
      }
    }
    const treeOid = store.buildTreeFromFiles(repo, merged);
    const mergeSha = store.createCommit(repo, treeOid, [baseTip], `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.merged = true;
    pull.state = 'closed';
    pull.merged_at = store.nowIso();
    pull.merge_commit_sha = mergeSha;
    pull.updated_at = store.nowIso();
    return toolResult(pullJson(repo, pull));
  }

  return rpcError(null, -32602, `Unknown tool: ${name}`);
}

export interface McpResponse {
  status: number;
  body: unknown; // JSON value, or null for no body
}

/**
 * Handle one POST /mcp request. `rawBody` is the raw request bytes (for parse errors).
 * Returns the HTTP status and the JSON-RPC response object (null body for notifications).
 */
export function handleMcp(owner: string, rawBody: Buffer): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    // Batched JSON-RPC requests.
    const responses: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      const resp = handleOne(owner, entry as JsonRpcRequest);
      if (resp !== null) responses.push(resp);
    }
    return { status: 200, body: responses };
  }
  const resp = handleOne(owner, parsed as JsonRpcRequest);
  if (resp === null) return { status: 202, body: null };
  return { status: 200, body: resp };
}

function handleOne(owner: string, req: JsonRpcRequest): Record<string, unknown> | null {
  const id = req.id ?? null;
  const isNotification = req.id === undefined;
  const method = req.method ?? '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: MCP_REVISIONS,
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      capabilities: { tools: {} },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = MCP_REVISIONS.includes(requested) ? requested : '2026-07-28';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      return rpcError(id, -32602, `Unknown tool: ${toolName}`);
    }
    const result = callTool(owner, toolName, args);
    // callTool returns either a tool result or a JSON-RPC error object.
    if (result.error !== undefined) {
      const err = result.error as { code: number; message: string };
      return rpcError(id, err.code, err.message);
    }
    return rpcResult(id, result);
  }

  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

// Keep the rest imports referenced (pullFiles is used by GraphQL; re-export for clarity).
export const _pullFiles = pullFiles;
