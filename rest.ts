// rest.ts — the GitHub REST v3 handlers + JSON/error/pagination helpers.
//
// The spec is the kit's checks (program/env/src/checks-rest.ts + rest-client.ts):
// every status, shape and header below exists because a check asserts it.
//
// ── Routes (all under /api/v3, all authenticated except none — /healthz lives in app.ts) ──
//   GET    /                          200 + X-Oauth-Scopes: repo, read:org
//   GET    /meta                      200 {"installed_version": string}
//   GET    /user                      200 the viewer (learned login, else 'octoshop')
//   POST   /user/repos                201; missing name → 422; duplicate → 422 'already exists'
//   GET    /user/repos                paginated, Link rel="next"/"last" on the entry's origin
//   GET    /repos/{o}/{r}             200; other owner or unknown repo → 404
//   PATCH  /repos/{o}/{r}             200 (description / private / default_branch / name)
//   DELETE /repos/{o}/{r}             204
//   GET    /repos/{o}/{r}/branches    200 [{name, commit:{sha}}] from refs/heads/*
//   POST   /repos/{o}/{r}/git/refs    201 {ref, object:{sha}}; unknown sha / duplicate → 422
//   GET    /repos/{o}/{r}/commits[?sha=<branch>]  200 newest-first
//   GET    /repos/{o}/{r}/contents[/{path}][?ref=]  file object or directory array
//   PUT    /repos/{o}/{r}/contents/{path}  201 create / 200 update / 409 stale sha
//   DELETE /repos/{o}/{r}/contents/{path}  200 {commit:{sha}} / 409 stale sha
//   POST   /repos/{o}/{r}/labels      201 (upsert — a default label name still answers 201)
//   GET    /repos/{o}/{r}/labels      200 list
//   POST   /repos/{o}/{r}/issues      201; unknown label → 422
//   GET    /repos/{o}/{r}/issues[?state=&sort=created&direction=]  paginated
//   GET    /repos/{o}/{r}/issues/{n}  200 / 404
//   PATCH  /repos/{o}/{r}/issues/{n}  200 (state / title / body / labels)
//   POST   /repos/{o}/{r}/issues/{n}/comments  201 {id, body}
//   GET    /repos/{o}/{r}/issues/{n}/comments  200 list
//   POST   /repos/{o}/{r}/pulls                201; unknown head/base branch → 422
//   GET    /repos/{o}/{r}/pulls[?state=]       paginated (default state=open)
//   GET    /repos/{o}/{r}/pulls/{n}            200 / 404
//   GET    /repos/{o}/{r}/pulls/{n}/files      200 [{filename, status, additions,
//                                              deletions, changes}]
//   PUT    /repos/{o}/{r}/pulls/{n}/merge      200 {merged:true, sha, message};
//                                              conflict / already merged → 405
//
// ── Protocol discipline ────────────────────────────────────────────────────────
//   * Every reply is application/json (never HTML), including errors.
//   * Every reply carries a non-empty X-GitHub-Request-Id (deterministic counter).
//   * 401/404/422 bodies carry a string `message`.
//   * Malformed JSON body → 400 {"message": ...}.
//   * Unknown route or wrong method → 404 {"message": "Not Found"} (GitHub's answer).
//   * Missing/wrong token → 401 on every route here (GET /healthz is app.ts's, unauthenticated).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authorIdentity,
  checkAuth,
  createComment,
  createIssue,
  createOrUpdateLabel,
  createPullRequest,
  createRepo,
  deleteRepo,
  findLabel,
  getCachedIssueJson,
  getIssue,
  getPullRequest,
  getRepoByName,
  invalidateIssueJson,
  isViewer,
  learnOwner,
  listRepos,
  nextRequestId,
  PLACEHOLDER_LOGIN,
  renameRepo,
  repoOwnerLogin,
  setCachedIssueJson,
  tick,
  tickIso,
  touchRepo,
  viewerLogin,
  viewerUser,
  type Issue,
  type IssueComment,
  type Label,
  type Repo,
} from './store.ts';
import {
  commitAuthorOf,
  commitTreeOid,
  createBlob,
  createCommit,
  getObject,
  getTreeAtPath,
  getTreeEntry,
  parsedCommit,
  resolveRef,
  treeEntries,
  updateTree,
  walkCommits,
} from './git-object.ts';
import { computePullFiles, mergePullRequestRecord, pullJson } from './pulls.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const SHA40 = /^[0-9a-f]{40}$/i;

type JsonObject = Record<string, unknown>;

// ── Response helpers (shared with app.ts) ─────────────────────────────────────

/** Answer with a JSON body; always sets Content-Type and X-GitHub-Request-Id. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/**
 * Answer with a pre-built JSON body (perf round 2): `text` already carries the
 * trailing '\n' sendJson appends. `length` is the body's byte length when the
 * caller knows it (the issue cache precomputes it); otherwise it is measured.
 * Byte-identical to sendJson for the same logical body.
 */
