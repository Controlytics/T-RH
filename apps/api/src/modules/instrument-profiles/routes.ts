import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { offsetKeyTest } from '../instruments/load-offsets.js';
import {
  createInstrumentProfileSchema,
  updateInstrumentProfileSchema,
  parseInstrumentAttributeKeys,
  validateAttributeRemark,
  coerceProfileMeasurements,
  measurementsEquivalent,
  profileMeasurementsSchema,
  DEFAULT_PROFILE_MEASUREMENTS,
  MEASUREMENT_CODES_PHASE1,
  coerceProfileDisplayKeys,
  displayKeysEqual,
  profileDisplayKeysSchema,
  type ProfileMeasurement,
} from '@digilog/shared';
import { invalidateProfileMeasurementsCache, loadMeasurementTypes } from '../instruments/profile-measurements.js';
import { DeviceCaNotConfiguredError, deviceCaAvailable } from '../instruments/device-ca.js';
import { invalidateIngestAuthCache } from '../instruments/ingest-auth.js';
import { invalidateChildMapCache } from '../instruments/gateway-children.js';
import { kickMqttClient } from '../instruments/broker-kick.js';
import { alarmsClearedBy } from '../alarms/stranded-decide.js';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { logger } from '../../lib/logger.js';
import { enforceReauth, enforceReauthAlways } from '../../lib/reauth-check.js';
import { resolveVisibility, withVisibility, type ScopeWhere } from '../instruments/visibility.js';
import { loadAttributeAccess, refuseAttributeWrite, needsReauth } from '../instruments/attribute-access.js';

/**
 * The database refusing a profile delete because instruments still reference
 * it. `instruments.profile_id` is ON DELETE RESTRICT, which Postgres reports as
 * 23001 and Prisma surfaces as an UNKNOWN request error with no `P2003` code —
 * so the constraint is matched by name (pinned against the real error in
 * instrument-profiles.e2e.test.ts).
 */
export function isProfileInUseError(err: unknown): boolean {
  if ((err as { code?: string })?.code === 'P2003') return true;
  return /instruments_profile_id_fkey/.test((err as { message?: string })?.message ?? '');
}

/** Thrown inside the cascade's transaction to roll it back: a carrier is out of the caller's scope. */
class OutOfScope extends Error {
  constructor() { super('OUT_OF_SCOPE'); this.name = 'OutOfScope'; }
}
import { publishAttributeDownlink } from '../instruments/attribute-downlink.js';
import { announceChildAttributeChange } from '../instruments/child-attributes-bundle.js';

/**
 * Instrument profiles — a named container for instruments.
 *
 * A profile carries ONE inherited setting: `attributeKeys`, the attribute keys
 * the New Instrument form asks for in this profile. Profiles inherit PROMPTS,
 * never VALUES — nothing is ever back-filled onto an instrument that already
 * exists, and moving an instrument between profiles changes only which keys are
 * suggested. See
 * `docs/superpowers/specs/2026-08-08-per-profile-instrument-attributes-design.md`.
 *
 * ONE exception since 2026-09-16 (operator: "when i removed attributes for
 * profile in configuration those are not removing for instruments"): a key
 * REMOVED from the list is also removed from every instrument in the profile
 * that carries it (case-folded, as every attribute surface matches). Each of
 * those deletions is its own §11 record — an INSTRUMENT_ATTRIBUTE_REMOVED row
 * per instrument with the value it held and the operator's remark — which is
 * why such a PUT REQUIRES a `reason` and is refused without one, naming what
 * would go. `GET /:id/attribute-usage` is how the page states that BEFORE the
 * save. A key nobody carries is dropped without ceremony. Adding a key still
 * back-fills nothing.
 *
 * PERMISSIONS reuse `INSTRUMENT_*` deliberately. A profile is not a capability
 * boundary of its own — anyone who may register an instrument may create the
 * folder it sits in — and dedicated constants would pull in the PERMISSION_TREE
 * frozen-snapshot test plus three documented counts for no access-control gain.
 */

/**
 * One profile measurement on the wire — EVERY inner key declared: Fastify strips
 * what a response schema does not name, and on a nested object it strips
 * silently (the outer key survives, an inner one vanishes).
 */
const keyList = { type: 'array', items: { type: 'string' } };
const boundProps = { type: 'object', properties: { enabled: { type: 'boolean' }, limitKeys: keyList, enableKeys: keyList } };
const measurementItem = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    deviceKeys: keyList,
    decimals: { type: 'object', properties: { attributeKeys: keyList, fallback: { type: 'integer' } } },
    high: boundProps,
    low: boundProps,
    range: { type: 'object', properties: { highKeys: keyList, lowKeys: keyList } },
    offsetKeys: keyList,
    mkt: { type: 'object', properties: { enabled: { type: 'boolean' }, attributeKeys: keyList } },
  },
};

const profileProps = {
  id: { type: 'string' },
  name: { type: 'string' },
  description: { type: 'string', nullable: true },
  isActive: { type: 'boolean' },
  attributeKeys: { type: 'string', nullable: true },
  measurements: { type: 'array', items: measurementItem },
  requireDeviceCertificate: { type: 'boolean' },
  // WIDGET DATA KEYS phase 3 (2026-10-29): the trend page's extra keys. Every
  // inner key DECLARED — Fastify strips what this block does not name.
  displayKeys: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        key: { type: 'string' },
        label: { type: 'string' },
        unit: { type: 'string' },
        decimals: { type: 'integer' },
        color: { type: 'integer' },
      },
    },
  },
  instrumentCount: { type: 'integer' },
  activeCount: { type: 'integer' },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
  createdBy: { type: 'string', nullable: true },
};

