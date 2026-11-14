// mcp.ts — Model Context Protocol endpoint (POST /mcp, streamable HTTP).
//
// The spec is the kit's checks (program/env/src/checks-mcp.ts + mcp-client.ts):
// every method, tool name, argument name and error code below exists because a
// check asserts it.
//
// ── Transport ────────────────────────────────────────────────────────────────
//   * POST /mcp, JSON-RPC 2.0 over streamable HTTP. One request → one plain
//     `application/json` JSON-RPC response (the client also accepts SSE, but plain
//     JSON is the whole contract it needs). No session: the server never issues an
//     `Mcp-Session-Id`, so the client never sends one and never DELETEs.
//   * Auth first: missing/wrong Bearer token → 401 {"message": ...} at the HTTP
//     level, before any JSON-RPC processing.
//   * Malformed JSON body → HTTP 400 with JSON-RPC -32700 (the modern era
//     requires 400; the legacy era accepts 400 too).
//   * Every HTTP reply carries X-GitHub-Request-Id (via rest.ts's send helpers).
//   * Non-POST methods → 405 {"message": "Method Not Allowed"} (no GET stream).
//   * Notifications (`notifications/*`, no id) → HTTP 202 with an empty body.
//   * JSON-RPC errors (unknown method -32601, invalid params -32602, invalid
//     request -32600) are HTTP 200 bodies with an `error` object — never HTTP 500.
//
// ── Protocol eras (the client negotiates; both are served) ──────────────────
//   * modern 2026-07-28: `server/discover` answers the identity, capabilities
//     and supportedVersions in one request; no handshake, no session.
//   * legacy 2025-11-25 and earlier: `initialize` echoes the client's revision
//     when it is one the server accepts, else the preferred revision
//     (2026-07-28); `notifications/initialized` is answered 202.
//
// ── Tools (tools/list, tools/call) ───────────────────────────────────────────
//   create_repo        {name, description?, private?, owner?, default_branch?}
//   get_repo           {owner, repo}
//   create_issue       {owner, repo, title, body?, labels?}
//   list_issues        {owner, repo, state?}
//   create_pull_request {owner, repo, title, body?, head, base}
//   merge_pull_request {owner, repo, pull_number, merge_method?}
//   Every tool calls the SAME store/pulls functions REST uses, so effects are
//   visible over REST (rest-parity). Tool results are {content: [{type: "text",
//   text: <JSON string of the REST-shaped object>}], isError: false}; a tool
//   failure (unknown repo, unknown branch, merge conflict, duplicate name) is a
//   result with isError: true, never a JSON-RPC error. Unknown tool names and
//   missing required arguments ARE JSON-RPC errors (-32602).
//
//   Argument names are liberal where the checks are ambiguous: `repository` /
//   `repo_name` for `repo`, `head_ref` for `head`, `base_ref` for `base`,
//   `number` / `pr_number` for `pull_number`, and a `full_name` of "owner/repo"
//   when owner/repo are not given separately.
//
//   Viewer learning: tool arguments carry owner/repo, so (authenticated only —
//   auth already passed above) the first owner seen is learned via learnOwner,
//   exactly like REST learns it from owner-bearing paths. A tool naming a
//   non-viewer owner reports not-found (isError), like REST's 404.
//
// Determinism: no randomness (no session ids), no wall clock — timestamps come
// from the store's logical clock, and tools/list is a frozen constant, so two
// calls answer byte-identically.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  checkAuth,
  createIssue,
  createPullRequest,
  createRepo,
  findLabel,
  getPullRequest,
  getRepoByName,
  isViewer,
  learnOwner,
  repoOwnerLogin,
  viewerLogin,
  type Issue,
  type Label,
  type Repo,
} from './store.ts';
import { mergePullRequestRecord, pullJson, type MergeMethod } from './pulls.ts';
import { sendEmpty, sendError, sendJson } from './rest.ts';

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number | null;

// ── JSON-RPC codes ────────────────────────────────────────────────────────────

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

// ── Protocol versions ─────────────────────────────────────────────────────────

/** The current revision (2026-07-28): the preferred answer and the discover era. */
const PREFERRED_REVISION = '2026-07-28';