export function sendPrebuiltJson(
  res: ServerResponse,
  status: number,
  text: string,
  headers: Readonly<Record<string, string>> = {},
  length?: number,
): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': length ?? Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/**
 * Answer with a pre-built JSON body held as a Buffer (perf round 3): identical
 * bytes to sendPrebuiltJson for the same body, but no per-response UTF-8
 * encode — res.end(Buffer) sends the bytes as-is. The body must already carry
 * the trailing '\n' sendJson appends.
 */
export function sendPrebuiltBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  headers: Readonly<Record<string, string>> = {},
  length?: number,
): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': length ?? body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

/** Answer with no body (204); still carries X-GitHub-Request-Id. */
export function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...headers });
  res.end();
}

/** An error body: always {"message": string}. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** The standard JSON 404, also used by app.ts for unmounted prefixes. */
export function sendNotFound(res: ServerResponse): void {
  sendError(res, 404, 'Not Found');
}

// ── Request plumbing ──────────────────────────────────────────────────────────

/** The request's own origin (scheme + Host header) for absolute Link/URL fields. */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/**
 * What the handlers need from a request URL: the path and the query. `new URL`
 * costs ~6 µs a call and every request pays for it twice (app.ts routes on the
 * path, then the handler parses again), so the common case — a plain ASCII path
 * with an ordinary query — is split by hand, and anything unusual falls back to
 * `new URL`, which stays the definition of the answer. The fast path runs only
 * when its result is provably identical to `new URL`'s:
 *   * only characters the URL parser leaves untouched in a path/query (no space,
 *     controls, `"<>`, backtick, `{|}^`, backslash, or non-ASCII);
 *   * starts with a single `/` (a leading `//` would read a host, a scheme
 *     would make it absolute-form, a relative target would resolve oddly —
 *     the leading-slash requirement excludes all three at once);
 *   * no dot segments (`/./`, `/../`, trailing `/.` or `/..`) and no `%2e`
 *     (the URL parser normalises both away — `%2e` counts as a dot).
 */
export interface ParsedRequestUrl {
  pathname: string;
  searchParams: URLSearchParams;
}

const FAST_URL_CHARS = /^[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%[\]]+$/;

export function parseRequestUrl(req: IncomingMessage): ParsedRequestUrl {
  const raw = req.url ?? '/';
  if (
    raw.startsWith('/') &&
    !raw.startsWith('//') &&
    FAST_URL_CHARS.test(raw) &&
    !raw.includes('%2e') &&
    !raw.includes('%2E')
  ) {
    let end = raw.length;
    let query = '';
    const q = raw.indexOf('?');
    const h = raw.indexOf('#');
    const cut = q === -1 ? h : h === -1 ? q : Math.min(q, h);
    if (cut !== -1) {
      end = cut;
      if (raw[cut] === '?') {
        const hashAfter = raw.indexOf('#', cut);
        query = hashAfter === -1 ? raw.slice(cut + 1) : raw.slice(cut + 1, hashAfter);
      }
    }
    const pathname = end === 0 ? '/' : raw.slice(0, end);
    if (
      !pathname.includes('/./') &&
      !pathname.includes('/../') &&
      !pathname.endsWith('/.') &&
      !pathname.endsWith('/..')
    ) {
      // searchParams is built lazily: most requests (every bench read/write) never
      // touch the query, so constructing URLSearchParams up front is pure waste.
      // The getter memoises, so repeated access returns the same instance.
      let params: URLSearchParams | null = null;
      return {
        pathname,
        get searchParams(): URLSearchParams {
          if (params === null) params = new URLSearchParams(query);
          return params;
        },
      };
    }
  }
  try {
    const url = new URL(raw, 'http://entry');
    return { pathname: url.pathname, searchParams: url.searchParams };
  } catch {
    return { pathname: '/', searchParams: new URLSearchParams() };
  }
}

/**
 * Path segments, percent-decoded, empty segments dropped (trailing slashes
 * tolerated). A hand-rolled scan: the old split/filter/map allocated three
 * arrays per request and decoded every segment even without a `%` (a segment
 * with no `%` decodes to itself).
 */
export function splitSegments(pathname: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= pathname.length; i += 1) {
    if (i === pathname.length || pathname.charCodeAt(i) === 47 /* '/' */) {
      if (i > start) {
        const segment = pathname.slice(start, i);
        if (segment.includes('%')) {
          try {
            out.push(decodeURIComponent(segment));
          } catch {
            out.push(segment);
          }
        } else {
          out.push(segment);
        }
      }
      start = i + 1;
    }
  }
  return out;
}

class MalformedBodyError extends Error {}

/** Read the request body (≤10 MB) and parse it as JSON; {} when empty. */
async function readJsonBody(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new MalformedBodyError('request body too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MalformedBodyError('Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  return parsed as JsonObject;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// ── Pagination ────────────────────────────────────────────────────────────────

interface PageParams {
  perPage: number;
  page: number;
}

function pageParams(url: ParsedRequestUrl, defaultPerPage = 30): PageParams {
  const rawPerPage = Number.parseInt(url.searchParams.get('per_page') ?? '', 10);
  const rawPage = Number.parseInt(url.searchParams.get('page') ?? '', 10);
  const perPage = Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, rawPerPage)) : defaultPerPage;
  const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], params: PageParams): { page: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / params.perPage));
  const start = (params.page - 1) * params.perPage;
  return { page: items.slice(start, start + params.perPage), totalPages };
}

