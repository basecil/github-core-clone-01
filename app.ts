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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git-http.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, parseRequestUrl, sendError, sendJson, sendNotFound } from './rest.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

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

/** The path of a request URL, or '/' when it does not parse (never a throw). */
function pathOf(req: IncomingMessage): string {
  return parseRequestUrl(req).pathname;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}, no auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    for (const mount of mounts) {
      if (!mount.test(path)) continue;
      Promise.resolve()
        .then(() => mount.handler(req, res))
        .catch(() => {
          // A handler bug must never take the server down or hang the client.
          if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
          else res.end();
        });
      return;
    }

    // Everything else, every method: GitHub's 404 body.
    sendNotFound(res);
  });

  // A malformed HTTP request line still gets a JSON answer, not a bare socket close.
  server.on('clientError', (err: Error, socket) => {
    const body = `${JSON.stringify({ message: 'Bad Request' })}\n`;
    socket.end(
      `HTTP/1.1 400 Bad Request\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
    void err;
  });

  return server;
}
