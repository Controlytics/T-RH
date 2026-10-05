import { type FastifyPluginAsync } from 'fastify';
import os from 'node:os';
import { prisma } from '../../lib/prisma.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { getDiskUsage } from './disk.js';

// ── In-memory request counter ──────────────────────────────────────────
let totalRequests = 0;
const requestTimestamps: number[] = [];

/** Call this from the onRequest hook to track API requests. */
export function trackRequest() {
  totalRequests++;
  const now = Date.now();
  requestTimestamps.push(now);
  // Keep only last 5 minutes of timestamps
  const fiveMinAgo = now - 5 * 60 * 1000;
  while (requestTimestamps.length > 0 && requestTimestamps[0] < fiveMinAgo) {
    requestTimestamps.shift();
  }
}

/** Get requests per minute (average over last 5 min). */
function getRequestsPerMinute(): number {
  const now = Date.now();
  const oneMinAgo = now - 60 * 1000;
  const recentCount = requestTimestamps.filter((t) => t >= oneMinAgo).length;
  return recentCount;
}

// Disk usage lives in ./disk.ts (audit 2026-10-03, API-17): `wmic` is gone
// from current Windows and the old reader returned zeros silently.

// ── CPU usage helper (1-second sample) ─────────────────────────────────
async function getCpuUsage(): Promise<number> {
  const cpus1 = os.cpus();
  await new Promise((r) => setTimeout(r, 500));
  const cpus2 = os.cpus();

  let totalIdle = 0;
  let totalTick = 0;

  for (let i = 0; i < cpus1.length; i++) {
    const c1 = cpus1[i].times;
    const c2 = cpus2[i].times;

    const idle = c2.idle - c1.idle;
    const total =
      c2.user - c1.user + c2.nice - c1.nice + c2.sys - c1.sys + c2.idle - c1.idle + c2.irq - c1.irq;

    totalIdle += idle;
    totalTick += total;
  }

  return totalTick === 0 ? 0 : Math.round(((totalTick - totalIdle) / totalTick) * 100);
}

// ── Database stats helper ──────────────────────────────────────────────
async function getDbStats(): Promise<{
  connected: boolean;
  databaseSize: string;
  activeConnections: number;
  totalTables: number;
}> {
  try {
    const sizeResult = await prisma.$queryRawUnsafe<{ size: string }[]>(
      "SELECT pg_size_pretty(pg_database_size(current_database())) as size",
    );
    const connResult = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      "SELECT count(*) as count FROM pg_stat_activity WHERE datname = current_database()",
    );
    const tableResult = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      "SELECT count(*) as count FROM information_schema.tables WHERE table_schema = 'public'",
    );

    return {
      connected: true,
      databaseSize: sizeResult[0]?.size ?? 'unknown',
      activeConnections: Number(connResult[0]?.count ?? 0),
      totalTables: Number(tableResult[0]?.count ?? 0),
    };
  } catch {
    return { connected: false, databaseSize: 'unknown', activeConnections: 0, totalTables: 0 };
  }
}

