import type { FastifyPluginAsync } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { modbusRegisterMapSchema } from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { resolveVisibility, withVisibility } from '../instruments/visibility.js';
import { resolvedSlotFor } from '../instruments/data-keys.js';
import { slotConfigForProfile } from '../instruments/profile-measurements.js';
import { loadModbusReaderConfig } from './config.js';
import { checkModbusAddress } from './address.js';
import { readDevice } from './protocol/index.js';
import { explainReadTarget } from './reader.js';
import { loadInactivityConfig } from '../alarms/load-inactivity.js';

/** Exact wording (plan Global Constraints, "Failure wording"). */
export const READING_OFF_MESSAGE = 'Reading devices from this server is off (Configuration → TCP/IP Reading).';

export interface ModbusRoutesOptions {
  /**
   * Ledger ruling P-1: admits 127.0.0.1 (and nothing else outside the device
   * networks) so an e2e test can read an in-process fake slave. Only
   * `e2e/test-helper.ts` sets it; `app.ts` never does and nothing reads it
   * from the environment.
   */
  allowLoopbackForTests?: boolean;
}

interface TestBody {
  profileId: string;
  modbusHost: string;
  modbusPort: number;
  modbusRegisters: unknown[];
  instrumentId?: string | null;
}

/**
 * Test connection (TCP/IP instruments spec §8): read the device ONCE with the
 * form's own address and map and show what came back. Nothing is stored and
 * nothing is audited — it is a look, not a record. Every decision (address
 * allowed / in use, reading on or off, which key is judged) is made here; the
 * browser only prints the answer.
 */
const modbusRoutes: FastifyPluginAsync<ModbusRoutesOptions> = async (app, opts) => {
  // app.ts registers @fastify/rate-limit globally; the e2e app does not (turning
  // it on there would put the login limits on every other suite). Register it
  // here, scoped to this plugin, only when no parent has — so the per-route
  // limit below is real in both.
  if (!app.hasDecorator('rateLimit')) {
    await app.register(rateLimit, { global: false });
  }

  app.post<{ Body: TestBody }>('/test', {
    preHandler: [app.requireAnyPermission('INSTRUMENT_CREATE', 'INSTRUMENT_UPDATE')],
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (req) => `modbus-test:${req.user.sub}`,
      },
    },
    schema: {
      tags: ['Instruments'],
      summary: 'Test connection to a TCP/IP (Modbus) device',
      description: 'Reads the device once with the given address and register map and returns what it answered. Stores nothing, audits nothing. A device failure, reading switched off and an address already in use are 200 answers with ok:false; a malformed body or a refused address is 400.',
      body: {
        type: 'object',
        required: ['profileId', 'modbusHost', 'modbusPort', 'modbusRegisters'],
        properties: {
          profileId: { type: 'string', format: 'uuid' },
          modbusHost: { type: 'string' },
          modbusPort: { type: 'integer' },
          modbusRegisters: { type: 'array', items: { type: 'object' } },
          instrumentId: { type: ['string', 'null'], format: 'uuid' },
        },
      },
    },
  }, async (req, reply) => {
    const { profileId, modbusHost, modbusPort, modbusRegisters } = req.body;
    const instrumentId = req.body.instrumentId ?? undefined;

    const profile = await prisma.instrumentProfile.findUnique({
      where: { id: profileId },
      select: { id: true, connection: true, modbusUnitId: true },
    });
    if (!profile) return reply.code(404).send({ error: 'PROFILE_NOT_FOUND', message: 'That instrument profile does not exist.' });
    if (profile.connection !== 'MODBUS_TCP' || profile.modbusUnitId === null) {
      return reply.code(400).send({ error: 'NOT_A_TCPIP_PROFILE', message: 'Test connection is only for a TCP/IP (Modbus) profile.' });
    }

    // A malformed map is a 400 here, never a throw out of readDevice's planner.
    const parsed = modbusRegisterMapSchema.safeParse(modbusRegisters);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'The register map is not valid.', details: parsed.error.flatten() });
    }
    const map = parsed.data;
    if (map.length === 0) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Add at least one register to test.' });
    }

    const visibility = await resolveVisibility(buildContext(req));
    if (instrumentId) {
      const visible = await prisma.instrument.findFirst({
        where: withVisibility({ id: instrumentId }, visibility.where) as { id: string },
        select: { id: true },
      });
      if (!visible) return reply.code(404).send({ error: 'INSTRUMENT_NOT_FOUND', message: 'Instrument not found.' });
    }

    const check = await checkModbusAddress(modbusHost, modbusPort, {
      excludeInstrumentId: instrumentId,
      visibility,
      allowLoopbackForTests: opts.allowLoopbackForTests === true,
    });
    if (!check.ok) {
      if (check.code === 'ADDRESS_IN_USE') return { ok: false, code: check.code, message: check.message };
      return reply.code(check.status).send({ error: check.code, message: check.message });
    }

    const { serverReadingEnabled } = await loadModbusReaderConfig();
    if (!serverReadingEnabled) {
      return { ok: false, code: 'READING_OFF', message: READING_OFF_MESSAGE };
    }

    // An unexpected throw here is a bug: it propagates to the global handler
    // (logged, 500) instead of being turned into a quiet ok:false.
    const result = await readDevice({
      host: modbusHost, port: modbusPort, unitId: profile.modbusUnitId, map,
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };

    // judgedAs: the slot the PROFILE's key mappings resolve each key to, given
    // every key of THIS map as the instrument's keys — the server's own rule
    // (`resolvedSlotFor`), so two keys naming one measurement mark only one.
    const cfg = await slotConfigForProfile(profile.id);
    const keys = map.map((r) => r.key);
    const values = map
      .filter((r) => Object.prototype.hasOwnProperty.call(result.values, r.key))
      .map((r) => {
        const slot = resolvedSlotFor(cfg, r.key, keys);
        return { key: r.key, value: result.values[r.key], judgedAs: slot ? slot.toUpperCase() : null };
      });
    return { ok: true, elapsedMs: result.elapsedMs, requests: result.requests, values, rejected: result.rejected };
  });
};

