// app.ts — the forge's HTTP server: health probe, API root, and the mount table.
//
// The router is a `mounts` table: one line per prefix.
//
//   GET /healthz        200 {"ok":true}, no auth (the env's boot probe)
//   /api/v3/*           REST v3 (rest.ts), including pull requests (pulls.ts)
//   /api/graphql        GraphQL v4 (graphql.ts)
//   /mcp                MCP over streamable HTTP (mcp.ts)
//   /*.git/*            git smart HTTP (git-http.ts): protocol v2 upload-pack,
//                       v0 receive-pack, info/refs advertisements
//   anything else       404 {"message":"Not Found"} (JSON, with a request id)
//
// Every reply is JSON and carries X-GitHub-Request-Id (see rest.ts sendJson).
// A handler that throws answers 500 JSON; the server stays up.

import type { Server } from 'node:net';
import type { ForgeRequest, ForgeResponse } from './forge-http.ts';
import { handleGit } from './git-http.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { createRawServer } from './raw-http.ts';
import {
  handleRest,
  parseRequestUrl,
  sendError,
  sendJson,
  sendNotFound,
  type ParsedRequestUrl,
} from './rest.ts';

/**
 * A mount handler. The router parses the request URL once and hands the parsed
 * form to the handler (perf round 2: rest.ts and git-http.ts used to re-parse
 * it); a handler that does not need the URL ignores the third argument.
 */
type Handler = (req: ForgeRequest, res: ForgeResponse, url?: ParsedRequestUrl) => Promise<void> | void;

interface Mount {
  /** Human name for the mount (logs/diagnostics only). */
  name: string;
  /** True when this mount owns the request path. */
  test: (path: string) => boolean;
  /** The handler for this mount. */
  handler: Handler;
}

/**
 * The mount table — one line per prefix.
 */
const mounts: readonly Mount[] = [
  { name: 'rest-v3', test: (path) => path === '/api/v3' || path.startsWith('/api/v3/'), handler: handleRest },
  { name: 'graphql-v4', test: (path) => path === '/api/graphql' || path.startsWith('/api/graphql/'), handler: handleGraphQL },
  { name: 'mcp', test: (path) => path === '/mcp' || path.startsWith('/mcp/'), handler: handleMcp },
  {
    name: 'git-smart-http',
    test: (path) => path.includes('.git/') || path.endsWith('.git'),
    handler: handleGit,
  },
];

/**
 * Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port.
 *
 * Transport (perf round 3): a hand-rolled HTTP/1.1 server over node:net
 * (raw-http.ts) instead of node:http — the same dispatch, the same handlers,
 * ~14µs less per exchange in the transport experiment. Malformed requests
 * are answered 400 + close inside the transport (what node:http's
 * clientError handler did).
 */
export function createApp(): Server {
  const server = createRawServer((req: ForgeRequest, res: ForgeResponse) => {
    // The URL is parsed ONCE here; the parsed form is passed to the mount
    // handler so no request pays for a second parse (perf round 2).
    const url = parseRequestUrl(req);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}, no auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    for (const mount of mounts) {
      if (!mount.test(path)) continue;
      // Invoke the handler directly (perf round 3): the old
      // Promise.resolve().then(() => handler(...)) cost a microtask hop and a
      // promise per request. Semantics unchanged — a sync throw and a rejected
      // promise both answer 500 and keep the server up.
      const onHandlerError = (): void => {
        if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
        else res.end();
      };
      let result: Promise<void> | void;
      try {
        result = mount.handler(req, res, url);
      } catch {
        onHandlerError();
        return;
      }
      if (result !== undefined) result.catch(onHandlerError);
      return;
    }

    // Everything else, every method: GitHub's 404 body.
    sendNotFound(res);
  });

  return server;
}