// ── Route plugin ───────────────────────────────────────────────────────
const systemHealthRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/system-health — Main system health endpoint (ADMIN+)
  app.get(
    '/',
    {
      preHandler: [app.requireRole('SUPER_ADMIN', 'ADMIN')],
      schema: {
        tags: ['System Health'],
        summary: 'Get system health metrics',
        description:
          'Returns OS, memory, CPU, disk, process, API request, and database metrics. Requires ADMIN role.',
        response: {
          200: {
            type: 'object',
            properties: {
              os: {
                type: 'object',
                properties: {
                  hostname: { type: 'string' },
                  platform: { type: 'string' },
                  arch: { type: 'string' },
                  release: { type: 'string' },
                  uptimeSeconds: { type: 'number' },
                  loadAvg: {
                    type: 'object',
                    properties: {
                      '1m': { type: 'number' },
                      '5m': { type: 'number' },
                      '15m': { type: 'number' },
                      // `os.loadavg()` is ALWAYS [0, 0, 0] on Windows (Node
                      // documents it); printing 0.00 there reads as an idle
                      // machine. Declared so the page can say "unavailable".
                      available: { type: 'boolean' },
                    },
                  },
                },
              },
              memory: {
                type: 'object',
                properties: {
                  totalBytes: { type: 'number' },
                  usedBytes: { type: 'number' },
                  freeBytes: { type: 'number' },
                  usagePercent: { type: 'number' },
                },
              },
              cpu: {
                type: 'object',
                properties: {
                  cores: { type: 'number' },
                  model: { type: 'string' },
                  usagePercent: { type: 'number' },
                },
              },
              disk: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'The path the figures describe — the uploads root, the disk this process writes to.' },
                  totalBytes: { type: 'number' },
                  usedBytes: { type: 'number' },
                  freeBytes: { type: 'number' },
                  usagePercent: { type: 'number' },
                  // Both DECLARED, or Fastify strips them and the page is back
                  // to a silent zero (audit 2026-10-03, API-17).
                  available: { type: 'boolean', description: 'False when no reader could measure the disk; the numbers are then 0 and `error` says why.' },
                  error: { type: 'string', nullable: true },
                },
              },
              process: {
                type: 'object',
                properties: {
                  nodeVersion: { type: 'string' },
                  pid: { type: 'number' },
                  uptimeSeconds: { type: 'number' },
                  memoryUsage: {
                    type: 'object',
                    properties: {
                      rss: { type: 'number' },
                      heapTotal: { type: 'number' },
                      heapUsed: { type: 'number' },
                      external: { type: 'number' },
                    },
                  },
                },
              },
              api: {
                type: 'object',
                properties: {
                  totalRequests: { type: 'number' },
                  requestsPerMinute: { type: 'number' },
                },
              },
              database: {
                type: 'object',
                properties: {
                  connected: { type: 'boolean' },
                  databaseSize: { type: 'string' },
                  activeConnections: { type: 'number' },
                  totalTables: { type: 'number' },
                },
              },
              timestamp: { type: 'string' },
            },
          },
          ...errorResponses,
        },
      },
    },
    async () => {
      const [cpuUsage, disk, dbStats] = await Promise.all([getCpuUsage(), getDiskUsage(), getDbStats()]);

      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const loadAvg = os.loadavg();
      const mem = process.memoryUsage();

      return {
        os: {
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
          release: os.release(),
          uptimeSeconds: Math.round(os.uptime()),
          loadAvg: {
            '1m': Math.round(loadAvg[0] * 100) / 100,
            '5m': Math.round(loadAvg[1] * 100) / 100,
            '15m': Math.round(loadAvg[2] * 100) / 100,
            available: process.platform !== 'win32',
          },
        },
        memory: {
          totalBytes: totalMem,
          usedBytes: usedMem,
          freeBytes: freeMem,
          usagePercent: Math.round((usedMem / totalMem) * 100),
        },
        cpu: {
          cores: os.cpus().length,
          model: os.cpus()[0]?.model ?? 'unknown',
          usagePercent: cpuUsage,
        },
        disk: {
          path: disk.path,
          totalBytes: disk.total,
          usedBytes: disk.used,
          freeBytes: disk.free,
          usagePercent: disk.usagePercent,
          available: disk.available,
          error: disk.error,
        },
        process: {
          nodeVersion: process.version,
          pid: process.pid,
          uptimeSeconds: Math.round(process.uptime()),
          memoryUsage: {
            rss: mem.rss,
            heapTotal: mem.heapTotal,
            heapUsed: mem.heapUsed,
            external: mem.external,
          },
        },
        api: {
          totalRequests,
          requestsPerMinute: getRequestsPerMinute(),
        },
        database: dbStats,
        timestamp: new Date().toISOString(),
      };
    },
  );
};

export default systemHealthRoutes;
