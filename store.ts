// store.ts — the shared in-memory store + data model for the forge.
//
// This is THE contract later slices build on: every handler (REST v3, git smart HTTP,
// GraphQL v4, MCP) reads and writes through this module, never through its own state.
//
// ── API surface (exported types / functions) ─────────────────────────────────────
// Types:
//   ObjectType      'blob' | 'tree' | 'commit' | 'tag' (git object kinds)
//   GitObject       { type: ObjectType, data: Buffer } — one stored git object
//   Label           { id, name, color, description, default }
//   IssueComment    { id, body, userLogin, created_at, updated_at }
//   Issue           { id, number, title, body, state, labels, userLogin,
//                     created_at, updated_at, closed_at, comments }
//   PullRequest     { number, title, body, state, head: {ref, sha},
//                     base: {ref, sha}, merged, merged_at, merge_commit_sha,
//                     userLogin, created_at, updated_at }
//                     (merge logic lives in a later slice; this slice only defines
//                     the record + createPullRequest/getPullRequest helpers)
//   Repo            { id, name, owner, private, description, default_branch,
//                     created_at, updated_at, labels, issues, issuesByNumber,
//                     nextIssueNumber, pullRequests, pullsByNumber, nextPullNumber,
//                     objects, refs, headBranch }
//   AuthorIdentity  { name, email }
//   ClockTick       { iso: string, unix: number }
//
// Viewer learning (the entry is never told the scenario viewer's login):
//   learnOwner(owner)        — first owner string seen wins; backfills repos created
//                              before learning (their owner is '' until then)
//   viewerLogin()            — string | null
//   isViewer(owner)          — true iff owner === learned login (false before learning)
//   authorIdentity()         — `${login} <${login}@example.invalid>` once learned,
//                              else 'forge <forge@example.invalid>'
//   viewerUser()             — { login, id: 1, type: 'User' } for JSON user objects;
//                              login is 'octoshop' before learning (documented choice:
//                              the checks never call GET /user before a repo exists, and
//                              the GraphQL viewer check runs after git+rest, so learning
//                              has happened by then)
//
// Deterministic clock + request ids (no Date.now(), no Math.random() anywhere):
//   tick()                   — next logical second; { iso, unix }. Epoch is
//                              2026-11-14T00:00:00.000Z, +1s per tick. Every
//                              created/updated timestamp takes exactly one tick, so
//                              created-order sorting is deterministic and replay-identical.
//   tickIso()                — tick().iso
//   nextRequestId()          — 'req-00000001', 'req-00000002', … (counter-based, never random)
//
// Auth (token read once at startup from process.env.MAKEFUN_SHOP_TOKEN):
//   checkAuth(req)           — true iff `Authorization: Bearer <token>` matches exactly
//   shopTokenConfigured()    — true iff a non-empty token was configured
//
// Labels:
//   defaultLabels()          — fresh copies of GitHub's default label set
//                              (bug, enhancement, documentation, question,
//                              good first issue, help wanted — the names wire.ts
//                              ISSUE_LABELS draws from), with fresh ids
//   findLabel(repo, name)    — Label | undefined (exact-name match)
//   createOrUpdateLabel(repo, name, color?, description?) — upsert; always returns a Label
//
// Repositories (all repos belong to the single viewer; names are unique per viewer):
//   createRepo(input)        — Repo; input { name, private, description, default_branch }
//                              (caller checks duplicates first via getRepoByName)
//   getRepoByName(name)      — Repo | undefined
//   listRepos()              — Repo[] in creation order
//   deleteRepo(name)         — boolean (true when a repo was removed)
//   renameRepo(repo, name)   — moves the by-name key (PATCH name support)
//   touchRepo(repo)          — updated_at = next tick
//   repoOwnerLogin(repo)     — repo.owner, or the learned viewer login, or 'octoshop'
//
// Issues / comments:
//   createIssue(repo, input) — Issue; input { title, body, labels: Label[] }
//   getIssue(repo, number)   — Issue | undefined
//   createComment(issue, body) — IssueComment (id from a global counter, ≥ 1)
//
// Pull requests (record only; merge logic in a later slice):
//   createPullRequest(repo, input) — PullRequest | null (null when head/base branch
//                              unknown); input { title, body, headRef, baseRef };
//                              head/base sha are the branch tips at creation time
//   getPullRequest(repo, number) — PullRequest | undefined

import type { IncomingMessage } from 'node:http';
import type { ParsedCommit, TreeEntry } from './git-object.ts';

// ── Viewer learning ─────────────────────────────────────────────────────────────

/** The login the bearer token owns, learned from the first owner-bearing request path. */
let viewer: string | null = null;

