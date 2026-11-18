import { describe, it, expect } from 'vitest';
import { poolUrl, poolSettings } from '../prisma.js';

/**
 * Performance audit 2026-11-17, P-04: three pools, each with its own size and time
 * limits, all built by ONE pure function from DATABASE_URL.
 */
const BASE = 'postgresql://digilog:p%40ss@localhost:5432/compliance_core_db?schema=public';
const params = (u: string) => new URL(u).searchParams;

describe('poolUrl', () => {
  it('general: 10 connections, 5-minute statement and socket limits, named', () => {
    const p = params(poolUrl(BASE, 'general', {}));
    expect(p.get('connection_limit')).toBe('10');
    expect(p.get('pool_timeout')).toBe('10');
    expect(p.get('connect_timeout')).toBe('5');
    expect(p.get('socket_timeout')).toBe('305');
    expect(p.get('options')).toBe('-c statement_timeout=300000');
    expect(p.get('application_name')).toBe('compliance-core:general');
    expect(p.get('schema')).toBe('public');
  });

  it('critical: a small reserved pool with the same limits', () => {
    const p = params(poolUrl(BASE, 'critical', {}));
    expect(p.get('connection_limit')).toBe('3');
    // 15 s to open a connection: the reserved pool must still open one to a slow database.
    expect(p.get('connect_timeout')).toBe('15');
    expect(p.get('options')).toBe('-c statement_timeout=300000');
    expect(p.get('application_name')).toBe('compliance-core:critical');
  });

  it('long: NO statement limit and NO socket limit — backup, restore and maintenance are never cut', () => {
    const p = params(poolUrl(BASE, 'long', {}));
    expect(p.get('connection_limit')).toBe('2');
    expect(p.get('options')).toBe('-c statement_timeout=0');
    expect(p.has('socket_timeout')).toBe(false);
  });

  it('keeps the credentials exactly (an encoded password survives)', () => {
    const u = new URL(poolUrl(BASE, 'long', {}));
    expect(u.username).toBe('digilog');
    expect(u.password).toBe('p%40ss');
    expect(u.pathname).toBe('/compliance_core_db');
  });

  it('keeps a pool size the operator put in DATABASE_URL for general, never for the others', () => {
    const base = `${BASE}&connection_limit=25`;
    expect(params(poolUrl(base, 'general', {})).get('connection_limit')).toBe('25');
    expect(params(poolUrl(base, 'critical', {})).get('connection_limit')).toBe('3');
  });

  it('adds the statement limit beside options already there, replacing an older limit', () => {
    const base = `${BASE}&options=${encodeURIComponent('-c search_path=public -c statement_timeout=9')}`;
    expect(params(poolUrl(base, 'critical', {})).get('options')).toBe('-c search_path=public -c statement_timeout=300000');
  });

  it('sizes come from DB_POOL_* when set to a positive integer, else the defaults', () => {
    expect(poolSettings('general', { DB_POOL_GENERAL: '20' }).connectionLimit).toBe(20);
    expect(poolSettings('critical', { DB_POOL_CRITICAL: '0' }).connectionLimit).toBe(3);
    expect(poolSettings('long', { DB_POOL_LONG: 'x' }).connectionLimit).toBe(2);
  });
});
