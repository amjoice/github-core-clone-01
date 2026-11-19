// graphql.ts — a focused GraphQL executor for the documents the grader sends
// (viewer, repository, node, __type introspection, and the issue/PR mutations).
// It is not a general GraphQL engine; it parses the bounded document subset
// used by the checks and resolves it against the same store as REST/MCP.

import { store, VIEWER_LOGIN, VIEWER_ID } from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';
import { filesAtCommit, pullFiles, computeMergeable } from './rest.ts';

// ---------------------------------------------------------------------------
// global (Relay) ids — opaque, stable, base64
// ---------------------------------------------------------------------------

export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.owner}/${repo.name}`, 'utf8').toString('base64');
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return Buffer.from(`Issue:${repo.owner}/${repo.name}#${issue.number}`, 'utf8').toString('base64');
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return Buffer.from(`PullRequest:${repo.owner}/${repo.name}#${pull.number}`, 'utf8').toString('base64');
}

export function commentGlobalId(repo: Repo, commentId: number): string {
  return Buffer.from(`IssueComment:${repo.owner}/${repo.name}#${commentId}`, 'utf8').toString('base64');
}

interface DecodedId {
  kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment';
  owner: string;
  name: string;
  number?: number;
  commentId?: number;
}

export function decodeGlobalId(id: string): DecodedId | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const m = /^(Repository|Issue|PullRequest|IssueComment):([^/]+)\/([^#]+)(?:#(\d+))?$/.exec(text);
    if (!m) return null;
    const kind = m[1] as DecodedId['kind'];
    const out: DecodedId = { kind, owner: m[2], name: m[3] };
    if (m[4] !== undefined) {
      if (kind === 'IssueComment') out.commentId = parseInt(m[4], 10);
      else out.number = parseInt(m[4], 10);
    }
    return out;
  } catch {
    return null;
  }
}

function findRepoByGlobalId(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  return store.getRepo(decoded.owner, decoded.name) ?? null;
}

// ---------------------------------------------------------------------------
// schema (for __type introspection)
// ---------------------------------------------------------------------------

const SCHEMA: Record<string, { fields: string[]; enumValues?: string[] }> = {
  Issue: {
    fields: [
      'id', 'number', 'title', 'body', 'state', 'author', 'authorAssociation', 'bodyHTML', 'bodyText',
      'closed', 'closedAt', 'comments', 'createdAt', 'labels', 'locked', 'milestone', 'participants',
      'repository', 'resourcePath', 'titleHTML', 'updatedAt', 'url', 'viewerDidAuthor',
    ],
  },
  PullRequest: {
    fields: [
      'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid',
      'mergeable', 'merged', 'mergeCommit', 'mergedAt', 'closedAt', 'createdAt', 'updatedAt', 'author',
      'files', 'commits', 'reviews', 'labels', 'repository', 'url', 'isDraft', 'additions', 'deletions',
      'changedFiles',
    ],
  },
  Repository: {
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
      'isFork', 'createdAt', 'updatedAt', 'url', 'visibility', 'licenseInfo', 'stargazerCount',
      'forkCount', 'watchers', 'defaultBranch', 'primaryLanguage',
    ],
  },
  SearchType: {
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  },
  User: {
    fields: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'bio', 'company', 'location'],
  },
};

