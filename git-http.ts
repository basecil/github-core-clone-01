// git-http.ts — git smart HTTP: protocol v2 upload-pack, v0 receive-pack, and the
// info/refs advertisements. Mounted in app.ts under /{owner}/{repo}.git/.
//
// The wire behaviour is defined by the kit's git-client.ts (the protocol reference):
//   * GET info/refs?service=git-upload-pack — protocol v2 advertisement when the request
//     carries `Git-Protocol: version=2` (the client's default), otherwise a v0 ref
//     advertisement. Both carry the `# service=...` preamble and the
//     application/x-git-upload-pack-advertisement content type.
//   * GET info/refs?service=git-receive-pack — always a v0 ref advertisement, with the
//     capabilities a push needs: report-status, side-band-64k, delete-refs, ofs-delta.
//     An empty repo advertises the single `capabilities^{}` pseudo-ref line.
//   * POST git-upload-pack — protocol v2 when `Git-Protocol: version=2` is present:
//     `command=ls-refs` (peel, symrefs, unborn, ref-prefix) and `command=fetch` (want /
//     have / shallow / deepen / deepen-relative / filter, answered with acknowledgments,
//     shallow-info and a sideband-64k-framed packfile section). Sections are separated
//     by DELIM packets, one FLUSH ends the response. Negotiation follows canonical
//     upload-pack: ACK = "the server has this object", `ready` = a common base was
//     found; a round with no `ready` and no `done` answers with the ack section ONLY
//     (the client then re-requests with `done`), and a `done` request is answered with
//     the packfile and no ack section. Without the header, a v0 fetch
//     (want/have/done/deepen, NAK/ACK lines + sideband pack). Unknown commands and
//     malformed bodies answer an `ERR ...` pkt-line — never a crash, never a hang.
//   * POST git-receive-pack — v0 push: pkt-line ref commands, then the raw packfile.
//     The pack is unpacked FIRST (parsePack with the store as the REF_DELTA lookup); an
//     unpack failure reports `unpack error` + ng for every ref and applies nothing. Each
//     command is then validated (create requires the ref absent, delete requires it
//     present, updates must be fast-forward — the exact reason is `non-fast-forward`)
//     and only the ok refs are applied, in order. The report-status reply is framed in
//     sideband-64k band 1 when the client asked for it.
//   * HEAD: the first branch created on an empty repo becomes headBranch (the checks
//     push to 'main' and repos are created with default_branch 'main'); deleting the
//     HEAD branch re-points HEAD at the first remaining branch.
//   * Auth: every git route needs the bearer token (missing/wrong → JSON 401). The
//     owner is learned from AUTHENTICATED requests only (learnOwner); an unknown owner
//     or repo is a JSON 404 and the server stays up.
//
// ── API surface ────────────────────────────────────────────────────────────────
//   handleGit(req, res) — the mount handler (async; always answers, never throws)

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  bumpGeneration,
  checkAuth,
  getCachedFetch,
  getRepoByName,
  isViewer,
  learnOwner,
  nextRequestId,
  setCachedFetch,
  touchRepo,
  type Repo,
} from './store.ts';
import { getObject, parsedCommit, walkCommits } from './git-object.ts';
import { buildPack, collectObjects, parsePack, peelTag } from './git-pack.ts';
import { decodePktLinesAll, encodePktLine, encodePktLines, pktFlush, sidebandPackets } from './pktline.ts';
import { parseRequestUrl, sendError, sendNotFound, splitSegments, type ParsedRequestUrl } from './rest.ts';

const ZERO_OID = '0'.repeat(40);
const SHA40 = /^[0-9a-f]{40}$/i;
/** A pushed pack is bounded (the checks' largest is far below this); larger bodies are refused. */
const MAX_GIT_BODY_BYTES = 64 * 1024 * 1024;

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** One pkt-line's worth of a single-line string (newlines would break the framing). */
function oneLine(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ').trim();
  return flat === '' ? 'error' : flat;
}

