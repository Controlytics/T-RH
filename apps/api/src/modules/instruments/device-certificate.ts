import { randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { writeDeadLetters } from './telemetry.repository.js';

/**
 * DEVICE CERTIFICATES (2026-10-27) — the ONE decision every ingest channel
 * asks: may this connection deliver data for this instrument?
 *
 * A profile can require each device to prove itself with its OWN client
 * certificate, issued by the platform's device CA (`device-ca.ts`). The
 * server cannot see whether a device loaded the SERVER's `ca.crt` — that is a
 * check inside the device — so a certificate the device PRESENTS is the only
 * thing it can enforce and prove (spec
 * `docs/superpowers/specs/2026-10-27-device-certificates-design.md`).
 *
 * Identity is the certificate's ISSUE ID — a random 32-hex value carried as
 * the subject's `serialNumber` and stored on the instrument — never the CN:
 * renaming an instrument must not break its certificate, and re-issuing or
 * revoking must kill every older certificate at once (pinning, not CRLs).
 * HTTPS / WebSocket read it from the TLS socket, MQTT from the subject string
 * the EMQX hook forwards, raw TCP never has one. ONE rule for all of them —
 * a fingerprint on one channel and a subject on another would be two rules.
 */

export type DeviceCertRefusal =
  | 'DEVICE_CERTIFICATE_REQUIRED'
  | 'DEVICE_CERTIFICATE_NOT_ISSUED'
  | 'DEVICE_CERTIFICATE_MISMATCH';

export type DeviceCertVerdict = { ok: true } | { ok: false; code: DeviceCertRefusal };

const ISSUE_ID = /^[0-9a-f]{32}$/;

export function deviceCertificateDecision(a: {
  required: boolean;
  currentIssueId: string | null;
  presentedIssueId: string | null;
}): DeviceCertVerdict {
  if (!a.required) return { ok: true };
  if (a.presentedIssueId === null) return { ok: false, code: 'DEVICE_CERTIFICATE_REQUIRED' };
  if (a.currentIssueId === null) return { ok: false, code: 'DEVICE_CERTIFICATE_NOT_ISSUED' };
  if (a.presentedIssueId !== a.currentIssueId) return { ok: false, code: 'DEVICE_CERTIFICATE_MISMATCH' };
  return { ok: true };
}

/**
 * The issue id from the subject string EMQX 5.3.2 renders for
 * `${cert_subject}` — measured on the broker 2026-10-27:
 * `CN=Test,SERIALNUMBER=<id>,O=DigiLog Device`, and `""` when the client sent
 * no certificate (plain 1883 always sends `""`). A certificate from another CA
 * never gets this far: EMQX refuses it at the handshake.
 */
export function issueIdFromEmqxSubject(subject: unknown): string | null {
  if (typeof subject !== 'string' || subject.length === 0) return null;
  for (const part of subject.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toUpperCase() !== 'SERIALNUMBER') continue;
    const value = part.slice(eq + 1).trim();
    if (ISSUE_ID.test(value)) return value;
  }
  return null;
}

/**
 * The issue id from a Node TLS socket. Only a certificate the TLS layer
 * AUTHORIZED against the device CA counts: the server runs with
 * `rejectUnauthorized: false` so devices without a certificate still connect,
 * which means a certificate from any other CA reaches us — unauthorized — and
 * must read as "none", never as a pass.
 */
export function issueIdFromTlsSocket(socket: unknown): string | null {
  if (!socket || typeof socket !== 'object') return null;
  const s = socket as { authorized?: unknown; getPeerCertificate?: () => unknown };
  if (s.authorized !== true || typeof s.getPeerCertificate !== 'function') return null;
  const cert = s.getPeerCertificate() as { subject?: { serialNumber?: unknown } } | null | undefined;
  const value = cert?.subject?.serialNumber;
  return typeof value === 'string' && ISSUE_ID.test(value) ? value : null;
}

export function refusalReason(code: DeviceCertRefusal, transport: string): string {
  switch (code) {
    case 'DEVICE_CERTIFICATE_REQUIRED':
      return `Refused on ${transport}: this instrument's profile requires a device certificate and none was presented.`;
    case 'DEVICE_CERTIFICATE_NOT_ISSUED':
      return `Refused on ${transport}: this instrument's profile requires a device certificate and no device certificate has been issued for it.`;
    case 'DEVICE_CERTIFICATE_MISMATCH':
      return `Refused on ${transport}: the device certificate presented is not this instrument's current one (re-issued or revoked).`;
  }
}

// One dead letter per instrument + channel + reason per minute: a device in a
// reconnect loop (MQTT retries every few seconds) must leave evidence, not
// flood the table.
const REFUSAL_WINDOW_MS = 60_000;
const lastRecorded = new Map<string, number>();

export function resetCertificateRefusalLimiter(): void { lastRecorded.clear(); }

export async function recordCertificateRefusal(
  instrumentId: string,
  transport: string,
  code: DeviceCertRefusal,
): Promise<void> {
  const key = `${instrumentId}|${transport}|${code}`;
  const now = Date.now();
  const last = lastRecorded.get(key);
  if (last !== undefined && now - last < REFUSAL_WINDOW_MS) return;
  lastRecorded.set(key, now);
  try {
    await writeDeadLetters([{
      id: randomUUID(), instrumentId, transport, reason: refusalReason(code, transport), rawPayload: null,
    }]);
  } catch (e) {
    // The refusal itself already happened; failing to record it must not turn
    // a 403 into a 500 or crash a listener — the same rule as ingest-core's
    // safeWriteDeadLetters. Logged, and the slot released so the next attempt
    // tries again.
    logger.error('[ingest] device-certificate refusal: dead-letter write failed', e);
    lastRecorded.delete(key);
  }
}
