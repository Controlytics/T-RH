/**
 * Newline framer — PURE. No sockets, no I/O.
 *
 * A TCP byte stream has no message boundaries; the OS is free to split or
 * coalesce writes anywhere, including inside a multi-byte UTF-8 character.
 * Framing bugs here pass every normal test — a `chunk.toString()` per packet
 * looks fine until the first reading straddles a packet boundary, at which
 * point it either truncates JSON or corrupts a multi-byte character into
 * `�` replacement bytes and the payload silently changes with no error
 * anywhere. That failure mode is "works on my desk, corrupts data in the
 * plant" — the whole reason this is isolated into its own pure, tested unit
 * instead of living inline in the socket handler.
 *
 * The fix: accumulate raw `Buffer`s across `push()` calls and only decode to
 * UTF-8 once a complete line (delimited by `\n`, with an optional preceding
 * `\r` stripped) is in hand. A line with no trailing newline yet is never
 * emitted — the sender may still be mid-write, and emitting early would hand
 * the caller a truncated reading.
 */
export class LineFramer {
  private chunks: Buffer[] = [];
  private byteLength = 0;

  /**
   * Feed the next chunk off the wire. Returns zero or more complete,
   * decoded lines (blank lines are dropped, not emitted as `''`). Any
   * trailing partial line stays buffered for the next call.
   */
  push(chunk: Buffer): string[] {
    if (chunk.length === 0) return [];

    this.chunks.push(chunk);
    this.byteLength += chunk.length;

    const combined = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.byteLength);

    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nlIndex = combined.indexOf(0x0a, start); // '\n'
      if (nlIndex === -1) break;
      // Strip a trailing '\r' (CRLF) if present.
      let end = nlIndex;
      if (end > start && combined[end - 1] === 0x0d) end -= 1;
      if (end > start) {
        lines.push(combined.toString('utf8', start, end));
      }
      start = nlIndex + 1;
    }

    // Keep only the unterminated remainder buffered.
    if (start >= combined.length) {
      this.chunks = [];
      this.byteLength = 0;
    } else {
      const remainder = combined.subarray(start);
      this.chunks = [remainder];
      this.byteLength = remainder.length;
    }

    return lines;
  }

  /** Bytes currently buffered awaiting a newline — used to enforce a per-line byte cap. */
  get buffered(): number {
    return this.byteLength;
  }
}
