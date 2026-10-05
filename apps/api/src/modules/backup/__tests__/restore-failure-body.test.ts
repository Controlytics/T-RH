import { describe, it, expect } from 'vitest';
import { restoreFailureBody } from '../routes.js';

/**
 * Audit 2026-10-03, API-20: `POST /api/backup/restore` returned `err.message`
 * verbatim on its 500 regardless of NODE_ENV, while the global handler hides
 * the same for every other route. The raw text is a Postgres or parser
 * message — table, constraint and path names from the server.
 */
describe('restoreFailureBody', () => {
  const err = new Error('relation "audit_trail" violates constraint "audit_trail_pkey" at /opt/digilog/app');

  it('returns a fixed message in production', () => {
    const body = restoreFailureBody(err, 'production');
    expect(body.error).toBe('RESTORE_FAILED');
    expect(body.message).not.toContain('audit_trail');
    expect(body.message).not.toContain('/opt/digilog');
    expect(body.message).toMatch(/server log/);
  });

  it('returns the raw message outside production, where the operator is the developer', () => {
    expect(restoreFailureBody(err, 'development').message).toBe(err.message);
    expect(restoreFailureBody(err, undefined).message).toBe(err.message);
  });

  it('never returns an empty message', () => {
    expect(restoreFailureBody({ message: '' }, 'test').message).toBe('Database restore failed.');
    expect(restoreFailureBody(null, 'test').message).toBe('Database restore failed.');
  });
});
