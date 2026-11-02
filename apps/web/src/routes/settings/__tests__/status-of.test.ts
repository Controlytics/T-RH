import { describe, it, expect } from 'vitest';
import { statusOf } from '../index';

/**
 * The Settings widget's status is the SERVER's `reporting`: a row seen a moment
 * ago with a 60 s interval still reads "Not reporting" when the server says so
 * (a TCP/IP instrument whose reads stopped), and the reverse.
 */
const row = (over: Record<string, unknown>) => ({
  id: 'i-1', code: 'C', name: 'C', isActive: true, profileId: 'p',
  expectedIntervalSec: 60, lastSeenAt: new Date().toISOString(), functionalLocationId: null,
  reporting: false,
  ...over,
});

describe('Settings statusOf', () => {
  it('reads the verdict from the payload, not from lastSeenAt', () => {
    expect(statusOf(row({ reporting: false }) as never)).toEqual({ tone: 'warn', label: 'Not reporting' });
    expect(statusOf(row({ reporting: true, lastSeenAt: null }) as never)).toEqual({ tone: 'ok', label: 'Reporting' });
  });

  it('a disabled instrument is Disabled whatever the server says', () => {
    expect(statusOf(row({ isActive: false, reporting: true }) as never)).toEqual({ tone: 'idle', label: 'Disabled' });
  });
});
