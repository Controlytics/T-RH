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

describe('createInstrumentProfileSchema attributeKeys', () => {
  it('accepts a newline-separated key list', () => {
    const out = createInstrumentProfileSchema.parse({
      name: 'Cleanroom-A',
      attributeKeys: 'Block\nArea\nSlave ID',
    });
    expect(out.attributeKeys).toBe('Block\nArea\nSlave ID');
  });

  it('leaves attributeKeys ABSENT when not sent, so the server can seed the default template', () => {
    // Not `''` and not a default: the route distinguishes "omitted" (seed me)
    // from "empty" (this profile asks for nothing), and a Zod default here
    // would destroy that distinction before the route ever sees it.
    const out = createInstrumentProfileSchema.parse({ name: 'Cleanroom-A' });
    expect('attributeKeys' in out).toBe(false);
  });

  it('accepts an empty string — a profile that deliberately asks for nothing', () => {
    expect(createInstrumentProfileSchema.parse({ name: 'A', attributeKeys: '' }).attributeKeys).toBe('');
  });

  it('does NOT trim, so the stored string matches what the config path stores', () => {
    // The dynamic-config PUT stores its value verbatim. If this trimmed, the
    // same list would round-trip differently depending on which page saved it.
    expect(createInstrumentProfileSchema.parse({ name: 'A', attributeKeys: 'Block\n' }).attributeKeys)
      .toBe('Block\n');
  });

  it('rejects more than 2000 characters, matching instrumentAttributesConfigSchema', () => {
    const tooLong = 'k'.repeat(2001);
    expect(createInstrumentProfileSchema.safeParse({ name: 'A', attributeKeys: tooLong }).success).toBe(false);
  });
});

describe('updateInstrumentProfileSchema attributeKeys', () => {
  it('accepts a replacement list', () => {
    expect(updateInstrumentProfileSchema.parse({ attributeKeys: 'Room' }).attributeKeys).toBe('Room');
  });

  it('accepts null, which re-arms the default-template fallback', () => {
    expect(updateInstrumentProfileSchema.parse({ attributeKeys: null }).attributeKeys).toBeNull();
  });

  it('accepts an empty string, which is NOT the same as null', () => {
    expect(updateInstrumentProfileSchema.parse({ attributeKeys: '' }).attributeKeys).toBe('');
  });

  it('rejects more than 2000 characters', () => {
    expect(updateInstrumentProfileSchema.safeParse({ attributeKeys: 'k'.repeat(2001) }).success).toBe(false);
  });
});
