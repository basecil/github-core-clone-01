// git-pack.ts — packfile codec + reachability collection for the smart-HTTP server.
//
// The wire formats mirror the kit's git-client.ts exactly (readPack / writePack /
// applyDelta / collectReachable are the reference): a v2 pack is `PACK` + version 2 +
// object count, then per-object type/size varint headers + zlib streams, then a 20-byte
// SHA-1 trailer over everything before it. Deltas (OFS_DELTA / REF_DELTA) are resolved
// on READ (a pushed pack may contain them); this server only ever WRITES full objects
// (no deltas) — the pack-deltas check only requires deltas to resolve IF the server
// sends them, and full objects are always acceptable.
//
// ── API surface ────────────────────────────────────────────────────────────────
//   PackedObject { oid, type, data } — a git object with its id attached
//   ObjectLookup                 — (oid) => GitObject | undefined (the store lookup)
//   parsePack(buf, lookup)       — parse a v2/v3 pack into resolved objects; verifies the
//                                  trailer checksum, the declared sizes and every delta;
//                                  throws a clear Error on malformed input (the caller
//                                  turns it into an unpack failure, never a crash)
//   applyDelta(base, delta)      — apply a git delta instruction stream to base bytes
//   buildPack(objects)           — a valid v2 pack of full objects, deterministic order
//                                  (sorted by oid), SHA-1 trailer
//   peelTag(repo, oid)           — follow a tag chain to the first non-tag object
//                                  ({ oid, type }); a non-tag object peels to itself
//   collectObjects(repo, wantOids, haveOids, options?)
//                                — the fetch set: objects reachable from `wantOids`
//                                  (commits, trees, blobs, tags — tags peeled to their
//                                  targets) minus the objects reachable from `haveOids`.
//                                  Stops descending at a have that is also in the
//                                  client's shallow boundary (the client holds the commit
//                                  but not its parents, so a deepen must send them).
//                                  options: { depth, deepenRelative, shallow, filter }.
//                                  Returns { objects (sorted by oid), shallow (the new
//                                  boundary commits at depth-1), unshallow (old boundary
//                                  commits that are complete now) }.
//                                  filter: 'blob:none' drops blobs, 'tree:0' drops trees
//                                  and blobs; anything else is ignored.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { objectId, parseCommit, parseTree } from './git-object.ts';
import type { GitObject, ObjectType, Repo } from './store.ts';

/** A git object with its id attached (what parsePack returns, what buildPack takes). */
export interface PackedObject {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

/** A lookup from object id to object; the store's `getObject` is the common case. */
export type ObjectLookup = (oid: string) => GitObject | undefined;

export interface CollectOptions {
  /** Deepen N: include commits within N generations of the wants (depth 1 = tips only). */
  depth?: number;
  /** With `depth`: the depth is relative to the client's current shallow boundary
      (real git's `deepen-relative`: the new boundary is N generations past the old one). */
  deepenRelative?: boolean;
  /** The client's current shallow boundary (commits it holds but whose parents it lacks). */
  shallow?: ReadonlySet<string>;
  /** 'blob:none' drops blobs; 'tree:0' drops trees and blobs; other values are ignored. */
  filter?: string;
}

export interface CollectResult {
  /** The objects to pack, sorted by oid. */
  objects: PackedObject[];
  /** The new shallow boundary: included commits at distance depth-1 from the wants. */
  shallow: string[];
  /** Old boundary commits that are complete after this fetch. */
  unshallow: string[];
}

const TYPE_CODE: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const SHA40 = /^[0-9a-f]{40}$/i;

// ── Tag peeling ───────────────────────────────────────────────────────────────

/** The target oid of a tag object (`object <oid>` is always the first header line). */
function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const newline = text.indexOf('\n');
  const firstLine = newline === -1 ? text : text.slice(0, newline);
  if (!firstLine.startsWith('object ')) return null;
  const oid = firstLine.slice(7).trim().toLowerCase();
  return SHA40.test(oid) ? oid : null;
}

/**
 * Follow a tag chain to the first non-tag object. A non-tag object (or a missing one)
 * peels to itself, with its stored type ('commit' when the object is missing).
 */
export function peelTag(repo: Repo, oid: string): { oid: string; type: ObjectType } {
  let current = oid.toLowerCase();
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return { oid: current, type: 'tag' }; // a tag cycle: stop
    seen.add(current);
    const object = repo.objects.get(current);
    if (object === undefined) return { oid: current, type: 'commit' };
    if (object.type !== 'tag') return { oid: current, type: object.type };
    const target = parseTagTarget(object.data);
    if (target === null) return { oid: current, type: 'tag' };
    current = target;
  }
}