// ── Request plumbing ──────────────────────────────────────────────────────────

/**
 * Read the request body (≤64 MB); throws on overflow. Uses 'data'/'end'
 * listeners rather than `for await` (perf round 3): the async-iterator
 * machinery (createAsyncIterator) showed up in the push profile, and the
 * listener form allocates nothing per chunk beyond the chunk itself.
 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise<Buffer>((resolve, reject) => {
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_GIT_BODY_BYTES) {
        failed = true;
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.once('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.once('error', (err: Error) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** Answer with a git content type; still carries X-GitHub-Request-Id like every reply. */
function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

type GitService = 'info/refs' | 'git-upload-pack' | 'git-receive-pack';

interface GitRoute {
  owner: string;
  repo: string;
  service: GitService;
}

/**
 * /{owner}/{repo}.git/info/refs | /{owner}/{repo}.git/git-upload-pack |
 * /{owner}/{repo}.git/git-receive-pack — null for anything else.
 */
function parseGitPath(pathname: string): GitRoute | null {
  const segments = splitSegments(pathname);
  if (segments.length < 3) return null;
  const owner = segments[0] as string;
  const repoSegment = segments[1] as string;
  if (owner === '' || !repoSegment.endsWith('.git')) return null;
  const repo = repoSegment.slice(0, -4);
  if (repo === '') return null;
  if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') {
    return { owner, repo, service: 'info/refs' };
  }
  if (segments.length === 3 && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')) {
    return { owner, repo, service: segments[2] as GitService };
  }
  return null;
}

/** The request asks for protocol v2 when it carries `Git-Protocol: version=2`. */
function wantsV2(req: IncomingMessage): boolean {
  return (req.headers['git-protocol'] ?? '') === 'version=2';
}

// ── The mount handler ─────────────────────────────────────────────────────────

/** Handle one /{owner}/{repo}.git/* request. Always answers (never throws to the caller). */
export async function handleGit(req: IncomingMessage, res: ServerResponse, parsedUrl?: ParsedRequestUrl): Promise<void> {
  const url = parsedUrl ?? parseRequestUrl(req);
  const method = (req.method ?? 'GET').toUpperCase();

  try {
    // Auth first: every git route needs the bearer token.
    if (!checkAuth(req)) {
      sendError(res, 401, 'Bad credentials');
      return;
    }

    const route = parseGitPath(url.pathname);
    if (route === null) {
      sendNotFound(res);
      return;
    }
    // Viewer learning: the first owner string seen in an authenticated owner-bearing
    // path wins (auth already passed above).
    learnOwner(route.owner);
    if (!isViewer(route.owner)) {
      sendNotFound(res);
      return;
    }
    const repo = getRepoByName(route.repo);
    if (repo === undefined) {
      sendNotFound(res);
      return;
    }

    if (route.service === 'info/refs') {
      if (method !== 'GET') {
        sendNotFound(res);
        return;
      }
      handleInfoRefs(req, res, repo, url);
      return;
    }

    if (method !== 'POST') {
      sendNotFound(res);
      return;
    }
    const body = await readBody(req);
    if (route.service === 'git-upload-pack') handleUploadPack(req, res, repo, body);
    else handleReceivePack(res, repo, body);
  } catch (err) {
    // A handler bug (or an oversize body) must never take the server down with it.
    if (!res.headersSent) {
      const message = err instanceof Error && err.message === 'request body too large' ? 'request body too large' : 'Internal Server Error';
      sendError(res, err instanceof Error && err.message === 'request body too large' ? 413 : 500, message);
    } else {
      res.end();
    }
  }
}

// ── Advertisements ────────────────────────────────────────────────────────────

/** The repo's refs, sorted by refname (git order: heads before tags). */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The peeled oid of a ref: for an annotated tag, the first non-tag object it points
 * to; null when the ref does not point at a tag object.
 */
