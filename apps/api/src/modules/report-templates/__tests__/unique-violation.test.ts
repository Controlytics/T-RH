/**
 * `uniqueViolation` reads WHICH unique index a Prisma P2002 came from out of
 * `meta.target`. The targets below were MEASURED on 2026-11-03 (Prisma 6.19,
 * PostgreSQL 18) against migration 20261103120000's three COALESCE indexes —
 * Prisma splits the index expression on its commas, so COALESCE arrives in two
 * pieces. If a Prisma upgrade changes this shape, a name clash would stop being
 * a 409 and become a 500; this file is where that shows first.
 */
import { describe, it, expect } from 'vitest';
import { uniqueViolation } from '../service.js';

const p2002 = (target: unknown) => ({ code: 'P2002', meta: { modelName: 'ReportTemplate', target } });

describe('uniqueViolation', () => {
  it('the plain name index is a name clash', () => {
    expect(uniqueViolation(p2002(['COALESCE(profile_id', "''::text)", 'kind', 'name']))).toBe('name');
  });

  it('the case-folded name index is a name clash', () => {
    expect(uniqueViolation(p2002(['COALESCE(profile_id', "''::text)", 'kind', 'lower(name)']))).toBe('name');
  });

  it('the one-default index is a default clash (a bug, rethrown by the routes)', () => {
    expect(uniqueViolation(p2002(['COALESCE(profile_id', "''::text)", 'kind']))).toBe('default');
    expect(uniqueViolation(p2002('report_templates_one_default'))).toBe('default');
  });

  it('anything else is not ours', () => {
    expect(uniqueViolation(p2002(['id']))).toBeNull();
    expect(uniqueViolation({ code: 'P2025', meta: { target: ['kind', 'name'] } })).toBeNull();
    expect(uniqueViolation(new Error('x'))).toBeNull();
    expect(uniqueViolation(null)).toBeNull();
  });
});
