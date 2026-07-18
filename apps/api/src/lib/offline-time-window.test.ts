import { describe, it, expect } from 'vitest';
import { validateOfflinePerformedAt, OfflineTimeError } from './offline-time-window.js';

const NOW = new Date('2026-05-04T12:00:00.000Z');

describe('validateOfflinePerformedAt — audit C2 (2026-05-04)', () => {
  describe('absent values', () => {
    it('returns undefined for undefined', () => {
      expect(validateOfflinePerformedAt(undefined, { isReplay: true, now: NOW })).toBeUndefined();
    });
    it('returns undefined for null', () => {
      expect(validateOfflinePerformedAt(null, { isReplay: true, now: NOW })).toBeUndefined();
    });
    it('returns undefined for empty string', () => {
      expect(validateOfflinePerformedAt('', { isReplay: true, now: NOW })).toBeUndefined();
    });
  });

  describe('online path (isReplay=false) — silently ignores client timestamp', () => {
    it('returns undefined even for a valid past time', () => {
      const past = '2026-05-04T11:00:00.000Z'; // 1h ago
      expect(validateOfflinePerformedAt(past, { isReplay: false, now: NOW })).toBeUndefined();
    });
    it('returns undefined even for a future time (not an error online — just dropped)', () => {
      const future = '2030-05-04T11:00:00.000Z';
      expect(validateOfflinePerformedAt(future, { isReplay: false, now: NOW })).toBeUndefined();
    });
  });

  describe('replay path (isReplay=true) — bounded acceptance', () => {
    it('accepts a recent past time', () => {
      const t = validateOfflinePerformedAt('2026-05-04T11:00:00.000Z', { isReplay: true, now: NOW });
      expect(t).toBeInstanceOf(Date);
      expect(t!.toISOString()).toBe('2026-05-04T11:00:00.000Z');
    });

    it('accepts within 5-min future skew tolerance (clock drift)', () => {
      const t = validateOfflinePerformedAt('2026-05-04T12:04:00.000Z', { isReplay: true, now: NOW });
      expect(t).toBeInstanceOf(Date);
    });

    it('rejects beyond 5-min future skew', () => {
      expect(() =>
        validateOfflinePerformedAt('2026-05-04T12:06:00.000Z', { isReplay: true, now: NOW }),
      ).toThrow(OfflineTimeError);
      try {
        validateOfflinePerformedAt('2026-05-04T12:06:00.000Z', { isReplay: true, now: NOW });
      } catch (e: any) {
        expect(e.code).toBe('OFFLINE_TIME_FUTURE');
      }
    });

    it('rejects far-future forgery', () => {
      expect(() =>
        validateOfflinePerformedAt('2030-01-01T00:00:00.000Z', { isReplay: true, now: NOW }),
      ).toThrow(/future/i);
    });

    it('accepts within 30-day staleness ceiling', () => {
      // 29 days ago
      const t = validateOfflinePerformedAt('2026-04-05T12:00:00.000Z', { isReplay: true, now: NOW });
      expect(t).toBeInstanceOf(Date);
    });

    it('rejects beyond 30-day staleness ceiling', () => {
      try {
        validateOfflinePerformedAt('2026-04-01T12:00:00.000Z', { isReplay: true, now: NOW });
        throw new Error('should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(OfflineTimeError);
        expect(e.code).toBe('OFFLINE_TIME_TOO_STALE');
      }
    });

    it('rejects values earlier than cycleStartedAt floor', () => {
      const cycleStartedAt = new Date('2026-05-04T11:30:00.000Z');
      try {
        validateOfflinePerformedAt('2026-05-04T11:00:00.000Z', {
          isReplay: true,
          now: NOW,
          cycleStartedAt,
        });
        throw new Error('should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(OfflineTimeError);
        expect(e.code).toBe('OFFLINE_TIME_BEFORE_CYCLE');
      }
    });

    it('accepts values at or after cycleStartedAt floor', () => {
      const cycleStartedAt = new Date('2026-05-04T11:30:00.000Z');
      const t = validateOfflinePerformedAt('2026-05-04T11:30:00.000Z', {
        isReplay: true,
        now: NOW,
        cycleStartedAt,
      });
      expect(t).toBeInstanceOf(Date);
    });

    it('rejects garbage strings', () => {
      try {
        validateOfflinePerformedAt('not-a-date', { isReplay: true, now: NOW });
        throw new Error('should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(OfflineTimeError);
        expect(e.code).toBe('OFFLINE_TIME_INVALID');
      }
    });
  });
});
