import { describe, it, expect } from 'vitest';
import { boundedMeaning } from '../routes.js';

/**
 * `audit_trail.signature_meaning` is VARCHAR(255) and the audit insert is raw
 * SQL, so a longer meaning is a 500 — the order route built one from every
 * block name and failed on a database with a dozen (2026-10-03).
 */
describe('boundedMeaning', () => {
  it('lists every name when they fit', () => {
    expect(boundedMeaning('Order: ', ['A', 'B', 'C'])).toBe('Order: A, B, C');
  });

  it('lists what fits and counts the rest, never over the column width', () => {
    const names = Array.from({ length: 40 }, (_, i) => `Functional location number ${i + 1}`);
    const out = boundedMeaning('Display order changed to: ', names);
    expect(out.length).toBeLessThanOrEqual(255);
    expect(out).toContain('Functional location number 1,');
    expect(out).toMatch(/ … and \d+ more$/);
    const listed = out.split(', ').length;
    expect(listed).toBeGreaterThan(3);
  });

  it('a first name too long for the column on its own still yields a meaning inside it', () => {
    const out = boundedMeaning('Order: ', ['x'.repeat(300), 'y']);
    expect(out.length).toBeLessThanOrEqual(255);
    expect(out).toBe('Order: 2 location(s)');
  });
});