/**
 * Whether the application is reaching a TCP/IP instrument (spec §9). Mounted at
 * `/api/instruments` (not under `/modbus`) so the path is `/:id/modbus-status`.
 *
 * Every word is the server's: `state` is `failing` ONLY when the Reader set
 * `failingSince` (three consecutive DEVICE failures; a storage failure never
 * does — ruling T9-1), else `reading` or `not-read`, and `not-read` carries the
 * Reader's own reason from the one rule it runs (`explainReadTarget`). A last
 * error is reported whatever its cause. The browser prints this, nothing more.
 */
export const modbusStatusRoutes: FastifyPluginAsync<ModbusRoutesOptions> = async (app, opts) => {
  app.get<{ Params: { id: string } }>('/:id/modbus-status', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Is the application reaching this TCP/IP (Modbus) instrument?',
      description: 'State (reading / failing / not-read), why it is not read, the read interval, the last success and failure, readings stored in the last 24 h against the number expected, and whether Inactivity Alarms are off. 400 for a Gateway (push) instrument; 404 outside the caller\'s instrument scope.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const { id } = req.params;
    const visibility = await resolveVisibility(buildContext(req));
    const inst = await prisma.instrument.findFirst({
      where: withVisibility({ id }, visibility.where) as { id: string },
      select: { id: true, profile: { select: { connection: true, modbusIntervalSec: true } } },
    });
    if (!inst) return reply.code(404).send({ error: 'INSTRUMENT_NOT_FOUND', message: 'Instrument not found.' });
    const intervalSec = inst.profile.modbusIntervalSec;
    if (inst.profile.connection !== 'MODBUS_TCP' || intervalSec === null) {
      return reply.code(400).send({ error: 'NOT_A_TCPIP_INSTRUMENT', message: 'This instrument is not a TCP/IP (Modbus) instrument.' });
    }

    const since = new Date(Date.now() - 86_400_000);
    const [row, target, inactivity, stored] = await Promise.all([
      prisma.modbusPollStatus.findUnique({ where: { instrumentId: id } }),
      explainReadTarget(id, { allowLoopbackForTests: opts.allowLoopbackForTests === true }),
      loadInactivityConfig(),
      prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(DISTINCT ts)::bigint AS n FROM instrument_telemetry_history
        WHERE instrument_id = ${id} AND ts >= ${since}`,
    ]);

    const failing = row?.failingSince != null;
    const state = failing ? 'failing' : target?.ok ? 'reading' : 'not-read';
    return {
      state,
      ...(target && !target.ok ? { notReadReason: target.code, notReadDetail: target.detail } : {}),
      readBy: 'server' as const,
      intervalSec,
      lastSuccessAt: row?.lastSuccessAt ?? null,
      failingSince: row?.failingSince ?? null,
      ...(row?.lastErrorCode && row.lastErrorAt
        ? { lastError: { code: row.lastErrorCode, message: row.lastErrorMessage ?? '', at: row.lastErrorAt } }
        : {}),
      stored24h: Number(stored[0]?.n ?? 0),
      expected24h: Math.floor(86_400 / intervalSec),
      inactivityAlarmsOff: !inactivity.enabled,
    };
  });
};

export default modbusRoutes;
