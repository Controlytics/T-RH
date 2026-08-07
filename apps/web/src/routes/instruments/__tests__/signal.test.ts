import { describe, it, expect } from 'vitest';
import { signalFor, relativeAge, SIGNAL_STYLES } from '../signal';

/**
 * The list and detail pages are colour-coded on this, so a wrong state is a
 * wrong colour on every row at once.
 *
 * The case worth protecting is EXEMPT: an instrument with no
 * `expectedIntervalSec` promised nothing, so no amount of silence makes it
 * late. Colouring it red would invent a rule no one configured — and would put
 * a red row in front of an operator who has no action to take.
 */
const NOW = new Date('2026-08-07T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('signalFor — with a promised interval', () => {
  // 60s interval: jitter and one retry must not turn the row amber.
  it('is live inside the interval and its slack', () => {
    expect(signalFor(ago(30 * SEC), 60, NOW).state).toBe('live');
    expect(signalFor(ago(89 * SEC), 60, NOW).state).toBe('live');
  });

  it('goes due once it is past the interval plus slack', () => {
    expect(signalFor(ago(2 * MIN), 60, NOW).state).toBe('due');
    expect(signalFor(ago(3 * MIN), 60, NOW).state).toBe('due');
  });

  it('goes silent once several windows have been missed', () => {
    expect(signalFor(ago(5 * MIN), 60, NOW).state).toBe('silent');
    expect(signalFor(ago(2 * DAY), 60, NOW).state).toBe('silent');
  });

  it('scales with the instrument\'s OWN interval, not a fixed clock', () => {
    // A daily reporter at 6 hours old is perfectly healthy; a 60s reporter at
    // the same age has been dead for hours. Same timestamp, different state.
    expect(signalFor(ago(6 * HOUR), 86_400, NOW).state).toBe('live');
    expect(signalFor(ago(6 * HOUR), 60, NOW).state).toBe('silent');
  });
});

describe('signalFor — without a promised interval', () => {
  it('is heard, never late, however long it has been', () => {
    expect(signalFor(ago(2 * MIN), null, NOW).state).toBe('heard');
    expect(signalFor(ago(30 * DAY), null, NOW).state).toBe('heard');
    expect(signalFor(ago(30 * DAY), null, NOW).label).toMatch(/never counted late/i);
  });

  it('says so on the label rather than leaving the reader to infer it', () => {
    expect(signalFor(ago(MIN), undefined, NOW).label).toMatch(/no expected interval/i);
  });
});

describe('signalFor — never reported', () => {
  it('is its own state, not a very old timestamp', () => {
    const s = signalFor(null, 60, NOW);
    expect(s.state).toBe('never');
    expect(s.age).toBe('Never');
    expect(s.bars).toBe(0);
  });
});

describe('signalFor — bars', () => {
  it('falls monotonically as the state worsens', () => {
    expect(signalFor(ago(SEC), 60, NOW).bars).toBe(3);
    expect(signalFor(ago(2 * MIN), 60, NOW).bars).toBe(2);
    expect(signalFor(ago(10 * MIN), 60, NOW).bars).toBe(1);
    expect(signalFor(null, 60, NOW).bars).toBe(0);
  });
});

describe('relativeAge', () => {
  it('rounds DOWN, so it never claims more elapsed time than there was', () => {
    expect(relativeAge(59 * MIN)).toBe('59m ago');
    expect(relativeAge(HOUR - 1)).toBe('59m ago');
    expect(relativeAge(23 * HOUR)).toBe('23h ago');
  });

  it('says "just now" under a minute rather than "0m ago"', () => {
    expect(relativeAge(0)).toBe('just now');
    expect(relativeAge(30 * SEC)).toBe('just now');
  });

  // A device whose clock runs ahead sends a future timestamp. "-3m ago" reads
  // as a rendering fault in this page rather than a fault in the device.
  it('treats a future timestamp as fresh, not negative', () => {
    const s = signalFor(new Date(NOW.getTime() + 5 * MIN).toISOString(), 60, NOW);
    expect(s.age).toBe('just now');
    expect(s.state).toBe('live');
  });
});

describe('SIGNAL_STYLES', () => {
  it('covers every state', () => {
    for (const state of ['live', 'due', 'silent', 'heard', 'never'] as const) {
      expect(SIGNAL_STYLES[state]).toBeDefined();
    }
  });

  // The ten colour presets move the brand accent; if they moved these, the one
  // urgent state could end up the same hue as the healthy one.
  it('uses fixed hues, never the themeable CSS variables', () => {
    for (const s of Object.values(SIGNAL_STYLES)) {
      expect(JSON.stringify(s)).not.toContain('--theme');
    }
  });
});