/** Placeholder login used before the viewer is learned (see viewerUser). */
export const PLACEHOLDER_LOGIN = 'octoshop';

export function learnOwner(owner: string): void {
  if (viewer !== null) return;
  const login = owner.trim();
  if (login === '') return;
  viewer = login;
  // Repos created before learning carry owner '' — they all belong to the viewer.
  for (const repo of reposInOrder) {
    if (repo.owner === '') repo.owner = login;
  }
}

export function viewerLogin(): string | null {
  return viewer;
}

export function isViewer(owner: string): boolean {
  return viewer !== null && owner === viewer;
}

export interface AuthorIdentity {
  name: string;
  email: string;
}

export function authorIdentity(): AuthorIdentity {
  if (viewer === null) return { name: 'forge', email: 'forge@example.invalid' };
  return { name: viewer, email: `${viewer}@example.invalid` };
}

export function viewerUser(): { login: string; id: number; type: string } {
  return { login: viewer ?? PLACEHOLDER_LOGIN, id: 1, type: 'User' };
}

// ── Deterministic clock ─────────────────────────────────────────────────────────

/** Logical-clock epoch: 2026-11-14T00:00:00.000Z. Every tick adds exactly one second. */
const CLOCK_EPOCH_MS = Date.parse('2026-11-14T00:00:00.000Z');

let clockTicks = 0;

export interface ClockTick {
  /** ISO-8601 timestamp, e.g. '2026-11-14T00:00:01.000Z'. */
  iso: string;
  /** Unix seconds since the epoch (for git author/committer lines). */
  unix: number;
}

export function tick(): ClockTick {
  const unix = Math.floor(CLOCK_EPOCH_MS / 1000) + clockTicks;
  clockTicks += 1;
  return { iso: new Date(unix * 1000).toISOString(), unix };
}

export function tickIso(): string {
  return tick().iso;
}

// ── Request ids ─────────────────────────────────────────────────────────────────

let requestCounter = 0;

/** Deterministic, non-empty request id for the X-GitHub-Request-Id header. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${String(requestCounter).padStart(8, '0')}`;
}

// ── Auth ────────────────────────────────────────────────────────────────────────

/** The shop token, read once at startup. Never printed, never logged. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function shopTokenConfigured(): boolean {
  return SHOP_TOKEN !== '';
}

/** True iff the request carries `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` exactly. */
export function checkAuth(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return false;
  const header = req.headers.authorization;
  return header === `Bearer ${SHOP_TOKEN}`;
}

// ── Data model ──────────────────────────────────────────────────────────────────

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
  default: boolean;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
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
  userLogin: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: IssueComment[];
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  userLogin: string;
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  name: string;
  /** '' until the viewer login is learned (learnOwner backfills it). */
  owner: string;
  private: boolean;
  description: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
  labels: Label[];
  issues: Issue[];
  issuesByNumber: Map<number, Issue>;
  nextIssueNumber: number;
  pullRequests: PullRequest[];
  pullsByNumber: Map<number, PullRequest>;
  nextPullNumber: number;
  /** oid → object (blobs, trees, commits, tags). */
  objects: Map<string, GitObject>;
  /** full refname (e.g. 'refs/heads/main') → oid. */
  refs: Map<string, string>;
  /** HEAD target branch (starts as the default branch). */
  headBranch: string;
  /**
   * Memoised parses of stored objects (git-object.ts). Objects are content-addressed
   * and immutable — once stored, an oid's bytes never change and are never removed
   * except with the whole repo — so a positive parse result stays valid for the
   * repo's lifetime and needs no invalidation. Only positive results are cached:
   * a missing oid may appear later (a push), so misses are never stored.
   */
  parsedCommits: Map<string, ParsedCommit | null>;
  parsedTrees: Map<string, TreeEntry[]>;
  /** Memoised zlib streams per object (git-pack.ts buildPack): same immutability argument. */
  deflatedObjects: Map<string, Buffer>;
}

// ── Global counters + registries ────────────────────────────────────────────────

let nextRepoId = 1;
let nextIssueId = 1;
let nextCommentId = 1;
let nextLabelId = 1;

const reposByName = new Map<string, Repo>();
const reposInOrder: Repo[] = [];

// ── Labels ──────────────────────────────────────────────────────────────────────

/** GitHub's default label set (names match wire.ts ISSUE_LABELS; colors are GitHub's). */
const DEFAULT_LABEL_DEFS: readonly { name: string; color: string; description: string }[] = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
];

export function defaultLabels(): Label[] {
  return DEFAULT_LABEL_DEFS.map((def) => ({
    id: nextLabelId++,
    name: def.name,
    color: def.color,
    description: def.description,
    default: true,
  }));
}