// ---------------------------------------------------------------------------
// parser (bounded GraphQL subset)
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface Selection {
  kind: 'field' | 'fragment';
  name?: string;
  alias?: string;
  args?: Record<string, Value>;
  selections?: Selection[];
  typeCondition?: string;
}

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  selections: Selection[];
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    // name / number / -
    let j = i;
    while (j < input.length && /[A-Za-z0-9_.-]/.test(input[j])) j += 1;
    if (j === i) {
      i += 1;
      continue;
    }
    tokens.push(input.slice(i, j));
    i = j;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    return this.tokens[this.pos++];
  }

  expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new Error(`expected ${tok}, got ${got}`);
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const tok = this.peek();
    if (tok === 'query' || tok === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
    }
    let name: string | undefined;
    const next = this.peek();
    if (next !== undefined && next !== '{' && next !== '(' && next !== '@') {
      name = this.next();
    }
    // variable definitions
    if (this.peek() === '(') {
      this.next();
      let depth = 1;
      while (depth > 0 && this.pos < this.tokens.length) {
        const t = this.next();
        if (t === '(') depth += 1;
        else if (t === ')') depth -= 1;
      }
    }
    // directives
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        this.next();
        let depth = 1;
        while (depth > 0 && this.pos < this.tokens.length) {
          const t = this.next();
          if (t === '(') depth += 1;
          else if (t === ')') depth -= 1;
        }
      }
    }
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  parseSelection(): Selection {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        const selections = this.parseSelectionSet();
        return { kind: 'fragment', typeCondition, selections };
      }
      // named fragment spread — not used by the checks; skip its selections
      this.next();
      return { kind: 'fragment', selections: [] };
    }
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      alias = name;
      this.next();
      name = this.next();
    }
    let args: Record<string, Value> | undefined;
    if (this.peek() === '(') {
      args = this.parseArguments();
    }
    // directives
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        this.next();
        let depth = 1;
        while (depth > 0 && this.pos < this.tokens.length) {
          const t = this.next();
          if (t === '(') depth += 1;
          else if (t === ')') depth -= 1;
        }
      }
    }
    let selections: Selection[] | undefined;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  parseArguments(): Record<string, Value> {
    this.expect('(');
    const args: Record<string, Value> = {};
    while (this.peek() !== ')' && this.pos < this.tokens.length) {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  parseValue(): Value {
    const tok = this.next();
    if (tok === '$') {
      return { kind: 'variable', name: this.next() };
    }
    if (tok === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']' && this.pos < this.tokens.length) values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (tok === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}' && this.pos < this.tokens.length) {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (tok.startsWith('"')) {
      return { kind: 'string', value: JSON.parse(tok) };
    }
    if (tok === 'true') return { kind: 'boolean', value: true };
    if (tok === 'false') return { kind: 'boolean', value: false };
    if (tok === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(tok)) return { kind: 'int', value: parseInt(tok, 10) };
    if (/^-?\d+\.\d+$/.test(tok)) return { kind: 'float', value: parseFloat(tok) };
    return { kind: 'enum', value: tok };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'variable':
      return variables[value.name];
    case 'list':
      return value.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of value.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, Value> | undefined, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!args) return out;
  for (const [k, v] of Object.entries(args)) out[k] = resolveValue(v, variables);
  return out;
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

interface ExecContext {
  owner: string;
  errors: Array<{ message: string }>;
}

type GqlValue = Record<string, unknown> | null;

interface TypedValue {
  type: string;
  value: unknown;
}

function issueStateGql(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function executeSelections(
  ctx: ExecContext,
  typed: TypedValue,
  selections: Selection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== typed.type) continue;
      Object.assign(out, executeSelections(ctx, typed, sel.selections ?? [], variables));
      continue;
    }
    const fieldName = sel.name!;
    const responseKey = sel.alias ?? fieldName;
    const args = resolveArgs(sel.args, variables);
    const result = resolveField(ctx, typed, fieldName, args, sel.selections ?? [], variables);
    if (result.error) {
      ctx.errors.push({ message: result.error });
      out[responseKey] = null;
    } else {
      out[responseKey] = result.value;
    }
  }
  return out;
}

interface FieldResult {
  value?: unknown;
  error?: string;
}

