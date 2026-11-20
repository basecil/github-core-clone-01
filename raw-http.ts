// raw-http.ts — a hand-rolled HTTP/1.1 server over node:net (perf round 3).
//
// Why: the round-3 profile + a transport experiment showed node:http's
// per-request machinery (llhttp header callbacks, IncomingMessage /
// ServerResponse + stream construction, header serialization) costs ~36µs
// per exchange on this VM, while a raw socket server answering the same fixed
// response costs ~22µs. The bench drives ~8,300 exchanges per full run, so
// the transport alone is worth ~115ms of server CPU. This module replaces
// node:http with a minimal parser + shims that present exactly the surface
// the handlers use (forge-http.ts), so no handler changes behavior.
//
// What it implements (deliberately small, but complete for real clients):
//   * HTTP/1.1 request line + headers (latin1, names lowercased, values
//     trimmed), keep-alive by default, `Connection: close` honored, HTTP/1.0
//     without keep-alive closes after the response.
//   * Bodies by Content-Length or chunked transfer-encoding; `Expect:
//     100-continue` answered with the interim response.
//   * Pipelined requests on one socket: parsed in order, dispatched
//     sequentially, responses written in request order.
//   * Malformed requests get the same 400 JSON body node:http's clientError
//     path sent, then the socket closes.
//   * Responses are one Buffer (status line + headers + body) per write, with
//     a per-second cached Date header like node:http's. Handlers always set
//     Content-Length; when one does not, it is computed from the body. 204 /
//     304 never carry a body, and HEAD answers send headers only.
//
// Limits: headers ≤64 KiB, bodies ≤64 MiB (the largest any handler accepts —
// git). A request over either limit is answered 400 and the socket closes.
// The body is fully buffered before the handler runs, so the request shim
// replays it from memory (listeners or `for await`); the handler-level size
// checks in readBody/readJsonBody still apply on top.

import net from 'node:net';
import type { ForgeRequest, ForgeResponse } from './forge-http.ts';

export type RawRequestListener = (req: ForgeRequest, res: ForgeResponse) => void;

const EMPTY = Buffer.alloc(0);
const HEADER_END = Buffer.from('\r\n\r\n');
const MAX_HEADER_BYTES = 64 * 1024;
/** Largest body the parser buffers: the git limit (64 MiB); REST caps at 10 MiB inside its reader. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/** Date header value, cached per second — the same trick node:http uses. */
let cachedDate = '';
let cachedDateSecond = -1;
function dateHeader(): string {
  const second = Math.floor(Date.now() / 1000);
  if (second !== cachedDateSecond) {
    cachedDateSecond = second;
    cachedDate = new Date(second * 1000).toUTCString();
  }
  return cachedDate;
}

// ── Request shim ──────────────────────────────────────────────────────────────

/**
 * A parsed request: method, raw URL, headers, and the fully buffered body.
 * Body delivery replays from memory: 'data' listeners get the body as one
 * chunk (handlers Buffer.concat anyway), then 'end'; `for await` yields the
 * same single chunk. Listeners attached after the body arrived still fire —
 * emission is scheduled on nextTick, so a reader that attaches data/end/error
 * synchronously (as readBody does) sees all three.
 */
