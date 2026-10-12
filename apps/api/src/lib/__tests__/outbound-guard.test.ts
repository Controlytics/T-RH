import { describe, it, expect, afterEach } from 'vitest';
import {
  blockedAddressReason,
  literalHostBlockedReason,
  resolveBlockedReason,
  allowLoopbackForTests,
} from '../outbound-guard.js';

/**
 * Audit 2026-10-12 #1 — which addresses an operator-typed URL may reach. The
 * private LAN ranges must stay allowed (that is where hooters live); link-local,
 * loopback, unspecified and their IPv6 spellings must not.
 */
describe('blockedAddressReason', () => {
  afterEach(() => allowLoopbackForTests(false));

  it.each([
    '169.254.169.254', '169.254.0.1', '127.0.0.1', '127.8.9.10', '0.0.0.0', '0.1.2.3',
    '::1', '::', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'fd00:ec2::254',
    '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::169.254.169.254', '64:ff9b::169.254.169.254', '[::1]',
  ])('blocks %s', (ip) => {
    expect(blockedAddressReason(ip)).not.toBeNull();
  });

  it.each([
    '192.168.1.60', '10.0.0.5', '172.16.4.4', '8.8.8.8', '169.255.0.1', '126.255.255.255',
    'fd00::1', 'fd00:ec2::253', 'fc00::5', '2001:db8::1', '::ffff:192.168.1.60', 'fec0::1',
  ])('allows %s', (ip) => {
    expect(blockedAddressReason(ip)).toBeNull();
  });

  it('is not an IP check for a name', () => {
    expect(blockedAddressReason('hooter.local')).toBeNull();
  });

  it('the test seam relaxes LOOPBACK only — never link-local', () => {
    allowLoopbackForTests(true);
    expect(blockedAddressReason('127.0.0.1')).toBeNull();
    expect(blockedAddressReason('::1')).toBeNull();
    expect(blockedAddressReason('169.254.169.254')).not.toBeNull();
    expect(blockedAddressReason('::ffff:169.254.169.254')).not.toBeNull();
  });
});

describe('literalHostBlockedReason / resolveBlockedReason', () => {
  afterEach(() => allowLoopbackForTests(false));

  it('refuses an IP-literal metadata URL without touching the network', () => {
    expect(literalHostBlockedReason('http://169.254.169.254/latest/api/token')).not.toBeNull();
    expect(literalHostBlockedReason('http://[::ffff:a9fe:a9fe]/x')).not.toBeNull();
    expect(literalHostBlockedReason('http://192.168.1.60/alarm')).toBeNull();
  });

  it('refuses a NAME that resolves to loopback', async () => {
    expect(await resolveBlockedReason('http://localhost:8080/x')).toMatch(/loopback/);
  });

  it('does not refuse a name that cannot be resolved (the send path judges it)', async () => {
    expect(await resolveBlockedReason('http://no-such-host.invalid/x')).toBeNull();
  });
});