type ProfileRow = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  attributeKeys: string | null;
  measurements: unknown;
  requireDeviceCertificate: boolean;
  displayKeys?: unknown;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  instruments?: { isActive: boolean }[];
};

const fold = (k: string) => k.trim().toLowerCase();

/**
 * Which attribute keys the profile's instruments actually carry, folded by
 * case (the spelling shown is the PROFILE's own where the key is listed, else
 * the first recorded one), with the number of instruments carrying each.
 *
 * `visibility` narrows the count to the caller's instrument scope. The GET
 * passes it (audit 2026-10-03, API-20): the counts it returns are shown to
 * whoever opens the profile editor, and until then a restricted admin saw the
 * whole plant's numbers from a route whose every sibling is scoped. The PUT's
 * cascade deliberately does NOT pass it — it must see every instrument the
 * removal would touch, including ones the caller cannot, in order to refuse.
 */
async function attributeUsage(
  profileId: string,
  listed: string[],
  visibility?: ScopeWhere,
): Promise<{ key: string; instruments: number }[]> {
  const rows = await prisma.instrumentAttribute.findMany({
    where: { instrument: withVisibility({ profileId }, visibility) as never },
    select: { key: true, instrumentId: true },
    orderBy: [{ key: 'asc' }],
  });
  const byFold = new Map<string, { key: string; instruments: Set<string> }>();
  for (const r of rows) {
    const f = fold(r.key);
    const hit = byFold.get(f);
    if (hit) hit.instruments.add(r.instrumentId);
    else byFold.set(f, { key: listed.find((k) => fold(k) === f) ?? r.key, instruments: new Set([r.instrumentId]) });
  }
  return [...byFold.values()].map((u) => ({ key: u.key, instruments: u.instruments.size }));
}

/**
 * The broker side of a cascaded removal, AFTER the commit (the same rule as the
 * instruments module's `announceAttributeChange`): the instrument's retained
 * slot republished without the key, and its gateway's change event carrying
 * `null` for it. Never throws.
 */
async function announceRemoval(
  instrument: { id: string; code: string; gatewayId: string | null },
  key: string,
): Promise<void> {
  try {
    const rows = await prisma.instrumentAttribute.findMany({ where: { instrumentId: instrument.id }, select: { key: true, value: true } });
    const gateway = instrument.gatewayId
      ? await prisma.instrument.findUnique({ where: { id: instrument.gatewayId }, select: { code: true } })
      : null;
    const log = (msg: string, meta?: Record<string, unknown>) => logger.warn(`[downlink:profile-cascade] ${msg}`, meta ?? {});
    await publishAttributeDownlink({
      instrumentId: instrument.id, gatewayId: instrument.gatewayId,
      code: instrument.code, gatewayCode: gateway?.code ?? null,
      attributes: Object.fromEntries(rows.map((r) => [r.key, r.value])),
      changedKey: key, changedValue: null, ts: new Date(),
    }, log);
    if (instrument.gatewayId) {
      await announceChildAttributeChange(instrument.gatewayId, { code: instrument.code, key, value: null }, log);
    }
  } catch (e) {
    logger.warn('[downlink:profile-cascade] the device was NOT told about a removed attribute', {
      instrument: instrument.id, key, err: (e as Error).message,
    });
  }
}

/**
 * Shape a row for the wire. Both counts come from the SAME fetch — deriving
 * `activeCount` from a second query could disagree with `instrumentCount` if an
 * instrument were toggled between them, and a card showing "3 instruments, 4
 * active" is worse than a stale number.
 */
/**
 * Sensor-offset keys are SUPER_ADMIN-only (2026-10-01). To anyone else a
 * profile's key list simply does not contain them — the New Instrument form and
 * the bulk template then never ask for them.
 */
async function keysFor(req: FastifyRequest): Promise<(attributeKeys: string | null) => string | null> {
  if (req.user?.role === 'SUPER_ADMIN') return (k) => k;
  const isOffset = await offsetKeyTest();
  return (k) => (k === null ? null : parseInstrumentAttributeKeys(k).filter((key) => !isOffset(key)).join('\n'));
}

function present(row: ProfileRow) {
  const instruments = row.instruments ?? [];
  const { instruments: _omit, ...rest } = row;
  return {
    ...rest,
    // NULL ("never customised") and anything unreadable read as the defaults —
    // the ONE reader, the same one every server consumer uses.
    measurements: coerceProfileMeasurements(row.measurements),
    // NULL or unreadable = no extra keys: the ONE reader, never a raw column.
    displayKeys: coerceProfileDisplayKeys(row.displayKeys),
    instrumentCount: instruments.length,
    activeCount: instruments.filter((i) => i.isActive).length,
  };
}

/**
 * What THIS caller may see of a presented profile: a non-super-admin sees no
 * sensor-offset key anywhere — not in the attribute keys and not in a
 * measurement's `offsetKeys` (2026-10-01 rule; the PUT response leaked the
 * attribute keys until 2026-10-26, which routes them all through here).
 */
async function forCaller(req: FastifyRequest): Promise<<P extends { attributeKeys: string | null; measurements: ProfileMeasurement[] }>(p: P) => P> {
  if (req.user?.role === 'SUPER_ADMIN') return (p) => p;
  const strip = await keysFor(req);
  return (p) => ({
    ...p,
    attributeKeys: strip(p.attributeKeys),
    measurements: p.measurements.map((m) => ({ ...m, offsetKeys: [] })),
  });
}

const noOffsets = (ms: ProfileMeasurement[]) => ms.map((m) => ({ ...m, offsetKeys: [] }));

/**
 * The phase-1 rules a SUPER_ADMIN's measurement list must also pass, beyond
 * the shared schema: only the two measurements the screens can show yet, and
 * MKT only on a °C measurement (the formula is Kelvin from °C). Null = fine.
 */