/**
 * GitHub's Link header with ABSOLUTE urls on the entry's own origin, preserving the
 * request's query parameters (per_page/page are set to the target page). Null when
 * there is a single page. The client follows rel="next" only on the same origin.
 */
function linkHeader(req: IncomingMessage, url: ParsedRequestUrl, params: PageParams, totalPages: number): string | null {
  if (totalPages <= 1) return null;
  const origin = originOf(req);
  const make = (page: number): string => {
    const query = new URLSearchParams(url.searchParams);
    query.set('per_page', String(params.perPage));
    query.set('page', String(page));
    return `${origin}${url.pathname}?${query.toString()}`;
  };
  const parts: string[] = [];
  if (params.page < totalPages) parts.push(`<${make(params.page + 1)}>; rel="next"`);
  if (params.page > 1) parts.push(`<${make(params.page - 1)}>; rel="prev"`);
  parts.push(`<${make(1)}>; rel="first"`);
  parts.push(`<${make(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

// ── Serializers ───────────────────────────────────────────────────────────────

function userJson(login: string): JsonObject {
  return { login, id: 1, type: 'User', site_admin: false };
}

function repoJson(repo: Repo, origin: string): JsonObject {
  const owner = repoOwnerLogin(repo);
  const base = `${origin}/api/v3/repos/${owner}/${repo.name}`;
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: userJson(owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    default_branch: repo.default_branch,
    visibility: repo.private ? 'private' : 'public',
    html_url: `${origin}/${owner}/${repo.name}`,
    url: base,
    clone_url: `${origin}/${owner}/${repo.name}.git`,
    git_url: `${origin}/${owner}/${repo.name}.git`,
    ssh_url: `git@forge.invalid:${owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    license: null,
    topics: [],
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
    size: 0,
  };
}

function labelJson(label: Label, repo: Repo, origin: string): JsonObject {
  const owner = repoOwnerLogin(repo);
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    default: label.default,
    url: `${origin}/api/v3/repos/${owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
  };
}

function issueJson(issue: Issue, repo: Repo, origin: string): JsonObject {
  const owner = repoOwnerLogin(repo);
  const base = `${origin}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => labelJson(label, repo, origin)),
    user: userJson(issue.userLogin),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
    url: base,
    html_url: `${origin}/${owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `${base}/comments`,
  };
}

/**
 * Answer a single-issue GET/CREATE/PATCH with the issue's cached REST body
 * (perf round 2): a cache hit sends the pre-built Buffer with no object build,
 * no stringify and no UTF-8 encode; a miss builds, caches and sends exactly
 * what sendJson would have. The cache is validated on (origin, owner, repo
 * name) at read time and invalidated at every issue-mutation site, so a hit
 * is always the body a fresh build would produce.
 */
function sendIssueJson(res: ServerResponse, status: number, issue: Issue, repo: Repo, origin: string): void {
  const owner = repoOwnerLogin(repo);
  const cached = getCachedIssueJson(repo, issue.number, origin, owner, repo.name);
  if (cached !== undefined) {
    sendPrebuiltBuffer(res, status, cached.body, {}, cached.length);
    return;
  }
  const text = `${JSON.stringify(issueJson(issue, repo, origin))}\n`;
  const entry = setCachedIssueJson(repo, issue.number, origin, owner, repo.name, text);
  sendPrebuiltBuffer(res, status, entry.body, {}, entry.length);
}

/**
 * One issue's REST JSON as a string, without the trailing newline (perf round
 * 2): the list endpoints join these with ',' inside '[' ']' — byte-identical
 * to JSON.stringify of the array of issue objects (no spaces either way).
 */
function issueJsonText(issue: Issue, repo: Repo, origin: string): string {
  const owner = repoOwnerLogin(repo);
  const cached = getCachedIssueJson(repo, issue.number, origin, owner, repo.name);
  if (cached !== undefined) return cached.text.slice(0, -1);
  const text = `${JSON.stringify(issueJson(issue, repo, origin))}\n`;
  setCachedIssueJson(repo, issue.number, origin, owner, repo.name, text);
  return text.slice(0, -1);
}

function commentJson(comment: IssueComment, repo: Repo, issueNumber: number, origin: string): JsonObject {
  const owner = repoOwnerLogin(repo);
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    author_association: 'OWNER',
    url: `${origin}/api/v3/repos/${owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
    html_url: `${origin}/${owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

function commitJson(repo: Repo, oid: string, origin: string): JsonObject | null {
  const parsed = parsedCommit(repo, oid);
  if (parsed === null) return null;
  const owner = repoOwnerLogin(repo);
  const author = {
    name: parsed.author.name,
    email: parsed.author.email,
    date: new Date(parsed.author.timestamp * 1000).toISOString(),
  };
  const committer = {
    name: parsed.committer.name,
    email: parsed.committer.email,
    date: new Date(parsed.committer.timestamp * 1000).toISOString(),
  };
  return {
    sha: oid,
    commit: { message: parsed.message, author, committer, tree: { sha: parsed.tree } },
    author: userJson(parsed.author.name),
    committer: userJson(parsed.committer.name),
    parents: parsed.parents.map((sha) => ({ sha })),
    url: `${origin}/api/v3/repos/${owner}/${repo.name}/commits/${oid}`,
    html_url: `${origin}/${owner}/${repo.name}/commit/${oid}`,
  };
}

// ── Git helpers for the contents API ──────────────────────────────────────────

/** The tip commit oid of a branch (undefined when the branch has no ref yet). */
function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/**
 * Commit a one-file change (add/update with `blobOid`, remove with null) on `branch`,
 * advancing the branch ref. Returns the new commit oid. The author/committer are the
 * viewer (or the forge fallback before learning); the timestamp takes one logical tick.
 */
function commitFileChange(
  repo: Repo,
  input: { branch: string; path: string; blobOid: string | null; message: string },
): string {
  const tip = branchTip(repo, input.branch);
  const baseTree = tip === undefined ? null : (commitTreeOid(repo, tip) ?? null);
  const tree = updateTree(repo, baseTree, input.path, input.blobOid);
  const identity = authorIdentity();
  const stamp = tick();
  const commit = createCommit(repo, {
    tree,
    parents: tip === undefined ? [] : [tip],
    author: { name: identity.name, email: identity.email, timestamp: stamp.unix, tz: '+0000' },
    committer: { name: identity.name, email: identity.email, timestamp: stamp.unix, tz: '+0000' },
    message: input.message,
  });
  repo.refs.set(`refs/heads/${input.branch}`, commit);
  touchRepo(repo);
  return commit;
}

/** Resolve the ?ref= query (branch, full ref, or commit oid) to a commit oid. */
function resolveContentsRef(repo: Repo, url: ParsedRequestUrl): string | undefined {
  const ref = url.searchParams.get('ref');
  if (ref === null || ref === '') return branchTip(repo, repo.default_branch);
  return resolveRef(repo, ref);
}

function fileEntryJson(
  repo: Repo,
  path: string,
  blobOid: string,
  origin: string,
  includeContent: boolean,
): JsonObject | null {
  const object = getObject(repo, blobOid);
  if (object === undefined || object.type !== 'blob') return null;
  const owner = repoOwnerLogin(repo);
  const name = path.split('/').pop() ?? path;
  const entry: JsonObject = {
    type: 'file',
    name,
    path,
    sha: blobOid,
    size: object.data.length,
    url: `${origin}/api/v3/repos/${owner}/${repo.name}/contents/${path}`,
    html_url: `${origin}/${owner}/${repo.name}/blob/HEAD/${path}`,
    git_url: `${origin}/api/v3/repos/${owner}/${repo.name}/git/blobs/${blobOid}`,
    download_url: null,
  };
  if (includeContent) {
    // Plain base64, no 60-column wrapping: the client strips whitespace anyway, and
    // unwrapped base64 is the safest decode target.
    entry.content = object.data.toString('base64');
    entry.encoding = 'base64';
  }
  return entry;
}

// ── The REST dispatcher ───────────────────────────────────────────────────────

/** Handle one /api/v3/* request. Always answers (never throws to the caller). */
export async function handleRest(req: IncomingMessage, res: ServerResponse, parsedUrl?: ParsedRequestUrl): Promise<void> {
  const url = parsedUrl ?? parseRequestUrl(req);
  const method = (req.method ?? 'GET').toUpperCase();
  const origin = originOf(req);

  try {
    // Auth first: every route here needs the bearer token (healthz is app.ts's).
    if (!checkAuth(req)) {
      sendError(res, 401, 'Bad credentials');
      return;
    }

    const segments = splitSegments(url.pathname);
    // segments[0] is 'api', segments[1] is 'v3'; the rest is the route.
    const route = segments.slice(2);

    // GET /api/v3/ — the API root (also answers for '/api/v3' without the slash).
    if (route.length === 0) {
      if (method !== 'GET') return sendNotFound(res);
      sendJson(
        res,
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }

    const head = route[0] as string;

    // GET /api/v3/meta
    if (route.length === 1 && head === 'meta') {
      if (method !== 'GET') return sendNotFound(res);
      sendJson(res, 200, { installed_version: '1.0.0' });
      return;
    }

    // GET /api/v3/user — the viewer. Before learning, the documented placeholder.
    if (route.length === 1 && head === 'user') {
      if (method !== 'GET') return sendNotFound(res);
      const login = viewerLogin() ?? PLACEHOLDER_LOGIN;
      const identity = authorIdentity();
      sendJson(res, 200, {
        ...viewerUser(),
        login,
        name: login,
        email: identity.email,
        created_at: '2026-11-14T00:00:00.000Z',
        updated_at: '2026-11-14T00:00:00.000Z',
        html_url: `${origin}/${login}`,
        url: `${origin}/api/v3/user`,
      });
      return;
    }

    // /api/v3/user/repos
    if (route.length === 2 && head === 'user' && route[1] === 'repos') {
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const name = asString(body.name);
        if (name === undefined || name.trim() === '') {
          sendError(res, 422, 'Validation Failed: name is required');
          return;
        }
        if (getRepoByName(name) !== undefined) {
          // The git client accepts a 422 only when the body says 'already exists'.
          sendError(res, 422, `Validation Failed: repository ${name} already exists`);
          return;
        }
        const defaultBranch = asString(body.default_branch);
        const repo = createRepo({
          name,
          private: asBoolean(body.private) ?? false,
          description: asString(body.description) ?? '',
          default_branch: defaultBranch !== undefined && defaultBranch !== '' ? defaultBranch : 'main',
        });
        sendJson(res, 201, repoJson(repo, origin));
        return;
      }
      if (method === 'GET') {
        const params = pageParams(url);
        const { page, totalPages } = paginate(listRepos(), params);
        const link = linkHeader(req, url, params, totalPages);
        sendJson(res, 200, page.map((repo) => repoJson(repo, origin)), link === null ? {} : { link });
        return;
      }
      return sendNotFound(res);
    }

    // /api/v3/repos/{owner}/{repo}/...
    if (head === 'repos' && route.length >= 3) {
      const owner = route[1] as string;
      const repoName = route[2] as string;
      // Viewer learning: the first owner string seen in an owner-bearing path wins.
      // Only authenticated requests learn (auth already passed above).
      learnOwner(owner);
      if (!isViewer(owner)) return sendNotFound(res);
      const repo = getRepoByName(repoName);
      if (repo === undefined) return sendNotFound(res);
      await handleRepoRoute(req, res, url, method, repo, route.slice(3), origin);
      return;
    }

    return sendNotFound(res);
  } catch (err) {
    if (err instanceof MalformedBodyError) {
      sendError(res, 400, err.message);
      return;
    }
    // A handler bug must never take the server down with it.
    sendError(res, 500, 'Internal Server Error');
  }
}

// ── Repo-scoped routes ────────────────────────────────────────────────────────

async function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: ParsedRequestUrl,
  method: string,
  repo: Repo,
  tail: string[],
  origin: string,
): Promise<void> {
  // /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo, origin));
      return;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      const description = asString(body.description);
      if (description !== undefined) repo.description = description;
      const isPrivate = asBoolean(body.private);
      if (isPrivate !== undefined) repo.private = isPrivate;
      const defaultBranch = asString(body.default_branch);
      if (defaultBranch !== undefined && defaultBranch !== '') {
        repo.default_branch = defaultBranch;
        repo.headBranch = defaultBranch;
      }
      const name = asString(body.name);
      if (name !== undefined && name !== '' && name !== repo.name) {
        if (getRepoByName(name) !== undefined) {
          sendError(res, 422, `Validation Failed: repository ${name} already exists`);
          return;
        }
        renameRepo(repo, name);
      }
      touchRepo(repo);
      sendJson(res, 200, repoJson(repo, origin));
      return;
    }
    if (method === 'DELETE') {
      deleteRepo(repo.name);
      sendEmpty(res, 204);
      return;
    }
    return sendNotFound(res);
  }

  const head = tail[0] as string;

  // GET /repos/{o}/{r}/branches
  if (tail.length === 1 && head === 'branches') {
    if (method !== 'GET') return sendNotFound(res);
    const branches: JsonObject[] = [];
    for (const [ref, sha] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      const name = ref.slice('refs/heads/'.length);
      const owner = repoOwnerLogin(repo);
      branches.push({
        name,
        commit: { sha, url: `${origin}/api/v3/repos/${owner}/${repo.name}/commits/${sha}` },
        protected: false,
      });
    }
    sendJson(res, 200, branches);
    return;
  }

  // POST /repos/{o}/{r}/git/refs
  if (tail.length === 2 && head === 'git' && tail[1] === 'refs') {
    if (method !== 'POST') return sendNotFound(res);
    const body = await readJsonBody(req);
    const ref = asString(body.ref);
    const sha = asString(body.sha);
    if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !SHA40.test(sha)) {
      sendError(res, 422, 'Validation Failed: ref and sha are required');
      return;
    }
    if (getObject(repo, sha) === undefined) {
      sendError(res, 422, `Validation Failed: object ${sha} does not exist`);
      return;
    }
    if (repo.refs.has(ref)) {
      sendError(res, 422, `Validation Failed: reference ${ref} already exists`);
      return;
    }
    repo.refs.set(ref, sha.toLowerCase());
    const owner = repoOwnerLogin(repo);
    sendJson(res, 201, {
      ref,
      object: { sha: sha.toLowerCase(), type: getObject(repo, sha)?.type ?? 'commit', url: `${origin}/api/v3/repos/${owner}/${repo.name}/git/refs/${ref}` },
      url: `${origin}/api/v3/repos/${owner}/${repo.name}/git/refs/${ref}`,
    });
    return;
  }

  // GET /repos/{o}/{r}/commits[?sha=<branch>]
  if (tail.length === 1 && head === 'commits') {
    if (method !== 'GET') return sendNotFound(res);
    const requested = url.searchParams.get('sha');
    let tip: string | undefined;
    if (requested === null || requested === '') {
      tip = branchTip(repo, repo.default_branch);
      if (tip === undefined) {
        sendJson(res, 200, []);
        return;
      }
    } else {
      tip = resolveRef(repo, requested);
      if (tip === undefined) {
        sendError(res, 404, `No commit found for SHA: ${requested}`);
        return;
      }
    }
    const params = pageParams(url);
    const { page } = paginate(walkCommits(repo, tip), params);
    const out: JsonObject[] = [];
    for (const oid of page) {
      const entry = commitJson(repo, oid, origin);
      if (entry !== null) out.push(entry);
    }
    sendJson(res, 200, out);
    return;
  }

  // /repos/{o}/{r}/contents[/{path...}]
  if (head === 'contents') {
    const filePath = tail.slice(1).join('/');
    await handleContents(req, res, url, method, repo, filePath, origin);
    return;
  }

  // /repos/{o}/{r}/labels
  if (tail.length === 1 && head === 'labels') {
    if (method === 'GET') {
      sendJson(res, 200, repo.labels.map((label) => labelJson(label, repo, origin)));
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const name = asString(body.name);
      if (name === undefined || name.trim() === '') {
        sendError(res, 422, 'Validation Failed: name is required');
        return;
      }
      // Upsert: posting an existing (e.g. default) label name still answers 201.
      const label = createOrUpdateLabel(repo, name, asString(body.color), asString(body.description));
      sendJson(res, 201, labelJson(label, repo, origin));
      return;
    }
    return sendNotFound(res);
  }

  // /repos/{o}/{r}/issues[/{n}[/comments]]
  if (head === 'issues') {
    await handleIssues(req, res, url, method, repo, tail.slice(1), origin);
    return;
  }

  // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
  if (head === 'pulls') {
    await handlePulls(req, res, url, method, repo, tail.slice(1), origin);
    return;
  }

  return sendNotFound(res);
}

// ── Contents ──────────────────────────────────────────────────────────────────

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  url: ParsedRequestUrl,
  method: string,
  repo: Repo,
  filePath: string,
  origin: string,
): Promise<void> {
  if (method === 'GET') {
    const tip = resolveContentsRef(repo, url);
    if (tip === undefined) return sendNotFound(res);
    const treeOid = commitTreeOid(repo, tip);
    if (treeOid === undefined) return sendNotFound(res);
    if (filePath === '') {
      // Root listing.
      sendJson(res, 200, directoryListing(repo, treeOid, '', origin));
      return;
    }
    const file = getTreeEntry(repo, treeOid, filePath);
    if (file !== undefined) {
      const entry = fileEntryJson(repo, filePath, file.oid, origin, true);
      if (entry === null) return sendNotFound(res);
      sendJson(res, 200, entry);
      return;
    }
    const dirOid = getTreeAtPath(repo, treeOid, filePath);
    if (dirOid !== undefined) {
      sendJson(res, 200, directoryListing(repo, dirOid, filePath, origin));
      return;
    }
    return sendNotFound(res);
  }

  if (method === 'PUT') {
    const body = await readJsonBody(req);
    const message = asString(body.message);
    const content = asString(body.content);
    if (filePath === '' || message === undefined || message === '' || content === undefined) {
      sendError(res, 422, 'Validation Failed: message and content are required');
      return;
    }
    const branch = asString(body.branch) ?? repo.default_branch;
    const tip = branchTip(repo, branch);
    if (tip === undefined && branch !== repo.default_branch) {
      sendError(res, 422, `Validation Failed: branch ${branch} does not exist`);
      return;
    }
    const treeOid = tip === undefined ? null : (commitTreeOid(repo, tip) ?? null);
    const current = treeOid === null ? undefined : getTreeEntry(repo, treeOid, filePath);
    const givenSha = asString(body.sha);
    if (current !== undefined) {
      // Update: the current blob sha is required and must match.
      if (givenSha === undefined) {
        sendError(res, 422, 'Validation Failed: sha is required to update a file');
        return;
      }
      if (givenSha.toLowerCase() !== current.oid.toLowerCase()) {
        sendError(res, 409, 'Conflict: sha does not match the current file');
        return;
      }
    } else if (givenSha !== undefined) {
      sendError(res, 422, 'Validation Failed: sha must not be given for a new file');
      return;
    }
    const blobOid = createBlob(repo, Buffer.from(content, 'base64'));
    const commitSha = commitFileChange(repo, { branch, path: filePath, blobOid, message });
    const entry = fileEntryJson(repo, filePath, blobOid, origin, true);
    const commit = commitJson(repo, commitSha, origin);
    sendJson(res, current === undefined ? 201 : 200, { content: entry, commit });
    return;
  }

  if (method === 'DELETE') {
    const body = await readJsonBody(req);
    const message = asString(body.message);
    const givenSha = asString(body.sha);
    if (filePath === '' || message === undefined || message === '' || givenSha === undefined) {
      sendError(res, 422, 'Validation Failed: message and sha are required');
      return;
    }
    const branch = asString(body.branch) ?? repo.default_branch;
    const tip = branchTip(repo, branch);
    if (tip === undefined) return sendNotFound(res);
    const treeOid = commitTreeOid(repo, tip);
    if (treeOid === undefined) return sendNotFound(res);
    const current = getTreeEntry(repo, treeOid, filePath);
    if (current === undefined) return sendNotFound(res);
    if (givenSha.toLowerCase() !== current.oid.toLowerCase()) {
      sendError(res, 409, 'Conflict: sha does not match the current file');
      return;
    }
    const commitSha = commitFileChange(repo, { branch, path: filePath, blobOid: null, message });
    const commit = commitJson(repo, commitSha, origin);
    sendJson(res, 200, { commit, content: null });
    return;
  }

  return sendNotFound(res);
}

/** Directory entries for one tree: files and subdirectories, in git order. */
function directoryListing(repo: Repo, treeOid: string, dirPath: string, origin: string): JsonObject[] {
  const owner = repoOwnerLogin(repo);
  const out: JsonObject[] = [];
  for (const entry of treeEntries(repo, treeOid)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({
        type: 'dir',
        name: entry.name,
        path,
        sha: entry.oid,
        size: 0,
        url: `${origin}/api/v3/repos/${owner}/${repo.name}/contents/${path}`,
        html_url: `${origin}/${owner}/${repo.name}/tree/HEAD/${path}`,
        git_url: `${origin}/api/v3/repos/${owner}/${repo.name}/git/trees/${entry.oid}`,
        download_url: null,
      });
    } else {
      const object = getObject(repo, entry.oid);
      out.push({
        type: 'file',
        name: entry.name,
        path,
        sha: entry.oid,
        size: object?.data.length ?? 0,
        url: `${origin}/api/v3/repos/${owner}/${repo.name}/contents/${path}`,
        html_url: `${origin}/${owner}/${repo.name}/blob/HEAD/${path}`,
        git_url: `${origin}/api/v3/repos/${owner}/${repo.name}/git/blobs/${entry.oid}`,
        download_url: null,
      });
    }
  }
  return out;
}

// ── Issues ────────────────────────────────────────────────────────────────────

/** Resolve a labels body value (strings or {name} objects) to Label records. */
function resolveIssueLabels(repo: Repo, value: unknown): { labels: Label[]; unknown: string | null } {
  if (value === undefined) return { labels: [], unknown: null };
  if (!Array.isArray(value)) return { labels: [], unknown: null };
  const labels: Label[] = [];
  for (const item of value) {
    const name = typeof item === 'string' ? item : typeof item === 'object' && item !== null ? asString((item as JsonObject).name) : undefined;
    if (name === undefined) continue;
    const label = findLabel(repo, name);
    if (label === undefined) return { labels: [], unknown: name };
    labels.push(label);
  }
  return { labels, unknown: null };
}

async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  url: ParsedRequestUrl,
  method: string,
  repo: Repo,
  tail: string[],
  origin: string,
): Promise<void> {
  // /repos/{o}/{r}/issues
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const title = asString(body.title);
      if (title === undefined || title.trim() === '') {
        sendError(res, 422, 'Validation Failed: title is required');
        return;
      }
      const { labels, unknown } = resolveIssueLabels(repo, body.labels);
      if (unknown !== null) {
        sendError(res, 422, `Validation Failed: label ${unknown} does not exist`);
        return;
      }
      const issue = createIssue(repo, { title, body: asString(body.body) ?? '', labels });
      sendIssueJson(res, 201, issue, repo, origin);
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      // sort=created (the only sort the checks use): creation order is number order,
      // because every created_at takes the next logical tick.
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const params = pageParams(url);
      const { page, totalPages } = paginate(list, params);
      const link = linkHeader(req, url, params, totalPages);
      // The joined body is byte-identical to JSON.stringify of the issue array.
      const bodyText = `[${page.map((issue) => issueJsonText(issue, repo, origin)).join(',')}]\n`;
      sendPrebuiltJson(res, 200, bodyText, link === null ? {} : { link });
      return;
    }
    return sendNotFound(res);
  }

  // /repos/{o}/{r}/issues/{n}[/comments]
  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isInteger(number) || number < 1) return sendNotFound(res);
  const issue = getIssue(repo, number);
  if (issue === undefined) return sendNotFound(res);

  if (tail.length === 1) {
    if (method === 'GET') {
      sendIssueJson(res, 200, issue, repo, origin);
      return;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      const state = asString(body.state);
      if (state !== undefined && state !== 'open' && state !== 'closed') {
        sendError(res, 422, 'Validation Failed: state must be open or closed');
        return;
      }
      if (body.labels !== undefined) {
        const { labels, unknown } = resolveIssueLabels(repo, body.labels);
        if (unknown !== null) {
          sendError(res, 422, `Validation Failed: label ${unknown} does not exist`);
          return;
        }
        issue.labels = labels;
      }
      const title = asString(body.title);
      if (title !== undefined) issue.title = title;
      const issueBody = asString(body.body);
      if (issueBody !== undefined) issue.body = issueBody;
      if (state !== undefined && state !== issue.state) {
        issue.state = state;
        issue.closed_at = state === 'closed' ? tickIso() : null;
      }
      issue.updated_at = tickIso();
      // The mutation changed the body: drop the cached one BEFORE rebuilding it.
      invalidateIssueJson(repo, issue.number);
      sendIssueJson(res, 200, issue, repo, origin);
      return;
    }
    return sendNotFound(res);
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const commentBody = asString(body.body);
      if (commentBody === undefined || commentBody === '') {
        sendError(res, 422, 'Validation Failed: body is required');
        return;
      }
      const comment = createComment(issue, commentBody);
      issue.updated_at = tickIso();
      // The comment count and updated_at changed: drop the cached issue body.
      invalidateIssueJson(repo, issue.number);
      sendJson(res, 201, commentJson(comment, repo, issue.number, origin));
      return;
    }
    if (method === 'GET') {
      const params = pageParams(url);
      const { page, totalPages } = paginate(issue.comments, params);
      const link = linkHeader(req, url, params, totalPages);
      sendJson(res, 200, page.map((comment) => commentJson(comment, repo, issue.number, origin)), link === null ? {} : { link });
      return;
    }
    return sendNotFound(res);
  }

  return sendNotFound(res);
}

// ── Pulls ─────────────────────────────────────────────────────────────────────

/** GitHub accepts `head` as "branch" or "user:branch"; the store wants the branch. */
function branchOf(ref: string): string {
  const colon = ref.lastIndexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  url: ParsedRequestUrl,
  method: string,
  repo: Repo,
  tail: string[],
  origin: string,
): Promise<void> {
  // /repos/{o}/{r}/pulls
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const title = asString(body.title);
      const headRaw = asString(body.head);
      const baseRaw = asString(body.base);
      if (title === undefined || title.trim() === '') {
        sendError(res, 422, 'Validation Failed: title is required');
        return;
      }
      if (headRaw === undefined || headRaw === '' || baseRaw === undefined || baseRaw === '') {
        sendError(res, 422, 'Validation Failed: head and base are required');
        return;
      }
      const pull = createPullRequest(repo, {
        title,
        body: asString(body.body) ?? '',
        headRef: branchOf(headRaw),
        baseRef: branchOf(baseRaw),
      });
      if (pull === null) {
        sendError(res, 422, 'Validation Failed: head or base branch does not exist');
        return;
      }
      sendJson(res, 201, pullJson(pull, repo, origin));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.pullRequests];
      if (state === 'open' || state === 'closed') list = list.filter((pull) => pull.state === state);
      // Newest first (created order is number order: every created_at takes the next tick).
      list.sort((a, b) => b.number - a.number);
      const params = pageParams(url);
      const { page, totalPages } = paginate(list, params);
      const link = linkHeader(req, url, params, totalPages);
      sendJson(res, 200, page.map((pull) => pullJson(pull, repo, origin)), link === null ? {} : { link });
      return;
    }
    return sendNotFound(res);
  }

  // /repos/{o}/{r}/pulls/{n}[/files|merge]
  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isInteger(number) || number < 1) return sendNotFound(res);
  const pull = getPullRequest(repo, number);
  if (pull === undefined) return sendNotFound(res);

  if (tail.length === 1) {
    if (method !== 'GET') return sendNotFound(res);
    sendJson(res, 200, pullJson(pull, repo, origin));
    return;
  }

  if (tail.length === 2 && tail[1] === 'files') {
    if (method !== 'GET') return sendNotFound(res);
    sendJson(res, 200, computePullFiles(repo, pull));
    return;
  }

  if (tail.length === 2 && tail[1] === 'merge') {
    if (method !== 'PUT') return sendNotFound(res);
    const body = await readJsonBody(req);
    const methodRaw = asString(body.merge_method);
    const mergeMethod = methodRaw === undefined ? 'squash' : methodRaw;
    if (mergeMethod !== 'squash' && mergeMethod !== 'merge') {
      sendError(res, 422, 'Validation Failed: merge_method must be squash or merge');
      return;
    }
    const result = mergePullRequestRecord(repo, pull, mergeMethod, {
      commitTitle: asString(body.commit_title),
      commitMessage: asString(body.commit_message),
    });
    if (!result.ok) {
      sendError(res, result.status, result.message);
      return;
    }
    sendJson(res, 200, { merged: true, sha: result.sha, message: 'Pull request successfully merged' });
    return;
  }

  return sendNotFound(res);
}

// Referenced for later slices: commitAuthorOf is the REST author helper for git data.
export { commitAuthorOf };
