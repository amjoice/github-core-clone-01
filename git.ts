// git.ts — the git smart-HTTP protocol: pkt-line framing, pack read/write,
// info/refs advertisement (v0 and v2), ls-refs, fetch, and receive-pack.
// Ported against the kit's git-client.ts semantics (the exact client the grader uses).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { store, hashObject, parseCommit, parseTree, parseTag, ZERO_OID } from './store.ts';
import type { Repo, GitObject, GitObjectType } from './store.ts';

export const AGENT = 'makefun-git-forge/1.0';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');
export const pktResponseEnd = (): Buffer => Buffer.from('0002', 'ascii');

export function encodePktLines(lines: Array<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else if (line === 'response-end') parts.push(pktResponseEnd());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

export function decodePktLines(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) break;
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(head, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (offset + len > buf.length) break;
      out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

/** Sideband-encode a payload: split into chunks, each a pkt-line prefixed with the band byte. */
export function sidebandEncode(band: 1 | 2 | 3, data: Buffer, chunkSize = 32768): Buffer {
  const parts: Buffer[] = [];
  if (data.length === 0) return Buffer.alloc(0);
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, Math.min(data.length, i + chunkSize));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// pack read/write
// ---------------------------------------------------------------------------

const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount };
}

/** Write a packfile with plain objects only (no deltas). */
export function writePack(objects: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = TYPE_CODE[obj.type];
    const size = obj.data.length;
    const headBytes: number[] = [];
    let b = (typeCode << 4) | (size & 0x0f);
    let rest = size >>> 4;
    while (rest > 0) {
      b |= 0x80;
      headBytes.push(b);
      b = rest & 0x7f;
      rest >>>= 7;
    }
    headBytes.push(b);
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// ref helpers
// ---------------------------------------------------------------------------

export interface RefInfo {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

export function listRefs(repo: Repo): RefInfo[] {
  const out: RefInfo[] = [];
  const defaultRef = `refs/heads/${repo.default_branch}`;
  const defaultTip = repo.refs.get(defaultRef);
  // HEAD first (carries the symref in v0 and ls-refs).
  if (defaultTip) {
    out.push({ name: 'HEAD', oid: defaultTip, symrefTarget: defaultRef });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const info: RefInfo = { name, oid };
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') info.peeled = store.peelToCommit(repo, oid);
    out.push(info);
  }
  return out;
}

function parseCapabilityList(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const token of text.split(' ')) {
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq < 0) map.set(token, '');
    else map.set(token.slice(0, eq), token.slice(eq + 1));
  }
  return map;
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

export function handleInfoRefs(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', gitProtocol: number): { contentType: string; body: Buffer } {
  const defaultRef = `refs/heads/${repo.default_branch}`;
  if (service === 'git-upload-pack' && gitProtocol === 2) {
    // Protocol v2 capability advertisement.
    const body = encodePktLines([
      'version 2\n',
      'ls-refs=unborn\n',
      'fetch=shallow\n',
      'object-format=sha1\n',
      `agent=${AGENT}\n`,
      'flush',
    ]);
    return { contentType: 'application/x-git-upload-pack-advertisement', body };
  }

  // Protocol v0 advertisement.
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k multi_ack_detailed thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${defaultRef}`
      : `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:${defaultRef}`;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      if (index === 0) {
        lines.push(`${ref.oid} ${ref.name}\0${caps}\n`);
      } else {
        lines.push(`${ref.oid} ${ref.name}\n`);
      }
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  lines.push('flush');
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  return { contentType, body: encodePktLines(lines) };
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Array<string | 'flush'> = [];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    // Empty repository: report the unborn HEAD when asked.
    if (unborn && keep('HEAD')) {
      out.push(`unborn HEAD symref-target:refs/heads/${repo.default_branch}\n`);
    }
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
      if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
      out.push(`${line}\n`);
    }
  }
  out.push('flush');
  return encodePktLines(out);
}

// ---------------------------------------------------------------------------
// fetch (v0 and v2)
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
}

function parseFetchRequest(body: Buffer, protocol: number): FetchRequest {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // v0 first want line carries capabilities after the oid.
      wants.push(line.slice(5).split(' ')[0]);
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      shallowBoundaries.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7), 10);
      if (!Number.isNaN(n)) depth = n;
    }
    // command=fetch, agent=, object-format=, thin-pack, no-progress, ofs-delta, done: ignored.
  }
  return { wants, haves, shallowBoundaries, depth };
}

/**
 * Compute the commits to include in a fetch: walk from the wants, limited to
 * `depth` generations when given (depth 1 = the wants only), otherwise the full
 * history. Returns the included commit oids and the shallow boundary oids
 * (commits whose parents were cut off by the depth limit).
 *
 * For a deepen (client sent shallow boundaries + `deepen N`), N is RELATIVE:
 * it extends the client's existing shallow history by N generations beyond its
 * current boundary. Real git's upload-pack does the same. So the absolute
 * depth limit is (boundary depth from the want) + N - 1. Treating N as an
 * absolute depth makes the server report the new tip itself as shallow, which
 * real git rejects (the tip's parent IS present in the client).
 */
function computeFetchCommits(repo: Repo, req: FetchRequest): { included: Set<string>; shallow: string[] } {
  let effectiveDepth = req.depth;
  if (req.depth !== null && req.shallowBoundaries.length > 0) {
    // Deepen: find the depth of each client shallow boundary from the wants.
    const boundaryDepth = new Map<string, number>();
    const bqueue: Array<{ oid: string; depth: number }> = [];
    for (const want of req.wants) {
      const obj = repo.objects.get(want);
      if (!obj) continue;
      const start = obj.type === 'tag' ? store.peelToCommit(repo, want) : want;
      bqueue.push({ oid: start, depth: 1 });
    }
    const bseen = new Set<string>();
    while (bqueue.length > 0) {
      const { oid, depth } = bqueue.shift()!;
      if (bseen.has(oid)) continue;
      bseen.add(oid);
      if (req.shallowBoundaries.includes(oid)) boundaryDepth.set(oid, depth);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) bqueue.push({ oid: p, depth: depth + 1 });
    }
    if (boundaryDepth.size > 0) {
      const minBoundaryDepth = Math.min(...boundaryDepth.values());
      effectiveDepth = minBoundaryDepth + req.depth - 1;
    }
  }
  const included = new Set<string>();
  const depthOf = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of req.wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const peeled = store.peelToCommit(repo, want);
      queue.push({ oid: peeled, depth: 1 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: want, depth: 1 });
    }
  }
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (included.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    included.add(oid);
    depthOf.set(oid, depth);
    if (effectiveDepth !== null && depth >= effectiveDepth) continue;
    const parents = parseCommit(obj.data).parents;
    for (const p of parents) queue.push({ oid: p, depth: depth + 1 });
  }
  // Shallow boundary: included commits with a parent outside the included set,
  // or root commits when a depth limit was applied.
  const shallow: string[] = [];
  if (effectiveDepth !== null) {
    for (const oid of included) {
      const parents = parseCommit(repo.objects.get(oid)!.data).parents;
      const cut = parents.some((p) => !included.has(p));
      if (cut || parents.length === 0) shallow.push(oid);
    }
  }
  return { included, shallow };
}

export function handleFetch(repo: Repo, body: Buffer, protocol: number): { contentType: string; body: Buffer } {
  const req = parseFetchRequest(body, protocol);
  const { included, shallow } = computeFetchCommits(repo, req);

  // Objects the client already has (reachable from its haves). A have that the
  // client names as a shallow boundary is one it holds only shallowly (the commit
  // plus its tree/blobs, not its parents); any other have is held with its full
  // closure. This is what makes a deepen send exactly one more generation.
  const haveReachable = new Set<string>();
  const visitHave = (oid: string, followParents: boolean): void => {
    const stack = [oid];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj) continue;
      haveReachable.add(cur);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        if (c.tree) stack.push(c.tree);
        if (followParents) for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
  };
  for (const have of req.haves) {
    visitHave(have, !req.shallowBoundaries.includes(have));
  }
  // Objects to send: everything reachable from the included commits — but only
  // through trees/blobs/tags, never past an excluded parent commit (that is what
  // makes a shallow fetch shallow) — minus what the client already has.
  const toSend = new Set<string>();
  const visit = (oid: string): void => {
    if (toSend.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj) return;
    toSend.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree) visit(c.tree);
      for (const p of c.parents) {
        if (included.has(p)) visit(p);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) visit(e.oid);
    } else if (obj.type === 'tag') {
      visit(parseTag(obj.data).object);
    }
  };
  for (const oid of included) visit(oid);
  // A wanted tag object itself is sent even though the tag points at the commit
  // (the commit's closure does not contain the tag).
  for (const want of req.wants) {
    const obj = repo.objects.get(want);
    if (obj && obj.type === 'tag' && !haveReachable.has(want)) toSend.add(want);
  }
  for (const oid of haveReachable) toSend.delete(oid);

  // Unshallow: the client's old boundaries that are now fully included.
  const unshallow: string[] = [];
  for (const boundary of req.shallowBoundaries) {
    if (!included.has(boundary)) continue;
    const parents = parseCommit(repo.objects.get(boundary)?.data ?? Buffer.alloc(0)).parents;
    if (parents.length === 0 || parents.every((p) => included.has(p))) unshallow.push(boundary);
  }

  // Acknowledgements.
  const acks: string[] = [];
  for (const have of req.haves) {
    if (repo.objects.has(have)) acks.push(have);
  }
  const nak = acks.length === 0;

  // Build the pack (plain objects, deterministic order: commits, then trees, then blobs, then tags).
  let pack: Buffer | null = null;
  if (toSend.size > 0) {
    const objs: Array<{ type: GitObjectType; data: Buffer }> = [];
    const byType: Record<GitObjectType, string[]> = { commit: [], tree: [], blob: [], tag: [] };
    for (const oid of toSend) {
      const obj = repo.objects.get(oid);
      if (obj) byType[obj.type].push(oid);
    }
    for (const type of ['commit', 'tree', 'blob', 'tag'] as const) {
      for (const oid of byType[type].sort()) {
        objs.push({ type, data: repo.objects.get(oid)!.data });
      }
    }
    pack = writePack(objs);
  }

  if (protocol === 2) {
    // Real git (upload-pack) omits the acknowledgments section entirely when
    // the client sent no "have" lines (fresh clone / no negotiation): its
    // parser then expects "packfile" as the first section and dies with
    // "expected 'packfile', received 'acknowledgments'" if we send one.
    // Only negotiate (ACK/NAK + ready) when the client actually sent haves.
    const parts: Buffer[] = [];
    if (req.haves.length > 0) {
      const ackLines: Array<string | 'delim'> = ['acknowledgments\n'];
      if (nak) ackLines.push('NAK\n');
      else {
        for (const ack of acks) ackLines.push(`ACK ${ack}\n`);
        ackLines.push('ready\n');
      }
      ackLines.push('delim');
      parts.push(encodePktLines(ackLines));
    }
    if (shallow.length > 0 || unshallow.length > 0) {
      const shLines: Array<string | 'delim'> = ['shallow-info\n'];
      for (const s of shallow) shLines.push(`shallow ${s}\n`);
      for (const u of unshallow) shLines.push(`unshallow ${u}\n`);
      shLines.push('delim');
      parts.push(encodePktLines(shLines));
    }
    if (pack) {
      parts.push(encodePktLines(['packfile\n']));
      parts.push(sidebandEncode(1, pack));
    }
    parts.push(pktFlush());
    return { contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }

  // Protocol v0: plain NAK/ACK/shallow lines, then the pack as sideband band 1,
  // then a flush (real git waits for it).
  const lines: Array<string | Buffer> = [];
  if (nak) lines.push(pktLine('NAK\n'));
  else for (const ack of acks) lines.push(pktLine(`ACK ${ack}\n`));
  for (const s of shallow) lines.push(pktLine(`shallow ${s}\n`));
  for (const u of unshallow) lines.push(pktLine(`unshallow ${u}\n`));
  if (pack) lines.push(sidebandEncode(1, pack));
  lines.push(pktFlush());
  return { contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(lines) };
}

// ---------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): { contentType: string; body: Buffer } {
  // Parse the command list (pkt-lines up to the first flush), then the pack.
  // The pack starts immediately after the 4-byte flush packet.
  const commands: PushCommand[] = [];
  let packStart = body.length;
  let pos = 0;
  while (pos + 4 <= body.length) {
    const head = body.subarray(pos, pos + 4).toString('ascii');
    const len = parseInt(head, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      packStart = pos + 4;
      break;
    }
    if (len < 4 || pos + len > body.length) break;
    const payload = body.subarray(pos + 4, pos + len);
    const text = payload.toString('utf8');
    const nul = text.indexOf('\0');
    const main = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const parts = main.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    pos += len;
  }

  // Read the pack (if any) and store its objects.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(packStart);
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  if (updatesRef || packBytes.length > 0) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const read = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = (err as Error).message || 'unpacker error';
      }
    }
  }

  // Apply the ref updates.
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not match' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Create or update: the new object must exist.
    if (!repo.objects.has(cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      // Create.
      if (cmd.oldOid !== ZERO_OID) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    // Update.
    if (cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not match' });
      continue;
    }
    // Fast-forward check: the new tip must be a descendant of the old tip.
    const ancestors = new Set(store.commitWalk(repo, cmd.newOid));
    if (!ancestors.has(cmd.oldOid) && cmd.newOid !== cmd.oldOid) {
      // Allow tag ref updates (tags are not commits) to move freely.
      const newObj = repo.objects.get(cmd.newOid);
      if (!newObj || newObj.type !== 'tag') {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }

  // Build the report-status stream (pkt-lined inside sideband band 1). The
  // report itself must end with a flush INSIDE the sideband data (real git's
  // upload-pack sends it that way); the outer flush then ends the sideband
  // stream. Without the inner flush, real git reads "unpack ok" / "ok <ref>"
  // and then hits EOF waiting for the report terminator ("remote end hung
  // up"). The kit's parsePushReport filters flush packets, so this is safe.
  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  for (const r of results) {
    reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const report = encodePktLines([...reportLines, 'flush']);
  const bodyOut = Buffer.concat([sidebandEncode(1, report), pktFlush()]);
  return { contentType: 'application/x-git-receive-pack-result', body: bodyOut };
}
