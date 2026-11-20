// pktline.ts — git pkt-line framing + sideband helpers for the smart-HTTP server.
//
// The wire format (see the kit's git-client.ts, the protocol reference):
//   * a data packet is 4 lowercase-hex length bytes (payload + 4) then the payload;
//     the largest packet is 65520 bytes total (git's LARGE_PACKET_MAX).
//   * 0000 = flush, 0001 = delim, 0002 = response-end.
//   * sideband framing (used by the fetch packfile section and the push report-status
//     stream): each pkt-line payload is 1 channel byte (1 = data, 2 = progress,
//     3 = error) + up to 65515 bytes of payload.
//
// ── API surface ────────────────────────────────────────────────────────────────
//   encodePktLine(payload)           — one data packet (string | Buffer)
//   pktFlush() / pktDelim() / pktResponseEnd() — the control packets
//   encodePktLines(items)            — a mixed sequence ('flush'/'delim'/'response-end'
//                                      are the control packets)
//   decodePktLinesAll(buf, {stopAtFlush}) — decode a whole buffer; returns the packets
//                                      plus `rest` (the unconsumed tail: a raw packfile
//                                      after the flush in a receive-pack request, or the
//                                      bytes after a non-hex header). Throws a clear Error
//                                      on malformed input — the caller turns it into a
//                                      protocol error, never a crash.
//   sidebandPackets(band, data)      — `data` framed as band-N sideband packets,
//                                      chunked so no pkt-line exceeds 65520 bytes.

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length. */
export const PKT_LINE_MAX = 65520;
/** The largest sideband payload chunk: 65516 (max payload) minus the 1-byte channel. */
export const SIDEBAND_CHUNK = 65515;

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX - 4}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/**
 * The three control packets as module-level constants (perf round 3): callers
 * only ever pass them to Buffer.concat, which copies, so sharing one instance
 * is safe — and saves a Buffer allocation on every flush/delim/response-end.
 */
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export function pktFlush(): Buffer {
  return PKT_FLUSH;
}

export function pktDelim(): Buffer {
  return PKT_DELIM;
}

export function pktResponseEnd(): Buffer {
  return PKT_RESPONSE_END;
}

/** Encode a mixed sequence; the string 'flush'/'delim'/'response-end' are the control packets. */
export function encodePktLines(
  items: ReadonlyArray<string | Buffer | 'flush' | 'delim' | 'response-end'>,
): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else if (item === 'response-end') parts.push(pktResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode a whole buffer into packets. Decoding stops at the first flush when
 * `stopAtFlush` is set (a receive-pack body: the raw packfile follows the flush), or
 * at the first 4 bytes that are not a hex length (raw pack data). `rest` is the
 * unconsumed tail. Throws on a truncated or invalid pkt-line.
 */
export function decodePktLinesAll(
  buf: Buffer,
  options: { stopAtFlush?: boolean } = {},
): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line: fewer than 4 bytes remain');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) break; // raw data (a packfile) starts here
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (options.stopAtFlush === true) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line: length exceeds the buffer');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buf.subarray(offset) };
}

/**
 * Frame `data` as sideband packets on `band` (1 = data, 2 = progress, 3 = error),
 * chunked so no pkt-line exceeds 65520 bytes. An empty buffer frames to nothing.
 */
export function sidebandPackets(band: 1 | 2 | 3, data: Buffer): Buffer {
  if (data.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, data.length));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}
