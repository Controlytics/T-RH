/**
 * Which ingest transports have a listener behind them RIGHT NOW.
 *
 * Extracted from `connection-instructions.tsx` on 2026-08-06, when `mqtts` was
 * verified and the set became all seven. That is precisely when the "<X> is not
 * accepting connections yet" banner stops being reachable through the
 * component's public API — an unrecognised `transport` prop falls back to
 * `http`, so with nothing un-live left there is no way to render the banner and
 * its logic quietly becomes dead code.
 *
 * Keeping the fact in its own module lets a test substitute it and drive the
 * banner anyway, so the mechanism stays pinned for the next transport that is
 * added ahead of its listener. Do not inline this back into the component.
 */

/**
 * A member of this set is a claim that someone connected over that protocol and
 * watched a reading land in `instrument_telemetry_latest` — not that a plan says
 * the listener landed. Verified 2026-08-06: HTTP/HTTPS on the ingest route, TCP
 * on `INGEST_TCP_PORT`, WS/WSS on `/api/ingest/v1/ws`, and MQTT/MQTTS through
 * EMQX 5.3.2 into the ingest bridge.
 */
export const LIVE_TRANSPORTS: ReadonlySet<string> = new Set([
  'http',
  'https',
  'tcp',
  'websocket',
  'wss',
  'mqtt',
  'mqtts',
]);

/**
 * KNOWN LIMITATION: compile-time, so the UI makes the same claim on every
 * machine — including one with no broker running. Making it true locally is an
 * operator step, documented in LOCAL_SETUP_WINDOWS.md §9 / §9A / §9B.
 */
export function isTransportLive(transport: string): boolean {
  return LIVE_TRANSPORTS.has(transport);
}
