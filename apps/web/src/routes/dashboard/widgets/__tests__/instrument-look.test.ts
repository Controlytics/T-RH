import { describe, it, expect } from 'vitest';
import type { InstrumentStatus } from '@digilog/shared';
import { statusClasses } from '../../status';
import { UNJUDGED_CLASSES } from '../key-value';
import { instrumentLook } from '../instrument-look';

const STATUSES: InstrumentStatus[] = ['OUT_OF_SPEC', 'STALE', 'NO_DATA', 'PARTIAL', 'OK'];

describe('instrumentLook', () => {
  it('a judged instrument reads its server status, word and colour', () => {
    for (const status of STATUSES) {
      for (const reporting of [true, false]) {
        const look = instrumentLook({ status, reporting, judged: true });
        expect(look.key).toBe(status);
        expect(look.classes).toEqual(statusClasses(status));
      }
    }
  });

  it('an absent judged (a cached response) reads as judged', () => {
    for (const status of STATUSES) {
      const look = instrumentLook({ status, reporting: true });
      expect(look.key).toBe(status);
      expect(look.classes).toEqual(statusClasses(status));
    }
  });

  it('not judged and reporting: "Not judged", neutral - never "No data", never green', () => {
    // A pressure-only instrument: the server says NO_DATA and judged:false.
    const look = instrumentLook({ status: 'NO_DATA', reporting: true, judged: false });
    expect(look.key).toBe('NOT_JUDGED');
    expect(look.classes).toBe(UNJUDGED_CLASSES);
    expect(look.classes.label).toBe('Not judged');
    expect(look.classes.label).not.toBe(statusClasses('NO_DATA').label);
    expect(look.classes.dot).not.toBe(statusClasses('OK').dot);
    expect(look.classes.text).not.toBe(statusClasses('OK').text);
  });

  it('not judged and not reporting: "Offline"', () => {
    for (const status of STATUSES) {
      const look = instrumentLook({ status, reporting: false, judged: false });
      expect(look.key).toBe('STALE');
      expect(look.classes).toEqual(statusClasses('STALE'));
      expect(look.classes.label).toBe('Offline');
    }
  });

  it('not judged ignores even an OK status from the server', () => {
    const look = instrumentLook({ status: 'OK', reporting: true, judged: false });
    expect(look.key).toBe('NOT_JUDGED');
    expect(look.classes.label).toBe('Not judged');
  });
});
