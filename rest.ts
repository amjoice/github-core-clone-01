// rest.ts — GitHub REST v3 surface for the forge.
// All JSON replies carry application/json and X-GitHub-Request-Id; errors are
// {"message": "..."} with the GitHub status codes the checks assert.

import { store, VIEWER_LOGIN, VIEWER_ID, VIEWER_EMAIL, VIEWER_NAME, hashObject, parseCommit, parseTree, ZERO_OID } from './store.ts';
import type { Repo, Issue, Pull, Label, GitObjectType } from './store.ts';

// ---------------------------------------------------------------------------
// response plumbing
// ---------------------------------------------------------------------------

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown; // JSON value, or null for 204
}

let requestCounter = 0;

export function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  requestCounter += 1;
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-GitHub-Request-Id': `req-${Date.now().toString(36)}-${requestCounter}`,
      'X-Oauth-Scopes': 'repo, read:org',
      ...extraHeaders,
    },
    body,
  };
}

export function errorResponse(status: number, message: string): RestResponse {
  return jsonResponse(status, { message });
}

export function notFound(message = 'Not Found'): RestResponse {
  return errorResponse(404, message);
}

export function unauthorized(message = 'Bad credentials'): RestResponse {
  return errorResponse(401, message);
}

// ---------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------

export function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: `LA_kwDO${label.id}`, name: label.name, color: label.color, description: label.description, default: true };
}

export function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, node_id: `U_kwDO${id}`, avatar_url: '', type: 'User', site_admin: false };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_kwDO${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1000),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.default_branch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_kwDO${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    locked: false,
    user: userJson(issue.user.login, issue.user.id),
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
    state_reason: null,
  };
}

export function commentJson(comment: { id: number; body: string; user: { login: string; id: number }; created_at: string; updated_at: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_kwDO${comment.id}`,
    body: comment.body,
    user: userJson(comment.user.login, comment.user.id),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    author_association: 'OWNER',
  };
}

export function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const parsed = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const rawMessage = parsed ? parsed.message : '';
  // The REST view strips the trailing newline git stores in the object.
  const message = rawMessage.replace(/\r?\n$/, '');
  const authorLine = parsed?.author ?? '';
  const committerLine = parsed?.committer ?? '';
  const parseIdent = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <([^>]*)> (\d+) ([+-]\d+)$/.exec(line);
    if (!m) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: repo.created_at };
    return { name: m[1], email: m[2], date: new Date(parseInt(m[3], 10) * 1000).toISOString() };
  };
  const author = parseIdent(authorLine);
  const committer = parseIdent(committerLine);
  return {
    sha: oid,
    node_id: `C_kwDO${oid.slice(0, 8)}`,
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message,
      tree: { sha: parsed?.tree ?? ZERO_OID },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: userJson(VIEWER_LOGIN, VIEWER_ID),
    committer: userJson(VIEWER_LOGIN, VIEWER_ID),
    parents: (parsed?.parents ?? []).map((p) => ({ sha: p })),
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: `PR_kwDO${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    locked: false,
    user: userJson(pull.user.login, pull.user.id),
    labels: [],
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}`, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: repoJson(repo) },
    merged: pull.merged,
    mergeable: computeMergeable(repo, pull),
    mergeable_state: pull.merged ? 'merged' : computeMergeable(repo, pull) ? 'clean' : 'dirty',
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    author_association: 'OWNER',
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export interface Query {
  [key: string]: string | undefined;
}

export function paginate<T>(items: T[], query: Query): { page: T[]; link: string | null; total: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.per_page ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
  const total = items.length;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  return { page: slice, link: null, total };
}

/** Build a GitHub-style Link header for pagination. */
export function linkHeader(baseUrl: string, path: string, query: Query, total: number): string | null {
  const perPage = Math.max(1, Math.min(100, parseInt(query.per_page ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (lastPage <= 1) return null;
  const urlFor = (p: number): string => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && k !== 'page') q.set(k, v);
    }
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `<${baseUrl}${path}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (page < lastPage) parts.push(`${urlFor(page + 1)}; rel="next"`);
  if (page > 1) parts.push(`${urlFor(page - 1)}; rel="prev"`);
  parts.push(`${urlFor(1)}; rel="first"`);
  parts.push(`${urlFor(lastPage)}; rel="last"`);
  return parts.join(', ');
}

/** Resolve a ref name (branch), a sha, or undefined (default branch) to a commit oid. */
export function resolveRef(repo: Repo, ref?: string): string | undefined {
  if (ref === undefined || ref === '') {
    return repo.refs.get(`refs/heads/${repo.default_branch}`);
  }
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(`refs/tags/${ref}`)) return store.peelToCommit(repo, repo.refs.get(`refs/tags/${ref}`)!);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const obj = repo.objects.get(ref);
  if (obj && obj.type === 'commit') return ref;
  if (obj && obj.type === 'tag') return store.peelToCommit(repo, ref);
  return undefined;
}

