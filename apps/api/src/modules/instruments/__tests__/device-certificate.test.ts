import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const writeDeadLetters = vi.fn(async (_rows: unknown[]) => {});
vi.mock('../telemetry.repository.js', () => ({
  writeDeadLetters: (rows: unknown[]) => writeDeadLetters(rows),
}));

import {
  deviceCertificateDecision,
  issueIdFromEmqxSubject,
  issueIdFromTlsSocket,
  recordCertificateRefusal,
  refusalReason,
  resetCertificateRefusalLimiter,
} from '../device-certificate.js';

const A = '0123456789abcdef0123456789abcdef';
const B = 'fedcba9876543210fedcba9876543210';

describe('deviceCertificateDecision — the spec table', () => {
  it('accepts anything when the profile does not require a certificate', () => {
    expect(deviceCertificateDecision({ required: false, currentIssueId: null, presentedIssueId: null })).toEqual({ ok: true });
    expect(deviceCertificateDecision({ required: false, currentIssueId: A, presentedIssueId: B })).toEqual({ ok: true });
  });
  it('refuses REQUIRED when nothing was presented', () => {
    expect(deviceCertificateDecision({ required: true, currentIssueId: A, presentedIssueId: null }))
      .toEqual({ ok: false, code: 'DEVICE_CERTIFICATE_REQUIRED' });
  });
  it('refuses NOT_ISSUED when a certificate was presented but the instrument has none', () => {
    expect(deviceCertificateDecision({ required: true, currentIssueId: null, presentedIssueId: A }))
      .toEqual({ ok: false, code: 'DEVICE_CERTIFICATE_NOT_ISSUED' });
  });
  it('refuses MISMATCH for an older or another instrument\'s certificate', () => {
    expect(deviceCertificateDecision({ required: true, currentIssueId: A, presentedIssueId: B }))
      .toEqual({ ok: false, code: 'DEVICE_CERTIFICATE_MISMATCH' });
  });
  it('accepts the current certificate', () => {
    expect(deviceCertificateDecision({ required: true, currentIssueId: A, presentedIssueId: A })).toEqual({ ok: true });
  });
});

describe('issueIdFromEmqxSubject', () => {
  it('reads the SERIALNUMBER component EMQX 5.3.2 sends (spike 2026-10-27)', () => {
    expect(issueIdFromEmqxSubject(`CN=Test,SERIALNUMBER=${A},O=DigiLog Device`)).toBe(A);
  });
  it('is case-insensitive on the key', () => {
    expect(issueIdFromEmqxSubject(`serialnumber=${A}`)).toBe(A);
  });
  it('returns null for no certificate (EMQX sends an empty string)', () => {
    expect(issueIdFromEmqxSubject('')).toBeNull();
    expect(issueIdFromEmqxSubject(undefined)).toBeNull();
    expect(issueIdFromEmqxSubject(42)).toBeNull();
  });
  it('returns null when there is no serial number, or it is not one of ours', () => {
    expect(issueIdFromEmqxSubject('CN=Test')).toBeNull();
    expect(issueIdFromEmqxSubject('CN=Test,SERIALNUMBER=iss-7f3a9c')).toBeNull();
    expect(issueIdFromEmqxSubject(`CN=Test,SERIALNUMBER=${A.toUpperCase()}`)).toBeNull();
  });
  it('returns the first well-formed component', () => {
    expect(issueIdFromEmqxSubject(`CN=x,SERIALNUMBER=${A},SERIALNUMBER=${B}`)).toBe(A);
  });
});

describe('issueIdFromTlsSocket', () => {
  const sock = (authorized: boolean, cert: unknown) => ({ authorized, getPeerCertificate: () => cert });
  it('ignores a certificate the TLS layer did not authorize (another CA, or none)', () => {
    expect(issueIdFromTlsSocket(sock(false, { subject: { serialNumber: A } }))).toBeNull();
  });
  it('reads the subject serial number of an authorized certificate', () => {
    expect(issueIdFromTlsSocket(sock(true, { subject: { serialNumber: A, CN: 'Test' } }))).toBe(A);
  });
  it('returns null for an authorized socket with no usable subject', () => {
    expect(issueIdFromTlsSocket(sock(true, {}))).toBeNull();
    expect(issueIdFromTlsSocket(sock(true, { subject: { serialNumber: 'iss-1' } }))).toBeNull();
  });
  it('returns null for a plain (non-TLS) socket', () => {
    expect(issueIdFromTlsSocket({})).toBeNull();
    expect(issueIdFromTlsSocket(null)).toBeNull();
  });
});

describe('refusalReason', () => {
  it('names the channel and the reason', () => {
    expect(refusalReason('DEVICE_CERTIFICATE_REQUIRED', 'mqtt'))
      .toBe("Refused on mqtt: this instrument's profile requires a device certificate and none was presented.");
    expect(refusalReason('DEVICE_CERTIFICATE_MISMATCH', 'http')).toMatch(/^Refused on http: .*not .*current/);
    expect(refusalReason('DEVICE_CERTIFICATE_NOT_ISSUED', 'ws')).toMatch(/^Refused on ws: .*no device certificate has been issued/);
  });
});

describe('recordCertificateRefusal — one dead letter per instrument, channel and reason per minute', () => {
  beforeEach(() => { vi.useFakeTimers(); writeDeadLetters.mockClear(); resetCertificateRefusalLimiter(); });
  afterEach(() => { vi.useRealTimers(); });

  it('writes once, then holds back repeats for 60 s', async () => {
    await recordCertificateRefusal('inst-1', 'mqtt', 'DEVICE_CERTIFICATE_REQUIRED');
    await recordCertificateRefusal('inst-1', 'mqtt', 'DEVICE_CERTIFICATE_REQUIRED');
    expect(writeDeadLetters).toHaveBeenCalledTimes(1);
    const [rows] = writeDeadLetters.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(rows).toEqual([expect.objectContaining({
      instrumentId: 'inst-1', transport: 'mqtt', rawPayload: null,
      reason: refusalReason('DEVICE_CERTIFICATE_REQUIRED', 'mqtt'),
    })]);
    vi.advanceTimersByTime(60_001);
    await recordCertificateRefusal('inst-1', 'mqtt', 'DEVICE_CERTIFICATE_REQUIRED');
    expect(writeDeadLetters).toHaveBeenCalledTimes(2);
  });

  it('counts each channel and each reason separately', async () => {
    await recordCertificateRefusal('inst-1', 'mqtt', 'DEVICE_CERTIFICATE_REQUIRED');
    await recordCertificateRefusal('inst-1', 'http', 'DEVICE_CERTIFICATE_REQUIRED');
    await recordCertificateRefusal('inst-1', 'http', 'DEVICE_CERTIFICATE_MISMATCH');
    await recordCertificateRefusal('inst-2', 'http', 'DEVICE_CERTIFICATE_MISMATCH');
    expect(writeDeadLetters).toHaveBeenCalledTimes(4);
  });

  it('never throws when the write fails', async () => {
    writeDeadLetters.mockRejectedValueOnce(new Error('db down'));
    await expect(recordCertificateRefusal('inst-1', 'tcp', 'DEVICE_CERTIFICATE_REQUIRED')).resolves.toBeUndefined();
  });
});
