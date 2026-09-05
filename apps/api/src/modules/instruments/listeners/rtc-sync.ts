import { publishRetained, EVENT_PUBLISH_OPTIONS, type PublishLogger } from '../attribute-downlink.js';
import { logger } from '../../../lib/logger.js';

/**
 * RTC SYNC — the platform tells devices what time it is (operator,
 * 2026-09-05: *"create another topic for rtc sync, {"method":"getTime"} user
 * will send request with this key, when ever we receive request we need to
 * send utc time, and also request is received or not for every minute that
 * current time utc time stamp should sent, this is global, add it for gateway
 * instrument"*).
 *
 * Two topics:
 *
 *   device → platform   instruments/<code>/rtc-request   {"method":"getTime"}
 *   platform → devices  digilog/rtc/time                  {"unix":1788600600000}
 *
 * The TIME topic is GLOBAL — one message every 10 minutes, on the wall-clock
 * boundary (:00, :10, :20 …), that every gateway subscribes to — and a request
 * from any instrument triggers the same message at once. It sits OUTSIDE `instruments/` so the bridge's own
 * `instruments/#` subscription never hands it back to itself, and so the
 * broker ACL can grant every device a subscribe on one literal topic. Not
 * retained: a clock read on connect must be fresh, not the last tick.
 *
 * The payload is exactly `{"unix":<epoch MILLISECONDS>}` — one key, a 13-digit
 * number (operator, 2026-09-05: "you have to send the payload like this it
 * seems {"unix":1792221233122}"). It went `{"method":"time","utc":<ISO>,"epoch"}`
 * → `utc` as a number → this, in one afternoon; the firmware's parser is the
 * authority on the shape. It is the unit the gateway already sends as `ts`.
 * There is no zone on the wire — an RTC holds UTC.
 */

export const RTC_TIME_TOPIC = 'digilog/rtc/time';
const RTC_REQUEST_PREFIX = 'instruments/';
const RTC_REQUEST_SUFFIX = '/rtc-request';

export function rtcRequestTopic(code: string): string {
  return `${RTC_REQUEST_PREFIX}${code}${RTC_REQUEST_SUFFIX}`;
}

/** `instruments/<code>/rtc-request` → `<code>`, or null. */
export function parseRtcRequestTopic(topic: string): string | null {
  if (topic.length <= RTC_REQUEST_PREFIX.length + RTC_REQUEST_SUFFIX.length) return null;
  if (!topic.startsWith(RTC_REQUEST_PREFIX) || !topic.endsWith(RTC_REQUEST_SUFFIX)) return null;
  const code = topic.slice(RTC_REQUEST_PREFIX.length, topic.length - RTC_REQUEST_SUFFIX.length);
  if (code.length === 0 || code.includes('+') || code.includes('#')) return null;
  return code;
}

/** Only `{"method":"getTime"}` is a request; anything else on the topic is ignored. */
export function isGetTimeRequest(raw: Buffer): boolean {
  try {
    const v = JSON.parse(raw.toString('utf8'));
    return v !== null && typeof v === 'object' && v.method === 'getTime';
  } catch {
    return false;
  }
}

export interface RtcTimePayload { unix: number }

/** `unix` is the epoch in MILLISECONDS, 13 digits — the only key. */
export function buildTimePayload(now: Date): RtcTimePayload {
  return { unix: now.getTime() };
}

const rtcLog: PublishLogger = (msg, meta) => logger.warn(`[rtc] ${msg}`, meta ?? '');

export async function publishTime(now: Date = new Date(), log?: PublishLogger): Promise<void> {
  await publishRetained(
    RTC_TIME_TOPIC,
    JSON.stringify(buildTimePayload(now)),
    'TIME NOT DELIVERED — devices were not told the time',
    log ?? rtcLog,
    EVENT_PUBLISH_OPTIONS,
  );
}

/** The automatic tick: every 10 minutes (operator, 2026-09-05: "make it every
 *  10 minutes" — it ran every minute for its first hours). */
export const RTC_TICK_MS = 10 * 60_000;

/** Milliseconds until the next wall-clock boundary of `periodMs`, from `now`. Pure. */
export function msUntilNextBoundary(now: Date, periodMs: number = RTC_TICK_MS): number {
  const ms = now.getTime() % periodMs;
  return ms === 0 ? periodMs : periodMs - ms;
}

/**
 * Publish the time on every period boundary until stopped. Aligned to the
 * wall clock rather than to the moment the bridge came up, so every gateway
 * sees the tick at a round instant (`:00`, `:10`, …) and a device that sets
 * its clock from it lands on a round boundary. Both timers are `unref()`'d — this repo has been bitten twice by a
 * stray handle holding the process open past shutdown.
 */
export function startRtcTicker(opts: {
  publish?: (now: Date) => Promise<void>;
  now?: () => Date;
  periodMs?: number;
} = {}): { stop(): void } {
  const publish = opts.publish ?? ((d: Date) => publishTime(d));
  const now = opts.now ?? (() => new Date());
  const periodMs = opts.periodMs ?? RTC_TICK_MS;
  let stopped = false;
  let interval: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    if (stopped) return;
    void publish(now());
    interval = setInterval(() => { if (!stopped) void publish(now()); }, periodMs);
    interval.unref();
  }, msUntilNextBoundary(now(), periodMs));
  first.unref();
  return {
    stop() {
      stopped = true;
      clearTimeout(first);
      if (interval) clearInterval(interval);
    },
  };
}