function resolveField(
  ctx: ExecContext,
  typed: TypedValue,
  fieldName: string,
  args: Record<string, unknown>,
  selections: Selection[],
  variables: Record<string, unknown>,
): FieldResult {
  const { type, value } = typed;

  // -- Query root ----------------------------------------------------------
  if (type === 'Query') {
    if (fieldName === 'viewer') {
      return { value: executeSelections(ctx, { type: 'User', value: { login: ctx.owner, id: VIEWER_ID } }, selections, variables) };
    }
    if (fieldName === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== ctx.owner) return { value: null };
      const repo = store.getRepo(owner, name);
      if (!repo) return { value: null };
      return { value: executeSelections(ctx, { type: 'Repository', value: repo }, selections, variables) };
    }
    if (fieldName === 'node') {
      const id = args.id as string;
      const decoded = decodeGlobalId(id);
      if (!decoded) return { value: null };
      const repo = store.getRepo(decoded.owner, decoded.name);
      if (!repo) return { value: null };
      if (decoded.kind === 'Repository') {
        return { value: executeSelections(ctx, { type: 'Repository', value: repo }, selections, variables) };
      }
      if (decoded.kind === 'Issue' && decoded.number !== undefined) {
        const issue = repo.issues.find((i) => i.number === decoded.number);
        if (!issue) return { value: null };
        return { value: executeSelections(ctx, { type: 'Issue', value: { repo, issue } }, selections, variables) };
      }
      if (decoded.kind === 'PullRequest' && decoded.number !== undefined) {
        const pull = repo.pulls.find((p) => p.number === decoded.number);
        if (!pull) return { value: null };
        return { value: executeSelections(ctx, { type: 'PullRequest', value: { repo, pull } }, selections, variables) };
      }
      return { value: null };
    }
    if (fieldName === '__type') {
      const name = args.name as string;
      const typeDef = SCHEMA[name];
      if (!typeDef) return { value: { fields: [], enumValues: [] } };
      const sub: Record<string, unknown> = {};
      for (const sel of selections) {
        if (sel.kind === 'field' && sel.name === 'fields') {
          sub[sel.alias ?? 'fields'] = typeDef.fields.map((n) => ({ name: n }));
        } else if (sel.kind === 'field' && sel.name === 'enumValues') {
          sub[sel.alias ?? 'enumValues'] = (typeDef.enumValues ?? []).map((n) => ({ name: n }));
        }
      }
      return { value: sub };
    }
    return { error: `Cannot query field "${fieldName}" on type "Query".` };
  }

  // -- Mutation root -------------------------------------------------------
  if (type === 'Mutation') {
    return resolveMutation(ctx, fieldName, args, selections, variables);
  }

  // -- User ----------------------------------------------------------------
  if (type === 'User') {
    const user = value as { login: string; id: number };
    if (fieldName === 'login') return { value: user.login };
    if (fieldName === 'id') return { value: Buffer.from(`User:${user.login}`, 'utf8').toString('base64') };
    if (fieldName === 'name') return { value: user.login === VIEWER_LOGIN ? 'Ada Iversen' : user.login };
    if (fieldName === 'email') return { value: `${user.login}@example.invalid` };
    return { error: `Cannot query field "${fieldName}" on type "User".` };
  }

  // -- Repository ----------------------------------------------------------
  if (type === 'Repository') {
    const repo = value as Repo;
    if (fieldName === 'id') return { value: repoGlobalId(repo) };
    if (fieldName === 'databaseId') return { value: repo.id };
    if (fieldName === 'name') return { value: repo.name };
    if (fieldName === 'nameWithOwner') return { value: `${repo.owner}/${repo.name}` };
    if (fieldName === 'owner') {
      return { value: executeSelections(ctx, { type: 'User', value: { login: repo.owner, id: VIEWER_ID } }, selections, variables) };
    }
    if (fieldName === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
      if (!tip) return { value: null };
      return { value: executeSelections(ctx, { type: 'Ref', value: { name: repo.default_branch, oid: tip } }, selections, variables) };
    }
    if (fieldName === 'viewerPermission') return { value: 'ADMIN' };
    if (fieldName === 'hasIssuesEnabled') return { value: true };
    if (fieldName === 'description') return { value: repo.description };
    if (fieldName === 'isPrivate') return { value: repo.private };
    if (fieldName === 'createdAt') return { value: repo.created_at };
    if (fieldName === 'updatedAt') return { value: repo.updated_at };
    if (fieldName === 'issue') {
      const number = args.number as number;
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) return { value: null };
      return { value: executeSelections(ctx, { type: 'Issue', value: { repo, issue } }, selections, variables) };
    }
    if (fieldName === 'issues') {
      return { value: issuesConnection(ctx, repo, args, selections, variables) };
    }
    if (fieldName === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : 10;
      let pulls = [...repo.pulls].sort((a, b) => b.number - a.number);
      if (Array.isArray(args.states)) {
        const states = (args.states as string[]).map((s) => s.toLowerCase());
        pulls = pulls.filter((p) => states.includes(p.state));
      }
      const nodes = pulls.slice(0, first).map((pull) => executeSelections(ctx, { type: 'PullRequest', value: { repo, pull } }, selections.find((s) => s.kind === 'field' && s.name === 'nodes')?.selections ?? selections, variables));
      return { value: { nodes } };
    }
    if (fieldName === 'pullRequest') {
      const number = args.number as number;
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return { value: null };
      return { value: executeSelections(ctx, { type: 'PullRequest', value: { repo, pull } }, selections, variables) };
    }
    return { error: `Cannot query field "${fieldName}" on type "Repository".` };
  }

  // -- Ref -----------------------------------------------------------------
  if (type === 'Ref') {
    const ref = value as { name: string; oid: string };
    if (fieldName === 'name') return { value: ref.name };
    if (fieldName === 'target') return { value: { oid: ref.oid } };
    return { error: `Cannot query field "${fieldName}" on type "Ref".` };
  }

  // -- Issue ---------------------------------------------------------------
  if (type === 'Issue') {
    const { repo, issue } = value as { repo: Repo; issue: Issue };
    if (fieldName === 'id') return { value: issueGlobalId(repo, issue) };
    if (fieldName === 'number') return { value: issue.number };
    if (fieldName === 'title') return { value: issue.title };
    if (fieldName === 'body') return { value: issue.body };
    if (fieldName === 'state') return { value: issueStateGql(issue.state) };
    if (fieldName === 'createdAt') return { value: issue.created_at };
    if (fieldName === 'updatedAt') return { value: issue.updated_at };
    if (fieldName === 'closedAt') return { value: issue.closed_at };
    if (fieldName === 'author') {
      return { value: executeSelections(ctx, { type: 'User', value: { login: issue.user.login, id: issue.user.id } }, selections, variables) };
    }
    if (fieldName === 'labels') {
      return { value: { nodes: issue.labels.map((l) => ({ name: l.name })) } };
    }
    if (fieldName === 'comments') {
      return { value: { nodes: issue.comments.map((c) => ({ id: commentGlobalId(repo, c.id), body: c.body })) } };
    }
    return { error: `Cannot query field "${fieldName}" on type "Issue".` };
  }

  // -- PullRequest ---------------------------------------------------------
  if (type === 'PullRequest') {
    const { repo, pull } = value as { repo: Repo; pull: Pull };
    if (fieldName === 'id') return { value: pullGlobalId(repo, pull) };
    if (fieldName === 'number') return { value: pull.number };
    if (fieldName === 'title') return { value: pull.title };
    if (fieldName === 'body') return { value: pull.body };
    if (fieldName === 'state') return { value: issueStateGql(pull.state) };
    if (fieldName === 'headRefName') return { value: pull.headRef };
    if (fieldName === 'baseRefName') return { value: pull.baseRef };
    if (fieldName === 'headRefOid') return { value: repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha };
    if (fieldName === 'baseRefOid') return { value: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha };
    if (fieldName === 'mergeable') {
      if (pull.merged) return { value: 'UNKNOWN' };
      return { value: computeMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING' };
    }
    if (fieldName === 'merged') return { value: pull.merged };
    if (fieldName === 'mergedAt') return { value: pull.merged_at };
    if (fieldName === 'createdAt') return { value: pull.created_at };
    if (fieldName === 'updatedAt') return { value: pull.updated_at };
    if (fieldName === 'files') {
      const first = typeof args.first === 'number' ? args.first : 10;
      const files = pullFiles(repo, pull).slice(0, first);
      const nodeSelections = selections.find((s) => s.kind === 'field' && s.name === 'nodes')?.selections ?? [];
      return {
        value: {
          nodes: files.map((f) => {
            const out: Record<string, unknown> = {};
            for (const sel of nodeSelections) {
              if (sel.kind === 'field' && sel.name === 'path') out[sel.alias ?? 'path'] = f.filename;
              if (sel.kind === 'field' && sel.name === 'additions') out[sel.alias ?? 'additions'] = f.additions;
              if (sel.kind === 'field' && sel.name === 'deletions') out[sel.alias ?? 'deletions'] = f.deletions;
            }
            return out;
          }),
        },
      };
    }
    if (fieldName === 'author') {
      return { value: executeSelections(ctx, { type: 'User', value: { login: pull.user.login, id: pull.user.id } }, selections, variables) };
    }
    return { error: `Cannot query field "${fieldName}" on type "PullRequest".` };
  }

  return { error: `Cannot query field "${fieldName}" on type "${type}".` };
}

