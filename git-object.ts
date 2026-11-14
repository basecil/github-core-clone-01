// git-object.ts — minimal pure git object layer (no pack files, no smart HTTP here;
// later slices build the pack/smart-HTTP server on top of these primitives).
//
// Object ids are SHA-1 over the canonical git framing: `<type> <len>\0<data>`.
// All objects live in Repo.objects (see store.ts); nothing here touches the disk,
// the network, or a git binary.
//
// ── API surface ────────────────────────────────────────────────────────────────
//   objectId(type, data)                 — SHA-1 hex id of a framed object (pure)
//   putObject(repo, type, data)          — store (idempotent) and return the oid
//   getObject(repo, oid)                 — GitObject | undefined
//   createBlob(repo, data)               — blob oid for Buffer | string data
//   createTree(repo, entries)            — tree oid; entries sorted in git order
//   parseTree(data)                      — TreeEntry[] { mode, name, oid }
//   createCommit(repo, {tree, parents, author, committer, message, timestamp})
//                                        — commit oid; message stored verbatim
//   parseCommit(data)                    — ParsedCommit { tree, parents, author,
//                                          committer, message }
//   treeEntries(repo, treeOid)           — direct entries of a tree ([] when missing)
//   getTreeEntry(repo, treeOid, path)    — { oid, mode } for a file path, or undefined
//   getTreeAtPath(repo, treeOid, path)   — subtree oid for a directory path
//                                          ('' = the tree itself), or undefined
//   updateTree(repo, baseTreeOid|null, path, oid|null, mode?)
//                                        — new tree oid with one path added/updated
//                                          (oid) or removed (null); prunes empty dirs
//   flattenTree(repo, treeOid)           — Map<path, { oid, mode }> for all files
//   walkCommits(repo, tipOid)            — reachable commit oids, newest-first
//                                          (by commit timestamp, then discovery order)
//   resolveRef(repo, ref)                — branch name, full refname, or raw commit
//                                          oid → commit oid, or undefined
//   commitTreeOid(repo, commitOid)       — the tree oid of a commit, or undefined
//   commitAuthorOf(repo, commitOid)      — { name, email, date } for REST responses

import { createHash } from 'node:crypto';
import type { GitObject, ObjectType, Repo } from './store.ts';

export interface TreeEntry {
  /** '100644' | '100755' | '120000' | '40000' (git omits the leading zero on dirs). */
  mode: string;
  name: string;
  oid: string;
}

export interface CommitIdentity {
  name: string;
  email: string;
  /** Unix seconds. */
  timestamp: number;
  /** Timezone offset as written, e.g. '+0000'. */
  tz: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: CommitIdentity;
  committer: CommitIdentity;
  /** The commit message, verbatim (no trailing-newline normalisation). */
  message: string;
}

const SHA40 = /^[0-9a-f]{40}$/i;

/** SHA-1 hex id of a git object: sha1(`<type> <len>\0<data>`). */
export function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object (idempotent — same bytes, same oid) and return its oid. */
export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid.toLowerCase());
}

export function createBlob(repo: Repo, data: Buffer | string): string {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return putObject(repo, 'blob', bytes);
}

/** Git's tree-entry order: names compared with directories as if suffixed by '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function createTree(repo: Repo, entries: readonly TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return putObject(repo, 'tree', Buffer.concat(parts));
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    if (space === -1 || nul === -1 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function identityLine(role: string, identity: CommitIdentity): string {
  return `${role} ${identity.name} <${identity.email}> ${identity.timestamp} ${identity.tz}`;
}

export function createCommit(
  repo: Repo,
  input: {
    tree: string;
    parents: readonly string[];
    author: CommitIdentity;
    committer: CommitIdentity;
    message: string;
  },
): string {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(identityLine('author', input.author));
  lines.push(identityLine('committer', input.committer));
  // The message is stored verbatim: REST round-trips compare it exactly, and a
  // well-formed commit does not require a trailing newline.
  const body = `${lines.join('\n')}\n\n${input.message}`;
  return putObject(repo, 'commit', Buffer.from(body, 'utf8'));
}

function parseIdentity(line: string): CommitIdentity | null {
  const match = /^([^<]*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (match === null) return null;
  return { name: (match[1] ?? '').trim(), email: match[2] ?? '', timestamp: Number(match[3]), tz: match[4] ?? '+0000' };
}

export function parseCommit(data: Buffer): ParsedCommit | null {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author: CommitIdentity | null = null;
  let committer: CommitIdentity | null = null;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parseIdentity(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseIdentity(line.slice(10));
  }
  if (tree === '' || author === null || committer === null) return null;
  return { tree, parents, author, committer, message };
}

/** Direct entries of a tree (empty when the oid is missing or not a tree). */
export function treeEntries(repo: Repo, treeOid: string): TreeEntry[] {
  const object = getObject(repo, treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data);
}

