import { describe, it, expect } from 'vitest';
import {
  describeTarget, targetFromRequestData, requesterLabel, requestRecordName,
} from '../describe-request.js';

/**
 * What an admin-request audit record calls itself.
 *
 * Operator, 2026-09-02: the records named only the REQUESTER and never the
 * account the request was about. Their own case had requester `101020` and
 * approver `101010` — two people, and the record showed neither the target
 * account nor its role.
 */
describe('describeTarget', () => {
  it('names the account and its role', () => {
    expect(describeTarget({ username: '900123', role: 'Operator' })).toBe('900123 (Operator)');
  });

  it('drops the bracket when no role is known', () => {
    // Normal, not an error: a target user may be unresolvable at submission time.
    expect(describeTarget({ username: '900123' })).toBe('900123');
    expect(describeTarget({ username: '900123', role: '' })).toBe('900123');
    expect(describeTarget({ username: '900123', role: null })).toBe('900123');
  });

  it('returns EMPTY rather than an orphan bracket when there is no account', () => {
    // A record reading `Create User — ()` looks like a rendering fault and invites
    // someone to "fix" a record that is merely sparse.
    expect(describeTarget({})).toBe('');
    expect(describeTarget({ username: '   ' })).toBe('');
    expect(describeTarget({ username: null, role: 'Operator' })).toBe('');
  });
});

describe('targetFromRequestData', () => {
  it("takes CREATE_USER's requested login ID and requested role", () => {
    const t = targetFromRequestData({ username: '900123', requestedRole: 'OPERATOR', fullName: 'A' });
    expect(t).toEqual({ username: '900123', role: 'OPERATOR' });
  });

  it('prefers a RESOLVED role over the one in the request', () => {
    /**
     * At approval the target user has been loaded, so the role is the account's
     * real one. `requestData` may carry a stale or absent value — for UNLOCK it
     * carries none at all.
     */
    const t = targetFromRequestData({ username: 'jsmith', requestedRole: 'OPERATOR' }, 'QA');
    expect(t.role).toBe('QA');
  });

  it('reads the same `username` key for every request type', () => {
    // CREATE_USER stores the ID being ASKED FOR; the rest store an existing
    // account. One key, so one reader serves all six types.
    expect(targetFromRequestData({ username: 'jsmith' }).username).toBe('jsmith');
    expect(targetFromRequestData({ username: 'jsmith', modifyField: 'email' }).username).toBe('jsmith');
  });

  it('survives a malformed or empty requestData', () => {
    expect(targetFromRequestData(null).username).toBe('');
    expect(targetFromRequestData(undefined).username).toBe('');
    expect(targetFromRequestData({}).username).toBe('');
    // A non-string username must not reach the record as "[object Object]".
    expect(targetFromRequestData({ username: { a: 1 } }).username).toBe('');
    expect(targetFromRequestData({ username: 42 }).username).toBe('');
  });
});

describe('requesterLabel', () => {
  it('is name and employee ID together', () => {
    expect(requesterLabel({ requesterName: 'Admin User', requesterEmployeeId: '101020' }))
      .toBe('Admin User (101020)');
  });

  it('falls back to the name alone', () => {
    expect(requesterLabel({ requesterName: 'Admin User', requesterEmployeeId: null }))
      .toBe('Admin User');
  });
});

describe('requestRecordName', () => {
  it('carries operation, target and requester — the three the record must answer', () => {
    expect(requestRecordName({
      operation: 'Create User', target: '900123 (Operator)', requester: 'Admin User (101020)',
    })).toBe('Create User — 900123 (Operator), requested by Admin User (101020)');
  });

  it('keeps the requester when there is no resolvable target', () => {
    expect(requestRecordName({ operation: 'Unlock Account', target: '', requester: 'Admin User (101020)' }))
      .toBe('Unlock Account, requested by Admin User (101020)');
  });

  it('is still a sentence with neither', () => {
    expect(requestRecordName({ operation: 'Unlock Account', target: '', requester: '' }))
      .toBe('Unlock Account');
  });

  it('CLAMPS free text, because signature_meaning is VARCHAR(255)', () => {
    /**
     * The load-bearing one. `auditLog` throws on overflow AFTER the action it
     * describes has been performed, leaving a regulated act with no audit row —
     * recorded in this repo already for long instrument codes. Every part here is
     * operator-supplied.
     */
    const name = requestRecordName({
      operation: 'Create User',
      target: 'x'.repeat(400),
      requester: 'y'.repeat(400),
    });
    expect(name.length).toBeLessThan(255);
    expect(name).toContain('…');
  });
});