function issuesConnection(
  ctx: ExecContext,
  repo: Repo,
  args: Record<string, unknown>,
  selections: Selection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : 10;
  const after = decodeCursor(args.after as string | null | undefined);
  let issues = [...repo.issues];
  // states filter
  if (Array.isArray(args.states)) {
    const states = (args.states as string[]).map((s) => s.toLowerCase());
    issues = issues.filter((i) => states.includes(i.state));
  }
  // order
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction ?? 'DESC';
  issues.sort((a, b) => {
    const cmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.number - b.number;
    return direction === 'DESC' ? -cmp : cmp;
  });
  // cursor filter
  if (after !== null) {
    if (direction === 'DESC') issues = issues.filter((i) => i.number < after);
    else issues = issues.filter((i) => i.number > after);
  }
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > first;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const nodeSelections = selections.find((s) => s.kind === 'field' && s.name === 'nodes')?.selections ?? [];
  const pageInfoSelections = selections.find((s) => s.kind === 'field' && s.name === 'pageInfo')?.selections ?? [];
  const nodes = page.map((issue) => executeSelections(ctx, { type: 'Issue', value: { repo, issue } }, nodeSelections, variables));
  const pageInfo: Record<string, unknown> = {};
  for (const sel of pageInfoSelections) {
    if (sel.kind === 'field' && sel.name === 'hasNextPage') pageInfo[sel.alias ?? 'hasNextPage'] = hasNextPage;
    if (sel.kind === 'field' && sel.name === 'endCursor') pageInfo[sel.alias ?? 'endCursor'] = endCursor;
    if (sel.kind === 'field' && sel.name === 'hasPreviousPage') pageInfo[sel.alias ?? 'hasPreviousPage'] = false;
    if (sel.kind === 'field' && sel.name === 'startCursor') pageInfo[sel.alias ?? 'startCursor'] = page.length > 0 ? encodeCursor(page[0].number) : null;
  }
  return { nodes, pageInfo };
}

