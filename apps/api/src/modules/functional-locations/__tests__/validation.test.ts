import { describe, it, expect } from 'vitest';
import { validateFlDraft } from '../validation.js';

const block = { id: 'b1', type: 'BLOCK' as const };
const area = { id: 'a1', type: 'AREA' as const };

describe('validateFlDraft', () => {
  it('accepts a BLOCK with no parent', () => {
    expect(validateFlDraft({ name: 'CWH', type: 'BLOCK', parentId: null }, null, [])).toBeNull();
  });

  it('rejects a BLOCK that has a parent', () => {
    expect(validateFlDraft({ name: 'CWH', type: 'BLOCK', parentId: 'b1' }, block, [])?.field).toBe('parentId');
  });

  it('rejects an AREA with no parent', () => {
    expect(validateFlDraft({ name: 'M-E', type: 'AREA', parentId: null }, null, [])?.field).toBe('parentId');
  });

  it('rejects an AREA parented to an AREA — this is the depth cap', () => {
    // Only AREAs may have parents and an AREA may only be parented to a BLOCK, so
    // a third level is unreachable. If this ever passes, the cap is gone.
    expect(validateFlDraft({ name: 'M-E', type: 'AREA', parentId: 'a1' }, area, [])?.field).toBe('parentId');
  });

  it('accepts an AREA under a BLOCK', () => {
    expect(validateFlDraft({ name: 'M-E', type: 'AREA', parentId: 'b1' }, block, [])).toBeNull();
  });

  it('rejects an AREA whose parent does not exist', () => {
    expect(validateFlDraft({ name: 'M-E', type: 'AREA', parentId: 'ghost' }, null, [])?.field).toBe('parentId');
  });

  it('rejects a blank or whitespace-only name', () => {
    expect(validateFlDraft({ name: '', type: 'BLOCK', parentId: null }, null, [])?.field).toBe('name');
    expect(validateFlDraft({ name: '   ', type: 'BLOCK', parentId: null }, null, [])?.field).toBe('name');
  });

  it('rejects a duplicate sibling name case-insensitively', () => {
    // The Postgres unique index is case-SENSITIVE, so "cwh" and "CWH" would both
    // be stored — and are indistinguishable to someone reading a dropdown.
    expect(validateFlDraft({ name: 'cwh', type: 'BLOCK', parentId: null }, null, ['CWH'])?.field).toBe('name');
  });

  it('rejects a duplicate that differs only by surrounding whitespace', () => {
    expect(validateFlDraft({ name: ' CWH ', type: 'BLOCK', parentId: null }, null, ['CWH'])?.field).toBe('name');
  });

  it('allows the same name under a different parent', () => {
    // siblingNames is per-parent, so two Blocks may each own a "QC" area.
    expect(validateFlDraft({ name: 'QC', type: 'AREA', parentId: 'b1' }, block, ['Packing'])).toBeNull();
  });

  it('allows a no-op rename — the caller excludes self from siblingNames', () => {
    // The validator does NOT know its own current name. Excluding self is the
    // route's job; this documents the contract so a route that forgets it fails
    // loudly rather than rejecting every rename that keeps the same name.
    expect(validateFlDraft({ name: 'CWH', type: 'BLOCK', parentId: null }, null, [], 'self')).toBeNull();
  });

  it('rejects a location parented to itself', () => {
    expect(validateFlDraft({ name: 'M-E', type: 'AREA', parentId: 'a1' }, block, [], 'a1')?.field).toBe('parentId');
  });
});
