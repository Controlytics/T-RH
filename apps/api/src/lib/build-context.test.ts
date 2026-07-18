import { describe, it, expect } from 'vitest';
import { buildContext } from './build-context.js';

describe('buildContext', () => {
  it('extracts context from Fastify request', () => {
    const req = {
      user: { sub: 'user-id-1', username: 'admin', role: 'ADMIN', sessionId: 'sess-1' },
      ip: '192.168.1.1',
      headers: { 'user-agent': 'Mozilla/5.0' },
    } as any;

    const ctx = buildContext(req);

    expect(ctx.userId).toBe('admin');
    expect(ctx.userSub).toBe('user-id-1');
    expect(ctx.userRole).toBe('ADMIN');
    expect(ctx.ipAddress).toBe('192.168.1.1');
    expect(ctx.userAgent).toBe('Mozilla/5.0');
    expect(ctx.sessionId).toBe('sess-1');
  });

  it('handles missing user-agent header', () => {
    const req = {
      user: { sub: 'u1', username: 'test', role: 'VIEWER', sessionId: 's1' },
      ip: '10.0.0.1',
      headers: {},
    } as any;

    const ctx = buildContext(req);
    expect(ctx.userAgent).toBeUndefined();
  });
});
