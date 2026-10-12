import { describe, it, expect } from 'vitest';
import { parseTrustProxy } from '../trust-proxy.js';

describe('parseTrustProxy', () => {
  it('defaults to trusting nothing', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy(' FALSE ')).toBe(false);
  });

  it('accepts true', () => {
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('passes an IP / CIDR list through for Fastify to validate the peer', () => {
    expect(parseTrustProxy('127.0.0.1')).toBe('127.0.0.1');
    expect(parseTrustProxy('10.0.0.0/24,127.0.0.1')).toBe('10.0.0.0/24,127.0.0.1');
  });

  it('refuses a bare hop count instead of silently changing behaviour', () => {
    expect(() => parseTrustProxy('1')).toThrow(/hop count/);
    expect(() => parseTrustProxy('2')).toThrow(/IP or CIDR/);
  });
});
