import { describe, it, expect } from 'vitest';
import { resolvePageSize } from '../page-size.js';

/**
 * The ONE definition of how many records a caller gets (operator, 2026-09-02:
 * *"whatever records are there all records should show in everywhere"*, clarified
 * as the BACKEND limits).
 *
 * The property under test is an ABSENCE — that nothing caps the caller — which is
 * the hardest kind to keep, because the obvious "defensive" edit restores it and
 * every one of these tests still passes if you only check small numbers. That is
 * why the large values below are asserted explicitly.
 */
describe('resolvePageSize — there is no ceiling', () => {
  it('returns exactly what the caller asked for, however large', () => {
    expect(resolvePageSize(10, 25)).toBe(10);
    expect(resolvePageSize(500, 25)).toBe(500);
    expect(resolvePageSize(5000, 25)).toBe(5000);
    // Past every ceiling this replaced (100, 200, 500, 1000) and past the largest
    // table on this installation (226,600 telemetry rows).
    expect(resolvePageSize(1_000_000, 25)).toBe(1_000_000);
  });

  it('accepts a numeric STRING, because query params arrive as text', () => {
    // `?pageSize=750` reaches a route as a string. A helper that only handled
    // numbers would silently hand back the default and look like a cap.
    expect(resolvePageSize('750', 25)).toBe(750);
    expect(resolvePageSize('25', 10)).toBe(25);
  });

  it('falls back to the default when there is no request', () => {
    expect(resolvePageSize(undefined, 25)).toBe(25);
    expect(resolvePageSize(null, 50)).toBe(50);
    expect(resolvePageSize('', 20)).toBe(20);
  });

  it('falls back to the default for values that are not a page size', () => {
    expect(resolvePageSize('abc', 25)).toBe(25);
    expect(resolvePageSize(NaN, 25)).toBe(25);
    expect(resolvePageSize(Infinity, 25)).toBe(25);
    expect(resolvePageSize({}, 25)).toBe(25);
  });

  it('KEEPS the lower bound — which is not a cap', () => {
    /**
     * Postgres errors on a negative LIMIT and returns nothing for 0, so passing
     * one through turns a client typo into a 500 or an empty page that reads as
     * "no records". This is the one guard the helper retains, and it constrains
     * malformed input rather than the size of an honest request.
     */
    expect(resolvePageSize(0, 25)).toBe(25);
    expect(resolvePageSize(-1, 25)).toBe(25);
    expect(resolvePageSize(-9999, 25)).toBe(25);
  });

  it('floors a fractional size rather than handing Prisma a decimal', () => {
    expect(resolvePageSize(25.9, 10)).toBe(25);
    expect(resolvePageSize('12.4', 10)).toBe(12);
    // Floors to 0 → malformed → the default, not a zero-row page.
    expect(resolvePageSize(0.5, 25)).toBe(25);
  });
});