// ── Delta application ─────────────────────────────────────────────────────────

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
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

// ── Pack reading ──────────────────────────────────────────────────────────────

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjectType;
  resolved?: Buffer;
  oid?: string;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and
 * REF_DELTA (a REF_DELTA base may be in the same pack or already in the store via
 * `lookup`). The trailer checksum, every declared size and every delta is verified;
 * a mismatch is an Error, so a corruption cannot be reported as a successful unpack.
 */
export function parsePack(buf: Buffer, lookup: ObjectLookup): PackedObject[] {
  if (buf.length < 32) throw new Error(`pack is ${buf.length} bytes, too short`);
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buf, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buf, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = lookup(wanted);
        if (external === undefined) {
          throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        }
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjectType;
      data = entry.data;
    }
    const oid = objectId(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  const out: PackedObject[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (seen.has(resolved.oid)) continue; // a pack must not list an object twice
    seen.add(resolved.oid);
    out.push({ oid: resolved.oid, type: resolved.type, data: resolved.data });
  }
  return out;
}

// ── Pack writing ──────────────────────────────────────────────────────────────

/** Encode one object's pack header: the type/size varint git's pack format uses. */
function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas). The order is deterministic (sorted
 * by oid) so a replay produces identical bytes. The trailer is SHA-1 over everything
 * before it.
 */
export function buildPack(objects: readonly PackedObject[]): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const deduped: PackedObject[] = [];
  const seen = new Set<string>();
  for (const object of sorted) {
    if (seen.has(object.oid)) continue;
    seen.add(object.oid);
    deduped.push(object);
  }
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(deduped.length, 8);
  parts.push(header);
  for (const object of deduped) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ── Reachability collection ───────────────────────────────────────────────────

/**
 * The fetch set for `wantOids`, minus what `haveOids` already hold.
 *
 * Commit distances are the minimum parent-hop count from any want commit (a want tag
 * peels to its target first). With `depth`, only commits at distance <= depth-1 are
 * included, and the commits at exactly depth-1 are the new shallow boundary. The have
 * closure stops descending at a have that is also in the client's shallow boundary:
 * the client holds that commit but not its parents, so a deepen must send them. A
 * boundary commit reached mid-walk from another have does NOT stop the walk. An old
 * boundary commit is unshallowed exactly when its parents are in this pack (or were
 * already haves) — a pack can legitimately be empty, and then the boundary stays.
 */
