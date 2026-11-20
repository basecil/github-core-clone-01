// forge-http.ts — the minimal request/response surface the forge handlers use.
//
// The handlers never touch node:http's stream machinery: they read method,
// url and three headers, read the body (listener form or `for await`), and
// answer with writeHead + end. This interface is that surface exactly, so the
// transport (node:http before, the raw node:net server now — raw-http.ts) can
// change without the handlers knowing. Both node:http's IncomingMessage /
// ServerResponse and the raw shims satisfy it.

/** The request surface handlers use. */
export interface ForgeRequest {
  method: string | undefined;
  url: string | undefined;
  /** Header names are lowercased; values are trimmed. */
  headers: Record<string, string | undefined>;
  /** Body-chunk listener (readBody/readJsonBody form). */
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  /** End/error listeners (readBody/readJsonBody form). */
  once(event: 'end', listener: () => void): this;
  once(event: 'error', listener: (err: Error) => void): this;
  /** Stop body delivery (overflow path). */
  destroy(): void;
  /** Body iteration (graphql.ts / mcp.ts `for await` form). */
  [Symbol.asyncIterator](): AsyncIterator<Buffer>;
}

/** The response surface handlers use. */
export interface ForgeResponse {
  readonly headersSent: boolean;
  /** Header values may be numbers (Content-Length) — node:http accepts those too. */
  writeHead(status: number, headers: Readonly<Record<string, string | number>>): void;
  end(chunk?: string | Buffer): void;
}
