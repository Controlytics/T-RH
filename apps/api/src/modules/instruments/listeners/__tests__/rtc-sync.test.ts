import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  RTC_TIME_TOPIC, rtcRequestTopic, parseRtcRequestTopic, isGetTimeRequest, buildTimePayload,
  msUntilNextBoundary, startRtcTicker, RTC_TICK_MS,
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
  it('is exactly {"unix":<epoch MILLISECONDS>} (operator: "{"unix":1792221233122}")', () => {
    expect(buildTimePayload(new Date('2026-09-05T11:30:00.750Z'))).toEqual({ unix: 1788607800750 });
    expect(JSON.stringify(buildTimePayload(new Date(1792221233122)))).toBe('{"unix":1792221233122}');
  });
});

describe('the ticker', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('ticks every 10 minutes, aligned to the wall clock (operator: "make it every 10 minutes")', () => {
    expect(RTC_TICK_MS).toBe(600_000);
    expect(msUntilNextBoundary(new Date('2026-09-05T11:30:00.000Z'))).toBe(600_000);
    expect(msUntilNextBoundary(new Date('2026-09-05T11:34:45.500Z'))).toBe(5 * 60_000 + 14_500);
    expect(msUntilNextBoundary(new Date('2026-09-05T11:30:45.500Z'), 60_000)).toBe(14_500);
  });

  it('publishes on the 10-minute boundary and then every 10 minutes, and stops cleanly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T11:34:45.000Z'));
    const published: string[] = [];
    const ticker = startRtcTicker({ publish: async (d) => { published.push(d.toISOString()); } });
    vi.advanceTimersByTime(5 * 60_000 + 14_999);
    expect(published).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(published).toEqual(['2026-09-05T11:40:00.000Z']);
    vi.advanceTimersByTime(600_000);
    expect(published).toEqual(['2026-09-05T11:40:00.000Z', '2026-09-05T11:50:00.000Z']);
    ticker.stop();
    vi.advanceTimersByTime(1_200_000);
    expect(published).toHaveLength(2);
  });
});
