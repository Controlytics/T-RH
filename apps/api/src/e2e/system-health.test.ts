import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet } from './test-helper.js';

describe('System Health endpoints', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildApp();
    adminToken = await loginAs(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/system-health', () => {
    it('returns system health metrics for admin', async () => {
      const res = await authGet(app, '/api/system-health', adminToken);
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);

      // OS
      expect(body.os).toBeDefined();
      expect(body.os.hostname).toBeTruthy();
      expect(body.os.platform).toBeTruthy();
      expect(body.os.arch).toBeTruthy();
      expect(typeof body.os.uptimeSeconds).toBe('number');
      expect(body.os.loadAvg).toBeDefined();

      // Memory
      expect(body.memory).toBeDefined();
      expect(body.memory.totalBytes).toBeGreaterThan(0);
      expect(body.memory.usedBytes).toBeGreaterThan(0);
      expect(body.memory.usagePercent).toBeGreaterThanOrEqual(0);
      expect(body.memory.usagePercent).toBeLessThanOrEqual(100);

      // CPU
      expect(body.cpu).toBeDefined();
      expect(body.cpu.cores).toBeGreaterThanOrEqual(1);
      expect(body.cpu.model).toBeTruthy();
      expect(typeof body.cpu.usagePercent).toBe('number');

      // Disk — a MEASUREMENT, not the silent zeros of audit 2026-10-03, API-17.
      // `statfs` works on every platform the suite runs on, so `available` is
      // true here; the fields are asserted individually because Fastify strips
      // an undeclared response property without a word.
      expect(body.disk).toBeDefined();
      expect(body.disk.available).toBe(true);
      expect(body.disk.error).toBeNull();
      expect(typeof body.disk.path).toBe('string');
      expect(body.disk.totalBytes).toBeGreaterThan(0);
      expect(body.disk.freeBytes).toBeGreaterThan(0);
      expect(body.disk.usagePercent).toBeGreaterThan(0);
      expect(body.disk.usagePercent).toBeLessThanOrEqual(100);
      // Load average is a Unix figure; Windows reports [0,0,0] and must say so.
      expect(body.os.loadAvg.available).toBe(process.platform !== 'win32');

      // Process
      expect(body.process).toBeDefined();
      expect(body.process.nodeVersion).toMatch(/^v\d+/);
      expect(body.process.pid).toBeGreaterThan(0);
      expect(body.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(body.process.memoryUsage.rss).toBeGreaterThan(0);
      expect(body.process.memoryUsage.heapUsed).toBeGreaterThan(0);

      // API
      expect(body.api).toBeDefined();
      expect(typeof body.api.totalRequests).toBe('number');
      expect(typeof body.api.requestsPerMinute).toBe('number');

      // Database
      expect(body.database).toBeDefined();
      expect(body.database.connected).toBe(true);
      expect(body.database.databaseSize).toBeTruthy();
      expect(body.database.activeConnections).toBeGreaterThanOrEqual(1);
      expect(body.database.totalTables).toBeGreaterThanOrEqual(1);

      // Timestamp
      expect(body.timestamp).toBeTruthy();
    });

    it('returns 401 without authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/system-health',
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
