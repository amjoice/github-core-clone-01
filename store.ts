// store.ts — in-memory data model for the git forge.
// The git object store is a dumb byte store: objects pushed by a client are kept
// byte-exactly (clone-commit-bytes requires the server to return pushed commit/tag
// bytes unchanged). Objects the server creates (via REST contents) are built in
// standard git format (tree mode 40000 for dirs, 100644 for files).

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_NAME = 'Ada Iversen';
export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface CommitParsed {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitParsed {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const message = headerEnd >= 0 ? text.slice(headerEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagParsed {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagParsed {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const message = headerEnd >= 0 ? text.slice(headerEnd + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// REST entities
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export const SCENARIO_LABELS: Array<{ name: string; color: string; description: string }> = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
];

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: IssueComment[];
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  nextIssueId: number;
  nextPullId: number;
  nextLabelId: number;
}

export class Store {
  repos = new Map<string, Repo>(); // key: `${owner}/${name}`
  nextRepoId = 5000;
  nextEntityId = 100000;
  private lastTs = 0;

  nowIso(): string {
    // Strictly increasing timestamps so created_at ordering is deterministic.
    const now = Date.now();
    this.lastTs = Math.max(now, this.lastTs + 1);
    return new Date(this.lastTs).toISOString();
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean }): Repo {
    const ts = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description: opts.description ?? '',
      private: opts.private ?? false,
      default_branch: 'main',
      created_at: ts,
      updated_at: ts,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: SCENARIO_LABELS.map((l) => ({ id: this.nextEntityId++, ...l })),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      nextIssueId: 1,
      nextPullId: 1,
      nextLabelId: 1000,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposFor(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.id - b.id);
  }

  // -- git object helpers -------------------------------------------------
  writeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid.toLowerCase());
  }

  /** Resolve a ref name to an oid (undefined when absent). */
  resolveRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Peel a tag object (recursively) to the underlying commit oid. */
  peelToCommit(repo: Repo, oid: string): string {
    let cur = oid;
    const seen = new Set<string>();
    while (!seen.has(cur)) {
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'tag') return cur;
      cur = parseTag(obj.data).object;
    }
    return cur;
  }

  /** All objects reachable from the given commit/tag oids (commits, trees, blobs, tags). */
  reachable(repo: Repo, roots: readonly string[]): Set<string> {
    const out = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (out.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        if (c.tree) stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return out;
  }

  /** Commit oids reachable from a tip (walking parents), most recent first. */
  commitWalk(repo: Repo, tip: string, limit = 1000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0 && out.length < limit) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      const c = parseCommit(obj.data);
      for (const p of c.parents) stack.push(p);
    }
    return out;
  }

  /** The merge-base (best common ancestor) of two commits, or undefined. */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const aAnc = new Set(this.commitWalk(repo, a));
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aAnc.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return undefined;
  }

  /** Flatten a tree (by oid) to path -> { oid, mode }. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') {
        this.flattenTree(repo, e.oid, path, out);
      } else {
        out.set(path, { oid: e.oid, mode: e.mode });
      }
    }
    return out;
  }

  /** Build a tree object from a path->oid map, creating intermediate trees. Returns root tree oid. */
  buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    // Group files by directory.
    const buildDir = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const subdirs = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [path, f] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          entries.push({ mode: f.mode, name: rest, oid: f.oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = subdirs.get(dir);
          if (!sub) {
            sub = new Map();
            subdirs.set(dir, sub);
          }
          sub.set(path, f);
        }
      }
      for (const [dir, sub] of subdirs) {
        const subOid = buildDir(prefix + dir + '/');
        entries.push({ mode: '40000', name: dir, oid: subOid });
      }
      return this.writeObject(repo, 'tree', buildTree(entries));
    };
    return buildDir('');
  }

  /** Create a commit object. Returns its oid. */
  createCommit(repo: Repo, treeOid: string, parents: string[], message: string, timestamp?: number): string {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
    const lines = [`tree ${treeOid}`];
    for (const p of parents) lines.push(`parent ${p}`);
    lines.push(`author ${ident}`, `committer ${ident}`, '', message.endsWith('\n') ? message : `${message}\n`);
    return this.writeObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  }
}

export const store = new Store();
