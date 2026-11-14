// mcp.ts — Model Context Protocol endpoint (POST /mcp, streamable HTTP).
//
// STUB: replaced by the MCP slice. The real handler speaks JSON-RPC 2.0:
// initialize, tools/list, tools/call over the store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendNotFound } from './rest.ts';

/** Handle /mcp. Stub: standard JSON 404 until the MCP slice lands. */
export function handleMcp(_req: IncomingMessage, res: ServerResponse): void {
  sendNotFound(res);
}