class RawRequest implements ForgeRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: Record<string, string | undefined>;
  private readonly body: Buffer;
  private destroyedFlag = false;
  private emissionScheduled = false;
  private readonly dataListeners: Array<(chunk: Buffer) => void> = [];
  private readonly endListeners: Array<() => void> = [];
  private readonly errorListeners: Array<(err: Error) => void> = [];

  constructor(method: string, url: string, headers: Record<string, string | undefined>, body: Buffer) {
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.body = body;
  }

  on(event: 'data', listener: (chunk: Buffer) => void): this {
    this.dataListeners.push(listener);
    this.scheduleEmission();
    return this;
  }

  once(event: 'end', listener: () => void): this;
  once(event: 'error', listener: (err: Error) => void): this;
  once(event: 'end' | 'error', listener: ((() => void) | ((err: Error) => void))): this {
    if (event === 'end') this.endListeners.push(listener as () => void);
    else this.errorListeners.push(listener as (err: Error) => void);
    this.scheduleEmission();
    return this;
  }

  destroy(): void {
    this.destroyedFlag = true;
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    let done = false;
    const body = this.body;
    const destroyed = (): boolean => this.destroyedFlag;
    return {
      next(): Promise<IteratorResult<Buffer>> {
        if (done || body.length === 0 || destroyed()) {
          done = true;
          return Promise.resolve({ done: true, value: undefined });
        }
        done = true;
        return Promise.resolve({ done: false, value: body });
      },
      return(): Promise<IteratorResult<Buffer>> {
        done = true;
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  private scheduleEmission(): void {
    if (this.emissionScheduled) return;
    this.emissionScheduled = true;
    process.nextTick(() => {
      if (this.destroyedFlag) return;
      if (this.body.length > 0) {
        for (const listener of this.dataListeners) listener(this.body);
      }
      for (const listener of this.endListeners) listener();
    });
  }
}

// ── Response shim ─────────────────────────────────────────────────────────────

/**
 * A response: writeHead stores status + headers, end builds one Buffer
 * (status line + headers + body) and writes it. end() is idempotent, and
 * calling it without writeHead answers 200 with just Date + Content-Length.
 * `onFinished` fires synchronously after the bytes are queued — socket writes
 * preserve order, so the next pipelined request may start at once.
 */
class RawResponse implements ForgeResponse {
  headersSent = false;
  private status = 200;
  private readonly headerMap: Record<string, string> = {};
  private ended = false;
  private readonly socket: net.Socket;
  private readonly isHead: boolean;
  private readonly onFinished: () => void;

  constructor(socket: net.Socket, isHead: boolean, onFinished: () => void) {
    this.socket = socket;
    this.isHead = isHead;
    this.onFinished = onFinished;
  }

  writeHead(status: number, headers: Readonly<Record<string, string | number>>): void {
    this.status = status;
    for (const [name, value] of Object.entries(headers)) this.headerMap[name.toLowerCase()] = String(value);
    this.headersSent = true;
  }

  end(chunk?: string | Buffer): void {
    if (this.ended) return;
    this.ended = true;
    this.headersSent = true;
    const noBody = this.status === 204 || this.status === 304 || this.isHead;
    const body = chunk === undefined ? EMPTY : typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    const reason = REASONS[this.status];
    const lines = [`HTTP/1.1 ${this.status}${reason === undefined ? '' : ` ${reason}`}`, `date: ${dateHeader()}`];
    let hasLength = false;
    for (const [name, value] of Object.entries(this.headerMap)) {
      if (name === 'content-length') hasLength = true;
      lines.push(`${name}: ${value}`);
    }
    if (!noBody && !hasLength) lines.push(`content-length: ${body.length}`);
    const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'ascii');
    const out = noBody || body.length === 0 ? head : Buffer.concat([head, body]);
    this.socket.write(out);
    this.onFinished();
  }
}

// ── Parser ────────────────────────────────────────────────────────────────────

interface ParsedRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
  /** Bytes after this request in the buffer (a pipelined next request). */
  rest: Buffer;
  closeAfter: boolean;
}

type ParseResult =
  | { kind: 'need-more'; expectContinue: boolean }
  | { kind: 'error' }
  | { kind: 'request'; request: ParsedRequest };

/** Parse one request from the front of `buf`, or say why it cannot yet. Pure: no I/O. */
function tryParse(buf: Buffer): ParseResult {
  const headerEnd = buf.indexOf(HEADER_END);
  if (headerEnd === -1) {
    if (buf.length > MAX_HEADER_BYTES) return { kind: 'error' };
    return { kind: 'need-more', expectContinue: false };
  }
  const headText = buf.subarray(0, headerEnd).toString('latin1');
  const lines = headText.split('\r\n');
  const requestLine = lines[0].split(' ');
  if (requestLine.length !== 3 || !requestLine[2].startsWith('HTTP/')) return { kind: 'error' };
  const [method, url, version] = requestLine;
  if (method === '' || url === '' || version.length < 6) return { kind: 'error' };
  const headers: Record<string, string | undefined> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon <= 0) return { kind: 'error' };
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const prev = headers[name];
    headers[name] = prev === undefined ? value : `${prev}, ${value}`;
  }
  const expectContinue = (headers['expect'] ?? '').toLowerCase() === '100-continue';
  const afterHeaders = headerEnd + 4;
  const transferEncoding = (headers['transfer-encoding'] ?? '').toLowerCase();
  if (transferEncoding.includes('chunked')) {
    const decoded = decodeChunked(buf.subarray(afterHeaders));
    if (decoded === 'error') return { kind: 'error' };
    if (decoded === null) return { kind: 'need-more', expectContinue };
    if (decoded.body.length > MAX_BODY_BYTES) return { kind: 'error' };
    return { kind: 'request', request: finish(method, url, version, headers, decoded.body, buf.subarray(afterHeaders + decoded.consumed)) };
  }
  const lengthRaw = headers['content-length'];
  if (lengthRaw !== undefined) {
    if (!/^\d+$/.test(lengthRaw)) return { kind: 'error' };
    const length = Number(lengthRaw);
    if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) return { kind: 'error' };
    if (buf.length - afterHeaders < length) return { kind: 'need-more', expectContinue };
    const body = buf.subarray(afterHeaders, afterHeaders + length);
    return { kind: 'request', request: finish(method, url, version, headers, body, buf.subarray(afterHeaders + length)) };
  }
  return { kind: 'request', request: finish(method, url, version, headers, EMPTY, buf.subarray(afterHeaders)) };
}