async function measurementRefusal(ms: ProfileMeasurement[]): Promise<{ error: string; message: string } | null> {
  const unsupported = ms.find((m) => !(MEASUREMENT_CODES_PHASE1 as readonly string[]).includes(m.code));
  if (unsupported) {
    return { error: 'MEASUREMENT_NOT_SUPPORTED', message: `${unsupported.code} cannot be added yet — this version shows temperature and humidity only.` };
  }
  const units = new Map((await loadMeasurementTypes()).map((t) => [t.code, t.unit]));
  const mkt = ms.find((m) => m.mkt.enabled && units.get(m.code) !== '°C');
  if (mkt) {
    return { error: 'MKT_NOT_TEMPERATURE', message: `MKT is calculated from a temperature in °C; ${mkt.code} is measured in ${units.get(mkt.code) ?? 'another unit'}.` };
  }
  return null;
}

/**
 * The instruments a profile's counts are drawn from, NARROWED to what the caller
 * may see.
 *
 * `visibility` is the caller's resolved instrument scope, or undefined when they
 * are unrestricted. Passing it into the nested relation — rather than counting
 * everything — is the whole point: a profile card reading "101 instruments" to
 * someone scoped to four misdescribes what they have AND discloses how many exist
 * outside their scope. Same defect shape as an unscoped list, just expressed as a
 * number instead of rows.
 *
 * `where: undefined` is Prisma's no-filter, so the unrestricted caller's counts
 * are byte-for-byte what they were before.
 */
const withInstruments = (visibility?: object) => ({
  instruments: { where: visibility, select: { isActive: true } },
});

