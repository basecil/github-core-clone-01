// pulls.ts — pull-request files diff + merge logic, shared by REST v3 (rest.ts) and
// the later GraphQL/MCP slices. The record itself lives in store.ts (createPullRequest
// / getPullRequest); this module only computes over it, never keeps its own state.
//
// Merge (squash is the default, "merge" makes a real two-parent merge commit):
//   * the merge runs against the CURRENT branch tips (a base that advanced since the PR
//     was opened is what GitHub merges against), falling back to the PR's stored shas
//     when a branch is gone.
//   * the tree is a three-way merge at file granularity between the merge-base tree,
//     the base-tip tree and the head-tip tree: a path changed on one side only takes
//     that side; a path changed identically on both takes it; a path changed differently
//     on both (including delete-vs-modify) is a CONFLICT → 405 and nothing changes.
//   * an already-merged PR, or a head tip already reachable from the base tip, is a 405.
//   * the squash commit has a single parent (the base tip); the merge commit has two.
//     The base branch advances to it, and the PR becomes closed/merged with merged_at
//     (logical clock) and merge_commit_sha set.
//
// Files: the diff between the base-tip tree and the head-tip tree, one entry per
// changed path: { filename, status: added|modified|removed, additions, deletions,
// changes }. Line counts come from a small LCS diff (capped: files over 2000 lines
// count whole-file lines as added+deleted rather than diffing).
//
// ── API surface (later slices use these directly) ─────────────────────────────
//   createPullRequestRecord   — re-export of store.createPullRequest (record creation)
//   pullJson(pull, repo, origin) — the REST v3 pull-request shape
//   computePullFiles(repo, pull) — PullFile[] for GET /pulls/{n}/files
//   findMergeBase(repo, a, b)  — nearest common ancestor of two commits (null if none)
//   mergePullRequestRecord(repo, pull, method, {commitTitle?, commitMessage?})
//                              — { ok: true, sha } or { ok: false, status, message }
//   MergeMethod / MergeResult / PullFile — the types above

import {
  authorIdentity,
  repoOwnerLogin,
  tick,
  tickIso,
  touchRepo,
  type PullRequest,
  type Repo,
} from './store.ts';
import {
  commitTreeOid,
  createCommit,
  createTree,
  flattenTree,
  getObject,
  parsedCommit,
  updateTree,
  walkCommits,
} from './git-object.ts';

export { createPullRequest as createPullRequestRecord } from './store.ts';

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export type MergeMethod = 'squash' | 'merge';

export type MergeResult = { ok: true; sha: string } | { ok: false; status: number; message: string };

/** Files over this many lines count whole-file lines instead of running the LCS diff. */
const DIFF_LINE_CAP = 2000;

// ── Small helpers ─────────────────────────────────────────────────────────────

/** The file map of a commit's tree (empty when the commit or its tree is missing). */
function treeFiles(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const treeOid = commitTreeOid(repo, commitOid);
  if (treeOid === undefined) return new Map();
  return flattenTree(repo, treeOid);
}

/** The current tip of a PR side's branch, falling back to the sha stored at creation. */
function sideTip(repo: Repo, side: { ref: string; sha: string }): string {
  return repo.refs.get(`refs/heads/${side.ref}`) ?? side.sha;
}

/** Split blob bytes into lines (a trailing newline does not make an extra empty line). */
function splitLines(data: Buffer | undefined): string[] {
  if (data === undefined || data.length === 0) return [];
  const lines = data.toString('utf8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countLines(data: Buffer | undefined): number {
  return splitLines(data).length;
}

/** Added/deleted line counts between two blobs, via LCS length (two-row DP). */
function diffLines(before: Buffer | undefined, after: Buffer | undefined): { additions: number; deletions: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > DIFF_LINE_CAP || b.length > DIFF_LINE_CAP) {
    return { additions: b.length, deletions: a.length };
  }
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const lcs = prev[b.length] as number;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

// ── Merge base ────────────────────────────────────────────────────────────────

/**
 * The nearest common ancestor of two commits: BFS from `b` until a commit in `a`'s
 * ancestor set is reached. Null when the histories are unrelated.
 */
export function findMergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set(walkCommits(repo, a));
  const seen = new Set<string>();
  const queue: string[] = [b];
  for (let index = 0; index < queue.length; index += 1) {
    const oid = queue[index] as string;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const parsed = parsedCommit(repo, oid);
    if (parsed === null) continue;
    for (const parent of parsed.parents) queue.push(parent);
  }
  return null;
}

