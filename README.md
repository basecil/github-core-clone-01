# github-core-clone-01

A GitHub-compatible git forge, built for [the contest](https://make.fun/bounty/github-core-clone-01):
an in-memory store, a pure git object layer, the REST v3 surface — repositories,
branches, commits, contents, issues, comments, labels and pull requests — and git
smart HTTP (protocol v2 upload-pack, v0 receive-pack, packfile codec) over the
lifecycle the harness drives it with, plus the MCP endpoint and GraphQL v4
over the same store.

Documented subset (what this build implements): REST v3 repositories, branches,
commits, contents (create/update/delete with real git commits), issues, comments,
labels and pull requests (create/list/get/files, squash + merge merges with
three-way conflict detection), plus git smart HTTP — `info/refs` advertisements
(protocol v2 for upload-pack, v0 for receive-pack), `ls-refs` with peel/symrefs/
unborn/ref-prefix, fetches with want/have negotiation, shallow/deepen and sideband-
64k framing, and pushes with unpack-then-validate report-status (fast-forward
enforcement, per-ref ok/ng) — plus the protocol discipline every reply follows
(JSON everywhere on the REST surface, a non-empty `X-GitHub-Request-Id`, bearer
auth on all API routes except the health probe) — and the MCP endpoint
(`server/discover`, `initialize`, `tools/list`, `tools/call` with six tools;
see [MCP](#mcp)) — and GraphQL v4 (the documents `gh` and
`github-mcp-server` send; see [GraphQL v4](#graphql-v4)). No claim of full
GitHub compatibility beyond the documented subset.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http` and its own `app.ts` only, and the trial has no package manager and
no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests (create/list/get/files/merge) |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` (see [MCP](#mcp)) |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs` (v2 upload-pack / v0 receive-pack advertisements), `git-upload-pack` (v2 ls-refs + fetch, v0 fetch), `git-receive-pack` (v0 push with report-status) |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. A missing or a wrong token is
refused with a JSON 401 on every API route.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## GraphQL v4

`POST /api/graphql` is a dependency-free GraphQL executor for the documents
`gh` and `github-mcp-server` send (the kit's `checks-graphql.ts`
`GRAPHQL_DOCUMENTS`): a small lexer + recursive-descent parser, validation
against the implemented schema, and resolvers over the same store REST uses.
It accepts one operation body (`{query, variables?, operationName?}`) or a
batch (a JSON array of operations, answered in order). Auth is the same
bearer token as REST: missing/wrong → JSON 401; a malformed JSON body → 400.
A GraphQL-level failure (an unknown field, a bad argument) is HTTP 200 with
an `errors` array naming the field, never an HTTP error; a successful null
(unknown repository, unknown node id) carries no errors.

Supported surface:

- **Query:** `viewer { login }` (the learned viewer login), `repository(owner:,
  name:)` (`id`, `databaseId`, `name`, `nameWithOwner`, `owner`, `defaultBranchRef`,
  `viewerPermission`, `hasIssuesEnabled`, `issue(number:)`, `issues(...)`,
  `pullRequests(...)`, `pullRequest(number:)`), `node(id:)` (Relay round-trip
  with inline fragments), `__type` / `__schema` introspection.
- **Issues connection:** `states: [OPEN|CLOSED]` filter, `orderBy: {field:
  CREATED_AT|UPDATED_AT, direction: ASC|DESC}` (default CREATED_AT DESC),
  `first` + `after` cursor pagination with `pageInfo { hasNextPage, endCursor }`.
- **Pull requests:** `state` (`OPEN`/`CLOSED`/`MERGED`), `merged`, `headRefName`,
  `baseRefName`, `mergeable` (`MERGEABLE`/`CONFLICTING`/`UNKNOWN` — a pure
  dry-run of the three-way merge check, see `pulls.ts` `mergeableState`),
  `files(first:) { nodes { path } }`.
- **Mutations** (all REST-visible, same store/pulls calls as REST):
  `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`
  (`SQUASH`/`MERGE`), `addComment` (on an issue, via its global id).
- **Global ids** are opaque base64url of `Kind:<stable parts>` (repo numeric
  id + issue/PR number), stable across reads; cursors are base64url of
  `cursor:<index>` in the ordered list. No randomness, no wall clock: every
  timestamp comes from the store's logical clock. The viewer login is learned
  from the `owner` argument of `repository(...)` queries too (authenticated
  only), so `viewer.login` is right even if GraphQL runs first.

## MCP

`POST /mcp` speaks JSON-RPC 2.0 over streamable HTTP (one request, one plain
`application/json` response; no SSE stream, no session id — the server never
issues an `Mcp-Session-Id`). It serves both protocol eras the suite negotiates:

- **modern 2026-07-28:** `server/discover` answers the server identity
  (`github-core-clone` 1.0.0), the `{tools: {}}` capability and the supported
  revisions in one request; no handshake.
- **legacy 2025-11-25 and earlier:** `initialize` echoes the client's revision
  when accepted, else the preferred revision (2026-07-28);
  `notifications/initialized` (and any `notifications/*`) answers HTTP 202
  with an empty body.

Auth is checked before any JSON-RPC processing: a missing or wrong bearer token
is a JSON 401. A malformed JSON body is HTTP 400 with JSON-RPC `-32700`.
JSON-RPC errors (unknown method `-32601`, invalid params `-32602`, invalid
request `-32600`) are HTTP 200 bodies with an `error` object, never HTTP 500.
Non-POST methods answer 405. Every reply carries `X-GitHub-Request-Id`.

`tools/list` returns six tools, byte-identical on every call:

| Tool | Arguments | Effect |
| --- | --- | --- |
| `create_repo` | `name`, `description?`, `private?`, `owner?`, `default_branch?` | Creates a repository (same store call as REST) |
| `get_repo` | `owner`, `repo` | Reads a repository |
| `create_issue` | `owner`, `repo`, `title`, `body?`, `labels?` | Creates an issue |
| `list_issues` | `owner`, `repo`, `state?` | Lists issues (`open`/`closed`/`all`, default `open`) |
| `create_pull_request` | `owner`, `repo`, `title`, `body?`, `head`, `base` | Opens a pull request |
| `merge_pull_request` | `owner`, `repo`, `pull_number`, `merge_method?` | Merges a pull request (`squash` default, or `merge`) |

Tool results are `{content: [{type: "text", text: <JSON of the REST-shaped
object>}], isError: false}`; a tool failure (unknown repo, unknown branch,
merge conflict, duplicate name) is a result with `isError: true`, while an
unknown tool name or missing required arguments is a JSON-RPC `-32602` error.
Argument names are liberal where the checks allow it (`repository` for `repo`,
`head_ref`/`base_ref`, `number`/`pr_number` for `pull_number`, a `full_name`
of `owner/repo`). Every tool calls the same store/pulls functions REST uses,
so effects are visible over REST. The viewer login is learned from the first
`owner` argument seen (authenticated only), exactly as REST learns it from
owner-bearing paths; a tool naming a non-viewer owner reports not-found.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the server and its mount table (REST v3, git smart HTTP, MCP and
  GraphQL v4 mounted).
- `store.ts`: the shared in-memory store + data model — the contract later slices
  build on. Viewer-login learning, the deterministic logical clock and request ids,
  bearer auth, repos/issues/comments/labels/pull-request records.
- `git-object.ts`: the pure git object layer (SHA-1 ids, blobs/trees/commits, tree
  updates, commit traversal). No packs or smart HTTP here.
- `git-pack.ts`: the packfile codec (parse v2/v3 packs with OFS/REF deltas, build
  deterministic full-object v2 packs) and the fetch reachability collection
  (want/have, shallow/deepen, filters).
- `pktline.ts`: git pkt-line framing + sideband-64k helpers shared by the server.
- `git-http.ts`: git smart HTTP — info/refs advertisements, protocol v2 upload-pack
  (ls-refs, fetch), v0 fetch, and v0 receive-pack pushes with report-status.
- `pulls.ts`: pull-request files diff (LCS line counts) and merge logic (squash +
  merge, three-way file-granularity conflict detection), shared by REST v3 and the
  later GraphQL/MCP slices.
- `rest.ts`: the REST v3 handlers, JSON/error/pagination helpers, and the serializers.
- `graphql.ts`: the GraphQL v4 endpoint (POST /api/graphql): a lexer +
  recursive-descent parser, schema validation, and resolvers over the store —
  viewer/repository/node reads, the issues and pull-requests connections,
  the five mutations, global ids, cursor pagination and introspection.
- `mcp.ts`: the MCP endpoint (POST /mcp, JSON-RPC 2.0 over streamable HTTP):
  `server/discover` + `initialize` (both protocol eras), `tools/list` and
  `tools/call` with the six tools above, over the same store REST uses.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

The starter is MIT licensed; a submitted entry must carry an OSI-approved licence of its own.