/** Flatten a commit's tree to path -> { oid, mode }. */
export function filesAtCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  const tree = parseCommit(obj.data).tree;
  return store.flattenTree(repo, tree);
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function countLineChanges(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // LCS length via DP (files are small).
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return { additions: n - lcs, deletions: m - lcs };
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff two file maps (path -> blob oid) into a changed-file list. */
export function diffFileMaps(repo: Repo, base: Map<string, { oid: string; mode: string }>, head: Map<string, { oid: string; mode: string }>): ChangedFile[] {
  const out: ChangedFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const { deletions } = countLineChanges(oldText, '');
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const { additions } = countLineChanges('', newText);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = countLineChanges(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Files a pull request changes: head tree vs the merge-base tree. */
export function pullFiles(repo: Repo, pull: Pull): ChangedFile[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const mergeBase = store.mergeBase(repo, headTip, baseTip) ?? baseTip;
  const baseFiles = filesAtCommit(repo, mergeBase);
  const headFiles = filesAtCommit(repo, headTip);
  return diffFileMaps(repo, baseFiles, headFiles);
}

/** Whether a pull request can be squash-merged without conflict (3-way per file). */
export function computeMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.merged) return false;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const mergeBase = store.mergeBase(repo, headTip, baseTip);
  if (mergeBase === undefined) return false;
  const baseFiles = filesAtCommit(repo, mergeBase);
  const headFiles = filesAtCommit(repo, headTip);
  const currentFiles = filesAtCommit(repo, baseTip);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const c = currentFiles.get(path);
    const headChanged = (h?.oid ?? null) !== (b?.oid ?? null);
    const baseChanged = (c?.oid ?? null) !== (b?.oid ?? null);
    if (headChanged && baseChanged && (h?.oid ?? null) !== (c?.oid ?? null)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// contents (PUT/GET/DELETE) — the git-backed file API
// ---------------------------------------------------------------------------

/** Apply a file set/delete to a branch, creating a commit. Returns the new commit oid. */
export function commitFileChange(
  repo: Repo,
  branch: string,
  message: string,
  changes: Array<{ path: string; content: Buffer | null }>,
): string {
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  const baseFiles = tip ? filesAtCommit(repo, tip) : new Map<string, { oid: string; mode: string }>();
  const files = new Map(baseFiles);
  for (const change of changes) {
    if (change.content === null) {
      files.delete(change.path);
    } else {
      const blobOid = store.writeObject(repo, 'blob', change.content);
      files.set(change.path, { oid: blobOid, mode: '100644' });
    }
  }
  const treeOid = store.buildTreeFromFiles(repo, files);
  const parents = tip ? [tip] : [];
  const commitOid = store.createCommit(repo, treeOid, parents, message);
  repo.refs.set(refName, commitOid);
  repo.updated_at = store.nowIso();
  return commitOid;
}

function contentEntryJson(repo: Repo, path: string, oid: string, name: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const data = obj?.data ?? Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: oid,
    url: '',
    html_url: '',
    git_url: '',
    download_url: '',
    _links: { self: '', git: '', html: '' },
  };
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

export interface RestContext {
  method: string;
  segments: string[]; // path segments after /api/v3 (decoded)
  query: Query;
  body: unknown;
  token: string | null;
  baseUrl: string;
  owner: string; // the token holder's login
}

function getRepoOr404(ctx: RestContext, owner: string, name: string): Repo | RestResponse {
  if (owner !== ctx.owner) return notFound('Not Found');
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  return repo;
}

function isResponse(value: Repo | RestResponse): value is RestResponse {
  return (value as RestResponse).status !== undefined;
}

export function handleRest(ctx: RestContext): RestResponse {
  const { method, segments } = ctx;

  // API root.
  if (segments.length === 0) {
    if (method !== 'GET') return errorResponse(405, 'Method Not Allowed');
    return jsonResponse(200, {
      current_user_url: `${ctx.baseUrl}/api/v3/user`,
      current_user_authorizations_html_url: '',
      authorizations_url: '',
      code_search_url: '',
      commit_search_url: '',
      emails_url: '',
      emojis_url: '',
      events_url: '',
      feeds_url: '',
      followers_url: '',
      following_url: '',
      gists_url: '',
      hub_url: '',
      issue_search_url: '',
      issues_url: '',
      keys_url: '',
      labels_url: '',
      notifications_url: '',
      organizations_url: '',
      public_gists_url: '',
      rate_limit_url: `${ctx.baseUrl}/api/v3/rate_limit`,
      repository_url: `${ctx.baseUrl}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: '',
      current_user_repositories_url: `${ctx.baseUrl}/api/v3/user/repos`,
      starred_url: '',
      starred_gists_url: '',
      user_url: `${ctx.baseUrl}/api/v3/users/{user}`,
      user_organizations_url: '',
      user_repositories_url: `${ctx.baseUrl}/api/v3/users/{user}/repos`,
      user_search_url: '',
    });
  }

  // /meta
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return errorResponse(405, 'Method Not Allowed');
    return jsonResponse(200, { installed_version: '1.0.0', verifiable_rate_limit: true, github_enterprise_impersonation: false });
  }

  // /user/repos
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') return createRepo(ctx);
    if (method === 'GET') {
      const repos = store.listReposFor(ctx.owner);
      const { page, total } = paginate(repos, ctx.query);
      const link = linkHeader(ctx.baseUrl, '/api/v3/user/repos', ctx.query, total);
      return jsonResponse(200, page.map(repoJson), link ? { Link: link } : {});
    }
    return errorResponse(405, 'Method Not Allowed');
  }

  // /user (viewer)
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return errorResponse(405, 'Method Not Allowed');
    return jsonResponse(200, {
      ...userJson(ctx.owner, VIEWER_ID),
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      bio: '',
      public_repos: store.listReposFor(ctx.owner).length,
      followers: 0,
      following: 0,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: store.nowIso(),
    });
  }

  // /repos/{owner}/{name}/...
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(segments[1]);
    const name = decodeURIComponent(segments[2]);
    const rest = segments.slice(3);
    return handleRepoRoute(ctx, owner, name, rest);
  }

  return notFound('Not Found');
}

function createRepo(ctx: RestContext): RestResponse {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return errorResponse(422, 'Validation Failed: name is required');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return errorResponse(422, 'Validation Failed: invalid repository name');
  if (store.getRepo(ctx.owner, name)) {
    return errorResponse(422, `Repository ${ctx.owner}/${name} already exists`);
  }
  const repo = store.createRepo(ctx.owner, name, {
    description: typeof body.description === 'string' ? body.description : '',
    private: body.private === true,
  });
  return jsonResponse(201, repoJson(repo));
}

function handleRepoRoute(ctx: RestContext, owner: string, name: string, rest: string[]): RestResponse {
  const { method } = ctx;
  const repoOrErr = getRepoOr404(ctx, owner, name);
  if (isResponse(repoOrErr)) return repoOrErr;
  const repo = repoOrErr;

  // /repos/{o}/{r} itself
  if (rest.length === 0) {
    if (method === 'GET') return jsonResponse(200, repoJson(repo));
    if (method === 'PATCH') {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
        repo.default_branch = body.default_branch;
      }
      repo.updated_at = store.nowIso();
      return jsonResponse(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return { status: 204, headers: { 'X-GitHub-Request-Id': `req-${Date.now().toString(36)}-${++requestCounter}` }, body: null };
    }
    return errorResponse(405, 'Method Not Allowed');
  }

  const sub = rest[0];

  if (sub === 'branches') {
    if (method !== 'GET') return errorResponse(405, 'Method Not Allowed');
    const branches = [...repo.refs.keys()]
      .filter((r) => r.startsWith('refs/heads/'))
      .sort()
      .map((r) => ({
        name: r.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(r), url: '' },
        protected: false,
      }));
    return jsonResponse(200, branches);
  }

  if (sub === 'commits') {
    if (rest.length === 2 && method === 'GET') {
      // GET /commits/{sha}
      const sha = decodeURIComponent(rest[1]);
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') return notFound('Not Found');
      return jsonResponse(200, commitJson(repo, sha));
    }
    if (rest.length === 1 && method === 'GET') {
      const tip = resolveRef(repo, ctx.query.sha);
      if (!tip) return jsonResponse(200, []);
      const commits = store.commitWalk(repo, tip).map((oid) => commitJson(repo, oid));
      const { page, total } = paginate(commits, ctx.query);
      const link = linkHeader(ctx.baseUrl, `/api/v3/repos/${owner}/${name}/commits`, ctx.query, total);
      return jsonResponse(200, page, link ? { Link: link } : {});
    }
    return errorResponse(405, 'Method Not Allowed');
  }

  if (sub === 'contents') {
    const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    if (method === 'GET') return getContents(ctx, repo, filePath);
    if (method === 'PUT') return putContents(ctx, repo, filePath);
    if (method === 'DELETE') return deleteContents(ctx, repo, filePath);
    return errorResponse(405, 'Method Not Allowed');
  }

  if (sub === 'git') {
    if (rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) return createGitRef(ctx, repo);
      if (method === 'GET') return getGitRef(ctx, repo, rest.slice(2).map((s) => decodeURIComponent(s)).join('/'));
      return errorResponse(405, 'Method Not Allowed');
    }
    if (rest[1] === 'ref') {
      if (method === 'GET') return getGitRef(ctx, repo, rest.slice(2).map((s) => decodeURIComponent(s)).join('/'));
      return errorResponse(405, 'Method Not Allowed');
    }
    return notFound('Not Found');
  }

  if (sub === 'labels') {
    if (method === 'GET') return jsonResponse(200, repo.labels.map(labelJson));
    if (method === 'POST') {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (!labelName) return errorResponse(422, 'Validation Failed: name is required');
      let label = repo.labels.find((l) => l.name === labelName);
      if (!label) {
        label = {
          id: store.nextEntityId++,
          name: labelName,
          color: typeof body.color === 'string' ? body.color : 'ededed',
          description: typeof body.description === 'string' ? body.description : '',
        };
        repo.labels.push(label);
      }
      return jsonResponse(201, labelJson(label));
    }
    return errorResponse(405, 'Method Not Allowed');
  }

  if (sub === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') return listIssues(ctx, repo);
      if (method === 'POST') return createIssue(ctx, repo);
      return errorResponse(405, 'Method Not Allowed');
    }
    const num = parseInt(rest[1], 10);
    if (Number.isNaN(num)) return notFound('Not Found');
    const issue = repo.issues.find((i) => i.number === num);
    if (rest.length === 2) {
      if (!issue) return notFound('Not Found');
      if (method === 'GET') return jsonResponse(200, issueJson(issue));
      if (method === 'PATCH') {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') {
          issue.state = body.state;
          issue.closed_at = body.state === 'closed' ? store.nowIso() : null;
        }
        if (Array.isArray(body.labels)) {
          const names = body.labels.filter((l): l is string => typeof l === 'string');
          const unknown = names.filter((n) => !repo.labels.some((l) => l.name === n));
          if (unknown.length > 0) return errorResponse(422, `Validation Failed: label ${unknown[0]} does not exist`);
          issue.labels = names.map((n) => repo.labels.find((l) => l.name === n)!);
        }
        issue.updated_at = store.nowIso();
        return jsonResponse(200, issueJson(issue));
      }
      return errorResponse(405, 'Method Not Allowed');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!issue) return notFound('Not Found');
      if (method === 'GET') return jsonResponse(200, issue.comments.map(commentJson));
      if (method === 'POST') {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof body.body !== 'string' || body.body === '') return errorResponse(422, 'Validation Failed: body is required');
        const comment = {
          id: store.nextEntityId++,
          body: body.body,
          user: { login: ctx.owner, id: VIEWER_ID },
          created_at: store.nowIso(),
          updated_at: store.nowIso(),
        };
        issue.comments.push(comment);
        issue.updated_at = store.nowIso();
        return jsonResponse(201, commentJson(comment));
      }
      return errorResponse(405, 'Method Not Allowed');
    }
    return notFound('Not Found');
  }

  if (sub === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') return listPulls(ctx, repo);
      if (method === 'POST') return createPull(ctx, repo);
      return errorResponse(405, 'Method Not Allowed');
    }
    const num = parseInt(rest[1], 10);
    if (Number.isNaN(num)) return notFound('Not Found');
    const pull = repo.pulls.find((p) => p.number === num);
    if (rest.length === 2) {
      if (!pull) return notFound('Not Found');
      if (method === 'GET') return jsonResponse(200, pullJson(repo, pull));
      if (method === 'PATCH') {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
        pull.updated_at = store.nowIso();
        return jsonResponse(200, pullJson(repo, pull));
      }
      return errorResponse(405, 'Method Not Allowed');
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (!pull) return notFound('Not Found');
      if (method !== 'GET') return errorResponse(405, 'Method Not Allowed');
      const files = pullFiles(repo, pull).map((f) => ({
        sha: '',
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        blob_url: '',
        raw_url: '',
        contents_url: '',
        patch: '',
      }));
      return jsonResponse(200, files);
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (!pull) return notFound('Not Found');
      if (method !== 'PUT') return errorResponse(405, 'Method Not Allowed');
      return mergePull(ctx, repo, pull);
    }
    return notFound('Not Found');
  }

  return notFound('Not Found');
}

// ---------------------------------------------------------------------------
// contents handlers
// ---------------------------------------------------------------------------

function getContents(ctx: RestContext, repo: Repo, filePath: string): RestResponse {
  const tip = resolveRef(repo, ctx.query.ref);
  if (!tip) return notFound('Not Found');
  const files = filesAtCommit(repo, tip);
  if (filePath === '') {
    // Root directory listing.
    const entries = [...files.keys()].map((p) => p.split('/')[0]);
    const names = [...new Set(entries)].sort();
    return jsonResponse(
      200,
      names.map((name) => {
        const isDir = [...files.keys()].some((p) => p.startsWith(`${name}/`));
        const entry = isDir ? null : files.get(name)!;
        return {
          type: isDir ? 'dir' : 'file',
          size: isDir ? 0 : (repo.objects.get(entry!.oid)?.data.length ?? 0),
          name,
          path: name,
          sha: isDir ? '' : entry!.oid,
        };
      }),
    );
  }
  const entry = files.get(filePath);
  if (entry) {
    return jsonResponse(200, contentEntryJson(repo, filePath, entry.oid, filePath.split('/').pop()!));
  }
  // Directory?
  const prefix = `${filePath}/`;
  const children = [...files.keys()].filter((p) => p.startsWith(prefix));
  if (children.length > 0) {
    const names = [...new Set(children.map((p) => p.slice(prefix.length).split('/')[0]))].sort();
    return jsonResponse(
      200,
      names.map((name) => {
        const full = `${prefix}${name}`;
        const isDir = children.some((p) => p.startsWith(`${full}/`));
        const child = isDir ? null : files.get(full)!;
        return {
          type: isDir ? 'dir' : 'file',
          size: isDir ? 0 : (repo.objects.get(child!.oid)?.data.length ?? 0),
          name,
          path: full,
          sha: isDir ? '' : child!.oid,
        };
      }),
    );
  }
  return notFound('Not Found');
}

function putContents(ctx: RestContext, repo: Repo, filePath: string): RestResponse {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (typeof body.message !== 'string' || typeof body.content !== 'string') {
    return errorResponse(422, 'Validation Failed: message and content are required');
  }
  const branch = typeof body.branch === 'string' ? body.branch : repo.default_branch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const files = tip ? filesAtCommit(repo, tip) : new Map<string, { oid: string; mode: string }>();
  const existing = files.get(filePath);
  let content: Buffer;
  try {
    content = Buffer.from(body.content, 'base64');
  } catch {
    return errorResponse(422, 'Validation Failed: content is not valid base64');
  }
  const isUpdate = existing !== undefined;
  if (isUpdate) {
    if (typeof body.sha !== 'string' || body.sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return errorResponse(409, 'Conflict: sha does not match the current file');
    }
  } else if (typeof body.sha === 'string') {
    return errorResponse(422, 'Validation Failed: sha does not match a file');
  }
  const commitOid = commitFileChange(repo, branch, body.message, [{ path: filePath, content }]);
  const blobOid = store.writeObject(repo, 'blob', content);
  const entry = contentEntryJson(repo, filePath, blobOid, filePath.split('/').pop()!);
  return jsonResponse(isUpdate ? 200 : 201, {
    content: entry,
    commit: { sha: commitOid, message: body.message },
  });
}

function deleteContents(ctx: RestContext, repo: Repo, filePath: string): RestResponse {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (typeof body.message !== 'string' || typeof body.sha !== 'string') {
    return errorResponse(422, 'Validation Failed: message and sha are required');
  }
  const branch = typeof body.branch === 'string' ? body.branch : repo.default_branch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return notFound('Not Found');
  const files = filesAtCommit(repo, tip);
  const existing = files.get(filePath);
  if (!existing) return notFound('Not Found');
  if (body.sha.toLowerCase() !== existing.oid.toLowerCase()) {
    return errorResponse(409, 'Conflict: sha does not match the current file');
  }
  const commitOid = commitFileChange(repo, branch, body.message, [{ path: filePath, content: null }]);
  return jsonResponse(200, { commit: { sha: commitOid, message: body.message } });
}

// ---------------------------------------------------------------------------
// git refs
// ---------------------------------------------------------------------------

function createGitRef(ctx: RestContext, repo: Repo): RestResponse {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
  if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
    return errorResponse(422, 'Validation Failed: ref and sha are required');
  }
  const obj = repo.objects.get(sha);
  if (!obj) return errorResponse(422, 'Validation Failed: sha does not exist');
  if (repo.refs.has(ref)) return errorResponse(422, `Validation Failed: ref ${ref} already exists`);
  repo.refs.set(ref, sha);
  repo.updated_at = store.nowIso();
  return jsonResponse(201, {
    ref,
    node_id: `REF_kwDO${sha.slice(0, 8)}`,
    url: '',
    object: { sha, type: obj.type, url: '' },
  });
}

function getGitRef(ctx: RestContext, repo: Repo, refPath: string): RestResponse {
  if (refPath === '') {
    const refs = [...repo.refs.entries()].sort().map(([ref, sha]) => ({
      ref,
      node_id: `REF_kwDO${sha.slice(0, 8)}`,
      url: '',
      object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' },
    }));
    return jsonResponse(200, refs);
  }
  const ref = `refs/${refPath}`;
  const oid = repo.refs.get(ref);
  if (!oid) return notFound('Not Found');
  return jsonResponse(200, {
    ref,
    node_id: `REF_kwDO${oid.slice(0, 8)}`,
    url: '',
    object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit', url: '' },
  });
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

function listIssues(ctx: RestContext, repo: Repo): RestResponse {
  const state = ctx.query.state ?? 'open';
  let issues = [...repo.issues];
  if (state !== 'all') issues = issues.filter((i) => i.state === state);
  const direction = ctx.query.direction ?? 'desc';
  const sort = ctx.query.sort ?? 'created';
  issues.sort((a, b) => {
    let cmp = 0;
    if (sort === 'created') cmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.number - b.number;
    else cmp = a.number - b.number;
    return direction === 'asc' ? cmp : -cmp;
  });
  const { page, total } = paginate(issues, ctx.query);
  const link = linkHeader(ctx.baseUrl, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, ctx.query, total);
  return jsonResponse(200, page.map(issueJson), link ? { Link: link } : {});
}

function createIssue(ctx: RestContext, repo: Repo): RestResponse {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (typeof body.title !== 'string' || body.title === '') {
    return errorResponse(422, 'Validation Failed: title is required');
  }
  const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  const unknown = labelNames.filter((n) => !repo.labels.some((l) => l.name === n));
  if (unknown.length > 0) return errorResponse(422, `Validation Failed: label ${unknown[0]} does not exist`);
  const ts = store.nowIso();
  const issue: Issue = {
    id: store.nextEntityId++,
    number: repo.nextIssueNumber++,
    title: body.title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    labels: labelNames.map((n) => repo.labels.find((l) => l.name === n)!),
    user: { login: ctx.owner, id: VIEWER_ID },
    created_at: ts,
    updated_at: ts,
    closed_at: null,
    comments: [],
    seq: repo.nextIssueNumber,
  };
  repo.issues.push(issue);
  return jsonResponse(201, issueJson(issue));
}

// ---------------------------------------------------------------------------
// pulls
// ---------------------------------------------------------------------------

function listPulls(ctx: RestContext, repo: Repo): RestResponse {
  const state = ctx.query.state ?? 'open';
  let pulls = [...repo.pulls];
  if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
  pulls.sort((a, b) => b.number - a.number);
  const { page, total } = paginate(pulls, ctx.query);
  const link = linkHeader(ctx.baseUrl, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, ctx.query, total);
  return jsonResponse(200, page.map((p) => pullJson(repo, p)), link ? { Link: link } : {});
}

function createPull(ctx: RestContext, repo: Repo): RestResponse {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.default_branch;
  if (!title || !head) return errorResponse(422, 'Validation Failed: title and head are required');
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (!headTip) return errorResponse(422, `Validation Failed: head branch ${head} does not exist`);
  if (!baseTip) return errorResponse(422, `Validation Failed: base branch ${base} does not exist`);
  const ts = store.nowIso();
  const pull: Pull = {
    id: store.nextEntityId++,
    number: repo.nextPullNumber++,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    headRef: head,
    baseRef: base,
    headSha: headTip,
    baseSha: baseTip,
    user: { login: ctx.owner, id: VIEWER_ID },
    created_at: ts,
    updated_at: ts,
    seq: repo.nextPullNumber,
  };
  repo.pulls.push(pull);
  return jsonResponse(201, pullJson(repo, pull));
}

function mergePull(ctx: RestContext, repo: Repo, pull: Pull): RestResponse {
  if (pull.merged) return errorResponse(405, 'Pull request already merged');
  if (pull.state !== 'open') return errorResponse(405, 'Pull request is closed');
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const mergeBase = store.mergeBase(repo, headTip, baseTip);
  if (mergeBase === undefined) return errorResponse(405, 'No merge base');
  const baseFiles = filesAtCommit(repo, mergeBase);
  const headFiles = filesAtCommit(repo, headTip);
  const currentFiles = filesAtCommit(repo, baseTip);
  // 3-way merge per file; any file changed on both sides differently is a conflict.
  const merged = new Map(currentFiles);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const c = currentFiles.get(path);
    const headChanged = (h?.oid ?? null) !== (b?.oid ?? null);
    const baseChanged = (c?.oid ?? null) !== (b?.oid ?? null);
    if (headChanged && baseChanged && (h?.oid ?? null) !== (c?.oid ?? null)) {
      return errorResponse(405, 'Merge conflict');
    }
    if (headChanged) {
      if (h) merged.set(path, h);
      else merged.delete(path);
    }
  }
  const treeOid = store.buildTreeFromFiles(repo, merged);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const mergeSha = store.createCommit(repo, treeOid, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.merged = true;
  pull.state = 'closed';
  pull.merged_at = store.nowIso();
  pull.merge_commit_sha = mergeSha;
  pull.updated_at = store.nowIso();
  repo.updated_at = store.nowIso();
  return jsonResponse(200, { merged: true, sha: mergeSha, message });
}