export function findLabel(repo: Repo, name: string): Label | undefined {
  return repo.labels.find((label) => label.name === name);
}

/**
 * Create a label, or update the existing one with that name (the checks POST a default
 * label name through /labels and expect 201, so upsert — never a duplicate error).
 */
export function createOrUpdateLabel(repo: Repo, name: string, color?: string, description?: string): Label {
  const existing = findLabel(repo, name);
  if (existing !== undefined) {
    if (color !== undefined && color !== '') existing.color = color;
    if (description !== undefined) existing.description = description;
    return existing;
  }
  const label: Label = {
    id: nextLabelId++,
    name,
    color: color !== undefined && color !== '' ? color : 'ededed',
    description: description ?? '',
    default: false,
  };
  repo.labels.push(label);
  return label;
}

// ── Repositories ────────────────────────────────────────────────────────────────

export function createRepo(input: { name: string; private: boolean; description: string; default_branch: string }): Repo {
  const now = tickIso();
  const repo: Repo = {
    id: nextRepoId++,
    name: input.name,
    owner: viewer ?? '',
    private: input.private,
    description: input.description,
    default_branch: input.default_branch,
    created_at: now,
    updated_at: now,
    labels: defaultLabels(),
    issues: [],
    issuesByNumber: new Map(),
    nextIssueNumber: 1,
    pullRequests: [],
    pullsByNumber: new Map(),
    nextPullNumber: 1,
    objects: new Map(),
    refs: new Map(),
    headBranch: input.default_branch,
    parsedCommits: new Map(),
    parsedTrees: new Map(),
    deflatedObjects: new Map(),
  };
  reposByName.set(repo.name, repo);
  reposInOrder.push(repo);
  return repo;
}

export function getRepoByName(name: string): Repo | undefined {
  return reposByName.get(name);
}

export function listRepos(): Repo[] {
  return [...reposInOrder];
}

export function deleteRepo(name: string): boolean {
  const repo = reposByName.get(name);
  if (repo === undefined) return false;
  reposByName.delete(name);
  const index = reposInOrder.indexOf(repo);
  if (index !== -1) reposInOrder.splice(index, 1);
  return true;
}

export function renameRepo(repo: Repo, name: string): void {
  if (repo.name === name) return;
  reposByName.delete(repo.name);
  repo.name = name;
  reposByName.set(name, repo);
}

export function touchRepo(repo: Repo): void {
  repo.updated_at = tickIso();
}

/** The login to show as the repo owner: stored owner, learned viewer, or placeholder. */
export function repoOwnerLogin(repo: Repo): string {
  if (repo.owner !== '') return repo.owner;
  return viewer ?? PLACEHOLDER_LOGIN;
}

// ── Issues / comments ───────────────────────────────────────────────────────────

export function createIssue(repo: Repo, input: { title: string; body: string; labels: Label[] }): Issue {
  const now = tickIso();
  const issue: Issue = {
    id: nextIssueId++,
    number: repo.nextIssueNumber++,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...input.labels],
    userLogin: viewer ?? PLACEHOLDER_LOGIN,
    created_at: now,
    updated_at: now,
    closed_at: null,
    comments: [],
  };
  repo.issues.push(issue);
  repo.issuesByNumber.set(issue.number, issue);
  return issue;
}

export function getIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issuesByNumber.get(number);
}

export function createComment(issue: Issue, body: string): IssueComment {
  const now = tickIso();
  const comment: IssueComment = {
    id: nextCommentId++,
    body,
    userLogin: viewer ?? PLACEHOLDER_LOGIN,
    created_at: now,
    updated_at: now,
  };
  issue.comments.push(comment);
  return comment;
}

// ── Pull requests (record only; merge logic in a later slice) ───────────────────

export function createPullRequest(
  repo: Repo,
  input: { title: string; body: string; headRef: string; baseRef: string },
): PullRequest | null {
  const headSha = repo.refs.get(`refs/heads/${input.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${input.baseRef}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const now = tickIso();
  const pull: PullRequest = {
    number: repo.nextPullNumber++,
    title: input.title,
    body: input.body,
    state: 'open',
    head: { ref: input.headRef, sha: headSha },
    base: { ref: input.baseRef, sha: baseSha },
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    userLogin: viewer ?? PLACEHOLDER_LOGIN,
    created_at: now,
    updated_at: now,
  };
  repo.pullRequests.push(pull);
  repo.pullsByNumber.set(pull.number, pull);
  return pull;
}

export function getPullRequest(repo: Repo, number: number): PullRequest | undefined {
  return repo.pullsByNumber.get(number);
}