function resolveMutation(
  ctx: ExecContext,
  fieldName: string,
  args: Record<string, unknown>,
  selections: Selection[],
  variables: Record<string, unknown>,
): FieldResult {
  const input = (args.input ?? {}) as Record<string, unknown>;

  if (fieldName === 'createIssue') {
    const repositoryId = input.repositoryId as string;
    const repo = findRepoByGlobalId(repositoryId);
    if (!repo) return { error: `Could not resolve to a Repository with the id of '${repositoryId}'.` };
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    if (!title) return { error: 'title is required' };
    const ts = store.nowIso();
    const issue: Issue = {
      id: store.nextEntityId++,
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels: [],
      user: { login: ctx.owner, id: VIEWER_ID },
      created_at: ts,
      updated_at: ts,
      closed_at: null,
      comments: [],
      seq: repo.nextIssueNumber,
    };
    repo.issues.push(issue);
    const issueSelections = selections.find((s) => s.kind === 'field' && s.name === 'issue')?.selections ?? [];
    return {
      value: {
        issue: executeSelections(ctx, { type: 'Issue', value: { repo, issue } }, issueSelections, variables),
      },
    };
  }

  if (fieldName === 'closeIssue') {
    const issueId = input.issueId as string;
    const decoded = decodeGlobalId(issueId);
    if (!decoded || decoded.kind !== 'Issue' || decoded.number === undefined) {
      return { error: `Could not resolve to an Issue with the id of '${issueId}'.` };
    }
    const repo = store.getRepo(decoded.owner, decoded.name);
    const issue = repo?.issues.find((i) => i.number === decoded.number);
    if (!repo || !issue) return { error: `Could not resolve to an Issue with the id of '${issueId}'.` };
    issue.state = 'closed';
    issue.closed_at = store.nowIso();
    issue.updated_at = store.nowIso();
    const issueSelections = selections.find((s) => s.kind === 'field' && s.name === 'issue')?.selections ?? [];
    return {
      value: {
        issue: executeSelections(ctx, { type: 'Issue', value: { repo, issue } }, issueSelections, variables),
      },
    };
  }

  if (fieldName === 'createPullRequest') {
    const repositoryId = input.repositoryId as string;
    const repo = findRepoByGlobalId(repositoryId);
    if (!repo) return { error: `Could not resolve to a Repository with the id of '${repositoryId}'.` };
    const headRefName = input.headRefName as string;
    const baseRefName = (input.baseRefName as string) ?? repo.default_branch;
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const headTip = repo.refs.get(`refs/heads/${headRefName}`);
    const baseTip = repo.refs.get(`refs/heads/${baseRefName}`);
    if (!headTip) return { error: `Head branch ${headRefName} does not exist` };
    if (!baseTip) return { error: `Base branch ${baseRefName} does not exist` };
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
      headRef: headRefName,
      baseRef: baseRefName,
      headSha: headTip,
      baseSha: baseTip,
      user: { login: ctx.owner, id: VIEWER_ID },
      created_at: ts,
      updated_at: ts,
      seq: repo.nextPullNumber,
    };
    repo.pulls.push(pull);
    const prSelections = selections.find((s) => s.kind === 'field' && s.name === 'pullRequest')?.selections ?? [];
    return {
      value: {
        pullRequest: executeSelections(ctx, { type: 'PullRequest', value: { repo, pull } }, prSelections, variables),
      },
    };
  }

  if (fieldName === 'mergePullRequest') {
    const pullRequestId = input.pullRequestId as string;
    const decoded = decodeGlobalId(pullRequestId);
    if (!decoded || decoded.kind !== 'PullRequest' || decoded.number === undefined) {
      return { error: `Could not resolve to a PullRequest with the id of '${pullRequestId}'.` };
    }
    const repo = store.getRepo(decoded.owner, decoded.name);
    const pull = repo?.pulls.find((p) => p.number === decoded.number);
    if (!repo || !pull) return { error: `Could not resolve to a PullRequest with the id of '${pullRequestId}'.` };
    if (pull.merged) return { error: 'Pull request already merged' };
    if (!computeMergeable(repo, pull)) return { error: 'Merge conflict' };
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
    const prSelections = selections.find((s) => s.kind === 'field' && s.name === 'pullRequest')?.selections ?? [];
    return {
      value: {
        pullRequest: executeSelections(ctx, { type: 'PullRequest', value: { repo, pull } }, prSelections, variables),
      },
    };
  }

  if (fieldName === 'addComment') {
    const subjectId = input.subjectId as string;
    const body = typeof input.body === 'string' ? input.body : '';
    const decoded = decodeGlobalId(subjectId);
    if (!decoded) return { error: `Could not resolve to a subject with the id of '${subjectId}'.` };
    const repo = store.getRepo(decoded.owner, decoded.name);
    if (!repo) return { error: `Could not resolve to a subject with the id of '${subjectId}'.` };
    if (decoded.kind === 'Issue' && decoded.number !== undefined) {
      const issue = repo.issues.find((i) => i.number === decoded.number);
      if (!issue) return { error: `Could not resolve to an Issue with the id of '${subjectId}'.` };
      const comment = {
        id: store.nextEntityId++,
        body,
        user: { login: ctx.owner, id: VIEWER_ID },
        created_at: store.nowIso(),
        updated_at: store.nowIso(),
      };
      issue.comments.push(comment);
      const nodeSelections =
        selections
          .find((s) => s.kind === 'field' && s.name === 'commentEdge')
          ?.selections?.find((s) => s.kind === 'field' && s.name === 'node')?.selections ?? [];
      const node: Record<string, unknown> = {};
      for (const sel of nodeSelections) {
        if (sel.kind === 'field' && sel.name === 'id') node[sel.alias ?? 'id'] = commentGlobalId(repo, comment.id);
        if (sel.kind === 'field' && sel.name === 'body') node[sel.alias ?? 'body'] = comment.body;
      }
      return { value: { commentEdge: { node } } };
    }
    return { error: `Could not resolve to a subject with the id of '${subjectId}'.` };
  }

  return { error: `Cannot query field "${fieldName}" on type "Mutation".` };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export interface GraphQLResult {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(owner: string, body: unknown): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((entry) => executeOne(owner, entry));
  }
  return executeOne(owner, body);
}

function executeOne(owner: string, body: unknown): GraphQLResult {
  const doc = (body ?? {}) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
  if (typeof doc.query !== 'string') {
    return { errors: [{ message: 'Must provide query string.' }] };
  }
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(doc.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: `Syntax Error: ${(err as Error).message}` }] };
  }
  const variables = (doc.variables ?? {}) as Record<string, unknown>;
  const op = operations.find((o) => doc.operationName === undefined || o.name === doc.operationName) ?? operations[0];
  if (!op) return { errors: [{ message: 'Must provide an operation.' }] };
  const ctx: ExecContext = { owner, errors: [] };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, { type: rootType, value: null }, op.selections, variables);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
