import type { FastifyPluginAsync } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { modbusRegisterMapSchema, MODBUS_UNIT_ID_MESSAGE } from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { resolveVisibility, withVisibility } from '../instruments/visibility.js';
import { resolvedSlotFor } from '../instruments/data-keys.js';
import { slotConfigForProfile } from '../instruments/profile-measurements.js';
import { loadModbusReaderConfig } from './config.js';
import { checkModbusAddress } from './address.js';
import { readDevice } from './protocol/index.js';
import { explainReadTarget, isSendableUnitId, isReadInterval } from './reader.js';
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
  /**
   * The Slave ID to read with — the form's, as the address and map are (CR-1).
   * Untyped in the JSON schema on purpose (review M3): with Fastify's
   * `coerceTypes` an `integer` field turns `null` into 0 and `true` into 1, so a
   * blank Slave ID would read unit 0. The handler judges the raw value.
   */
  modbusUnitId: unknown;
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
      // 30 a minute per user (ruling CR1-7, 2026-11-02; was 10): the form has
      // a Test button per key, and "add a key, test it" on a 12-key device
      // passed 10 inside a minute. Over it: 429 TOO_MANY_REQUESTS whose message
      // is the plugin's "Rate limit exceeded, retry in <time left>".
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: (req) => `modbus-test:${req.user.sub}`,
      },
    },
    schema: {
      tags: ['Instruments'],
      summary: 'Test connection to a TCP/IP (Modbus) device',
      description: 'Reads the device once with the given address, Slave ID and register map and returns what it answered. Stores nothing, audits nothing. A device failure, reading switched off and an address already in use are 200 answers with ok:false; a malformed body or a refused address is 400.',
      body: {
        type: 'object',
        required: ['profileId', 'modbusHost', 'modbusPort', 'modbusRegisters', 'modbusUnitId'],
        properties: {
          profileId: { type: 'string', format: 'uuid' },
          modbusHost: { type: 'string' },
          modbusPort: { type: 'integer' },
          modbusRegisters: { type: 'array', items: { type: 'object' } },
          // The form's Slave ID (CR-1, 2026-11-02 — the instrument's own, no
          // longer the profile's). NO `type`: Ajv's coercion would turn null into
          // 0 and true into 1 (review M3). Required here, judged in the handler —
          // a whole number 0..255 or the field's one sentence.
          modbusUnitId: { description: 'The Modbus unit (Slave) ID to read with: a whole number 0..255 (null, a string or a boolean is a 400).' },
          instrumentId: { type: ['string', 'null'], format: 'uuid' },
        },
      },
    },
  }, async (req, reply) => {
    const { profileId, modbusHost, modbusPort, modbusRegisters, modbusUnitId } = req.body;
    const instrumentId = req.body.instrumentId ?? undefined;

    const profile = await prisma.instrumentProfile.findUnique({
      where: { id: profileId },
      select: { id: true, connection: true },
    });
    if (!profile) return reply.code(404).send({ error: 'PROFILE_NOT_FOUND', message: 'That instrument profile does not exist.' });
    if (profile.connection !== 'MODBUS_TCP') {
      return reply.code(400).send({ error: 'NOT_A_TCPIP_PROFILE', message: 'Test connection is only for a TCP/IP (Modbus) profile.' });
    }
    // The form's Slave ID, by the Reader's own range rule (final review F-6):
    // nothing outside 0..255 reaches a socket. It is the instrument's since
    // 2026-11-02 (CR-1), so it comes with the address, never from the profile.
    if (!isSendableUnitId(modbusUnitId)) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR', message: MODBUS_UNIT_ID_MESSAGE,
        details: { formErrors: [], fieldErrors: { modbusUnitId: [MODBUS_UNIT_ID_MESSAGE] } },
      });
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
      host: modbusHost, port: modbusPort, unitId: modbusUnitId, map,
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
 * Every word is the server's: `state` is `not-read` whenever the Reader's own
 * rule (`explainReadTarget`) would not read the instrument, carrying that rule's
 * reason; otherwise `failing` ONLY when the Reader set `failingSince` (three
 * consecutive DEVICE failures; a storage failure never does — ruling T9-1), else
 * `reading`. A last error is reported whatever its cause. The browser prints
 * this, nothing more.
 */
export const modbusStatusRoutes: FastifyPluginAsync<ModbusRoutesOptions> = async (app, opts) => {
  app.get<{ Params: { id: string } }>('/:id/modbus-status', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Is the application reaching this TCP/IP (Modbus) instrument?',
      description: 'State (reading / failing / not-read), why it is not read, the instrument\'s read interval, the last success and failure, readings stored in the last 24 h against the number expected, and whether Inactivity Alarms are off. `intervalSec` / `expected24h` are null when the stored interval is not one the Reader reads at (a hand-edited row; `notReadReason` INVALID_CONFIG). 400 for a Gateway (push) instrument; 404 outside the caller\'s instrument scope.',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const { id } = req.params;
    const visibility = await resolveVisibility(buildContext(req));
    const inst = await prisma.instrument.findFirst({
      where: withVisibility({ id }, visibility.where) as { id: string },
      select: { id: true, modbusIntervalSec: true, profile: { select: { connection: true } } },
    });
    if (!inst) return reply.code(404).send({ error: 'INSTRUMENT_NOT_FOUND', message: 'Instrument not found.' });
    // Its PROFILE says whether it is a TCP/IP instrument; the interval is the
    // instrument's own (CR-1, 2026-11-02).
    if (inst.profile.connection !== 'MODBUS_TCP') {
      return reply.code(400).send({ error: 'NOT_A_TCPIP_INSTRUMENT', message: 'This instrument is not a TCP/IP (Modbus) instrument.' });
    }
    // Only an interval the Reader reads at gives an expected count. A stored
    // value outside 10..3600 (hand-edited; no route writes one) is NOT read —
    // `notReadReason` says INVALID_CONFIG — so nothing is expected, never NaN.
    const intervalSec = isReadInterval(inst.modbusIntervalSec) ? inst.modbusIntervalSec : null;

    const since = new Date(Date.now() - 86_400_000);
    const [row, target, inactivity, storedCount] = await Promise.all([
      prisma.modbusPollStatus.findUnique({ where: { instrumentId: id } }),
      explainReadTarget(id, { allowLoopbackForTests: opts.allowLoopbackForTests === true }),
      loadInactivityConfig(),
      prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(DISTINCT ts)::bigint AS n FROM instrument_telemetry_history
        WHERE instrument_id = ${id} AND ts >= ${since}`,
    ]);

    // "Not read" OUTRANKS "failing" (final review F-2): the Reader clears
    // failingSince only on a stored read, and a skipped read writes nothing, so
    // a device the server has stopped asking (disabled, reading OFF, outside the
    // networks…) keeps a stale failingSince — "Not answering" would then claim
    // the device is silent when the server is not asking. failingSince is still
    // returned, as the record of when it last stopped answering.
    const failing = row?.failingSince != null;
    const state = target?.ok ? (failing ? 'failing' : 'reading') : 'not-read';
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
      stored24h: Number(storedCount[0]?.n ?? 0),
      expected24h: intervalSec === null ? null : Math.floor(86_400 / intervalSec),
      inactivityAlarmsOff: !inactivity.enabled,
    };
  });
};

export default modbusRoutes;