function peeledOid(repo: Repo, oid: string): string | null {
  const object = getObject(repo, oid);
  if (object === undefined || object.type !== 'tag') return null;
  const peeled = peelTag(repo, oid);
  return peeled.oid === oid ? null : peeled.oid;
}

/**
 * The protocol v2 capability advertisement (upload-pack only). Static — the same
 * lines for every repo — so it is one prebuilt buffer (perf round 2) instead of
 * being re-encoded per advertisement.
 */
const V2_ADVERTISEMENT = encodePktLines([
  '# service=git-upload-pack\n',
  'flush',
  'version 2\n',
  'ls-refs=unborn\n',
  'fetch=shallow filter\n',
  'flush',
]);

/**
 * A v0 ref advertisement: the `# service=...` preamble, then one line per ref
 * (`<oid> <refname>`, the first line carrying the capabilities after a NUL), then a
 * flush. An empty repo advertises the single `capabilities^{}` pseudo-ref line.
 */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const symref = `symref=HEAD:refs/heads/${repo.headBranch}`;
  const caps =
    service === 'git-receive-pack'
      ? ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', symref]
      : ['side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', symref];
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`);
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.headBranch}`) ?? ZERO_OID;
    lines.push(`${headOid} HEAD\0${caps.join(' ')}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  return encodePktLines([`# service=${service}\n`, 'flush', ...lines, 'flush']);
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, url: ParsedRequestUrl): void {
  const service = url.searchParams.get('service');
  if (service === 'git-upload-pack') {
    const body = wantsV2(req) ? V2_ADVERTISEMENT : v0Advertisement(repo, 'git-upload-pack');
    sendGit(res, 200, UPLOAD_ADVERTISEMENT, body);
    return;
  }
  if (service === 'git-receive-pack') {
    sendGit(res, 200, RECEIVE_ADVERTISEMENT, v0Advertisement(repo, 'git-receive-pack'));
    return;
  }
  sendError(res, 400, 'Bad Request: service parameter is required');
}

// ── Upload-pack ───────────────────────────────────────────────────────────────

function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  try {
    if (wantsV2(req)) handleUploadPackV2(res, repo, body);
    else handleUploadPackV0(res, repo, body);
  } catch (err) {
    // A malformed request answers a git error pkt-line — never a crash, never a hang.
    if (!res.headersSent) {
      const message = oneLine(err instanceof Error ? err.message : 'malformed request');
      sendGit(res, 200, UPLOAD_RESULT, encodePktLines([`ERR ${message}\n`, 'flush']));
    } else {
      res.end();
    }
  }
}

/** The haves that are ancestors of the wants (what the acknowledgments section ACKs). */
function commonHaves(repo: Repo, wants: readonly string[], haves: readonly string[]): string[] {
  const reachable = new Set<string>();
  for (const want of wants) {
    const peeled = peelTag(repo, want);
    const object = getObject(repo, peeled.oid);
    if (object !== undefined && object.type === 'commit') {
      for (const commit of walkCommits(repo, peeled.oid)) reachable.add(commit);
    }
  }
  const common: string[] = [];
  for (const have of haves) {
    const oid = have.toLowerCase();
    if (reachable.has(oid)) common.push(oid);
  }
  return common;
}

function handleUploadPackV2(res: ServerResponse, repo: Repo, body: Buffer): void {
  const { packets, rest } = decodePktLinesAll(body);
  if (rest.length !== 0) throw new Error('trailing bytes after the pkt-line stream');
  const first = packets[0];
  if (first === undefined || first.kind !== 'data') throw new Error('missing command');
  const commandLine = first.payload.toString('utf8');
  if (!commandLine.startsWith('command=')) throw new Error('expected a command= line');
  const command = commandLine.slice('command='.length).trim();
  const last = packets[packets.length - 1];
  if (last === undefined || last.kind !== 'flush') throw new Error('request does not end with a flush');

  // Arguments live after the delim packet; the options before it (agent=, object-format=)
  // are accepted and ignored.
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const argPackets = delimIndex === -1 ? [] : packets.slice(delimIndex + 1);
  const args: string[] = [];
  for (const packet of argPackets) {
    if (packet.kind === 'data') args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }

  if (command === 'ls-refs') {
    handleLsRefs(res, repo, args);
    return;
  }
  if (command === 'fetch') {
    handleFetchV2(res, repo, args);
    return;
  }
  sendGit(res, 200, UPLOAD_RESULT, encodePktLines([`ERR unknown command ${oneLine(command)}\n`, 'flush']));
}

