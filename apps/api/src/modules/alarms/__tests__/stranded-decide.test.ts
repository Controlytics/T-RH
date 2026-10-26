import { describe, it, expect } from 'vitest';
import { strandedAlarmIds } from '../stranded-decide.js';

const both = { temperature: true, humidity: true };
const tempOnly = { temperature: true, humidity: false };

describe('strandedAlarmIds — alarms on a measurement the profile no longer has', () => {
  it('names a limit / RS485 / range alarm whose metric the instrument\'s profile stopped measuring', () => {
    const open = [
      { id: 'a', instrumentId: 'i1', metric: 'HUMIDITY' },
      { id: 'b', instrumentId: 'i1', metric: 'TEMPERATURE' },
    ];
    expect(strandedAlarmIds(open, new Map([['i1', tempOnly]]))).toEqual(['a']);
  });

  it('never names an OFFLINE (inactivity) alarm — that is not a measurement', () => {
    const open = [{ id: 'x', instrumentId: 'i1', metric: 'OFFLINE' }];
    expect(strandedAlarmIds(open, new Map([['i1', { temperature: false, humidity: false }]]))).toEqual([]);
  });

  it('leaves an instrument it was told nothing about alone', () => {
    const open = [{ id: 'a', instrumentId: 'gone', metric: 'HUMIDITY' }];
    expect(strandedAlarmIds(open, new Map([['i1', both]]))).toEqual([]);
  });

  it('names nothing while the profile still measures it', () => {
    const open = [{ id: 'a', instrumentId: 'i1', metric: 'HUMIDITY' }];
    expect(strandedAlarmIds(open, new Map([['i1', both]]))).toEqual([]);
  });
});
