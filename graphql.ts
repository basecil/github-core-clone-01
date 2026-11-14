// graphql.ts — GitHub GraphQL v4 endpoint (POST /api/graphql).
//
// STUB: replaced by the GraphQL slice. The real handler parses the documents gh
// and github-mcp-server send and resolves them against the store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendNotFound } from './rest.ts';

/** Handle POST /api/graphql. Stub: standard JSON 404 until the GraphQL slice lands. */
export function handleGraphQL(_req: IncomingMessage, res: ServerResponse): void {
  sendNotFound(res);
}