/** Prisma's unique-constraint violation — here, only `name` is unique. */
function isDuplicateName(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

export default async function instrumentProfileRoutes(app: FastifyInstance) {
  // GET /api/instrument-profiles
  app.get('/', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'List instrument profiles',
      description: 'Every profile with its instrument count and how many of those are active.',
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object', properties: profileProps } },
            total: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const rows = await prisma.instrumentProfile.findMany({
      include: withInstruments(visibility),
      orderBy: { name: 'asc' },
    });
    // Every profile is still LISTED, including ones holding nothing the caller can
    // see. A profile is a device type, not an instrument: hiding the type would
    // make the New Instrument form's dropdown depend on who is looking.
    const show = await forCaller(req);
    return { data: rows.map((r) => show(present(r as ProfileRow))), total: rows.length };
  });

  // GET /api/instrument-profiles/measurement-types — the measurement TYPES a
  // profile chooses from (2026-10-26): code, name, unit, order. Every reader —
  // a measurement's name and unit are display facts, not configuration.
  // Registered before '/:id' so the static path wins.
  app.get('/measurement-types', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'The measurement types a profile can carry',
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: { code: { type: 'string' }, name: { type: 'string' }, unit: { type: 'string' }, sortOrder: { type: 'integer' } },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async () => ({ data: await loadMeasurementTypes() }));

  // GET /api/instrument-profiles/:id
  app.get('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'Get an instrument profile',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: { 200: { type: 'object', properties: profileProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const row = await prisma.instrumentProfile.findUnique({
      where: { id }, include: withInstruments(visibility),
    });
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Profile not found.' });
    return (await forCaller(req))(present(row as ProfileRow));
  });

  // GET /api/instrument-profiles/:id/attribute-usage — which keys the
  // profile's instruments carry, so the editor can say what a removal deletes.
  app.get('/:id/attribute-usage', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'Which attribute keys the profile\'s instruments carry, with counts',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            keys: {
              type: 'array',
              items: { type: 'object', properties: { key: { type: 'string' }, instruments: { type: 'integer' } } },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const profile = await prisma.instrumentProfile.findUnique({ where: { id }, select: { attributeKeys: true } });
    if (!profile) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Profile not found.' });
    // Scoped like every other read on this module (audit 2026-10-03, API-20).
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const usage = await attributeUsage(id, parseInstrumentAttributeKeys(profile.attributeKeys), visibility);
    if (req.user?.role === 'SUPER_ADMIN') return { keys: usage };
    const isOffset = await offsetKeyTest();
    return { keys: usage.filter((u) => !isOffset(u.key)) };
  });

  // POST /api/instrument-profiles
  app.post('/', {
    preHandler: [app.requirePermission('INSTRUMENT_CREATE')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'Create an instrument profile',
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          isActive: { type: 'boolean' },
          attributeKeys: { type: 'string' },
          measurements: { type: 'array', items: { type: 'object' } },
        },
      },
      response: { 201: { type: 'object', properties: profileProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const parsed = createInstrumentProfileSchema.safeParse(
      // `attributeKeys` is EXEMPT from HTML stripping so that the two write
      // paths for this same data agree. The dynamic-config PUT does not strip
      // (config.service.ts:87-93), and stripHtml DISCARDS tag-shaped content
      // rather than escaping it — so without this exemption a key like
      // "Temp <5C" would survive on the Configuration page and be silently
      // truncated to "Temp" here. Not a new exposure: the SPA escapes on
      // output, and this is the same value the config endpoint already stores
      // unstripped.
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['attributeKeys']),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const ctx = buildContext(req);

    // A new profile starts EMPTY — it asks for no attributes until an admin
    // adds them on Configuration → Instrument Attributes (2026-08-08 operator
    // decision, reversing the seed-from-the-global-template rule that shipped
    // earlier the same day). Seeding made every new profile open as an
    // identical copy of the last one, which reads as "the list is global" —
    // the exact confusion per-profile keys exist to remove. The cost is that
    // Block / Area / Location are not asked for until they are added; the
    // config page warns about that per profile.
    let attributeKeys = parsed.data.attributeKeys ?? '';
    // Only a super admin may list a sensor-offset key on a profile (2026-10-01).
    if (req.user?.role !== 'SUPER_ADMIN') {
      const isOffset = await offsetKeyTest();
      attributeKeys = parseInstrumentAttributeKeys(attributeKeys).filter((k) => !isOffset(k)).join('\n');
    }

    // What the profile measures (2026-10-26). A new profile starts with
    // TEMPERATURE + HUMIDITY at the shipped defaults, written explicitly — a
    // profile created by someone who may not edit measurements must never yield
    // instruments that silently monitor nothing. Anything else is alarm
    // behaviour, so a SUPER_ADMIN's act under the profile re-auth.
    const measurements = parsed.data.measurements ?? structuredClone(DEFAULT_PROFILE_MEASUREMENTS);
    if (!measurementsEquivalent(measurements, DEFAULT_PROFILE_MEASUREMENTS)) {
      if (req.user?.role !== 'SUPER_ADMIN') {
        return reply.code(403).send({ error: 'SUPER_ADMIN_ONLY', message: 'Only a super admin may set what a profile measures.' });
      }
      const { ok } = await enforceReauth('UPDATE_INSTRUMENT_PROFILE', req, reply);
      if (!ok) return;
      const refusal = await measurementRefusal(measurements);
      if (refusal) return reply.code(400).send(refusal);
    }

    try {
      // A profile that has just been created holds nothing, so there is no scope
      // question here — the empty argument keeps one shape for the helper.
      // One transaction with its audit row (audit 2026-10-12): written after
      // the commit, a failed audit write left a profile with no record.
      const row = await prisma.$transaction(async (tx) => {
        const created = await tx.instrumentProfile.create({
          data: { ...parsed.data, attributeKeys, measurements, createdBy: ctx.userId },
          include: withInstruments(),
        });
        await auditLog({
          userId: ctx.userId, userRole: ctx.userRole,
          action: 'INSTRUMENT_PROFILE_CREATED',
          targetType: 'instrument_profile', targetId: created.id,
          afterValue: {
            name: created.name, description: created.description, isActive: created.isActive,
            attributeKeys: parseInstrumentAttributeKeys(created.attributeKeys),
            measurements,
          },
          signatureMeaning: `Instrument profile "${created.name}" created`,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx as unknown as Prisma.TransactionClient);
        return created;
      });
      invalidateProfileMeasurementsCache();

      return reply.code(201).send((await forCaller(req))(present(row as ProfileRow)));
    } catch (err) {
      // Caught rather than pre-checked: a SELECT-then-INSERT has a race that the
      // unique index closes anyway, so the index is the authority and this
      // merely translates it into an answer the operator can act on.
      if (isDuplicateName(err)) {
        return reply.code(409).send({
          error: 'DUPLICATE_NAME',
          message: `A profile named "${parsed.data.name}" already exists.`,
        });
      }
      throw err;
    }
  });

  // PUT /api/instrument-profiles/:id
  app.put('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'Update an instrument profile',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
          isActive: { type: 'boolean' },
          attributeKeys: { type: ['string', 'null'] },
          measurements: { type: 'array', items: { type: 'object' }, description: 'What the profile measures. A change is super-admin only and requires `reason`; an equivalent list is a no-op.' },
          requireDeviceCertificate: { type: 'boolean', description: 'Every instrument of the profile must connect with its own device certificate. A change is super-admin only and requires `reason`; ON is 409 DEVICE_CA_NOT_CONFIGURED while the server has no device CA.' },
          reason: { type: 'string', description: 'Required when a removed key is carried by instruments (recorded on each INSTRUMENT_ATTRIBUTE_REMOVED row), when the measurements change, and when requireDeviceCertificate changes.' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ...profileProps,
            // Set only when this save switched the requirement ON: how many of
            // the profile's instruments have no certificate yet, i.e. whose
            // data is refused from now on.
            instrumentsWithoutCertificate: { type: 'integer', nullable: true },
            // ...and the gateways reporting for one of its ACTIVE instruments:
            // each must now present its OWN certificate, and is refused on
            // MQTT without one (final review, 2026-10-27 — the blast radius a
            // count of the profile's own instruments cannot show).
            gatewaysNeedingCertificate: {
              type: 'array', nullable: true,
              items: { type: 'object', properties: { code: { type: 'string' }, certificateIssued: { type: 'boolean' } } },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    // Configurable e-signature (audit 2026-10-03, SEC-7): this PUT can delete an
    // attribute on every instrument of the profile, which is the same act the
    // per-instrument attribute delete signs. FIRST, so `_currentPassword` is
    // stripped before the body is parsed.
    //
    // The password is read BEFORE that strip, because the cascade below may
    // need it again for the attribute re-auth (audit 2026-10-12): taken from
    // the body after `enforceReauth`, it would already be gone and a caller
    // who DID send it would be refused.
    const sentPassword = ((req.body as Record<string, unknown> | undefined)?._currentPassword as string | undefined)
      ?? (req.headers['x-reauth-password'] as string | undefined);
    const { ok } = await enforceReauth('UPDATE_INSTRUMENT_PROFILE', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const parsed = updateInstrumentProfileSchema.safeParse(
      // Exempt for the same reason as POST — see the comment there. `reason`
      // is exempt like every free-text remark: `stripHtml` would blank
      // "value < 20 per SOP" into a §11 record.
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['attributeKeys', 'reason']),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const { reason, ...data } = parsed.data;

    const before = await prisma.instrumentProfile.findUnique({ where: { id } });
    if (!before) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Profile not found.' });
    // SENSOR OFFSETS (2026-10-01): a non-SUPER_ADMIN never SEES the offset keys
    // (they are stripped from every read), so the list they send never mentions
    // them. Taken literally that would REMOVE them — and removing a key from a
    // profile deletes it from every instrument of the profile. So for them the
    // stored offset keys are carried over unchanged, and any offset key they
    // send is dropped.
    if (req.user?.role !== 'SUPER_ADMIN' && typeof data.attributeKeys === 'string') {
      const isOffset = await offsetKeyTest();
      const kept = parseInstrumentAttributeKeys(before.attributeKeys).filter((k) => isOffset(k));
      data.attributeKeys = [...parseInstrumentAttributeKeys(data.attributeKeys).filter((k) => !isOffset(k)), ...kept].join('\n');
    }

    // MEASUREMENTS (2026-10-26) — alarm behaviour, so SUPER_ADMIN-only, enforced
    // HERE and not only on the page. A list EQUIVALENT to the stored one is a
    // no-op for anyone: the profile page sends it back when it saves the
    // attribute keys. A non-super-admin reads every `offsetKeys` empty, so their
    // copy is compared with offsets blanked on both sides — and never written.
    const storedMeasurements = coerceProfileMeasurements(before.measurements);
    let measurementsChanged = false;
    if (data.measurements) {
      const isSuperAdmin = req.user?.role === 'SUPER_ADMIN';
      const same = isSuperAdmin
        ? measurementsEquivalent(data.measurements, storedMeasurements)
        : measurementsEquivalent(noOffsets(data.measurements), noOffsets(storedMeasurements));
      if (same) {
        delete data.measurements;
      } else {
        if (!isSuperAdmin) {
          return reply.code(403).send({ error: 'SUPER_ADMIN_ONLY', message: 'Only a super admin may change what a profile measures.' });
        }
        const refusal = await measurementRefusal(data.measurements);
        if (refusal) return reply.code(400).send(refusal);
        // A switched-off bound or a removed measurement CLEARS open alarms on
        // every instrument of the profile (the evaluator's next pass) — a bulk
        // act on regulated records, so it is signed with a reason, like the
        // attribute cascade below.
        const problem = validateAttributeRemark(reason);
        if (problem) {
          return reply.code(400).send({
            error: 'REASON_REQUIRED',
            message: `Changing what this profile measures changes how every instrument in it is monitored. ${problem}`,
          });
        }
        measurementsChanged = true;
      }
    }
    // DEVICE CERTIFICATES (2026-10-27): whether every instrument of this
    // profile must connect with its own client certificate decides which
    // devices the platform accepts data from — super admin only, signed with a
    // reason, and ON is refused while the server has no device CA (the switch
    // would refuse every device with no way to issue them a certificate).
    // Sending the stored value back (a page saving other fields) is a no-op.
    let certificateChanged = false;
    if (data.requireDeviceCertificate !== undefined) {
      if (data.requireDeviceCertificate === before.requireDeviceCertificate) {
        delete data.requireDeviceCertificate;
      } else {
        if (req.user?.role !== 'SUPER_ADMIN') {
          return reply.code(403).send({ error: 'SUPER_ADMIN_ONLY', message: 'Only a super admin may change whether a profile requires device certificates.' });
        }
        if (data.requireDeviceCertificate && !deviceCaAvailable()) {
          return reply.code(409).send({ error: 'DEVICE_CA_NOT_CONFIGURED', message: new DeviceCaNotConfiguredError().message });
        }
        const problem = validateAttributeRemark(reason);
        if (problem) {
          return reply.code(400).send({
            error: 'REASON_REQUIRED',
            message: `Changing whether this profile requires device certificates changes which devices it accepts data from. ${problem}`,
          });
        }
        certificateChanged = true;
      }
    }
    const ctx = buildContext(req);

    // Which listed keys this PUT DROPS, and which of those instruments carry.
    // `null` re-arms the default template and drops nothing.
    const keysBefore = parseInstrumentAttributeKeys(before.attributeKeys);
    const requested = typeof data.attributeKeys === 'string' ? parseInstrumentAttributeKeys(data.attributeKeys) : null;
    const removed = requested ? keysBefore.filter((k) => !requested.some((a) => fold(a) === fold(k))) : [];
    const affected = removed.length
      ? (await attributeUsage(id, keysBefore)).filter((u) => removed.some((k) => fold(k) === fold(u.key)))
      : [];
    if (affected.length > 0) {
      const problem = validateAttributeRemark(reason);
      if (problem) {
        return reply.code(400).send({
          error: 'REASON_REQUIRED',
          message: `Removing ${affected.map((a) => `"${a.key}"`).join(', ')} deletes the attribute on ${affected.reduce((n, a) => n + a.instruments, 0)} instrument(s). ${problem}`,
          affected,
        });
      }
    }

    try {
      // Scoped like the read routes: this response replaces the row on screen, and
      // an edit must not make the count jump to a number the list never shows.
      const { where: visibility } = await resolveVisibility(ctx);
      if (affected.length > 0) {
        // The cascade is an attribute DELETE on every instrument of the profile,
        // so it answers to the same two rules the direct delete answers to
        // (audit 2026-10-03, API-10): the role's Attribute Access rule per key
        // — a SELECTED-keys role that may not delete a limit on one instrument
        // must not remove it from all 101 via the profile — and the caller's
        // instrument scope: a key carried by an instrument the caller cannot
        // see is refused outright rather than half-removed.
        const access = await loadAttributeAccess(ctx.userRole, ctx.userSub);
        for (const a of affected) {
          const refusal = refuseAttributeWrite({ access, hasUpdatePermission: true, key: a.key, isNewKey: false, remark: reason as string | undefined });
          if (refusal) return reply.code(refusal.status).send(refusal.body);
        }
        // ...and the same PASSWORD the direct delete forces when the role's
        // Attribute Access asks for one (audit 2026-10-12): the cascade checked
        // the access rule but never the re-auth, so a role that must sign every
        // attribute delete could delete one key from a whole profile unsigned.
        // AFTER the access check, as on the direct delete. Skipped only when
        // this request already verified the password (the profile's own
        // re-auth above) — one password, one request.
        if (needsReauth(access) && !(req as unknown as { _reauthVerified?: boolean })._reauthVerified) {
          const body = (req.body ?? {}) as Record<string, unknown>;
          if (sentPassword) body._currentPassword = sentPassword;
          const { ok: signed } = await enforceReauthAlways('UPDATE_INSTRUMENT_ATTRIBUTE', req, reply);
          if (!signed) return;
        }
      }
      const deleted: { instrument: { id: string; code: string; gatewayId: string | null }; key: string }[] = [];
      const row = await prisma.$transaction(async (tx) => {
        const updated = await tx.instrumentProfile.update({
          where: { id },
          data: {
            ...data,
            ...(data.measurements ? { measurements: data.measurements as unknown as Prisma.InputJsonValue } : {}),
            updatedBy: ctx.userId,
          },
          include: withInstruments(visibility),
        });
        if (affected.length > 0) {
          const folds = new Set(affected.map((a) => fold(a.key)));
          const rows = (await tx.instrumentAttribute.findMany({
            where: { instrument: { profileId: id } },
            select: { instrumentId: true, key: true, value: true, instrument: { select: { code: true, gatewayId: true } } },
          })).filter((r) => folds.has(fold(r.key)));
          // The caller's instrument SCOPE, checked on exactly the rows this
          // transaction is about to delete (audit 2026-10-12): checked before
          // the transaction, an instrument joining the profile in between was
          // deleted unchecked. A key carried by an instrument the caller cannot
          // see refuses the whole cascade rather than half-removing it.
          const carryingIds = [...new Set(rows.map((r) => r.instrumentId))];
          if (carryingIds.length > 0) {
            const visibleCount = await tx.instrument.count({ where: withVisibility({ id: { in: carryingIds } }, visibility) as never });
            if (visibleCount < carryingIds.length) {
              throw new OutOfScope();
            }
          }
          for (const r of rows) {
            // The same per-attribute advisory lock the instruments module takes.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(20260807, hashtext(${`${r.instrumentId}:${r.key}`}))`;
            await tx.instrumentAttribute.delete({ where: { instrumentId_key: { instrumentId: r.instrumentId, key: r.key } } });
            // The removed VALUE is in `beforeValue`: once the row is gone this
            // audit record is the only place it survives.
            await auditLog({
              action: 'INSTRUMENT_ATTRIBUTE_REMOVED', targetType: 'Instrument', targetId: r.instrumentId,
              beforeValue: { code: r.instrument.code, attribute: r.key, value: r.value },
              reason: reason as string,
              signatureMeaning: `Attribute "${r.key}" removed from instrument "${r.instrument.code.length <= 80 ? r.instrument.code : `${r.instrument.code.slice(0, 80)}…`}" (key dropped from profile)`,
              userId: ctx.userId, userRole: ctx.userRole,
              ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
            }, tx as unknown as Prisma.TransactionClient);
            deleted.push({ instrument: { id: r.instrumentId, code: r.instrument.code, gatewayId: r.instrument.gatewayId }, key: r.key });
          }
        }

        const row = updated;
        const keysAfter = parseInstrumentAttributeKeys(row.attributeKeys);
        // Compared as PARSED lists, so a whitespace-only edit that changes no key
        // does not claim the keys changed.
        const keysChanged = keysBefore.join('\n') !== keysAfter.join('\n');
        const cascadeNote = deleted.length > 0
          ? `; removed ${affected.map((a) => `"${a.key}"`).join(', ')} from ${new Set(deleted.map((d) => d.instrument.id)).size} instrument(s)`
          : '';

        // In the SAME transaction as the update (audit 2026-10-12): written
        // after the commit, a failed audit write left the change unrecorded.
        await auditLog({
          userId: ctx.userId, userRole: ctx.userRole,
          action: 'INSTRUMENT_PROFILE_UPDATED',
          targetType: 'instrument_profile', targetId: id,
          beforeValue: {
            name: before.name, description: before.description, isActive: before.isActive,
            attributeKeys: keysBefore,
            measurements: storedMeasurements,
            requireDeviceCertificate: before.requireDeviceCertificate,
          },
          afterValue: {
            name: row.name, description: row.description, isActive: row.isActive,
            attributeKeys: keysAfter,
            measurements: coerceProfileMeasurements(row.measurements),
            requireDeviceCertificate: row.requireDeviceCertificate,
          },
          // A rename is called out first: it changes what an inspector reads
          // against every instrument in the profile, so "updated" alone would
          // understate it. A key change is named next, with the counts, because it
          // changes what every future registration is asked. Both fit
          // audit_trail.signature_meaning's varchar(255): ~50 fixed characters
          // plus a name capped at 120.
          // The cascade note is clamped so a long key list cannot overflow
          // signature_meaning's varchar(255) — `auditLog` does not truncate.
          signatureMeaning: (() => {
            const certificateNote = certificateChanged
              ? (row.requireDeviceCertificate ? 'device certificate now required' : 'device certificate no longer required')
              : '';
            if (certificateChanged && before.name === row.name && !keysChanged && !measurementsChanged && deleted.length === 0) {
              return `Instrument profile "${row.name}": ${certificateNote}`.slice(0, 250);
            }
            const named = before.name !== row.name
              ? `Instrument profile renamed "${before.name}" → "${row.name}"`
              : keysChanged && measurementsChanged
                ? `Instrument profile "${row.name}" attribute keys and measurements changed`
                : keysChanged
                  ? `Instrument profile "${row.name}" attribute keys changed (${keysBefore.length} → ${keysAfter.length})`
                  : measurementsChanged
                    ? `Instrument profile "${row.name}" measurements changed`
                    : `Instrument profile "${row.name}" updated`;
            const base = certificateChanged ? `${named}; ${certificateNote}` : named;
            const full = base + cascadeNote;
            if (full.length <= 250) return full;
            const short = base + `; removed ${affected.length} key(s) from ${new Set(deleted.map((d) => d.instrument.id)).size} instrument(s)`;
            return short.length <= 250 ? short : short.slice(0, 249) + '…';
          })(),
          ...((deleted.length > 0 || measurementsChanged || certificateChanged) && reason ? { reason } : {}),
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx as unknown as Prisma.TransactionClient);
        return updated;
      });

      // Committed. Now, and only now, tell each device — but AFTER this
      // response, not before it: a cascade can be hundreds of removals, and
      // the operator's save must not wait on the broker (2026-09-16: 400
      // removals against a down broker held the response ~27 minutes even
      // before the bridge learned to resolve on queue). The database is the
      // record; the announcements are best-effort and each one logs its own
      // failure.
      if (deleted.length > 0) {
        void (async () => {
          for (const d of deleted) await announceRemoval(d.instrument, d.key);
          logger.info('[downlink:profile-cascade] devices told', { profileId: id, removals: deleted.length });
        })();
      }
      // The resolver's 10 s cache must not outlive the save: the dashboard polls
      // every few seconds and must read the new keys on its very next poll.
      invalidateProfileMeasurementsCache();

      let instrumentsWithoutCertificate: number | null = null;
      let gatewaysNeedingCertificate: { code: string; certificateIssued: boolean }[] | null = null;
      if (certificateChanged) {
        // Every cached ingest identity and gateway child map of this profile now
        // carries the wrong flag — drop them, so the next reading is judged by
        // the new rule rather than after the 10 s TTL.
        invalidateIngestAuthCache();
        invalidateChildMapCache();
        const members = await prisma.instrument.findMany({
          where: { profileId: id }, select: { code: true, gatewayId: true, deviceCertIssueId: true, isActive: true },
        });
        if (row.requireDeviceCertificate) {
          instrumentsWithoutCertificate = members.filter((m) => !m.deviceCertIssueId).length;
          const reportingGateways = [...new Set(members.filter((m) => m.isActive && m.gatewayId).map((m) => m.gatewayId as string))];
          gatewaysNeedingCertificate = reportingGateways.length === 0 ? [] : (await prisma.instrument.findMany({
            where: { id: { in: reportingGateways }, isActive: true },
            select: { code: true, deviceCertIssueId: true }, orderBy: { code: 'asc' },
          })).map((g) => ({ code: g.code, certificateIssued: g.deviceCertIssueId !== null }));
        }
        // MQTT is judged only at CONNECT: drop the open sessions of the
        // profile's instruments and of their gateways so they reconnect under
        // the new rule. After the response and best effort, like the cascade
        // announcements above — `kickMqttClient` logs its own failures and is a
        // no-op where the EMQX API key is not provisioned.
        const gatewayIds = [...new Set(members.map((m) => m.gatewayId).filter((g): g is string => g !== null))];
        void (async () => {
          const gateways = gatewayIds.length > 0
            ? await prisma.instrument.findMany({ where: { id: { in: gatewayIds } }, select: { code: true } })
            : [];
          for (const code of [...members.map((m) => m.code), ...gateways.map((g) => g.code)]) {
            await kickMqttClient(code, 'profile device-certificate requirement changed');
          }
        })().catch((e: unknown) => logger.error('[instrument-profiles] device-certificate kick pass failed', e));
      }

      return { ...(await forCaller(req))(present(row as ProfileRow)), instrumentsWithoutCertificate, gatewaysNeedingCertificate };
    } catch (err) {
      if (err instanceof OutOfScope) {
        return reply.code(403).send({
          error: 'OUT_OF_SCOPE',
          message: 'Removing this key would delete attributes on instruments outside your instrument scope.',
        });
      }
      if (isDuplicateName(err)) {
        return reply.code(409).send({
          error: 'DUPLICATE_NAME',
          message: `A profile named "${parsed.data.name}" already exists.`,
        });
      }
      throw err;
    }
  });

  // PUT /api/instrument-profiles/:id/display-keys — the extra keys the trend page
  // shows for every instrument of the profile (widget data keys phase 3,
  // 2026-10-29). SUPER_ADMIN, like what the profile measures; behind
  // INSTRUMENT_UPDATE and the profile re-auth action; audited with before and
  // after in the same transaction. Display configuration, not a measurement or a
  // limit, so `reason` is optional (ruling P3-4). An unchanged list writes
  // nothing and audits nothing.
  app.put('/:id/display-keys', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: "Set the trend page's extra keys for a profile",
      description: 'SUPER_ADMIN only. Up to 12 TELEMETRY keys with display settings (label, unit, decimals, colour). Unchanged = no write, no audit.',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['displayKeys'],
        properties: {
          displayKeys: { type: 'array', items: { type: 'object', additionalProperties: true } },
          reason: { type: 'string' },
        },
      },
      response: { 200: { type: 'object', properties: profileProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    if (req.user?.role !== 'SUPER_ADMIN') {
      return reply.code(403).send({ error: 'SUPER_ADMIN_ONLY', message: "Only a super admin may set the trend page's extra keys." });
    }
    const { ok } = await enforceReauth('UPDATE_INSTRUMENT_PROFILE', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const body = req.body as { displayKeys: unknown; reason?: string };
    const parsed = profileDisplayKeysSchema.safeParse(body.displayKeys);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Not a list of keys.' });
    }
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
    const ctx = buildContext(req);

    const result = await prisma.$transaction(async (tx) => {
      const before = await tx.instrumentProfile.findUnique({ where: { id }, select: { name: true, displayKeys: true } });
      if (!before) return null;
      const stored = coerceProfileDisplayKeys(before.displayKeys);
      if (displayKeysEqual(stored, parsed.data)) return 'unchanged' as const;
      await tx.instrumentProfile.update({
        where: { id },
        data: { displayKeys: parsed.data as unknown as Prisma.InputJsonValue, updatedBy: ctx.userId },
      });
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'INSTRUMENT_PROFILE_UPDATED',
        targetType: 'instrument_profile', targetId: id,
        // `name` on both: the INSTRUMENT_PROFILE_UPDATED template renders
        // {targetName} from it (review 2026-10-29) — the sibling PUT /:id
        // always writes it too.
        beforeValue: { name: before.name, displayKeys: stored },
        afterValue: { name: before.name, displayKeys: parsed.data },
        reason,
        signatureMeaning: `Profile "${before.name.slice(0, 60)}" trend-page keys set: ${parsed.data.length} key(s)`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return 'changed' as const;
    });
    if (result === null) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Profile not found.' });

    const { where: visibility } = await resolveVisibility(ctx);
    const row = await prisma.instrumentProfile.findUnique({ where: { id }, include: withInstruments(visibility) });
    return present(row as ProfileRow);
  });

  // POST /api/instrument-profiles/:id/measurement-impact — which OPEN alarms a
  // proposed measurement list would clear (2026-10-26): the profile editor
  // states it before the save, because switching a bound off or removing a
  // measurement closes alarms on every instrument of the profile. Read-only, no
  // audit; super admin only, like the change it previews. POST because the
  // proposal is a body, not a query.
  app.post('/:id/measurement-impact', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'Which open alarms a proposed measurement list would clear',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['measurements'], properties: { measurements: { type: 'array', items: { type: 'object' } } } },
      response: {
        200: {
          type: 'object',
          properties: {
            clears: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  metric: { type: 'string' }, source: { type: 'string' },
                  limitKind: { type: 'string', nullable: true }, count: { type: 'integer' },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    if (req.user?.role !== 'SUPER_ADMIN') {
      return reply.code(403).send({ error: 'SUPER_ADMIN_ONLY', message: 'Only a super admin may change what a profile measures.' });
    }
    const { id } = req.params as { id: string };
    const parsed = profileMeasurementsSchema.safeParse((req.body as { measurements?: unknown })?.measurements);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    const exists = await prisma.instrumentProfile.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Profile not found.' });
    // EVERY open alarm of the profile's instruments, scope ignored on purpose:
    // the save would clear them all, seen or not, and the warning must not
    // understate a bulk act.
    const open = await prisma.alarm.findMany({
      where: {
        state: 'ACTIVE',
        source: { in: ['INSTRUMENT_LIMIT', 'RS485_FAILURE', 'SENSOR_RANGE'] },
        instrument: { profileId: id },
      },
      select: { metric: true, source: true, limitKind: true },
    });
    return { clears: alarmsClearedBy(parsed.data, open) };
  });

  // DELETE /api/instrument-profiles/:id
  app.delete('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_DELETE')],
    schema: {
      tags: ['Instrument Profiles'],
      summary: 'Delete an instrument profile',
      description: 'Refused while the profile still contains instruments.',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    // Configurable e-signature (audit 2026-10-03, SEC-7), the functional-location
    // precedent.
    const { ok } = await enforceReauth('DELETE_INSTRUMENT_PROFILE', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    // DELIBERATELY UNSCOPED, unlike the read routes above. The guard exists to
    // explain the foreign key's refusal, and the FK counts every instrument
    // regardless of who is asking. A scoped count here would tell a restricted
    // admin the profile is empty and then hand them a raw FK error when they act
    // on it.
    const row = await prisma.instrumentProfile.findUnique({
      where: { id },
      include: { _count: { select: { instruments: true } } },
    });
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Profile not found.' });

    // Checked here so the operator gets a COUNT and a next step. The foreign key
    // (ON DELETE RESTRICT) refuses it regardless — this check exists for the
    // message, not for the safety.
    if (row._count.instruments > 0) {
      const n = row._count.instruments;
      return reply.code(409).send({
        error: 'PROFILE_NOT_EMPTY',
        message: `"${row.name}" still contains ${n} instrument${n === 1 ? '' : 's'}. `
          + 'Move or delete them before deleting the profile.',
      });
    }

    const ctx = buildContext(req);
    // One transaction with its audit row (audit 2026-10-12): deleted first and
    // audited after, a failed audit write left a profile gone with no record.
    try {
      await prisma.$transaction(async (tx) => {
        await tx.instrumentProfile.delete({ where: { id } });
        await auditLog({
          userId: ctx.userId, userRole: ctx.userRole,
          action: 'INSTRUMENT_PROFILE_DELETED',
          targetType: 'instrument_profile', targetId: id,
          beforeValue: { name: row.name, description: row.description, isActive: row.isActive },
          signatureMeaning: `Instrument profile "${row.name}" deleted`,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx as unknown as Prisma.TransactionClient);
      });
    } catch (err) {
      // An instrument created in the profile after the count above: the
      // foreign key (ON DELETE RESTRICT) refuses the delete. The same answer
      // as the pre-check, never a raw 500.
      if (isProfileInUseError(err)) {
        return reply.code(409).send({
          error: 'PROFILE_NOT_EMPTY',
          message: `"${row.name}" still contains instruments. Move or delete them before deleting the profile.`,
        });
      }
      throw err;
    }
    // Its offset keys leave `allOffsetKeys()` now, not in 10 s.
    invalidateProfileMeasurementsCache();

    return { success: true };
  });
}