/** Every revision the server accepts (the preferred one + the handshake eras). */
const ACCEPTED_REVISIONS: readonly string[] = Object.freeze([
  PREFERRED_REVISION,
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

/** The tools capability every identity answer declares. */
const TOOLS_CAPABILITY: JsonObject = { tools: {} };

const MAX_BODY_BYTES = 10 * 1024 * 1024;

// ── The six tools (a frozen constant: tools/list is byte-identical every call) ─

const TOOLS: readonly JsonObject[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        owner: Object.freeze({ type: 'string', description: 'The owner login (the authenticated user).' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
        default_branch: Object.freeze({ type: 'string', description: 'The default branch name (default main).' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
        labels: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), description: 'Label names to apply (must already exist on the repository).' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'Filter by state: open, closed, or all (default open).' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch (or "user:branch").' }),
        base: Object.freeze({ type: 'string', description: 'The base branch (or "user:branch").' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The pull request number.' }),
        merge_method: Object.freeze({ type: 'string', description: 'The merge method: squash (default) or merge.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

// ── Small helpers ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** A number out of a JSON value (a number, or a string of digits). */
function asInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** The first defined string among the given argument names (liberal synonyms). */
function pickString(args: JsonObject, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = asString(args[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The request's own origin (scheme + Host header) for absolute URL fields. */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/** GitHub accepts `head` as "branch" or "user:branch"; the store wants the branch. */
function branchOf(ref: string): string {
  const colon = ref.lastIndexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

// ── Response helpers ──────────────────────────────────────────────────────────

/** A JSON-RPC success: HTTP 200, the request's id echoed verbatim. */
function sendResult(res: ServerResponse, id: JsonRpcId, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

/** A JSON-RPC error: HTTP 200 (except parse errors, which are HTTP 400). */
function sendRpcError(res: ServerResponse, status: number, id: JsonRpcId, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } });
}

/** A tool success: the value as one JSON text block. */
function toolOk(value: unknown): JsonObject {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
}

/** A tool failure: a text message with isError set (still a JSON-RPC success). */
function toolFail(message: string): JsonObject {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ── Serializers (the REST v3 shapes, mirrored from rest.ts — same fields) ─────

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

// ── Tool argument handling ────────────────────────────────────────────────────

/** The error a tool call raises for missing/invalid arguments (JSON-RPC -32602). */
class InvalidParamsError extends Error {}

/** The owner + repo a tool call names, from `owner`/`repo` or a `full_name`. */
function ownerRepoOf(args: JsonObject): { owner: string | undefined; repo: string | undefined } {
  let owner = pickString(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']);
  let repo = pickString(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']);
  const fullName = pickString(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  if ((owner === undefined || repo === undefined) && fullName !== undefined && fullName.includes('/')) {
    const [namedOwner, namedRepo] = fullName.split('/', 2);
    if (owner === undefined && namedOwner !== '') owner = namedOwner;
    if (repo === undefined && namedRepo !== '') repo = namedRepo;
  }
  return { owner, repo };
}

/**
 * Resolve the repository a tool call names: learn the viewer from the owner
 * argument (authenticated only — auth already passed), then refuse a non-viewer
 * owner or an unknown repo with a tool error, like REST's 404.
 */
function resolveRepo(args: JsonObject): { repo: Repo } | { error: JsonObject } {
  const { owner, repo: repoName } = ownerRepoOf(args);
  if (owner === undefined || owner === '') throw new InvalidParamsError('owner is required');
  if (repoName === undefined || repoName === '') throw new InvalidParamsError('repo is required');
  if (viewerLogin() === null) learnOwner(owner);
  if (!isViewer(owner)) return { error: toolFail(`Repository ${owner}/${repoName} not found`) };
  const repo = getRepoByName(repoName);
  if (repo === undefined) return { error: toolFail(`Repository ${owner}/${repoName} not found`) };
  return { repo };
}

/** A required string argument, or an InvalidParamsError naming it. */
function requiredString(args: JsonObject, names: readonly string[], label: string): string {
  const value = pickString(args, names);
  if (value === undefined || value === '') throw new InvalidParamsError(`${label} is required`);
  return value;
}

/** Resolve a labels argument value (strings or {name} objects) to Label records. */
function resolveLabels(repo: Repo, value: unknown): { labels: Label[] } | { error: JsonObject } {
  if (value === undefined) return { labels: [] };
  if (!Array.isArray(value)) return { labels: [] };
  const labels: Label[] = [];
  for (const item of value) {
    const name = typeof item === 'string' ? item : isRecord(item) ? asString(item.name) : undefined;
    if (name === undefined) continue;
    const label = findLabel(repo, name);
    if (label === undefined) return { error: toolFail(`Label ${name} does not exist`) };
    labels.push(label);
  }
  return { labels };
}

// ── The tools ─────────────────────────────────────────────────────────────────

function callCreateRepo(args: JsonObject, origin: string): JsonObject {
  const name = requiredString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name'], 'name');
  const owner = pickString(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']);
  if (owner !== undefined && owner !== '') {
    if (viewerLogin() === null) learnOwner(owner);
    if (!isViewer(owner)) return toolFail(`Repository ${owner}/${name} not found`);
  }
  if (getRepoByName(name) !== undefined) return toolFail(`Repository ${name} already exists`);
  const defaultBranch = pickString(args, ['default_branch', 'defaultBranch']) ?? 'main';
  const repo = createRepo({
    name,
    private: asBoolean(args.private) ?? asBoolean(args.is_private) ?? false,
    description: pickString(args, ['description', 'about', 'summary', 'body']) ?? '',
    default_branch: defaultBranch !== '' ? defaultBranch : 'main',
  });
  return toolOk(repoJson(repo, origin));
}

function callGetRepo(args: JsonObject, origin: string): JsonObject {
  const resolved = resolveRepo(args);
  if ('error' in resolved) return resolved.error;
  return toolOk(repoJson(resolved.repo, origin));
}

function callCreateIssue(args: JsonObject, origin: string): JsonObject {
  const resolved = resolveRepo(args);
  if ('error' in resolved) return resolved.error;
  const repo = resolved.repo;
  const title = requiredString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'], 'title');
  const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
  const labels = resolveLabels(repo, args.labels);
  if ('error' in labels) return labels.error;
  const issue = createIssue(repo, { title, body, labels: labels.labels });
  return toolOk(issueJson(issue, repo, origin));
}

function callListIssues(args: JsonObject, origin: string): JsonObject {
  const resolved = resolveRepo(args);
  if ('error' in resolved) return resolved.error;
  const repo = resolved.repo;
  const state = pickString(args, ['state', 'status']) ?? 'open';
  let list = [...repo.issues];
  if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
  list.sort((a, b) => a.number - b.number);
  return toolOk(list.map((issue) => issueJson(issue, repo, origin)));
}

function callCreatePullRequest(args: JsonObject, origin: string): JsonObject {
  const resolved = resolveRepo(args);
  if ('error' in resolved) return resolved.error;
  const repo = resolved.repo;
  const title = requiredString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'], 'title');
  const head = requiredString(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'], 'head');
  const base = requiredString(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'], 'base');
  const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
  const pull = createPullRequest(repo, { title, body, headRef: branchOf(head), baseRef: branchOf(base) });
  if (pull === null) return toolFail('head or base branch does not exist');
  return toolOk(pullJson(pull, repo, origin));
}

function callMergePullRequest(args: JsonObject, origin: string): JsonObject {
  const resolved = resolveRepo(args);
  if ('error' in resolved) return resolved.error;
  const repo = resolved.repo;
  const number = asInteger(args.pull_number) ?? asInteger(args.pull_request_number) ?? asInteger(args.pr_number) ?? asInteger(args.number) ?? asInteger(args.issue_number) ?? asInteger(args.index);
  if (number === undefined) throw new InvalidParamsError('pull_number is required');
  const methodRaw = pickString(args, ['merge_method', 'mergeMethod', 'method']);
  const method: MergeMethod | 'invalid' = methodRaw === undefined || methodRaw === '' ? 'squash' : methodRaw === 'merge' ? 'merge' : methodRaw === 'squash' ? 'squash' : 'invalid';
  if (method === 'invalid') return toolFail('merge_method must be squash or merge');
  const pull = getPullRequest(repo, number);
  if (pull === undefined) return toolFail(`Pull request #${number} not found`);
  const result = mergePullRequestRecord(repo, pull, method, {});
  if (!result.ok) return toolFail(result.message);
  return toolOk({ merged: true, sha: result.sha, message: 'Pull request successfully merged', pull_request: pullJson(pull, repo, origin) });
}

const TOOL_HANDLERS: Readonly<Record<string, (args: JsonObject, origin: string) => JsonObject>> = Object.freeze({
  create_repo: callCreateRepo,
  get_repo: callGetRepo,
  create_issue: callCreateIssue,
  list_issues: callListIssues,
  create_pull_request: callCreatePullRequest,
  merge_pull_request: callMergePullRequest,
});

// ── Body reading ──────────────────────────────────────────────────────────────

class MalformedBodyError extends Error {}

/** Read the request body (≤10 MB) as text. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new MalformedBodyError('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ── The handler ───────────────────────────────────────────────────────────────

/** Handle /mcp: POST only, JSON-RPC 2.0 over streamable HTTP. Always answers. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const origin = originOf(req);

  // No GET stream, no sessions to DELETE: only POST is served.
  if (method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  try {
    // Auth first: before any JSON-RPC processing.
    if (!checkAuth(req)) {
      sendError(res, 401, 'Bad credentials');
      return;
    }

    const text = await readBody(req);
    let parsed: unknown;
    try {
      parsed = text.trim() === '' ? null : JSON.parse(text);
    } catch {
      // A body that is not JSON: HTTP 400 with JSON-RPC -32700 (both eras accept it).
      sendRpcError(res, 400, null, PARSE_ERROR, 'Parse error');
      return;
    }
    if (!isRecord(parsed)) {
      sendRpcError(res, 200, null, INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC object');
      return;
    }

    const rpcMethod = asString(parsed.method);
    if (rpcMethod === undefined || rpcMethod === '') {
      sendRpcError(res, 200, (parsed.id as JsonRpcId) ?? null, INVALID_REQUEST, 'Invalid Request: method is required');
      return;
    }

    // Notifications carry no id and get no response body: HTTP 202, empty.
    const id = parsed.id;
    const hasId = typeof id === 'string' || typeof id === 'number';
    if (rpcMethod.startsWith('notifications/') || !hasId) {
      sendEmpty(res, 202);
      return;
    }
    const rpcId: JsonRpcId = id as JsonRpcId;
    const params = isRecord(parsed.params) ? parsed.params : {};

    // ── server/discover (modern 2026-07-28): identity + capabilities + versions.
    if (rpcMethod === 'server/discover') {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      sendResult(res, rpcId, {
        supportedVersions: [...ACCEPTED_REVISIONS],
        capabilities: { ...TOOLS_CAPABILITY },
        serverInfo: { ...serverInfo },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...serverInfo } },
      });
      return;
    }

    // ── initialize (legacy handshake): echo an accepted revision, else the preferred.
    if (rpcMethod === 'initialize') {
      const offered = asString(params.protocolVersion);
      const negotiated = offered !== undefined && ACCEPTED_REVISIONS.includes(offered) ? offered : PREFERRED_REVISION;
      sendResult(res, rpcId, {
        protocolVersion: negotiated,
        capabilities: { ...TOOLS_CAPABILITY },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }

    // ── tools/list: the six tools, byte-identical every call.
    if (rpcMethod === 'tools/list') {
      sendResult(res, rpcId, { tools: TOOLS });
      return;
    }

    // ── tools/call: dispatch to the store (the same functions REST uses).
    if (rpcMethod === 'tools/call') {
      const name = asString(params.name);
      if (name === undefined || name === '') {
        sendRpcError(res, 200, rpcId, INVALID_PARAMS, 'Invalid params: name is required');
        return;
      }
      const handler = TOOL_HANDLERS[name];
      if (handler === undefined) {
        sendRpcError(res, 200, rpcId, INVALID_PARAMS, `Unknown tool: ${name}`);
        return;
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      try {
        sendResult(res, rpcId, handler(args, origin));
      } catch (err) {
        if (err instanceof InvalidParamsError) {
          sendRpcError(res, 200, rpcId, INVALID_PARAMS, `Invalid params: ${err.message}`);
          return;
        }
        throw err;
      }
      return;
    }

    // ── ping (defensive; the suite's client never sends it).
    if (rpcMethod === 'ping') {
      sendResult(res, rpcId, {});
      return;
    }

    // Anything else is a method this server does not serve.
    sendRpcError(res, 200, rpcId, METHOD_NOT_FOUND, `Method not found: ${rpcMethod}`);
  } catch (err) {
    if (err instanceof MalformedBodyError) {
      sendRpcError(res, 400, null, PARSE_ERROR, 'Parse error');
      return;
    }
    // A handler bug must never take the server down or hang the client.
    if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
    else res.end();
  }
}
