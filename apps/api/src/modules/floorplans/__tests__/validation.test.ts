import { describe, it, expect } from 'vitest';
import { validateRoomPayload } from '../validation.js';

const base = { code: 'CWH-I/142', x: 0.1, y: 0.1, w: 0.2, h: 0.2 };

describe('validateRoomPayload — geometry', () => {
  it('accepts a box inside the plan', () => {
    expect(validateRoomPayload(base).ok).toBe(true);
  });

  it('accepts a box exactly filling the plan', () => {
    expect(validateRoomPayload({ ...base, x: 0, y: 0, w: 1, h: 1 }).ok).toBe(true);
  });

  it('rejects a negative origin', () => {
    const r = validateRoomPayload({ ...base, x: -0.01 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/x/);
  });

  it('rejects a box running off the right edge', () => {
    const r = validateRoomPayload({ ...base, x: 0.9, w: 0.2 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/right edge/i);
  });

  it('rejects a box running off the bottom edge', () => {
    const r = validateRoomPayload({ ...base, y: 0.95, h: 0.1 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/bottom edge/i);
  });

  it('rejects a zero-width box — an unclickable hotspot is a bug, not a choice', () => {
    expect(validateRoomPayload({ ...base, w: 0 }).ok).toBe(false);
  });

  it('rejects a zero-height box', () => {
    expect(validateRoomPayload({ ...base, h: 0 }).ok).toBe(false);
  });

  it('rejects pixel coordinates, which is the likely mistake', () => {
    const r = validateRoomPayload({ ...base, x: 420, y: 300, w: 120, h: 80 });
    expect(r.ok).toBe(false);
  });

  it('rejects a missing coordinate rather than defaulting it to zero', () => {
    const { x, ...noX } = base;
    expect(validateRoomPayload(noX).ok).toBe(false);
  });
});

describe('validateRoomPayload — limits', () => {
  it('accepts no limits at all — a corridor has no specification', () => {
    expect(validateRoomPayload(base).ok).toBe(true);
  });

  it('accepts one bound without the other', () => {
    expect(validateRoomPayload({ ...base, tempMax: 25 }).ok).toBe(true);
  });

  it('accepts a valid range', () => {
    expect(validateRoomPayload({ ...base, tempMin: 18, tempMax: 25 }).ok).toBe(true);
  });

  it('accepts an explicit null, which is how the editor clears a limit', () => {
    const r = validateRoomPayload({ ...base, tempMin: null, tempMax: null });
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.tempMin).toBeNull();
  });

  it('rejects an inverted temperature range', () => {
    const r = validateRoomPayload({ ...base, tempMin: 25, tempMax: 18 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/temperature/i);
  });

  it('rejects an inverted humidity range', () => {
    const r = validateRoomPayload({ ...base, rhMin: 60, rhMax: 40 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/humidity/i);
  });

  it('rejects equal bounds — nothing could ever be in spec', () => {
    expect(validateRoomPayload({ ...base, tempMin: 20, tempMax: 20 }).ok).toBe(false);
  });

  it('rejects humidity outside 0-100', () => {
    expect(validateRoomPayload({ ...base, rhMin: -1 }).ok).toBe(false);
    expect(validateRoomPayload({ ...base, rhMax: 101 }).ok).toBe(false);
  });

  it('rejects a non-numeric limit rather than coercing it', () => {
    expect(validateRoomPayload({ ...base, tempMax: '25' }).ok).toBe(false);
  });
});

describe('validateRoomPayload — code', () => {
  it('rejects a blank code', () => {
    expect(validateRoomPayload({ ...base, code: '   ' }).ok).toBe(false);
  });

  it('trims the code', () => {
    const r = validateRoomPayload({ ...base, code: '  CWH-I/142  ' });
    expect(r.ok && r.data.code).toBe('CWH-I/142');
  });

  it('keeps a slash — room codes on the drawing contain them', () => {
    const r = validateRoomPayload({ ...base, code: 'CWH-I/142' });
    expect(r.ok && r.data.code).toBe('CWH-I/142');
  });
});