function finish(
  method: string,
  url: string,
  version: string,
  headers: Record<string, string | undefined>,
  body: Buffer,
  rest: Buffer,
): ParsedRequest {
  const connection = (headers['connection'] ?? '').toLowerCase();
  const closeAfter = connection.includes('close') || (version === 'HTTP/1.0' && !connection.includes('keep-alive'));
  return { method, url, headers, body, rest, closeAfter };
}

/**
 * Decode a chunked body: 'error' on malformed framing, null when more bytes
 * are needed, otherwise the body plus the bytes consumed (through the final
 * chunk's CRLF and any trailers).
 */
function decodeChunked(buf: Buffer): 'error' | null | { body: Buffer; consumed: number } {
  const chunks: Buffer[] = [];
  let total = 0;
  let offset = 0;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd === -1) return null;
    const sizeText = buf.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0].trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) return 'error';
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isSafeInteger(size)) return 'error';
    offset = lineEnd + 2;
    if (size === 0) {
      // Trailers end at an empty line.
      const trailerEnd = buf.indexOf('\r\n', offset);
      if (trailerEnd === -1) return null;
      if (trailerEnd !== offset) {
        // One or more trailer lines: scan to the blank line.
        const blank = buf.indexOf('\r\n\r\n', offset);
        if (blank === -1) return null;
        return { body: Buffer.concat(chunks), consumed: blank + 4 };
      }
      return { body: Buffer.concat(chunks), consumed: offset + 2 };
    }
    if (buf.length - offset < size + 2) return null;
    if (buf[offset + size] !== 13 || buf[offset + size + 1] !== 10) return 'error';
    total += size;
    if (total > MAX_BODY_BYTES) return 'error';
    chunks.push(buf.subarray(offset, offset + size));
    offset += size + 2;
  }
}

// ── Server ────────────────────────────────────────────────────────────────────

const BAD_REQUEST_BODY = `${JSON.stringify({ message: 'Bad Request' })}\n`;

/** Answer a malformed request the way node:http's clientError path did, then close. */
function sendBadRequest(socket: net.Socket): void {
  const head =
    `HTTP/1.1 400 Bad Request\r\ncontent-type: application/json; charset=utf-8\r\n` +
    `content-length: ${Buffer.byteLength(BAD_REQUEST_BODY)}\r\nconnection: close\r\ndate: ${dateHeader()}\r\n\r\n`;
  socket.end(`${head}${BAD_REQUEST_BODY}`);
}

/**
 * Create the raw server. `listener` is invoked once per request, in arrival
 * order per socket; the next request on a socket starts only after the
 * previous response's end() — responses can never interleave.
 */
export function createRawServer(listener: RawRequestListener): net.Server {
  return net.createServer((socket) => {
    socket.setNoDelay(true);
    // Plain `Buffer` (ArrayBufferLike) on purpose: socket chunks and subarrays
    // are Buffer<ArrayBufferLike> in @types/node 22, and Buffer.alloc(0) would
    // otherwise infer the narrower Buffer<ArrayBuffer>.
    let buf: Buffer = Buffer.alloc(0);
    let queue: Promise<void> = Promise.resolve();
    let expectSent = false;
    let dead = false;

    socket.on('data', (chunk: Buffer) => {
      if (dead) return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      pump();
    });
    socket.on('error', () => {
      dead = true;
    });
    socket.on('close', () => {
      dead = true;
    });

    function pump(): void {
      for (;;) {
        if (dead) return;
        const parsed = tryParse(buf);
        if (parsed.kind === 'error') {
          dead = true;
          sendBadRequest(socket);
          return;
        }
        if (parsed.kind === 'need-more') {
          if (parsed.expectContinue && !expectSent) {
            expectSent = true;
            socket.write('HTTP/1.1 100 Continue\r\n\r\n');
          }
          return;
        }
        const req = parsed.request;
        buf = req.rest;
        expectSent = false;
        const { method, url, headers, body, closeAfter } = req;
        queue = queue.then(
          () =>
            new Promise<void>((resolve) => {
              const request = new RawRequest(method, url, headers, body);
              const response = new RawResponse(socket, method === 'HEAD', () => {
                if (closeAfter) socket.end();
                resolve();
              });
              listener(request, response);
            }),
        );
      }
    }
  });
}
