import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  RTC_TIME_TOPIC, rtcRequestTopic, parseRtcRequestTopic, isGetTimeRequest, buildTimePayload,
  msUntilNextMinute, startRtcTicker,
} from '../rtc-sync.js';

/** RTC sync (2026-09-05) — the pure half and the ticker. */
describe('topics', () => {
  it('the request is per instrument, the time is global and outside instruments/', () => {
    expect(rtcRequestTopic('IOTGW01')).toBe('instruments/IOTGW01/rtc-request');
    expect(rtcRequestTopic('CWH/GW/01')).toBe('instruments/CWH/GW/01/rtc-request');
    expect(RTC_TIME_TOPIC).toBe('digilog/rtc/time');
    expect(RTC_TIME_TOPIC.startsWith('instruments/')).toBe(false);
  });
  it('parses the request topic and nothing else', () => {
    expect(parseRtcRequestTopic('instruments/IOTGW01/rtc-request')).toBe('IOTGW01');
    expect(parseRtcRequestTopic('instruments/CWH/GW/01/rtc-request')).toBe('CWH/GW/01');
    expect(parseRtcRequestTopic('instruments/IOTGW01/telemetry')).toBeNull();
    expect(parseRtcRequestTopic('instruments/+/rtc-request')).toBeNull();
    expect(parseRtcRequestTopic('digilog/rtc/time')).toBeNull();
  });
});

describe('the request', () => {
  it('is exactly {"method":"getTime"}; anything else is ignored', () => {
    expect(isGetTimeRequest(Buffer.from('{"method":"getTime"}'))).toBe(true);
    expect(isGetTimeRequest(Buffer.from('{"method":"getTime","id":1}'))).toBe(true);
    expect(isGetTimeRequest(Buffer.from('{"method":"setTime"}'))).toBe(false);
    expect(isGetTimeRequest(Buffer.from('getTime'))).toBe(false);
    expect(isGetTimeRequest(Buffer.from(''))).toBe(false);
  });
});

describe('the time payload', () => {
  it('carries UTC ISO to the millisecond and whole epoch seconds', () => {
    expect(buildTimePayload(new Date('2026-09-05T11:30:00.750Z'))).toEqual({
      method: 'time', utc: '2026-09-05T11:30:00.750Z', epoch: 1788607800,
    });
  });
});

describe('the minute ticker', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('waits until the next whole minute, then every minute', () => {
    expect(msUntilNextMinute(new Date('2026-09-05T11:30:00.000Z'))).toBe(60_000);
    expect(msUntilNextMinute(new Date('2026-09-05T11:30:45.500Z'))).toBe(14_500);
  });

  it('publishes on the minute boundary and then once per minute, and stops cleanly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T11:30:45.000Z'));
    const published: string[] = [];
    const ticker = startRtcTicker({ publish: async (d) => { published.push(d.toISOString()); } });
    vi.advanceTimersByTime(14_999);
    expect(published).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(published).toEqual(['2026-09-05T11:31:00.000Z']);
    vi.advanceTimersByTime(60_000);
    expect(published).toEqual(['2026-09-05T11:31:00.000Z', '2026-09-05T11:32:00.000Z']);
    ticker.stop();
    vi.advanceTimersByTime(120_000);
    expect(published).toHaveLength(2);
  });
});