function handleLsRefs(res: ServerResponse, repo: Repo, args: readonly string[]): void {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  // ref-limit and any other argument are accepted and ignored.
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const lines: string[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.headBranch}`);
  if (matches('HEAD')) {
    const symrefAttr = symrefs ? ` symref-target:refs/heads/${repo.headBranch}` : '';
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${symrefAttr}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefAttr}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  sendGit(res, 200, UPLOAD_RESULT, encodePktLines([...lines, 'flush']));
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenRelative?: boolean;
  filter?: string;
  /** The client sent `done`: negotiation is over, the packfile goes out now. */
  done?: boolean;
}

/** Parse the fetch arguments shared by v2 (pkt-line args) and v0 (want/have lines). */
function parseFetchArgs(lines: readonly string[], v0: boolean): FetchArgs {
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const line of lines) {
    if (line.startsWith('want ')) {
      // A v0 first want line may carry capabilities after the oid: `want <oid> <caps>`.
      const rest = line.slice(5).trim();
      const oid = v0 ? (rest.split(' ')[0] as string) : rest;
      parsed.wants.push(oid);
    } else if (line.startsWith('have ')) {
      parsed.haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      parsed.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(depth) && depth > 0) parsed.depth = depth;
    } else if (line === 'deepen-relative') {
      parsed.deepenRelative = true;
    } else if (line === 'done') {
      parsed.done = true;
    } else if (line.startsWith('filter ')) {
      parsed.filter = line.slice(7).trim();
    }
    // thin-pack, no-progress, ofs-delta, include-tag, deepen-since,
    // deepen-not: accepted, ignored.
  }
  return parsed;
}

/**
 * The fetch-response cache key (perf round 2). A fetch response is a pure
 * function of (protocol, request args, object store): the generation pins the
 * store state (bumped on every object write, which also clears the cache), and
 * the args are joined in their given order — haves order shapes the ACK
 * section, shallow order shapes the shallow-info section, so they are NOT
 * sorted. The bench's 50 concurrent clones send byte-identical fetch requests
 * for the same tip, so every clone after the first is a cache hit.
 */
function fetchCacheKey(repo: Repo, fetch: FetchArgs, protocol: 'v2' | 'v0'): string {
  return [
    protocol,
    repo.generation,
    fetch.wants.join(','),
    fetch.haves.join(','),
    fetch.shallow.join(','),
    fetch.depth ?? '',
    fetch.deepenRelative === true ? '1' : '0',
    fetch.filter ?? '',
    fetch.done === true ? '1' : '0',
  ].join('|');
}

function handleFetchV2(res: ServerResponse, repo: Repo, args: readonly string[]): void {
  const fetch = parseFetchArgs(args, false);
  for (const want of fetch.wants) {
    if (getObject(repo, want) === undefined) {
      sendGit(res, 200, UPLOAD_RESULT, encodePktLines([`ERR object ${oneLine(want)} not found\n`, 'flush']));
      return;
    }
  }
  // The whole response is a pure function of (args, object store): a cached
  // fetch for this exact key is byte-identical to a fresh build (perf round 2).
  const cacheKey = fetchCacheKey(repo, fetch, 'v2');
  const cached = getCachedFetch(repo, cacheKey);
  if (cached !== undefined) {
    sendGit(res, 200, UPLOAD_RESULT, cached);
    return;
  }
  // An ACK means "the server has this object" (canonical upload-pack ACKs every
  // have it holds, whether or not it is an ancestor of a want). `ready` means a
  // common base was found and the packfile follows in this response. `ready` is
  // only consulted for a negotiation round with haves and no `done` — and
  // commonHaves walks the whole history, so it is computed lazily: a haveless
  // clone or a `done` fetch never pays for the walk.
  const existingHaves = fetch.haves
    .map((have) => have.toLowerCase())
    .filter((have) => getObject(repo, have) !== undefined);
  const needsCommon = !fetch.done && fetch.haves.length > 0;
  const ready = needsCommon && commonHaves(repo, fetch.wants, fetch.haves).length > 0;

  // Negotiation round with no common base and no `done`: send ONLY the ack
  // section and end the response with a flush. Real git then sends a follow-up
  // request with `done` (verified against a local git daemon). Sending further
  // sections here makes real git die ("expected no other sections to be sent
  // after no 'ready'").
  if (!fetch.done && fetch.haves.length > 0 && !ready) {
    const ack: Array<string | 'flush'> = ['acknowledgments\n'];
    if (existingHaves.length > 0) {
      for (const oid of existingHaves) ack.push(`ACK ${oid}\n`);
    } else {
      ack.push('NAK\n');
    }
    ack.push('flush');
    const body = encodePktLines(ack);
    setCachedFetch(repo, cacheKey, body);
    sendGit(res, 200, UPLOAD_RESULT, body);
    return;
  }

  // Otherwise the packfile goes out in this response: a `done` request (the kit
  // client always sends one; real git sends one in round 2), a haveless fetch
  // (a clone), or a negotiation round that found a common base (`ready`).
  const { objects, shallow, unshallow } = collectObjects(repo, fetch.wants, new Set(fetch.haves), {
    depth: fetch.depth,
    deepenRelative: fetch.deepenRelative,
    shallow: new Set(fetch.shallow),
    filter: fetch.filter,
  });
  const pack = buildPack(objects, repo.deflatedObjects);

  // Sections are separated by DELIM packets (0001); a single FLUSH (0000) ends the
  // whole response. A flush between sections would end the response early — real git
  // dies ("expected packfile to be sent after 'ready'") if it sees one there.
  // The acknowledgments section appears only in the no-`done` + `ready` case: a
  // `done` response carries no ack section (canonical upload-pack sends just the
  // packfile after `done`, and the kit client never reads acks), and a haveless
  // fetch goes straight to the packfile section.
  const head: Array<string | 'delim'> = [];
  if (!fetch.done && fetch.haves.length > 0) {
    head.push('acknowledgments\n');
    for (const oid of existingHaves) head.push(`ACK ${oid}\n`);
    head.push('ready\n');
    head.push('delim');
  }
  if (fetch.depth !== undefined || fetch.shallow.length > 0) {
    head.push('shallow-info\n');
    for (const oid of shallow) head.push(`shallow ${oid}\n`);
    for (const oid of unshallow) head.push(`unshallow ${oid}\n`);
    head.push('delim');
  }
  head.push('packfile\n');
  const body = Buffer.concat([encodePktLines(head), sidebandPackets(1, pack), pktFlush()]);
  setCachedFetch(repo, cacheKey, body);
  sendGit(res, 200, UPLOAD_RESULT, body);
}

function handleUploadPackV0(res: ServerResponse, repo: Repo, body: Buffer): void {
  const { packets, rest } = decodePktLinesAll(body);
  if (rest.length !== 0) throw new Error('trailing bytes after the pkt-line stream');
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const fetch = parseFetchArgs(lines, true);
  for (const want of fetch.wants) {
    if (getObject(repo, want) === undefined) {
      sendGit(res, 200, UPLOAD_RESULT, encodePktLines([`ERR object ${oneLine(want)} not found\n`, 'flush']));
      return;
    }
  }
  // Same pure-function argument as the v2 fetch (perf round 2).
  const cacheKey = fetchCacheKey(repo, fetch, 'v0');
  const cached = getCachedFetch(repo, cacheKey);
  if (cached !== undefined) {
    sendGit(res, 200, UPLOAD_RESULT, cached);
    return;
  }
  const { objects, shallow, unshallow } = collectObjects(repo, fetch.wants, new Set(fetch.haves), {
    depth: fetch.depth,
    deepenRelative: fetch.deepenRelative,
    shallow: new Set(fetch.shallow),
    filter: fetch.filter,
  });
  const pack = buildPack(objects, repo.deflatedObjects);
  // With no haves there is no common base by definition: NAK without the walk.
  const common = fetch.haves.length === 0 ? [] : commonHaves(repo, fetch.wants, fetch.haves);

  const head: string[] = [];
  for (const oid of shallow) head.push(`shallow ${oid}\n`);
  for (const oid of unshallow) head.push(`unshallow ${oid}\n`);
  if (common.length > 0) {
    for (const oid of common) head.push(`ACK ${oid}\n`);
  } else {
    head.push('NAK\n');
  }
  const out = Buffer.concat([encodePktLines(head), sidebandPackets(1, pack), pktFlush()]);
  setCachedFetch(repo, cacheKey, out);
  sendGit(res, 200, UPLOAD_RESULT, out);
}

// ── Receive-pack ──────────────────────────────────────────────────────────────

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface RefReport {
  ref: string;
  ok: boolean;
  reason: string;
}

/** True when `ancestor` is reachable from `tip` (parent walk, stopped at the first hit). */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const parsed = parsedCommit(repo, oid);
    if (parsed === null) continue;
    for (const parent of parsed.parents) stack.push(parent);
  }
  return false;
}

/**
 * Validate one push command against the current refs and apply it when it is ok.
 * The non-fast-forward reason is the exact string the checks assert.
 */
function applyPushCommand(repo: Repo, command: PushCommand): RefReport {
  const current = repo.refs.get(command.ref);
  const isCreate = command.oldOid === ZERO_OID;
  const isDelete = command.newOid === ZERO_OID;

  if (isDelete) {
    if (current === undefined) return { ref: command.ref, ok: false, reason: 'remote ref does not exist' };
    if (!isCreate && command.oldOid !== current) return { ref: command.ref, ok: false, reason: 'stale info' };
    repo.refs.delete(command.ref);
    return { ref: command.ref, ok: true, reason: '' };
  }

  const object = getObject(repo, command.newOid);
  if (object === undefined) return { ref: command.ref, ok: false, reason: 'object not found' };
  if (command.ref.startsWith('refs/heads/') && object.type !== 'commit') {
    return { ref: command.ref, ok: false, reason: 'not a commit' };
  }

  if (isCreate) {
    if (current !== undefined) return { ref: command.ref, ok: false, reason: 'already exists' };
    repo.refs.set(command.ref, command.newOid);
    return { ref: command.ref, ok: true, reason: '' };
  }

  if (current === undefined) return { ref: command.ref, ok: false, reason: 'remote ref does not exist' };
  if (command.oldOid !== current) return { ref: command.ref, ok: false, reason: 'stale info' };
  if (command.newOid === current) return { ref: command.ref, ok: true, reason: '' }; // a no-op update
  if (!isAncestor(repo, command.oldOid, command.newOid)) {
    return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(command.ref, command.newOid);
  return { ref: command.ref, ok: true, reason: '' };
}

function handleReceivePack(res: ServerResponse, repo: Repo, body: Buffer): void {
  try {
    const { packets, rest } = decodePktLinesAll(body, { stopAtFlush: true });
    const last = packets[packets.length - 1];
    if (last === undefined || last.kind !== 'flush') {
      sendError(res, 400, 'Bad Request: malformed receive-pack stream');
      return;
    }

    const commands: PushCommand[] = [];
    let wantSideband = false;
    const commandPackets = packets.filter((packet) => packet.kind === 'data');
    for (let index = 0; index < commandPackets.length; index += 1) {
      let line = (commandPackets[index] as { kind: 'data'; payload: Buffer }).payload.toString('utf8').replace(/\n$/, '');
      if (index === 0) {
        // The first command line carries the client's capabilities after a NUL.
        const nul = line.indexOf('\0');
        if (nul !== -1) {
          const caps = line.slice(nul + 1).split(' ');
          wantSideband = caps.includes('side-band-64k');
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(' ');
      if (parts.length !== 3) {
        sendError(res, 400, 'Bad Request: malformed push command');
        return;
      }
      const [oldOid, newOid, ref] = parts as [string, string, string];
      if (!SHA40.test(oldOid) || !SHA40.test(newOid) || !ref.startsWith('refs/')) {
        sendError(res, 400, 'Bad Request: malformed push command');
        return;
      }
      commands.push({ oldOid: oldOid.toLowerCase(), newOid: newOid.toLowerCase(), ref });
    }

    // Unpack FIRST: an unpack failure reports `unpack error` + ng for every ref and
    // applies nothing. A delete-only push carries no pack at all (unpack trivially ok).
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (rest.length > 0) {
      try {
        const parsed = parsePack(rest, (oid) => getObject(repo, oid));
        let storedNew = false;
        for (const object of parsed) {
          if (!repo.objects.has(object.oid)) {
            repo.objects.set(object.oid, { type: object.type, data: object.data });
            storedNew = true;
          }
        }
        // New objects change what a fetch can return: bump the generation so
        // cached fetch bytes are dropped (perf round 2). A push that stores
        // nothing new (all duplicates) leaves the cache untouched.
        if (storedNew) bumpGeneration(repo);
      } catch (err) {
        unpackOk = false;
        unpackDetail = oneLine(err instanceof Error ? err.message : 'unpack failed');
      }
    }

    const reports: RefReport[] = [];
    if (unpackOk) {
      const hadNoRefs = repo.refs.size === 0;
      let firstCreatedBranch: string | null = null;
      for (const command of commands) {
        const report = applyPushCommand(repo, command);
        reports.push(report);
        if (report.ok && command.oldOid === ZERO_OID && command.ref.startsWith('refs/heads/') && firstCreatedBranch === null) {
          firstCreatedBranch = command.ref.slice('refs/heads/'.length);
        }
      }
      // The first branch created on an empty repo defines HEAD.
      if (hadNoRefs && firstCreatedBranch !== null) repo.headBranch = firstCreatedBranch;
      // Deleting the HEAD branch re-points HEAD at the first remaining branch.
      if (repo.refs.get(`refs/heads/${repo.headBranch}`) === undefined) {
        const remaining = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
        if (remaining.length > 0) repo.headBranch = (remaining[0] as string).slice('refs/heads/'.length);
      }
      if (reports.some((report) => report.ok)) touchRepo(repo);
    } else {
      for (const command of commands) {
        reports.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      }
    }

    const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack error ${unpackDetail}\n`];
    for (const report of reports) {
      reportLines.push(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${oneLine(report.reason)}\n`);
    }
    let out: Buffer;
    if (wantSideband) {
      // With side-band-64k the report-status stream is itself pkt-lined inside band 1:
      // each report pkt-line rides in its own sideband packet — INCLUDING the stream's
      // terminating flush. Git's report parser reads pkt-lines from the demuxed stream
      // and treats EOF without a flush as a hangup ("the remote end hung up").
      const frames: Buffer[] = [];
      for (const line of reportLines) frames.push(sidebandPackets(1, encodePktLine(line)));
      frames.push(sidebandPackets(1, pktFlush()));
      out = Buffer.concat([...frames, pktFlush()]);
    } else {
      out = Buffer.concat([encodePktLines(reportLines), pktFlush()]);
    }
    sendGit(res, 200, RECEIVE_RESULT, out);
  } catch (err) {
    if (!res.headersSent) {
      sendError(res, 500, 'Internal Server Error');
    } else {
      res.end();
    }
    void err;
  }
}
