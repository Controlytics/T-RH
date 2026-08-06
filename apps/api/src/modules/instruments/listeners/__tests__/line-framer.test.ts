import { describe, it, expect } from 'vitest';
import { LineFramer } from '../line-framer.js';

describe('LineFramer', () => {
  it('returns whole lines', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('{"a":1}\n{"b":2}\n'))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('holds a partial line until its newline arrives — the split-packet case', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('{"a":'))).toEqual([]);
    expect(f.push(Buffer.from('1}\n'))).toEqual(['{"a":1}']);
  });

  it('survives a split INSIDE a multi-byte UTF-8 character', () => {
    // A naive chunk.toString() per packet corrupts this into replacement
    // characters and the JSON silently changes.
    const whole = Buffer.from('{"n":"°C"}\n', 'utf8');
    const f = new LineFramer();
    expect(f.push(whole.subarray(0, 8))).toEqual([]);
    expect(f.push(whole.subarray(8))).toEqual(['{"n":"°C"}']);
  });

  it('handles CRLF as well as LF', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('{"a":1}\r\n'))).toEqual(['{"a":1}']);
  });

  it('skips blank lines rather than emitting empty strings', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('\n\n{"a":1}\n'))).toEqual(['{"a":1}']);
  });

  it('reports how much is buffered so a caller can enforce a cap', () => {
    const f = new LineFramer();
    f.push(Buffer.from('abcdef'));
    expect(f.buffered).toBe(6);
  });

  it('handles a chunk that is exactly a newline', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('abc'))).toEqual([]);
    expect(f.push(Buffer.from('\n'))).toEqual(['abc']);
  });

  it('keeps a final line with no trailing newline buffered, not emitted', () => {
    // The sender may still be mid-write; emitting early would truncate a
    // reading that arrives in a later packet.
    const f = new LineFramer();
    expect(f.push(Buffer.from('{"a":1}\n{"b":2}'))).toEqual(['{"a":1}']);
    expect(f.buffered).toBe(7); // '{"b":2}'.length
  });

  it('emits many lines from a single chunk', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":3}\n{"d":4}\n'))).toEqual([
      '{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}',
    ]);
  });

  it('treats a push of an empty buffer as a no-op', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.alloc(0))).toEqual([]);
    expect(f.buffered).toBe(0);
    // Doesn't disturb a partial line already buffered.
    f.push(Buffer.from('{"a":'));
    expect(f.push(Buffer.alloc(0))).toEqual([]);
    expect(f.buffered).toBe(5);
  });
});