// ── Files ─────────────────────────────────────────────────────────────────────

/** The changed files between the base-tip tree and the head-tip tree, sorted by path. */
export function computePullFiles(repo: Repo, pull: PullRequest): PullFile[] {
  const baseMap = treeFiles(repo, sideTip(repo, pull.base));
  const headMap = treeFiles(repo, sideTip(repo, pull.head));
  const files: PullFile[] = [];
  const allPaths = new Set([...baseMap.keys(), ...headMap.keys()]);
  for (const path of [...allPaths].sort()) {
    const base = baseMap.get(path);
    const head = headMap.get(path);
    if (base !== undefined && head !== undefined && base.oid === head.oid && base.mode === head.mode) continue;
    if (base === undefined && head !== undefined) {
      const additions = countLines(getObject(repo, head.oid)?.data);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (base !== undefined && head === undefined) {
      const deletions = countLines(getObject(repo, base.oid)?.data);
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (base !== undefined && head !== undefined) {
      if (base.oid === head.oid) {
        // A mode-only change: modified, with no line changes.
        files.push({ filename: path, status: 'modified', additions: 0, deletions: 0, changes: 0 });
      } else {
        const { additions, deletions } = diffLines(getObject(repo, base.oid)?.data, getObject(repo, head.oid)?.data);
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
  }
  return files;
}

// ── Merge ─────────────────────────────────────────────────────────────────────

/**
 * Merge a pull request. Squash (the default) creates ONE commit on the base branch
 * whose tree is the three-way merge result; "merge" creates a two-parent merge commit
 * with the same tree. On success the base ref advances and the PR is closed/merged.
 * On failure nothing changes and the caller answers the returned status + message.
 */
export function mergePullRequestRecord(
  repo: Repo,
  pull: PullRequest,
  method: MergeMethod,
  options: { commitTitle?: string; commitMessage?: string } = {},
): MergeResult {
  if (pull.state === 'closed') {
    return { ok: false, status: 405, message: 'pull request is already merged' };
  }
  const baseTip = sideTip(repo, pull.base);
  const headTip = sideTip(repo, pull.head);
  const baseObject = getObject(repo, baseTip);
  const headObject = getObject(repo, headTip);
  if (baseObject === undefined || baseObject.type !== 'commit' || headObject === undefined || headObject.type !== 'commit') {
    return { ok: false, status: 405, message: 'the head or base branch tip is missing' };
  }
  if (headTip === baseTip || walkCommits(repo, baseTip).includes(headTip)) {
    return { ok: false, status: 405, message: 'already merged' };
  }

  const mergeBase = findMergeBase(repo, baseTip, headTip);
  const ancestorMap = mergeBase === null ? new Map<string, { oid: string; mode: string }>() : treeFiles(repo, mergeBase);
  const baseMap = treeFiles(repo, baseTip);
  const headMap = treeFiles(repo, headTip);
  const versionOf = (map: Map<string, { oid: string; mode: string }>, path: string): string | null => {
    const entry = map.get(path);
    return entry === undefined ? null : `${entry.oid}:${entry.mode}`;
  };

  // Start from the base tip's tree and apply the head side's changes, one path at a time.
  let resultTree: string | null = commitTreeOid(repo, baseTip) ?? null;
  const allPaths = new Set([...ancestorMap.keys(), ...baseMap.keys(), ...headMap.keys()]);
  for (const path of [...allPaths].sort()) {
    const ancestorVersion = versionOf(ancestorMap, path);
    const baseVersion = versionOf(baseMap, path);
    const headVersion = versionOf(headMap, path);
    if (baseVersion === headVersion) continue; // identical on both sides (or absent on both)
    if (baseVersion === ancestorVersion) {
      // Only the head side changed: take the head version (or remove it, if deleted).
      const head = headMap.get(path);
      resultTree = updateTree(repo, resultTree, path, head === undefined ? null : head.oid, head?.mode);
    } else if (headVersion === ancestorVersion) {
      continue; // only the base side changed: keep the base version (already in the tree)
    } else {
      // Both sides changed the path differently (including delete-vs-modify): conflict.
      return { ok: false, status: 405, message: `merge conflict in ${path}` };
    }
  }

  const identity = authorIdentity();
  const stamp = tick();
  const title =
    options.commitTitle ??
    (method === 'squash' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.head.ref}`);
  const message =
    options.commitMessage !== undefined && options.commitMessage !== '' ? `${title}\n\n${options.commitMessage}` : title;
  const sha = createCommit(repo, {
    tree: resultTree ?? createTree(repo, []),
    parents: method === 'merge' ? [baseTip, headTip] : [baseTip],
    author: { name: identity.name, email: identity.email, timestamp: stamp.unix, tz: '+0000' },
    committer: { name: identity.name, email: identity.email, timestamp: stamp.unix, tz: '+0000' },
    message,
  });
  repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
  touchRepo(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = tickIso();
  pull.merge_commit_sha = sha;
  pull.updated_at = tickIso();
  return { ok: true, sha };
}

// ── Mergeability (pure dry-run, for the GraphQL `mergeable` field) ────────────

/** GitHub's MergeableState enum, as the GraphQL `mergeable` field answers it. */
export type MergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

/**
 * The pull request's mergeability WITHOUT mutating anything: the same three-way
 * file-granularity conflict check the merge runs (base-tip tree vs head-tip tree
 * against the merge-base tree), but it only compares versions and never builds
 * the result tree. A closed pull request, a missing tip, or a head already
 * reachable from the base is UNKNOWN (there is nothing left to merge).
 */
export function mergeableState(repo: Repo, pull: PullRequest): MergeableState {
  if (pull.state === 'closed') return 'UNKNOWN';
  const baseTip = sideTip(repo, pull.base);
  const headTip = sideTip(repo, pull.head);
  const baseObject = getObject(repo, baseTip);
  const headObject = getObject(repo, headTip);
  if (baseObject === undefined || baseObject.type !== 'commit' || headObject === undefined || headObject.type !== 'commit') {
    return 'UNKNOWN';
  }
  if (headTip === baseTip || walkCommits(repo, baseTip).includes(headTip)) return 'UNKNOWN';

  const mergeBase = findMergeBase(repo, baseTip, headTip);
  const ancestorMap = mergeBase === null ? new Map<string, { oid: string; mode: string }>() : treeFiles(repo, mergeBase);
  const baseMap = treeFiles(repo, baseTip);
  const headMap = treeFiles(repo, headTip);
  const versionOf = (map: Map<string, { oid: string; mode: string }>, path: string): string | null => {
    const entry = map.get(path);
    return entry === undefined ? null : `${entry.oid}:${entry.mode}`;
  };
  const allPaths = new Set([...ancestorMap.keys(), ...baseMap.keys(), ...headMap.keys()]);
  for (const path of [...allPaths].sort()) {
    const ancestorVersion = versionOf(ancestorMap, path);
    const baseVersion = versionOf(baseMap, path);
    const headVersion = versionOf(headMap, path);
    if (baseVersion === headVersion) continue;
    if (baseVersion === ancestorVersion) continue; // only the head side changed
    if (headVersion === ancestorVersion) continue; // only the base side changed
    return 'CONFLICTING'; // both sides changed the path differently
  }
  return 'MERGEABLE';
}

// ── Serializer ────────────────────────────────────────────────────────────────

/** The REST v3 pull-request shape (the checks assert number/state/title/body/head/base). */
export function pullJson(pull: PullRequest, repo: Repo, origin: string): Record<string, unknown> {
  const owner = repoOwnerLogin(repo);
  const base = `${origin}/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`;
  const user = { login: pull.userLogin, id: 1, type: 'User', site_admin: false };
  return {
    id: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${owner}:${pull.head.ref}`, user },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${owner}:${pull.base.ref}`, user },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? (pull.merged_at ?? pull.updated_at) : null,
    draft: false,
    locked: false,
    url: base,
    html_url: `${origin}/${owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `${base}.diff`,
    patch_url: `${base}.patch`,
    comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}
