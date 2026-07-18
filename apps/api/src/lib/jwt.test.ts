import { describe, it, expect, beforeAll } from 'vitest';
import { signToken, verifyToken, signVerificationToken, verifyVerificationToken, type JwtPayload } from './jwt.js';

// JWT module initializes secrets on import; dev mode generates random secrets
// so these tests work without env vars set

describe('JWT token operations', () => {
  const testPayload: JwtPayload = {
    sub: 'user-123',
    username: 'testuser',
    role: 'ADMIN',
    sessionId: 'session-abc',
  };

  describe('signToken + verifyToken', () => {
    it('signs and verifies a token', async () => {
      const token = await signToken(testPayload);
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts

      const decoded = await verifyToken(token);
      expect(decoded.sub).toBe('user-123');
      expect(decoded.username).toBe('testuser');
      expect(decoded.role).toBe('ADMIN');
      expect(decoded.sessionId).toBe('session-abc');
    });

    it('preserves all payload fields', async () => {
      const token = await signToken(testPayload);
      const decoded = await verifyToken(token);

      for (const [key, value] of Object.entries(testPayload)) {
        expect(decoded[key as keyof JwtPayload]).toBe(value);
      }
    });

    it('rejects tampered token', async () => {
      const token = await signToken(testPayload);
      const tampered = token.slice(0, -5) + 'XXXXX';
      await expect(verifyToken(tampered)).rejects.toThrow();
    });

    it('rejects empty string token', async () => {
      await expect(verifyToken('')).rejects.toThrow();
    });

    it('rejects garbage token', async () => {
      await expect(verifyToken('not.a.jwt')).rejects.toThrow();
    });
  });

  describe('signVerificationToken + verifyVerificationToken', () => {
    it('signs and verifies a verification token', async () => {
      const token = await signVerificationToken('user-456');
      expect(token).toBeTruthy();

      const decoded = await verifyVerificationToken(token);
      expect(decoded.sub).toBe('user-456');
    });

    it('rejects tampered verification token', async () => {
      const token = await signVerificationToken('user-789');
      const tampered = token.slice(0, -3) + 'ZZZ';
      await expect(verifyVerificationToken(tampered)).rejects.toThrow();
    });
  });

  describe('cross-contamination prevention', () => {
    it('main token cannot be verified as verification token', async () => {
      const mainToken = await signToken(testPayload);
      await expect(verifyVerificationToken(mainToken)).rejects.toThrow();
    });

    it('verification token cannot be verified as main token', async () => {
      const verifyTok = await signVerificationToken('user-123');
      await expect(verifyToken(verifyTok)).rejects.toThrow();
    });
  });
});