/** The file entry at `path` under a tree, or undefined (missing path, or a directory). */
export function getTreeEntry(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | undefined {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return undefined;
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const entries = treeEntries(repo, current);
    const found = entries.find((entry) => entry.name === segments[i]);
    if (found === undefined) return undefined;
    if (i === segments.length - 1) {
      if (found.mode === '40000') return undefined;
      return { oid: found.oid, mode: found.mode };
    }
    if (found.mode !== '40000') return undefined;
    current = found.oid;
  }
  return undefined;
}

/** The subtree oid for a directory path ('' returns the tree itself), or undefined. */
export function getTreeAtPath(repo: Repo, treeOid: string, path: string): string | undefined {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (const segment of segments) {
    const found = treeEntries(repo, current).find((entry) => entry.name === segment);
    if (found === undefined || found.mode !== '40000') return undefined;
    current = found.oid;
  }
  return current;
}

/**
 * A new tree with one path added/updated (oid) or removed (null). `baseTreeOid` may be
 * null for an empty tree (an unborn repository). Intermediate directories are created
 * as needed; directories left empty by a removal are pruned (git stores no empty dirs).
 */
export function updateTree(
  repo: Repo,
  baseTreeOid: string | null,
  path: string,
  oid: string | null,
  mode = '100644',
): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) throw new Error('updateTree: empty path');
  const build = (treeOid: string | null, depth: number): string | null => {
    const entries = treeOid === null ? [] : treeEntries(repo, treeOid);
    const name = segments[depth] as string;
    const last = depth === segments.length - 1;
    const next = entries.filter((entry) => entry.name !== name);
    if (last) {
      if (oid !== null) next.push({ mode, name, oid });
    } else {
      const existing = entries.find((entry) => entry.name === name);
      const childOid = build(existing !== undefined && existing.mode === '40000' ? existing.oid : null, depth + 1);
      if (childOid !== null) next.push({ mode: '40000', name, oid: childOid });
    }
    if (next.length === 0) return null;
    return createTree(repo, next);
  };
  // A removal that empties the root still needs a (real, empty) tree object.
  return build(baseTreeOid, 0) ?? createTree(repo, []);
}

/** Every file under a tree: path → { oid, mode } (directories are not listed). */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    for (const entry of treeEntries(repo, oid)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/**
 * All commits reachable from `tipOid`, newest-first: collected with a visited set
 * (first-parent and merge parents alike), then ordered by commit timestamp descending
 * with discovery order as the tie-break. Deterministic for a given history.
 */
export function walkCommits(repo: Repo, tipOid: string): string[] {
  const discovered: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tipOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = getObject(repo, oid);
    if (object === undefined || object.type !== 'commit') continue;
    discovered.push(oid);
    const parsed = parseCommit(object.data);
    if (parsed === null) continue;
    // Push in reverse so the first parent is visited first.
    for (let i = parsed.parents.length - 1; i >= 0; i -= 1) stack.push(parsed.parents[i] as string);
  }
  const stamp = new Map<string, number>();
  for (const oid of discovered) {
    const object = getObject(repo, oid);
    const parsed = object === undefined ? null : parseCommit(object.data);
    stamp.set(oid, parsed?.committer.timestamp ?? 0);
  }
  const order = new Map(discovered.map((oid, index) => [oid, index]));
  return [...discovered].sort((a, b) => {
    const diff = (stamp.get(b) ?? 0) - (stamp.get(a) ?? 0);
    return diff !== 0 ? diff : (order.get(a) ?? 0) - (order.get(b) ?? 0);
  });
}

/**
 * Resolve a branch name ('main'), a full refname ('refs/heads/main'), or a raw
 * 40-hex commit oid to a commit oid. Returns undefined when nothing matches.
 */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const headed = repo.refs.get(`refs/heads/${ref}`);
  if (headed !== undefined) return headed;
  if (SHA40.test(ref)) {
    const object = getObject(repo, ref);
    if (object !== undefined && object.type === 'commit') return ref.toLowerCase();
  }
  return undefined;
}

/** The tree oid of a commit, or undefined when the oid is not a commit. */
export function commitTreeOid(repo: Repo, commitOid: string): string | undefined {
  const object = getObject(repo, commitOid);
  if (object === undefined || object.type !== 'commit') return undefined;
  return parseCommit(object.data)?.tree;
}

/** Author { name, email, date } of a commit for REST responses, or undefined. */
export function commitAuthorOf(repo: Repo, commitOid: string): { name: string; email: string; date: string } | undefined {
  const object = getObject(repo, commitOid);
  if (object === undefined || object.type !== 'commit') return undefined;
  const parsed = parseCommit(object.data);
  if (parsed === null) return undefined;
  return {
    name: parsed.author.name,
    email: parsed.author.email,
    date: new Date(parsed.author.timestamp * 1000).toISOString(),
  };
}