export function collectObjects(
  repo: Repo,
  wantOids: readonly string[],
  haveOids: ReadonlySet<string>,
  options: CollectOptions = {},
): CollectResult {
  const depth = options.depth;
  const clientShallow = options.shallow ?? new Set<string>();
  const get = (oid: string): GitObject | undefined => repo.objects.get(oid.toLowerCase());

  // Every tree + blob under a tree (gitlinks skipped: they name a commit the repo
  // does not hold). Missing objects are skipped silently by the final lookup.
  const addTreeClosure = (treeOid: string, into: Set<string>): void => {
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (into.has(oid)) continue;
      const object = get(oid);
      if (object === undefined || object.type !== 'tree') continue;
      into.add(oid);
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        if (entry.mode === '40000') stack.push(entry.oid);
        else into.add(entry.oid);
      }
    }
  };

  // ── Peel the want roots ────────────────────────────────────────────────────
  const tagObjects = new Set<string>();
  const commitRoots: string[] = [];
  const directObjects = new Set<string>();
  for (const rawWant of wantOids) {
    let current = rawWant.toLowerCase();
    for (;;) {
      const object = get(current);
      if (object === undefined || object.type !== 'tag') break;
      tagObjects.add(current);
      const target = parseTagTarget(object.data);
      if (target === null) break;
      current = target;
    }
    const object = get(current);
    if (object === undefined) continue;
    if (object.type === 'commit') commitRoots.push(current);
    else directObjects.add(current);
  }

  // ── Commit distances (BFS from the roots) ───────────────────
  // With a relative deepen the BFS is unlimited: the boundary distances are needed
  // to turn the relative depth into an absolute one. Otherwise the BFS stops at the
  // depth cap (a depth-1 clone never walks the history).
  const bfsLimit = options.deepenRelative === true ? undefined : depth;
  const distance = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const root of commitRoots) {
    if (!distance.has(root)) {
      distance.set(root, 0);
      queue.push([root, 0]);
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    const [oid, d] = queue[index] as [string, number];
    if (bfsLimit !== undefined && d + 1 > bfsLimit - 1) continue;
    const object = get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parsed = parseCommit(object.data);
    if (parsed === null) continue;
    for (const parent of parsed.parents) {
      if (!distance.has(parent)) {
        distance.set(parent, d + 1);
        queue.push([parent, d + 1]);
      }
    }
  }

  // ── Effective depth ────────────────────────────────────────────────────────
  // A relative deepen extends the client's CURRENT depth: the boundary commits sit
  // at distance (currentDepth - 1) from the wants, so the new depth is the deepest
  // boundary distance + 1 + N. (With no measurable boundary, the relative depth
  // behaves like an absolute one.)
  let effectiveDepth = depth;
  if (depth !== undefined && options.deepenRelative === true) {
    let baseline = 0;
    for (const oid of clientShallow) {
      const d = distance.get(oid);
      if (d !== undefined && d + 1 > baseline) baseline = d + 1;
    }
    effectiveDepth = baseline + depth;
  }
  const withinDepth = (d: number): boolean => effectiveDepth === undefined || d <= effectiveDepth - 1;

  // ── Want closure ───────────────────────────────────────────────────────────
  const wantClosure = new Set<string>();
  for (const tag of tagObjects) wantClosure.add(tag);
  for (const oid of directObjects) {
    const object = get(oid);
    if (object === undefined) continue;
    if (object.type === 'tree') addTreeClosure(oid, wantClosure);
    else wantClosure.add(oid);
  }
  for (const [oid, d] of distance) {
    if (!withinDepth(d)) continue;
    wantClosure.add(oid);
    const object = get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parsed = parseCommit(object.data);
    if (parsed !== null) addTreeClosure(parsed.tree, wantClosure);
  }

  // ── Have closure ───────────────────────────────────────────────────────────
  // The walk descends from each have, but stops at a commit that is itself BOTH a
  // have AND in the client's shallow boundary: the client holds that commit but
  // not its parents, so the parents must stay sendable (this is what makes a
  // deepen deliver the parents). A boundary commit reached mid-walk from another
  // have does NOT stop the walk: canonical upload-pack sends an empty pack for
  // the tag fetch after a deepen (want = the boundary commit, have = the tip),
  // not the boundary's parents.
  const haveClosure = new Set<string>();
  const haveSeen = new Set<string>();
  const haveOidSet = new Set([...haveOids].map((oid) => oid.toLowerCase()));
  const haveStack: string[] = [...haveOidSet];
  while (haveStack.length > 0) {
    const oid = haveStack.pop() as string;
    if (haveSeen.has(oid)) continue;
    haveSeen.add(oid);
    const object = get(oid);
    if (object === undefined) continue;
    haveClosure.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      if (parsed !== null) addTreeClosure(parsed.tree, haveClosure);
      if (!(haveOidSet.has(oid) && clientShallow.has(oid)) && parsed !== null) {
        for (const parent of parsed.parents) haveStack.push(parent);
      }
    } else if (object.type === 'tag') {
      const target = parseTagTarget(object.data);
      if (target !== null) haveStack.push(target);
    } else if (object.type === 'tree') {
      addTreeClosure(oid, haveClosure);
    }
  }

  // ── Included = want closure minus have closure, with the filter applied ────
  const filter = options.filter;
  const included: PackedObject[] = [];
  for (const oid of wantClosure) {
    if (haveClosure.has(oid)) continue;
    const object = get(oid);
    if (object === undefined) continue;
    if (filter === 'blob:none' && object.type === 'blob') continue;
    if (filter === 'tree:0' && (object.type === 'tree' || object.type === 'blob')) continue;
    included.push({ oid, type: object.type, data: object.data });
  }
  included.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));

  // ── Shallow boundary + unshallow ───────────────────────────────────────────
  const includedSet = new Set(included.map((object) => object.oid));
  const shallow: string[] = [];
  if (effectiveDepth !== undefined) {
    for (const [oid, d] of distance) {
      if (d === effectiveDepth - 1 && includedSet.has(oid)) shallow.push(oid);
    }
  }
  shallow.sort();
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const d = distance.get(oid);
    if (d === undefined) continue; // not reachable from these wants: still shallow
    // A boundary commit is unshallowed exactly when the client holds its parents
    // after this fetch: every parent is in this pack, or was already a have.
    // (Depth alone does not decide it: a pack can be empty — e.g. the tag fetch
    // after a deepen — and then the boundary must stay shallow.)
    const object = get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parsed = parseCommit(object.data);
    if (parsed === null) continue;
    if (parsed.parents.length === 0) {
      unshallow.push(oid); // a root commit has no parents to fetch: it is complete
      continue;
    }
    const allParentsHeld = parsed.parents.every(
      (parent) => includedSet.has(parent) || haveOidSet.has(parent),
    );
    if (allParentsHeld) unshallow.push(oid);
  }
  unshallow.sort();

  return { objects: included, shallow, unshallow };
}
