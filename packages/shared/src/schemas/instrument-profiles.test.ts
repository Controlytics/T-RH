import { describe, it, expect } from 'vitest';
import { createInstrumentProfileSchema, updateInstrumentProfileSchema } from './instrument-profiles.js';

describe('createInstrumentProfileSchema', () => {
  it('accepts a name alone', () => {
    expect(createInstrumentProfileSchema.parse({ name: 'Cleanroom-A' }))
      .toMatchObject({ name: 'Cleanroom-A', isActive: true });
  });

  it('rejects an empty name', () => {
    expect(createInstrumentProfileSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects a whitespace-only name — it would render as a blank card', () => {
    expect(createInstrumentProfileSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('trims the name, so "A " and "A" cannot both exist', () => {
    // The database's unique index is an exact match. Without trimming here, two
    // profiles differing only by a trailing space would both be accepted and
    // would be indistinguishable in every list on screen.
    expect(createInstrumentProfileSchema.parse({ name: '  Cleanroom-A  ' }).name).toBe('Cleanroom-A');
  });

  it('caps the name so it cannot overflow the card layout', () => {
    expect(createInstrumentProfileSchema.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
    expect(createInstrumentProfileSchema.safeParse({ name: 'x'.repeat(120) }).success).toBe(true);
  });

  it('caps the description', () => {
    expect(createInstrumentProfileSchema.safeParse({ name: 'A', description: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('updateInstrumentProfileSchema', () => {
  it('allows a partial update', () => {
    expect(updateInstrumentProfileSchema.parse({ description: 'new' })).toEqual({ description: 'new' });
  });

  it('still rejects a blank name when one is supplied', () => {
    expect(updateInstrumentProfileSchema.safeParse({ name: '  ' }).success).toBe(false);
  });

  it('accepts an explicit null description — that is how you clear it', () => {
    expect(updateInstrumentProfileSchema.safeParse({ description: null }).success).toBe(true);
  });
});
