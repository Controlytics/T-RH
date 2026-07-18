import { describe, it, expect } from 'vitest';
import {
  signOfflineReplayToken,
  verifyOfflineReplayToken,
  OfflineReplayTokenError,
} from './offline-replay-token.js';

const USER_A = 'user-a-uuid';
const USER_B = 'user-b-uuid';
const SESSION_A = 'session-a-id';
const SESSION_B = 'session-b-id';

describe('offline-replay-token — audit C1 (2026-05-04)', () => {
  it('issues a token + future expiry', async () => {
    const grant = await signOfflineReplayToken(USER_A, SESSION_A, 1);
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(grant.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(grant.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 100);
  });

  it('verifies a fresh token bound to the same user + session', async () => {
    const { token } = await signOfflineReplayToken(USER_A, SESSION_A);
    const claims = await verifyOfflineReplayToken(token, USER_A, SESSION_A);
    expect(claims.sub).toBe(USER_A);
    expect(claims.sid).toBe(SESSION_A);
    expect(claims.typ).toBe('offline-replay');
  });

  it('rejects token used by a different user (USER_MISMATCH)', async () => {
    const { token } = await signOfflineReplayToken(USER_A, SESSION_A);
    try {
      await verifyOfflineReplayToken(token, USER_B, SESSION_A);
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(OfflineReplayTokenError);
      expect(e.code).toBe('OFFLINE_REPLAY_TOKEN_USER_MISMATCH');
    }
  });

  it('rejects token from a different session (SESSION_MISMATCH)', async () => {
    const { token } = await signOfflineReplayToken(USER_A, SESSION_A);
    try {
      await verifyOfflineReplayToken(token, USER_A, SESSION_B);
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(OfflineReplayTokenError);
      expect(e.code).toBe('OFFLINE_REPLAY_TOKEN_SESSION_MISMATCH');
    }
  });

  it('rejects empty / missing token', async () => {
    for (const bad of ['', null as any, undefined as any]) {
      try {
        await verifyOfflineReplayToken(bad, USER_A, SESSION_A);
        throw new Error('should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(OfflineReplayTokenError);
        expect(e.code).toBe('OFFLINE_REPLAY_TOKEN_MISSING');
      }
    }
  });

  it('rejects an unrelated JWT (signature mismatch — INVALID)', async () => {
    // A JWT signed with a different secret cannot verify under the
    // offline-replay secret. Using a known-bad string here suffices.
    try {
      await verifyOfflineReplayToken('ey.notarealjwt.signature', USER_A, SESSION_A);
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(OfflineReplayTokenError);
      expect(e.code).toBe('OFFLINE_REPLAY_TOKEN_INVALID');
    }
  });
});
