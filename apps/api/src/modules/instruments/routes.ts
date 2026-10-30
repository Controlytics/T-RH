import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { offsetKeyTest, withoutOffsets } from './load-offsets.js';
import { parseOffsetValue, formatOffsetValue, SENSOR_OFFSET_VALUE_MESSAGE, validateAttributeRemark } from '@digilog/shared';
import { Prisma } from '@prisma/client';
import {
  createInstrumentSchema,
  updateInstrumentSchema,
  instrumentQuerySchema,
  bulkCreateInstrumentsSchema,
  setInstrumentTokenSchema,
  setInstrumentAttributeSchema,
  updateInstrumentAttributeSchema,
  coerceReading,
} from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { resolvePageSize } from '../../lib/page-size.js';
import { resolveVisibility, withVisibility, type ScopeWhere } from './visibility.js';
import { resolveLocationIds, type FlNode } from '../functional-locations/tree.js';
import { getTelemetryAggregate } from './telemetry-aggregate.js';
import { HISTORY_WINDOWS, type HistoryWindow } from '../floorplans/room-history.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauth, enforceReauthAlways } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { generateToken, hashToken, tokenPrefix, tokenMatches } from './token.js';
import { encryptToken, decryptToken, tokenKeyConfigured } from './token-crypto.js';
import { parseInstrumentCsv, type AttributeColumn, type RowError } from './bulk-csv.js';
import { planBulkUpload, remarkRequired, type ExistingInstrument, type PlannedChange, type RowPlan } from './bulk-plan.js';
import { buildTelemetryOverview, instrumentLimitsWithText, NO_LIMIT_TEXT, loadActiveWindowMinutes } from './telemetry-overview.js';
import { enabledBoundsFor } from '../alarms/load-limits.js';
import { decimalsFor, annotateAttribute } from './decimals.js';
import { slotConfigForProfile, allOffsetKeys, measurementsForProfile, loadMeasurementTypes } from './profile-measurements.js';
import { loadAttributeAccess, refuseAttributeWrite, needsReauth, attributeAccessRefusal } from './attribute-access.js';
import {
  ATTRIBUTE_REMARK_MAX, lttb, isInstrumentReporting,
  parseInstrumentAttributeKeys, coerceAttributeLabels, ATTRIBUTE_LABELS_CONFIG_KEY,
  isMktOn, mktFromExpMean, measurementsEquivalent,
} from '@digilog/shared';
import { invalidateIngestAuthCache } from './ingest-auth.js';
import { kickMqttClient } from './broker-kick.js';
import { invalidateChildMapCache } from './gateway-children.js';
import { codeLabel } from './code-label.js';
import deviceCertificateRoutes from './device-certificate-routes.js';
import dataKeysRoutes from './data-keys-routes.js';
import { parseKeysParam } from './keys-param.js';
import { parseUuidList } from '../../lib/uuid-list.js';
import { resolvedSlotFor, measurementFor } from './data-keys.js';
import {
  gatewayInvariantError, lockedGatewayRecheck, lockInstrumentRows, isDeadlock,
  GatewayInvariantViolation,
} from './gateway-invariants.js';
import {
  getLatest, getHistory, getDistinctKeys, getKeyCatalogue, getRangeRows, getRangeSummary, chartRangeTotal,
  getMultiInstrumentHistory,
  type TelemetryRow, type RangeSummary,
} from './telemetry.repository.js';
import { publishAttributeDownlink, publishRetained, attributeDownlinkTopic } from './attribute-downlink.js';
import { publishChildRoster, clearChildRoster } from './child-roster.js';
import { announceChildAttributeChange } from './child-attributes-bundle.js';
import { logger } from '../../lib/logger.js';
import { roleHasPermission } from '../../plugins/rbac.js';

/**
 * Registry (operator-facing, JWT + permission gated). The device-facing ingest
 * endpoint lives in `ingest-routes.ts` and is deliberately a separate file:
 * that one is on the auth-hook allowlist and reachable from the network without
 * a login, this one is not. Keeping them apart makes it obvious in review which
 * file is internet-facing.
 *
 * LOCK-ORDER RULE FOR EVERY TRANSACTION IN THIS FILE — no transaction may take
 * an instrument row lock AFTER calling `auditLog`. `auditLog` takes the audit
 * chain's advisory lock and holds it to commit, so locking afterwards cycles
 * against a concurrent write and Postgres kills one with 40P01 (a 500). Take
 * the row locks first, via `lockInstrumentRows`/`lockedGatewayRecheck`, parent
 * before self. See `gateway-invariants.ts` and `apps/api/DECISIONS.md`.
 */

/**
 * Shape returned to the UI. The token itself is NEVER in here — only the
 * non-secret prefix, so an operator can tell which credential a device is
 * holding without the value being retrievable (design spec D5).
 */
const instrumentProps = {
  id: { type: 'string' },
  name: { type: 'string' },
  code: { type: 'string' },
  isActive: { type: 'boolean' },
  // Fastify strips response properties this schema does not declare. Omit
  // these and the UI sees no profile at all, however correct the query is.
  profileId: { type: 'string' },
  /**
   * DECLARED so it survives the response filter — the query already selects the
   * whole model, so this field existed and was being stripped silently. Added
   * 2026-09-01 for the Alarm Report, which names the Block and Area of a
   * single-instrument download that chose neither.
   */
  functionalLocationId: { type: 'string', nullable: true },
  profileName: { type: 'string', nullable: true },
  instrumentType: { type: 'string', nullable: true },
  manufacturer: { type: 'string', nullable: true },
  model: { type: 'string', nullable: true },
  serialNumber: { type: 'string', nullable: true },
  description: { type: 'string', nullable: true },
  expectedIntervalSec: { type: 'integer', nullable: true },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
  createdBy: { type: 'string', nullable: true },
  tokenPrefix: { type: 'string', nullable: true },
  /**
   * Can `GET /:id/token` actually return a value? False for a credential issued
   * before 2026-08-06 (no ciphertext exists, and none can be derived from a
   * hash) or on a deployment with no INSTRUMENT_TOKEN_KEY. The UI needs this
   * BEFORE it offers a Reveal button, since finding out the other way costs the
   * operator a password re-auth to reach an error. Not a secret: it says whether
   * a value is recoverable, never anything about the value.
   */
  tokenRevealable: { type: 'boolean' },
  /** Last time a reading arrived FOR this instrument — "is it talking?" */
  lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
  // Placement is free text by design (spec D8): `code` stays the identifier.
  location: { type: 'string', nullable: true },
  area: { type: 'string', nullable: true },
  block: { type: 'string', nullable: true },
  isGateway: { type: 'boolean' },
  gatewayId: { type: 'string', nullable: true },
  /** 'direct' | 'gateway' — which path the last reading arrived by. */
  lastSeenVia: { type: 'string', nullable: true },
} as const;

/**
 * `GET /:id` only: the instrument's GATEWAY as the child's own fact (2026-10-26).
 * The detail page used to look the gateway up by id, and a viewer whose scope
 * holds the child but not the gateway (IOTGW01 sits in no location) got a 404
 * toast on every child it opened — plus "Gateway: No" and the wrong attribute
 * topic in the connection card. The child's row already names the gateway's
 * id; its code is how the child's own downlink is addressed. Whether the
 * caller may OPEN the gateway is the server's answer, never the browser's.
 * DECLARED here or Fastify strips both.
 */
const instrumentDetailProps = {
  ...instrumentProps,
  gatewayCode: { type: 'string', nullable: true },
  gatewayVisible: { type: 'boolean' },
} as const;

/** The narrow shape both gateway-link pickers render: no secrets, no telemetry. */
/**
 * Flattens Prisma's nested `profile` onto `profileName`, which is what
 * `childProps` declares. Fastify STRIPS anything absent from the response schema,
 * so returning the nested object would have sent no profile at all — the field
 * would simply be missing and the UI would show blanks with nothing to debug.
 */
function asChild(row: { id: string; code: string; name: string; isActive: boolean; profile: { name: string } | null }) {
  return { id: row.id, code: row.code, name: row.name, isActive: row.isActive, profileName: row.profile?.name ?? null };
}

const childProps = {
  id: { type: 'string' },
  code: { type: 'string' },
  name: { type: 'string' },
  isActive: { type: 'boolean' },
  /**
   * The child's OWN profile, which need not be the gateway's. Gateways and the
   * instruments reporting through them are routinely created under different
   * profiles, and a link across profiles is legitimate — nothing here or in
   * `eligible-children` filters on profile. Surfacing it means the operator can
   * see which profile a child came from before linking it, instead of guessing
   * from the code.
   */
  profileName: { type: 'string', nullable: true },
} as const;

/** One telemetry reading as the UI renders it. `value` is free-form JSON. */
const readingProps = {
  key: { type: 'string' },
  value: {},
  valueType: { type: 'string' },
  ts: { type: 'string', format: 'date-time' },
  // Which named slot this key maps to, and the precision to show it at — both
  // resolved server-side so this raw key/value list renders a temperature the
  // same way the dashboard does. Null for a key that is neither slot (a battery
  // level, a door contact): those keep their raw value, since nothing has said
  // what precision they carry.
  slot: { type: 'string', nullable: true },
  decimals: { type: 'integer', nullable: true },
} as const;

/**
 * Backstop on the CHART path's row read — far above any real range at this
 * installation's 30-90s cadence (a 30-day period is ~86,000 readings per key),
 * low enough to bound memory. NOT the sampling target: sampling happens after
 * the rows come back, and if this cap is ever hit the response says so through
 * `historySampled` rather than quietly plotting a short window.
 */
const CHART_HARD_CAP = 200_000;

/**
 * A `RangeSummary` on the wire: the two timestamps as ISO strings, plus the
 * BOUNDS the breach counts were taken against.
 *
 * The bounds ride along deliberately. A client that printed the counts from
 * here and the limits from its own `telemetry-overview` fetch would be quoting
 * two independent resolutions in one table — and "0 above 25.0" is a claim
 * about a specific number, so the number has to come from the same resolution
 * that produced the count. `null` means no bound was resolved for this key,
 * which is the server's statement, not a client inference.
 */
type SerialisedSummary = Omit<RangeSummary, 'first' | 'last' | 'mktExpMean'> & {
  first: string; last: string; limitMin: number | null; limitMax: number | null;
  /** The text each bound prints in place of its number; null = the number. */
  limitMinText: string | null; limitMaxText: string | null;
  /**
   * Mean Kinetic Temperature over EVERY reading in the range, °C — ONLY on the
   * temperature slot of an instrument whose `isMktCalculationEnabled`
   * attribute is on (operator, 2026-10-03); null otherwise. The SERVER
   * decides, so the Data Report prints the row iff this is a number.
   */
  mkt: number | null;
};

type CredentialRow = { tokenPrefix: string; tokenEncrypted?: string | null };
type InstrumentRow = Record<string, unknown> & { credentials?: CredentialRow[] };

/**
 * Flatten the active credential onto the instrument; never leak `tokenHash`.
 *
 * `lastSeenAt` / `lastSeenVia` come from the INSTRUMENT's own columns, not from
 * the credential's `lastUsedAt` (spec D9): a child reported through its gateway
 * never presents its own credential, so a credential-derived value would read
 * "Never" for exactly the instruments the gateway feature exists to serve.
 * `tokenPrefix` stays credential-derived — it IS a property of the credential.
 */
function present(row: InstrumentRow) {
  const { credentials, profile, ...rest } =
    row as InstrumentRow & { profile?: { name: string } | null };
  const active = credentials?.[0];
  return {
    ...rest,
    // The profile is joined purely for its NAME — every screen shows a label,
    // never the id. Destructured away so the nested object never reaches the
    // client alongside the flat field.
    profileName: profile?.name ?? null,
    tokenPrefix: active?.tokenPrefix ?? null,
    // The CIPHERTEXT ITSELF is destructured away with `credentials` and never
    // reaches the client — only the boolean derived from it. Selecting it here
    // is what lets the UI decide whether Reveal is even offered.
    tokenRevealable: Boolean(active?.tokenEncrypted) && tokenKeyConfigured(),
  };
}

/** Reads join the profile only for its name (see `present`). */
const withProfileName = { profile: { select: { name: true } } };

const activeCredential = {
  where: { revokedAt: null },
  // `lastUsedAt` is deliberately NOT selected: `present()` does not read it.
  // Last-seen moved to the instrument's own columns (spec D9) — see present().
  select: { tokenPrefix: true, tokenEncrypted: true },
  orderBy: { createdAt: 'desc' },
  take: 1,
} as const;

/** Human label for an audit row, so the trail never carries a bare UUID. */
async function codeOf(
  id: string | null | undefined,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string | null> {
  if (!id) return null;
  const row = await client.instrument.findUnique({ where: { id }, select: { code: true } });
  return row?.code ?? null;
}

/**
 * A code, shortened for a §11 signature meaning.
 *
 * `audit_trail.signature_meaning` is `VarChar(255)`, and the code became FREE
 * TEXT of any length on 2026-08-07. A 300-character code interpolated into
 * "Instrument \"…\" registered" overflows the column, Postgres raises 22001,
 * and the whole create transaction rolls back — the operator sees a 500 for a
 * perfectly legal instrument.
 *
 * Truncating the SENTENCE loses nothing that the trail needs: the full code is
 * recorded verbatim in the row's `afterValue` / `beforeValue` JSON, which is
 * unbounded. The sentence is the human rendering, not the record.
 */
/**
 * `code` and `name` are exempt from HTML stripping (2026-08-07).
 *
 * The operator asked for an Instrument ID that accepts any symbol, and the
 * sanitiser DISCARDS anything tag-shaped: a code of `<b>` came back as the
 * empty string, and `A<B` as `A`. Silently storing something other than what
 * was typed is worse here than the XSS the stripper defends against, and that
 * defence is not load-bearing for these two fields — React escapes on render,
 * and neither value is ever interpolated into HTML or into a topic (the wire
 * addresses instruments by UUID).
 *
 * Every other text field on these payloads is still stripped.
 */
const IDENTITY_FIELDS = ['code', 'name'];

/**
 * A profileId naming no profile would otherwise surface as a raw foreign-key
 * error — a 500 that tells the operator nothing about which field is wrong.
 *
 * There is a benign race (the profile could be deleted between this check and
 * the insert), but a POPULATED profile cannot be deleted and this insert is what
 * populates it, so the window closes itself.
 */
async function profileMissing(profileId: string | undefined): Promise<boolean> {
  if (!profileId) return false;
  return !(await prisma.instrumentProfile.findUnique({
    where: { id: profileId }, select: { id: true },
  }));
}

const PROFILE_NOT_FOUND = {
  error: 'PROFILE_NOT_FOUND',
  message: 'The selected profile no longer exists.',
};

/**
 * Checked before the create, as the profile is: an unknown id would otherwise
 * reach the foreign key and surface as a 500.
 */
async function locationMissing(functionalLocationId: string | null | undefined): Promise<boolean> {
  if (!functionalLocationId) return false;
  return !(await prisma.functionalLocation.findUnique({
    where: { id: functionalLocationId }, select: { id: true },
  }));
}

const LOCATION_NOT_FOUND = {
  error: 'LOCATION_NOT_FOUND',
  message: 'The selected functional location no longer exists.',
};

/**
 * The refusal for an instrument its creator could not see (2026-10-26). Two
 * wordings because the remedy differs: no location chosen, or one outside the
 * caller's instrument view.
 */
function placementRefusal(functionalLocationId: unknown): { error: string; message: string } {
  return functionalLocationId
    ? { error: 'LOCATION_OUT_OF_SCOPE', message: 'That functional location is outside your instrument view. Choose one of your own locations.' }
    : { error: 'LOCATION_REQUIRED', message: 'Choose a functional location. Your instrument view is limited to selected locations, and an instrument registered outside them would be hidden from you.' };
}


/**
 * Tell a gateway who its children are. CALLED AFTER THE COMMIT.
 *
 * Reads the membership HERE rather than inside the transaction, for the reason
 * `announceAttributeChange` re-reads: an in-transaction read cannot see a
 * concurrent commit that linked or unlinked a DIFFERENT child, so it could
 * retain a membership that was never true.
 *
 * Takes the gateway's id, not its code, because every caller has the id and
 * only some have the code — and looking it up here also settles the two cases
 * that must NOT publish: an id that is no longer a gateway (mode was just
 * turned off), and one whose row is gone. Both leave silently. The TOPIC is
 * the gateway's CODE (2026-09-04), read from the same lookup.
 *
 * Never throws. A broker failure must not turn a committed link into an error
 * the operator would retry.
 */
async function announceRoster(gatewayId: string | null | undefined): Promise<void> {
  if (!gatewayId) return;
  try {
    const gw = await prisma.instrument.findUnique({
      where: { id: gatewayId }, select: { isGateway: true, code: true },
    });
    if (!gw?.isGateway) return;
    const children = await prisma.instrument.findMany({
      where: { gatewayId },
      select: { code: true, name: true, isActive: true },
    });
    // Topic AND payload are keyed on codes: the gateway subscribes
    // `instruments/${clientid}/children` with its code as client id, and the
    // code is what a person reads on the device.
    await publishChildRoster(gw.code, children, new Date());
  } catch (e) {
    logger.warn('[downlink:children] roster NOT DELIVERED — could not read the membership', {
      gatewayId, err: (e as Error).message,
    });
  }
  // Membership publishes NOTHING on `…/children/attributes` (operator,
  // 2026-09-05): that topic carries attribute CHANGES only, as they happen.
}

/**
 * Create an instrument and its first credential in ONE transaction, with the
 * audit row joined to that same transaction (§11.10(e) — a rollback must take
 * the audit row with it). Returns the plaintext token, which is the only moment
 * it is knowable.
 */
async function createWithCredential(
  draft: Record<string, unknown>,
  ctx: ReturnType<typeof buildContext>,
  /**
   * The caller's instrument visibility (`undefined` = unrestricted). REQUIRED,
   * not optional: the gateway a new instrument links to must be in it, and the
   * new instrument itself must land in it. An optional parameter is how the
   * bulk path once skipped both without anyone noticing.
   */
  visibility: ScopeWhere | undefined,
): Promise<{ id: string; code: string; name: string; token: string }> {
  const token = generateToken();
  return prisma.$transaction(async (tx) => {
    // FIRST statement of the transaction, before the write and before any
    // auditLog takes the audit advisory lock — see gateway-invariants.ts.
    await lockedGatewayRecheck(tx, { linkTo: (draft.gatewayId as string | null | undefined) ?? null, visibility });

    const instrument = await tx.instrument.create({
      data: { ...draft, createdBy: ctx.userId } as unknown as Prisma.InstrumentCreateInput,
    });
    // The caller must be able to SEE what they just created (2026-10-26). Read
    // back through the SAME fragment `GET /:id` applies, inside the transaction
    // and BEFORE the credential and the audit row, so a refusal rolls the row
    // back and never consumes an audit chain position. Without it a scoped
    // user's new instrument was a 404 on every route from birth — attributes,
    // detail page, telemetry — while it existed for everyone else (AWS: two
    // such instruments, every attribute write lost).
    if (visibility) {
      const seen = await tx.instrument.findFirst({
        where: withVisibility({ id: instrument.id }, visibility) as { id: string },
        select: { id: true },
      });
      if (!seen) throw new HandledRouteError(400, placementRefusal(draft.functionalLocationId));
    }
    // Named beside the id on the record, as `gateway` is beside `gatewayId`.
    const bornIn = instrument.functionalLocationId
      ? await tx.functionalLocation.findUnique({ where: { id: instrument.functionalLocationId }, select: { name: true } })
      : null;
    await tx.instrumentCredential.create({
      data: {
        instrumentId: instrument.id,
        tokenHash: hashToken(token),
        tokenPrefix: tokenPrefix(token),
        // Null when no INSTRUMENT_TOKEN_KEY is configured. Issuance must never
        // depend on the key: a deployment without one still registers devices,
        // their tokens just cannot be revealed later.
        tokenEncrypted: encryptToken(token),
      },
    });
    await auditLog({
      action: 'INSTRUMENT_CREATED', targetType: 'Instrument', targetId: instrument.id,
      // The location it was born in is part of what was registered — it decides
      // who can see the instrument — so it is on the record when chosen.
      afterValue: {
        name: instrument.name, code: instrument.code,
        ...(instrument.functionalLocationId
          ? { functionalLocation: bornIn?.name ?? null, functionalLocationId: instrument.functionalLocationId }
          : {}),
      },
      signatureMeaning: `Instrument "${codeLabel(instrument.code)}" registered and access token issued`,
      userId: ctx.userId, userRole: ctx.userRole,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    }, tx);

    // Gateway wiring is an access-control fact, not metadata: `gatewayId`
    // decides which credential may write this instrument's telemetry. Born
    // linked or born a gateway gets its own row, in this same transaction, so
    // the trail reads the same whether the state was set at create or later.
    if (instrument.isGateway) {
      await auditLog({
        action: 'INSTRUMENT_GATEWAY_ENABLED', targetType: 'Instrument', targetId: instrument.id,
        afterValue: { code: instrument.code, isGateway: true },
        signatureMeaning: `Instrument "${codeLabel(instrument.code)}" registered as a gateway`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    }
    if (instrument.gatewayId) {
      const parentCode = (await tx.instrument.findUnique({
        where: { id: instrument.gatewayId }, select: { code: true },
      }))?.code ?? instrument.gatewayId;
      await auditLog({
        action: 'INSTRUMENT_LINKED_TO_GATEWAY', targetType: 'Instrument', targetId: instrument.id,
        afterValue: { code: instrument.code, gateway: parentCode, gatewayId: instrument.gatewayId },
        signatureMeaning: `Instrument "${codeLabel(instrument.code)}" linked to gateway "${parentCode}"`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    }

    return { id: instrument.id, code: instrument.code, name: instrument.name, token };
  });
}

/**
 * A 4xx decided INSIDE a transaction. Throwing (rather than returning) is what
 * rolls the partial work back; the handler catches it and sends `body`.
 * `GatewayInvariantViolation` does the same job for the gateway rules — this one
 * exists so a token conflict is not misreported as a gateway invariant.
 */
class HandledRouteError extends Error {
  constructor(readonly status: number, readonly body: { error: string; message: string }) {
    super(body.message);
    this.name = 'HandledRouteError';
  }
}

/** Postgres unique-violation on `instruments.code`. */
function isDuplicateCode(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * A bulk row that names an existing instrument, and one change it carries
 * (2026-10-28). EVERY inner key is declared — Fastify strips what the schema
 * does not name, and `from: null` (a first fill) must survive as null.
 */
const bulkChangeProps = {
  key: { type: 'string' },
  column: { type: 'string' },
  from: { type: 'string', nullable: true },
  to: { type: 'string' },
} as const;
const bulkUpdatedProps = {
  id: { type: 'string' },
  code: { type: 'string' },
  row: { type: 'integer' },
  changes: { type: 'array', items: { type: 'object', properties: bulkChangeProps } },
} as const;
const bulkRowRefProps = { row: { type: 'integer' }, code: { type: 'string' } } as const;

/** One aggregate bucket on the wire. */
const aggregatePointProps = {
  ts: { type: 'string', format: 'date-time' },
  min: { type: 'number' },
  mean: { type: 'number' },
  max: { type: 'number' },
  instrumentCount: { type: 'integer' },
} as const;

/** A shared bound, or null when the selection's instruments disagree. */
const aggregateBoundProps = {
  min: { type: 'number', nullable: true },
  max: { type: 'number', nullable: true },
} as const;

/**
 * The ONE way a route that names an instrument by id looks it up (audit
 * 2026-10-03, API-5 / API-9): the caller's resolved visibility ANDed onto the
 * id, so an instrument outside the caller's scope is a 404 — never a 403,
 * which would confirm it exists. The read routes (`GET /:id`, telemetry,
 * telemetry-keys, dead-letters) had this since 2026-08; the attribute read,
 * the writes (update, delete, tokens, attributes) and the pickers did not,
 * so a supervisor scoped to Block A could read Block B's limits by id, or
 * rename, delete or re-limit a Block B instrument. Root CLAUDE.md records
 * scope as "enforced on the query"; writes were simply never listed.
 */
async function visibleInstrumentWhere(req: FastifyRequest, id: string): Promise<{ id: string }> {
  const { where: visibility } = await resolveVisibility(buildContext(req));
  return withVisibility({ id }, visibility) as { id: string };
}

export default async function instrumentRoutes(app: FastifyInstance) {
  // GET/POST/DELETE /api/instruments/:id/device-certificate (2026-10-27) — a
  // child plugin, so it inherits this prefix and the RBAC decorators.
  await app.register(deviceCertificateRoutes);
  // GET /api/instruments/data-keys (2026-10-28) — every key a set of instruments
  // has, for the widget key picker. A child plugin, the same arrangement.
  await app.register(dataKeysRoutes);

  // GET /api/instruments — paginated list
  app.get('/', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'List instruments',
      description: 'Paginated instrument registry with search and status/placement filters.',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer' },
          isActive: { type: 'string', enum: ['true', 'false'] },
          search: { type: 'string', description: 'Matches name, code or serial number' },
          block: { type: 'string' },
          area: { type: 'string' },
          location: { type: 'string' },
          isGateway: { type: 'string', enum: ['true', 'false'] },
          profileId: { type: 'string', format: 'uuid', description: 'Scope to one instrument profile' },
          functionalLocationId: {
            type: 'string', format: 'uuid',
            description: 'Scope to a Block (expanding to its Areas) or one Area',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object', properties: instrumentProps } },
            total: { type: 'integer' }, page: { type: 'integer' },
            limit: { type: 'integer' }, totalPages: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const parsed = instrumentQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const {
      page, limit, search, isActive, block, area, location, isGateway, profileId,
      functionalLocationId,
    } = parsed.data;

    const where: Prisma.InstrumentWhereInput = {
      ...(isActive !== undefined ? { isActive: isActive === 'true' } : {}),
      ...(block ? { block: { contains: block, mode: 'insensitive' as const } } : {}),
      ...(area ? { area: { contains: area, mode: 'insensitive' as const } } : {}),
      ...(location ? { location: { contains: location, mode: 'insensitive' as const } } : {}),
      ...(isGateway !== undefined ? { isGateway: isGateway === 'true' } : {}),
      ...(profileId ? { profileId } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { code: { contains: search, mode: 'insensitive' as const } },
              { serialNumber: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    /**
     * A FUNCTIONAL LOCATION filter — a Block or an Area.
     *
     * `resolveLocationIds`, never a bare equality: a Block's instruments are its
     * OWN plus every Area beneath it, and querying the id directly returns only
     * what is pinned to the Block itself, which on this installation is nothing at
     * all. The same call the alarms list makes, for the same reason, and the
     * expansion the browser must never re-derive.
     */
    if (functionalLocationId) {
      const nodes = await prisma.functionalLocation.findMany({
        select: { id: true, name: true, type: true, parentId: true },
      });
      where.functionalLocationId = { in: resolveLocationIds(functionalLocationId, nodes as FlNode[]) };
    }

    // Visibility is merged into the SAME where the count uses, so `total` cannot
    // claim more instruments than the caller is shown.
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const scopedWhere = withVisibility(where, visibility) as typeof where;

    const [rows, total] = await Promise.all([
      prisma.instrument.findMany({
        where: scopedWhere,
        include: { credentials: activeCredential, ...withProfileName },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.instrument.count({ where: scopedWhere }),
    ]);

    return {
      data: rows.map((r) => present(r as unknown as InstrumentRow)),
      total, page, limit, totalPages: Math.ceil(total / limit) || 1,
    };
  });

  // GET /api/instruments/eligible-children — candidates for a gateway link.
  // Registered before `/:id` for readability only: Fastify's router already
  // ranks a static segment above a parameterised one.
  app.get('/eligible-children', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Instruments eligible to be linked to a gateway',
      description: 'Active instruments that are neither a gateway themselves (D2) nor already linked to one (D3). Both exclusions are the invariants, not a UI preference.',
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'object', properties: childProps } } },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    // Scoped (audit 2026-10-03, API-8): the picker handed every id in the
    // plant to a caller scoped to four instruments.
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const data = await prisma.instrument.findMany({
      where: withVisibility({ isGateway: false, gatewayId: null, isActive: true }, visibility) as never,
      select: { id: true, code: true, name: true, isActive: true, profile: { select: { name: true } } },
      orderBy: { code: 'asc' },
    });
    return { data: data.map(asChild) };
  });

  // GET /api/instruments/:id/children — what this gateway currently reports for
  app.get('/:id/children', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Instruments linked to this gateway',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'object', properties: childProps } } },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const exists = await prisma.instrument.findFirst({ where: await visibleInstrumentWhere(req, id), select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const { where: visibility } = await resolveVisibility(buildContext(req));
    const data = await prisma.instrument.findMany({
      where: withVisibility({ gatewayId: id }, visibility) as never,
      select: { id: true, code: true, name: true, isActive: true, profile: { select: { name: true } } },
      orderBy: { code: 'asc' },
    });
    return { data: data.map(asChild) };
  });

  // GET /api/instruments/telemetry-overview — every instrument's current
  // temperature and humidity, in one request.
  //
  // GET /activity-summary — how many instruments exist, and how many are
  // REPORTING. Registered before '/:id' for the same reason
  // '/telemetry-overview' is.
  //
  // Exists because the dashboard's "All Instruments" card needs the same split
  // the Block and Area cards show, and the location tree cannot supply it: the
  // tree only counts PLACED instruments, and this installation has one with no
  // functional location. Summing the tree would have quietly under-reported the
  // headline while the cards beneath it added up to something else.
  //
  // Active means REPORTING, judged by `isInstrumentReporting` — the same rule
  // Configuration → Instrument Activity describes and telemetry-overview
  // applies. Deliberately not `isActive`: that is the administrator's
  // enable/disable flag, and counting it produced "101 active" on a plant that
  // had not reported for two days.
  app.get('/activity-summary', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'How many instruments are visible, and how many are reporting',
      description:
        'Counts are narrowed to the caller\'s instrument visibility, so they never '
        + 'disclose the size of an estate the caller cannot see. `active` counts '
        + 'instruments reporting within their expected interval, or within the '
        + 'site-wide active window when they declare none.',
      response: {
        200: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            active: { type: 'integer' },
            /** Minutes; the fallback window in force, so a caller can explain the split. */
            activeWindowMinutes: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const [rows, activeWindowMinutes] = await Promise.all([
      prisma.instrument.findMany({
        where: withVisibility({}, visibility) as never,
        select: { lastSeenAt: true, expectedIntervalSec: true },
      }),
      loadActiveWindowMinutes(),
    ]);
    // One `now` for the whole pass, so the window cannot move mid-count.
    const now = new Date();
    let active = 0;
    for (const r of rows) {
      if (isInstrumentReporting(r.lastSeenAt, r.expectedIntervalSec, activeWindowMinutes, now)) {
        active += 1;
      }
    }
    return { total: rows.length, active, activeWindowMinutes };
  });

  // GET /api/instruments/offset-keys — which attribute keys are SENSOR OFFSETS
  // (2026-10-26), so the attribute editor can offer the + / - input for them.
  // The server's answer — every profile's offset keys, folded — not the browser
  // re-reading a config row and deciding for itself (it did until this date).
  // Offsets are SUPER_ADMIN-only, so any other caller is told none.
  // Registered before '/:id' (see '/telemetry-overview' below).
  app.get('/offset-keys', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'The attribute keys that are sensor offsets (super admin only; empty for anyone else)',
      response: {
        200: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } } }, required: ['keys'] },
        ...errorResponses,
      },
    },
  }, async (req) => {
    if (req.user?.role !== 'SUPER_ADMIN') return { keys: [] };
    return { keys: [...(await allOffsetKeys())].sort() };
  });

  // Registered BEFORE '/:id' so the static path wins the match, exactly as
  // '/eligible-children' does. Without that ordering the param route claims it
  // and rejects "telemetry-overview" as a malformed uuid — a 400, not a 404,
  // which is a confusing way to discover a routing bug. There is a test for it.
  //
  // Feeds BOTH dashboard views; see telemetry-overview.ts for why there is only
  // one such endpoint.
  app.get('/telemetry-overview', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Current temperature and humidity for every instrument',
      querystring: {
        type: 'object',
        properties: {
          floorplanId: { type: 'string', format: 'uuid' },
          functionalLocationId: { type: 'string' },
          functionalLocationDirect: { type: 'string', enum: ['true', 'false'] },
          // Dashboard sources, ANDed with every filter above and with visibility.
          profileId: { type: 'string', format: 'uuid' },
          instrumentIds: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  instrumentId: { type: 'string' },
                  code: { type: 'string' },
                  name: { type: 'string' },
                  isActive: { type: 'boolean' },
                  room: {
                    type: 'object', nullable: true,
                    properties: {
                      id: { type: 'string' },
                      code: { type: 'string' },
                      label: { type: 'string', nullable: true },
                      floorplanId: { type: 'string' },
                    },
                  },
                  // The two PLACEMENT facts beside `room` above: the authoritative
                  // functional-location NAME, and the instrument's own `Location`
                  // attribute. Declared here, like everything else, because Fastify
                  // strips what this block does not name — `rangeBounds` below is
                  // the fourth time that has bitten this endpoint.
                  functionalLocationName: { type: 'string', nullable: true },
                  locationAttribute: { type: 'string', nullable: true },
                  // Fastify STRIPS anything absent from this schema, so a field
                  // added to OverviewRow but not declared here silently never
                  // reaches the client. That is why limits is listed.
                  limits: {
                    type: 'object', nullable: true,
                    properties: {
                      tempMin: { type: 'number', nullable: true },
                      tempMax: { type: 'number', nullable: true },
                      rhMin: { type: 'number', nullable: true },
                      rhMax: { type: 'number', nullable: true },
                    },
                  },
                  // WHY a bound is missing from `limits`: switched off by the
                  // instrument's own `Enable_*` attribute, versus never
                  // administered. `limits` already withholds it either way — this
                  // only lets a UI word the absence honestly.
                  limitEnabled: {
                    type: 'object',
                    properties: {
                      tempMin: { type: 'boolean' },
                      tempMax: { type: 'boolean' },
                      rhMin: { type: 'boolean' },
                      rhMax: { type: 'boolean' },
                    },
                  },
                  // The text a bound's attribute carries beside its number
                  // (`60 (For Reference)`), printed in place of the bare
                  // number on every set point. Null = the number. Declared
                  // inner key by inner key — an undeclared nested key is
                  // stripped silently, which has bitten this endpoint before.
                  limitText: {
                    type: 'object',
                    properties: {
                      tempMin: { type: 'string', nullable: true },
                      tempMax: { type: 'string', nullable: true },
                      rhMin: { type: 'string', nullable: true },
                      rhMax: { type: 'string', nullable: true },
                    },
                  },
                  limitSource: { type: 'string', nullable: true },
                  temperature: {
                    type: 'object', nullable: true,
                    properties: {
                      key: { type: 'string' },
                      value: { type: 'number' },
                      ts: { type: 'string', format: 'date-time' },
                    },
                  },
                  humidity: {
                    type: 'object', nullable: true,
                    properties: {
                      key: { type: 'string' },
                      value: { type: 'number' },
                      ts: { type: 'string', format: 'date-time' },
                    },
                  },
                  decimals: {
                    type: 'object',
                    properties: {
                      temperature: { type: 'integer' },
                      humidity: { type: 'integer' },
                    },
                  },
                  reporting: { type: 'boolean' },
                  // Declared or Fastify strips them. `judged`: the profile measures
                  // temperature or humidity; `lastSeenAt`: ISO instant or null.
                  judged: { type: 'boolean' },
                  lastSeenAt: { type: 'string', nullable: true },
                  status: { type: 'string' },
                  // Which slots reported something that is not a number. Declared
                  // because Fastify strips what this block does not name — see the
                  // note on `limits` above. `rawSlots` is deliberately NOT declared:
                  // the decision belongs on the wire, the device's raw text does not.
                  sensorError: {
                    type: 'object',
                    properties: {
                      temperature: { type: 'boolean' },
                      humidity: { type: 'boolean' },
                    },
                  },
                  // Which slots reported a number outside the probe's span. The
                  // numeric slot is null in that case, so without this the cell
                  // would read NA and hide a hardware fault behind "no data".
                  rangeError: {
                    type: 'object',
                    properties: {
                      temperature: { type: 'boolean' },
                      humidity: { type: 'boolean' },
                    },
                  },
                  /**
                   * The probe's declared span. `buildTelemetryOverview` has
                   * returned this since the sensor-range source shipped, but it
                   * was never DECLARED here, so Fastify stripped it on the way
                   * out and no browser surface could see it.
                   *
                   * That is why the trend page's raw table printed a saturated
                   * reading as a number: `rangeError` answers only "is the
                   * LATEST reading out of span", and a table of historical rows
                   * needs the bounds themselves to judge each one.
                   */
                  rangeBounds: {
                    type: 'object',
                    properties: {
                      temperatureHigh: { type: 'number', nullable: true },
                      temperatureLow: { type: 'number', nullable: true },
                      humidityHigh: { type: 'number', nullable: true },
                      humidityLow: { type: 'number', nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const q = req.query as {
      floorplanId?: string; functionalLocationId?: string; functionalLocationDirect?: string;
      profileId?: string; instrumentIds?: string;
    };
    const list = parseUuidList(q.instrumentIds, 200);
    if (list.error) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: list.error });
    const { where: visibility } = await resolveVisibility(buildContext(req));
    return { data: await buildTelemetryOverview({
      profileId: q.profileId,
      instrumentIds: list.ids,
      floorplanId: q.floorplanId,
      functionalLocationId: q.functionalLocationId,
      functionalLocationDirect: q.functionalLocationDirect === 'true',
      visibilityWhere: visibility,
    }) };
  });

  // GET /api/instruments/telemetry-aggregate — min/mean/max across a SELECTION.
  //
  // The dashboard's trend card. Registered before `/:id` so the static segment is
  // unambiguous (Fastify already ranks it higher; this is for the reader).
  //
  // EVERY VALUE IT RETURNS IS DERIVED — not one is a stored reading. The card that
  // draws them says so; see telemetry-aggregate.ts.
  app.get('/telemetry-aggregate', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Min/mean/max across the instruments in a selection, bucketed',
      description:
        'Aggregate of every instrument the caller may see within the given functional location. '
        + 'All values are COMPUTED, not stored readings. Limit bounds are returned only when every '
        + 'instrument in the selection resolves to the same bound.',
      querystring: {
        type: 'object',
        properties: {
          functionalLocationId: { type: 'string' },
          functionalLocationDirect: { type: 'string' },
          window: { type: 'string', enum: [...HISTORY_WINDOWS], default: '24h' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            bucketSeconds: { type: 'integer', nullable: true },
            instrumentCount: { type: 'integer' },
            series: {
              type: 'object',
              // Fastify STRIPS any field absent from a response schema, silently.
              // Both slots are declared explicitly for that reason.
              properties: {
                temperature: { type: 'array', items: { type: 'object', properties: aggregatePointProps } },
                humidity: { type: 'array', items: { type: 'object', properties: aggregatePointProps } },
              },
            },
            limits: {
              type: 'object',
              properties: {
                temperature: { type: 'object', nullable: true, properties: aggregateBoundProps },
                humidity: { type: 'object', nullable: true, properties: aggregateBoundProps },
              },
            },
            limitsMixed: {
              type: 'object',
              properties: { temperature: { type: 'boolean' }, humidity: { type: 'boolean' } },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const q = req.query as { functionalLocationId?: string; functionalLocationDirect?: string; window?: string };
    const { where: visibility } = await resolveVisibility(buildContext(req));
    return getTelemetryAggregate({
      functionalLocationId: q.functionalLocationId,
      direct: q.functionalLocationDirect === 'true',
      window: (q.window ?? '24h') as HistoryWindow,
      visibility,
    });
  });

  /**
   * GET /api/instruments/telemetry-history — the merged, paged readings of
   * SEVERAL instruments, newest first (the Instruments page's history widget,
   * 2026-09-05).
   *
   * One row per (instrument, instant) with every key that instrument reported
   * at it, pivoted in SQL so a page boundary cannot split one instant's
   * temperature from its humidity. Values are RAW: which key is the temperature
   * is per instrument (`telemetry-overview` says), and the caller reads the
   * slot keys, limits and precision from there.
   *
   * Visibility is applied to the ID SET before the query, the same way the
   * `/:id/telemetry` route applies it to its lookup: an instrument outside the
   * caller's scope is simply absent from the rows and the count, never a 403 —
   * which would confirm it exists. Static path, registered before `/:id` like
   * `/telemetry-overview`, so Fastify's static-first matching keeps it off the
   * detail route.
   */
  app.get('/telemetry-history', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Merged, paged readings of several instruments, newest first',
      querystring: {
        type: 'object',
        required: ['instrumentIds'],
        properties: {
          /** Comma-separated instrument UUIDs. */
          instrumentIds: { type: 'string', minLength: 1 },
          /** Comma-separated telemetry keys, exactly as stored (2026-10-28). Absent = every key. */
          keys: { type: 'string' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          limit: { type: 'integer', default: 50 },
          offset: { type: 'integer', default: 0, minimum: 0 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  instrumentId: { type: 'string' },
                  ts: { type: 'string', format: 'date-time' },
                  // Every key the instrument reported at this instant, raw.
                  // `additionalProperties` is what lets it through Fastify's
                  // serializer — an object schema with no properties declared
                  // and no additionalProperties would strip every key.
                  values: { type: 'object', additionalProperties: true },
                },
              },
            },
            total: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const q = req.query as { instrumentIds: string; keys?: string; from?: string; to?: string; limit?: number; offset?: number };
    const keyFilter = parseKeysParam(q.keys);
    if ('error' in keyFilter) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: keyFilter.error });
    const asked = [...new Set(q.instrumentIds.split(',').map((s) => s.trim()).filter(Boolean))];
    const bad = asked.find((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
    if (bad) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: `Not an instrument id: ${bad.slice(0, 80)}` });
    }
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;
    if (from && to && from > to) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '`from` must not be after `to`.' });
    }
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const visible = await prisma.instrument.findMany({
      where: withVisibility({ id: { in: asked } }, visibility) as { id: { in: string[] } },
      select: { id: true },
    });
    const { rows, total } = await getMultiInstrumentHistory({
      instrumentIds: visible.map((i) => i.id),
      keys: keyFilter.keys ?? undefined,
      from, to,
      limit: q.limit, offset: q.offset,
    });
    return { data: rows.map((r) => ({ instrumentId: r.instrumentId, ts: r.ts.toISOString(), values: r.values })), total };
  });

  // GET /api/instruments/:id — detail
  app.get('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Get instrument by ID',
      description: 'Full instrument detail. The access token is never returned — only its prefix.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', properties: instrumentDetailProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Visibility is applied as part of the LOOKUP, not checked after it, so an
    // out-of-scope instrument is indistinguishable from a non-existent one. 404, not
    // 403: a 403 would confirm the instrument exists, which is the fact being
    // withheld.
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const row = await prisma.instrument.findFirst({
      where: withVisibility({ id }, visibility) as { id: string },
      include: { credentials: activeCredential, ...withProfileName, gateway: { select: { code: true } } },
    });
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });
    const { gateway, ...rest } = row;
    // Opened through the same fragment as this lookup, so the link is offered
    // exactly when following it would not 404.
    const gatewayVisible = row.gatewayId
      ? Boolean(await prisma.instrument.findFirst({
          where: withVisibility({ id: row.gatewayId }, visibility) as { id: string },
          select: { id: true },
        }))
      : false;
    return {
      ...present(rest as unknown as InstrumentRow),
      gatewayCode: gateway?.code ?? null,
      gatewayVisible,
    };
  });

  // GET /api/instruments/:id/telemetry — latest value per key + recent history.
  // The detail page's whole job is answering "data is being sent, why can't I
  // see it?", which needs the readings and the failures side by side.
  app.get('/:id/telemetry', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Latest and recent telemetry for one instrument',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          // Several keys, comma-separated, exactly as stored (widget data keys,
          // 2026-10-28). Not together with `key`. Absent = every key.
          keys: { type: 'string' },
          limit: { type: 'integer', default: 100 },
          offset: { type: 'integer', default: 0, minimum: 0 },
          // Additive: getHistory() has always accepted a time range, the route
          // simply never surfaced it. Callers passing neither are unaffected.
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          // Target points per key for the CHART path. Omitted = legacy behaviour
          // (the paged `limit`/`offset` table path), so existing callers are
          // unaffected. Enumerated bounds, so an out-of-range value is a 400 from
          // the schema rather than a silent clamp.
          points: { type: 'integer', minimum: 1, maximum: 5000 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            latest: { type: 'array', items: { type: 'object', properties: readingProps } },
            history: { type: 'array', items: { type: 'object', properties: readingProps } },
            historyTotal: { type: 'integer' },
            // Chart path only. Fastify STRIPS any field not declared here, so a
            // field added to the handler without a line in this block vanishes
            // between the handler and the wire with no error anywhere.
            historySampled: { type: 'boolean' },
            summaries: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                properties: {
                  count: { type: 'integer' },
                  // The numeric population, and the TRUE breach counts over the
                  // whole range — see `getRangeSummary`. Nullable, and null is
                  // load-bearing: it means no limit was resolved for this key,
                  // which is not the same claim as zero breaches.
                  numericCount: { type: 'integer' },
                  belowCount: { type: 'integer', nullable: true },
                  aboveCount: { type: 'integer', nullable: true },
                  outOfSpecCount: { type: 'integer', nullable: true },
                  limitMin: { type: 'number', nullable: true },
                  limitMax: { type: 'number', nullable: true },
                  // The text each bound prints in place of its number
                  // (2026-10-03). Declared or Fastify strips it silently.
                  limitMinText: { type: 'string', nullable: true },
                  limitMaxText: { type: 'string', nullable: true },
                  // Mean Kinetic Temperature, °C, temperature slot only and
                  // only when the instrument's `isMktCalculationEnabled` is on.
                  mkt: { type: 'number', nullable: true },
                  min: { type: 'number' }, max: { type: 'number' }, avg: { type: 'number' },
                  first: { type: 'string' }, last: { type: 'string' },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as {
      key?: string; keys?: string; limit?: number; offset?: number; from?: string; to?: string; points?: number;
    };
    const keyFilter = parseKeysParam(q.keys);
    if ('error' in keyFilter) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: keyFilter.error });
    if (q.key && keyFilter.keys) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Give `key` or `keys`, not both.' });
    }
    // Visibility is applied as part of the LOOKUP, not checked after it, so an
    // out-of-scope instrument is indistinguishable from a non-existent one —
    // matching the /:id detail route above (404, never 403).
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const exists = await prisma.instrument.findFirst({
      where: withVisibility({ id }, visibility) as { id: string },
      // The ROOM's band comes back on this same read rather than in a second
      // query: it is the fallback for an instrument that declares no limits of
      // its own, and without it every room-limited instrument would have its
      // breach counts reported as "no limit set" in a signed document.
      select: {
        id: true,
        profileId: true,
        room: { select: { tempMin: true, tempMax: true, rhMin: true, rhMax: true } },
      },
    });
    if (!exists) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    // NO ceiling (operator, 2026-09-02). The old comment claimed "the page only
    // ever renders a recent window" — but the caller passes `from`/`to`, so the
    // window is the CALLER's, and a 500-row cap over a month-long range returned
    // the newest 500 with nothing to say so. `total` rides beside the rows.
    const limit = resolvePageSize(q.limit, 100);
    const offset = Math.max(Number(q.offset ?? 0), 0);
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;
    // `points` present = the CHART path: every reading in the range, downsampled
    // to `points` per key, with Min/Max/Avg computed in SQL over the WHOLE range.
    // Absent = the paged TABLE path, unchanged.
    //
    // Why the chart needs its own path at all: `getHistory` caps at 1000 rows
    // ORDER BY ts DESC, so before 2026-08-27 a 7-day request came back holding
    // only the newest day, with nothing in the response saying so — the axis
    // claimed a week and the summary strip was computed over that truncated
    // slice. The fix is not a bigger cap; it is sampling plus true aggregates.
    const points = q.points === undefined ? null : Number(q.points);

    // Loaded BEFORE the branch, not after it: the chart path needs the slot
    // mapping and the resolved limits to bound its per-key breach counts, and
    // the table path needs the same two for its annotation anyway.
    const [slotCfg, attributes, latest] = await Promise.all([
      // The instrument PROFILE's key mappings (2026-10-26) — the SAME resolver
      // the alarm evaluator and the dashboard use. Nothing here reads an
      // attribute name directly — two surfaces disagreeing about which limit
      // applies is a defect this repo has already paid for once.
      slotConfigForProfile(exists.profileId),
      prisma.instrumentAttribute.findMany({
        where: { instrumentId: id },
        select: { key: true, value: true },
      }),
      getLatest(id),
    ]);
    const dp = decimalsFor(slotCfg.decimals, attributes);
    // The ONE rule (2026-10-28): of several device keys of one measurement, only
    // the key the instrument's temperature RESOLVED to (the overview's and the
    // alarm evaluator's choice) is a temperature here; it is the one the trend
    // page charts and the one the breach counts are taken for.
    const latestKeys = latest.map((r) => r.key);
    const slotFor = (key: string): 'temperature' | 'humidity' | null => resolvedSlotFor(slotCfg, key, latestKeys);
    /**
     * The band the breach counts are taken against: the instrument's OWN limits
     * where it declares any, else its room's — `buildTelemetryOverview`'s rule,
     * through the same `instrumentLimits()` helper.
     *
     * That helper also nulls BOTH bounds of a metric whose pair is inverted,
     * because the evaluator raises nothing for such a pair. Counting breaches
     * against a band the alarm system deliberately ignores would put a number
     * in a §11 report that no alarm on this system could ever corroborate.
     */
    const ownResolved = instrumentLimitsWithText(slotCfg.limitKeys, attributes);
    const own = ownResolved?.band ?? null;
    const rawBand = own ?? (exists.room
      ? { tempMin: exists.room.tempMin, tempMax: exists.room.tempMax, rhMin: exists.room.rhMin, rhMax: exists.room.rhMax }
      : null);

    /**
     * A bound the instrument has switched OFF is not a bound.
     *
     * `Enable_Temp_NMT` / `_NLT` / `Enable_Humid_NMT` / `_NLT` gate the four
     * bounds (NMT is the HIGH one, NLT the LOW one). `buildTelemetryOverview`
     * has applied them since 2026-08-31 and nulls a disabled bound before it
     * ever leaves the server; this route resolved the SAME limits through the
     * SAME helper and then did not, which is the defect this fixes.
     *
     * What it cost: the chart's limit LINE comes from the overview and so
     * disappeared correctly, while the summary strip beside it kept printing
     * that bound AND counting breaches against it in SQL. On this installation
     * that is not hypothetical — an instrument carrying `High Humidity Limit =
     * 0` with `Enable_Humid_NMT = 0` would report every reading as above limit,
     * in a §11 report, against a bound no alarm on this system can raise. One
     * screen, two answers to "is this bound in force?".
     *
     * Gated here rather than inside `instrumentLimits()` because that helper is
     * also the ALARM path's resolver and the enable flags are applied there by
     * `enabledBoundsFor` at its own call site; moving the gate down would apply
     * it twice in one place and not at all in the other.
     *
     * Room-sourced bounds are gated too, deliberately and consistently with the
     * overview: the flag is the instrument's statement about which of ITS
     * bounds are judged, and a room bound it disowns enforces nothing either.
     */
    const boundEnabled = enabledBoundsFor(slotCfg, attributes);
    const band = rawBand && {
      tempMin: boundEnabled.temperatureLow ? rawBand.tempMin : null,
      tempMax: boundEnabled.temperatureHigh ? rawBand.tempMax : null,
      rhMin: boundEnabled.humidityLow ? rawBand.rhMin : null,
      rhMax: boundEnabled.humidityHigh ? rawBand.rhMax : null,
    };
    // The TEXT each bound prints (`60 (For Reference)`), following the bound
    // through the same gate — null wherever the bound is null, and always null
    // for a room-sourced band. Rides on the summary beside `limitMin`/`limitMax`
    // so the report's printed bound and its breach count come from ONE answer.
    const texts = ownResolved?.texts ?? NO_LIMIT_TEXT;
    const boundsFor = (key: string): {
      low: number | null; high: number | null; lowText: string | null; highText: string | null;
    } => {
      const slot = slotFor(key);
      if (!band || !slot) return { low: null, high: null, lowText: null, highText: null };
      const low = (slot === 'temperature' ? band.tempMin : band.rhMin) ?? null;
      const high = (slot === 'temperature' ? band.tempMax : band.rhMax) ?? null;
      return {
        low,
        high,
        lowText: low === null || !own ? null : (slot === 'temperature' ? texts.tempMin : texts.rhMin),
        highText: high === null || !own ? null : (slot === 'temperature' ? texts.tempMax : texts.rhMax),
      };
    };


    let historyRows: TelemetryRow[];
    let historyTotal: number;
    let historySampled: boolean | undefined;
    let summaries: Record<string, SerialisedSummary> | undefined;

    if (points === null) {
      const history = await getHistory({
        instrumentId: id, key: q.key, keys: keyFilter.keys ?? undefined, limit, offset, from, to,
      });
      historyRows = history.rows;
      historyTotal = history.total;
    } else {
      // No `key` means "every key this instrument has sent" — the trend page
      // charts them all in one request. A key with no readings inside the range
      // simply contributes no rows and no summary entry.
      const keys = keyFilter.keys ?? (q.key ? [q.key] : (await getDistinctKeys(id)).map((k) => k.key));
      const perKey = await Promise.all(keys.map(async (key) => {
        const bounds = boundsFor(key);
        const [{ rows, truncated }, summary] = await Promise.all([
          getRangeRows({ instrumentId: id, key, from, to, hardCap: CHART_HARD_CAP }),
          // The breach counts are computed in THIS query, over every reading in
          // the range — never over `rows`, which may be a sample.
          getRangeSummary({ instrumentId: id, key, from, to, low: bounds.low, high: bounds.high }),
        ]);
        // A non-numeric reading (a device once sent the string "hello") has no
        // position on a value axis, so it is dropped BEFORE sampling. That is
        // why the sampled row count can be below `historyTotal` even when
        // nothing was sampled away.
        //
        // Through `coerceReading`, so a QUOTED number plots like any other — the
        // chart must not silently omit readings the dashboard and the alarms
        // both accept.
        const plottable = rows.flatMap((r) => {
          const n = coerceReading(r.value);
          return n === null ? [] : [{ ...r, value: n }];
        });
        const sampled = lttb(plottable, points);
        return {
          key,
          summary,
          bounds,
          sampled,
          // The range's TRUE reading count, from the summary's own `count(*)`,
          // not `rows.length` — which is the post-slice count and understates
          // the range whenever `CHART_HARD_CAP` fires. `historyTotal` is an
          // on-screen and printed §11 statement ("Showing 5,000 of N"), so it
          // has to describe the window that was asked for. The two are
          // byte-equivalent on every non-truncating call: `getRangeSummary`
          // counts `count(*)` with no numeric guard, exactly what `getRangeRows`
          // selects. `rows.length` remains the fallback for a key the summary
          // returned nothing for (an empty range), where it is 0 either way.
          //
          // DIRECTION OF TRUNCATION: `getRangeRows` is `ORDER BY ts ASC LIMIT
          // hardCap + 1`, so a capped fetch keeps the OLDEST readings and the
          // chart would cover only the BEGINNING of the period. (The original
          // defect was the mirror image — `getHistory`'s DESC kept only the
          // newest.) Unreachable at this cadence, and `truncated` is reported
          // either way, but the next reader should not have to re-derive which
          // end goes missing.
          total: chartRangeTotal(summary, rows.length),
          truncated,
          dropped: sampled.length < plottable.length,
        };
      }));

      historyRows = perKey.flatMap((k) => k.sampled);
      // The TRUE number of readings in the range, not the number returned — the
      // whole defect this task fixes was a count that described the returned
      // slice rather than the window that was asked for.
      historyTotal = perKey.reduce((n, k) => n + k.total, 0);
      historySampled = perKey.some((k) => k.truncated || k.dropped);
      summaries = {};
      // MKT is the PROFILE's switch AND then the INSTRUMENT's attribute
      // (`isMktCalculationEnabled`; 2026-10-26, operator: "in instrument
      // profiles … MKT attributes … enabled or disabled"), decided here from the
      // attributes already loaded, so the Data Report prints the row iff the
      // server sent a number — nothing in the browser re-reads the flag.
      // Temperature slot only: the formula is in kelvin from °C, and a "mean
      // kinetic humidity" is not a thing.
      const mktOn = isMktOn(slotCfg.mkt.temperature, attributes);
      for (const k of perKey) {
        if (!k.summary) continue;
        const { mktExpMean, ...rest } = k.summary;
        // ISO explicitly rather than trusting Date→string coercion in the
        // serialiser: the wire contract for these two is a timestamp string.
        summaries[k.key] = {
          ...rest,
          first: k.summary.first.toISOString(),
          last: k.summary.last.toISOString(),
          limitMin: k.bounds.low,
          limitMax: k.bounds.high,
          limitMinText: k.bounds.lowText,
          limitMaxText: k.bounds.highText,
          mkt: mktOn && slotFor(k.key) === 'temperature' ? mktFromExpMean(mktExpMean) : null,
        };
      }
    }
    // Label each reading with its slot and this instrument's precision. Same
    // administered vocabulary and same resolver the dashboard uses — a raw list
    // that disagrees with the dashboard about the same stored number is the
    // failure this annotation exists to prevent. `slotFor` is the SAME mapping
    // the breach bounds above were chosen with, so a key cannot be a
    // temperature for one and not the other.
    const annotate = (r: { key: string }) => {
      const slot = slotFor(r.key);
      return { ...r, slot, decimals: slot ? dp[slot] : null };
    };

    return {
      latest: latest.map(annotate),
      history: historyRows.map(annotate),
      historyTotal,
      // Only on the chart path — the table path's response shape is untouched.
      ...(historySampled === undefined ? {} : { historySampled, summaries }),
    };
  });

  // GET /api/instruments/:id/telemetry-keys — the keys this instrument has
  // ACTUALLY sent, newest activity first. Backs the trend page's "add a key"
  // picker: ingest stores whatever key a device sends, so a free-text field
  // would invite a key that has never existed and a widget that can never draw.
  app.get('/:id/telemetry-keys', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Distinct telemetry keys sent by one instrument',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  slot: { type: ['string', 'null'], enum: ['temperature', 'humidity', null] },
                  lastSeen: { type: 'string' },
                  // 2026-10-28 (widget data keys). Declared, or Fastify strips them.
                  numeric: { type: 'boolean' },
                  measurement: {
                    type: 'object', nullable: true,
                    properties: { code: { type: 'string' }, name: { type: 'string' }, unit: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Same visibility discipline as /:id/telemetry above — an out-of-scope
    // instrument must 404, not 403, so this route can't be used to confirm an
    // instrument exists outside the caller's scope.
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const exists = await prisma.instrument.findFirst({
      where: withVisibility({ id }, visibility) as { id: string },
      // Existence and the PROFILE (whose device keys label each key). This route
      // computes no breach counts, so it needs no room band.
      select: { id: true, profileId: true },
    });
    if (!exists) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    // Same per-profile resolution the telemetry route uses, so the picker and
    // the charts agree about which key is "temperature".
    // The latest table, one row per key — the same catalogue the widget picker
    // reads (`getKeyCatalogue`), so `numeric` means the same thing on both.
    const [slotCfg, keys, types] = await Promise.all([
      slotConfigForProfile(exists.profileId), getKeyCatalogue([id]), loadMeasurementTypes(),
    ]);
    const keyNames = keys.map((k) => k.key);

    return {
      data: keys.map((k) => {
        // The ONE rule, so the picker, the chart and the overview name the
        // same key the instrument's temperature.
        const measured = resolvedSlotFor(slotCfg, k.key, keyNames);
        return {
          key: k.key, slot: measured, lastSeen: k.lastSeen,
          numeric: k.numeric,
          measurement: measured ? measurementFor(measured, types) : null,
        };
      }),
    };
  });

  // GET /api/instruments/:id/dead-letters — this device's rejected payloads
  app.get('/:id/dead-letters', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Rejected payloads for one instrument',
      description: 'Payloads that could not be parsed or were refused. The first place to look when a device reports success but no readings appear.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: { type: 'object', properties: { limit: { type: 'integer', default: 50 } } },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' }, transport: { type: 'string' }, reason: { type: 'string' },
                  rawPayload: { type: 'string', nullable: true },
                  receivedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
            total: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { limit?: number };
    // Scoped like `GET /:id` and `GET /:id/telemetry` beside it. This route was
    // left on a bare `findUnique` when the telemetry gap was closed on
    // 2026-08-24 — and `rawPayload` is the device's own message, so an
    // out-of-scope instrument's readings were readable here verbatim. Visibility
    // is applied as part of the LOOKUP, so out-of-scope is indistinguishable
    // from non-existent: 404, never 403.
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const exists = await prisma.instrument.findFirst({
      where: withVisibility({ id }, visibility) as { id: string },
      select: { id: true },
    });
    if (!exists) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const take = resolvePageSize(q.limit, 50);   // no ceiling — see lib/page-size.ts
    const [data, total] = await Promise.all([
      prisma.deadLetter.findMany({ where: { instrumentId: id }, orderBy: { receivedAt: 'desc' }, take }),
      prisma.deadLetter.count({ where: { instrumentId: id } }),
    ]);
    return { data, total };
  });

  // POST /api/instruments — create one instrument + its credential
  app.post('/', {
    preHandler: [app.requirePermission('INSTRUMENT_CREATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Create instrument',
      description: 'Creates an instrument and issues its access token. The token is returned ONCE and cannot be retrieved later.',
      body: {
        type: 'object',
        required: ['name', 'code', 'profileId'],
        properties: {
          name: { type: 'string' }, code: { type: 'string' },
          profileId: { type: 'string', format: 'uuid' },
          isActive: { type: 'boolean' },
          instrumentType: { type: 'string' }, manufacturer: { type: 'string' },
          model: { type: 'string' }, serialNumber: { type: 'string' },
          description: { type: 'string' },
          expectedIntervalSec: { type: ['integer', 'null'] },
          location: { type: ['string', 'null'] }, area: { type: ['string', 'null'] },
          block: { type: ['string', 'null'] },
          isGateway: { type: 'boolean' },
          gatewayId: { type: ['string', 'null'], format: 'uuid' },
        },
      },
      response: {
        // `token` appears HERE and in no other response schema — Fastify strips
        // unlisted properties, so the write-once rule is enforced by
        // serialization rather than by remembering to omit it on every read.
        201: { type: 'object', properties: { ...instrumentProps, token: { type: 'string' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    // Configurable e-signature (audit 2026-10-03, SEC-7): registering an
    // instrument mints a device credential. Its sibling, functional-location
    // create, has carried one since 2026-08-13; this one carried none and no
    // action existed to configure it. FIRST, so `_currentPassword` is stripped
    // before anything reads the body.
    const { ok: reauthOk } = await enforceReauth('CREATE_INSTRUMENT', req, reply);
    if (!reauthOk) return;
    const parsed = createInstrumentSchema.safeParse(
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, IDENTITY_FIELDS),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    // The gateway a new instrument links to must be in the caller's scope
    // (audit 2026-10-12) — out of scope reads exactly like missing.
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const invalid = await gatewayInvariantError(parsed.data, null, visibility);
    if (invalid) return reply.code(invalid.status).send(invalid.body);

    if (await profileMissing(parsed.data.profileId)) {
      return reply.code(400).send(PROFILE_NOT_FOUND);
    }
    if (await locationMissing(parsed.data.functionalLocationId)) {
      return reply.code(400).send(LOCATION_NOT_FOUND);
    }

    try {
      const { id, token } = await createWithCredential(parsed.data as Record<string, unknown>, buildContext(req), visibility);
      // An instrument born linked must be writable by its gateway at once, not
      // after the child-map TTL.
      if (parsed.data.gatewayId) invalidateChildMapCache(parsed.data.gatewayId);
      // ...and if its profile requires a device certificate the gateway's open
      // MQTT session must be judged again (final review, 2026-10-27: the hook
      // decides only at CONNECT). Kicking it unconditionally keeps the rule in
      // ONE place — the hook — at the cost of one reconnect per link.
      if (parsed.data.gatewayId) {
        const gatewayCode = await codeOf(parsed.data.gatewayId);
        if (gatewayCode) await kickMqttClient(gatewayCode, 'a child was registered under it');
      }
      // Born linked → its new parent's roster gained a member. Born a GATEWAY →
      // publish its (empty) roster now, so a gateway that connects before it
      // ever gains a child reads an explicit "no children" instead of an empty
      // slot it cannot tell from a broker that lost the message.
      await announceRoster(parsed.data.gatewayId ?? (parsed.data.isGateway ? id : null));
      const row = await prisma.instrument.findUnique({ where: { id }, include: { credentials: activeCredential, ...withProfileName } }); // post-write re-read; the write already resolved visibility
      return reply.code(201).send({ ...present(row as unknown as InstrumentRow), token });
    } catch (err) {
      if (err instanceof GatewayInvariantViolation) return reply.code(err.status).send(err.body);
      if (err instanceof HandledRouteError) return reply.code(err.status).send(err.body);
      if (isDuplicateCode(err)) {
        return reply.code(409).send({ error: 'DUPLICATE_CODE', message: `An instrument with code "${parsed.data.code}" already exists.` });
      }
      throw err;
    }
  });

  // POST /api/instruments/bulk — CSV, partial success
  app.post('/bulk', {
    preHandler: [app.requirePermission('INSTRUMENT_CREATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Bulk-create instruments from CSV, and update the ones that already exist',
      description: 'Per-row validation with partial success: a new Instrument ID is created, an existing one has the attribute cells that differ updated (blank cells change nothing), invalid rows are reported with their source row number. `reason` is required when a change overwrites a recorded value — `POST /bulk/preview` says so first. The response carries one plaintext token per CREATED instrument — it is a live credential file.',
      // profileId is a SIBLING of csv, not a column: the CSV format operators
      // already have on disk stays exactly as it was.
      body: {
        type: 'object', required: ['csv', 'profileId'],
        properties: {
          csv: { type: 'string' },
          profileId: { type: 'string', format: 'uuid' },
          // The functional location EVERY row is born in, chosen once like the
          // profile. Required when the caller's instrument view is limited.
          functionalLocationId: { type: 'string', format: 'uuid', nullable: true },
          // ONE remark for every recorded value the file overwrites (2026-10-28).
          reason: { type: 'string', maxLength: ATTRIBUTE_REMARK_MAX },
          _currentPassword: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            // Existing instruments whose attribute cells differed, with what
            // each change replaced — no token: nothing about access moved.
            updated: { type: 'array', items: { type: 'object', properties: bulkUpdatedProps } },
            unchanged: { type: 'array', items: { type: 'object', properties: bulkRowRefProps } },
            created: {
              type: 'array',
              items: { type: 'object', properties: { id: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' }, token: { type: 'string' } } },
            },
            errors: {
              type: 'array',
              // `column` is the heading as the file spells it, when the fault is
              // a cell; DECLARED, or Fastify strips it and the popup names no cell.
              items: { type: 'object', properties: { row: { type: 'integer' }, column: { type: 'string' }, message: { type: 'string' } } },
            },
            // Whole-file advisories (e.g. a retired column that was ignored).
            // Distinct from `errors`: these fail nothing and cost no rows.
            warnings: { type: 'array', items: { type: 'string' } },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    // The same e-signature the single create carries (audit 2026-10-03,
    // SEC-7; found 2026-10-05 by the web sweep): a bulk upload is N creates,
    // and a policy that challenged one but not a hundred would be bypassed by
    // the CSV form. FIRST, so `_currentPassword` never reaches the parser.
    // The password is read before that strip: the attribute re-auth below may
    // need it again (audit 2026-10-12).
    const sentPassword = ((req.body as Record<string, unknown> | undefined)?._currentPassword as string | undefined)
      ?? (req.headers['x-reauth-password'] as string | undefined);
    const { ok: reauthOk } = await enforceReauth('CREATE_INSTRUMENT', req, reply);
    if (!reauthOk) return;
    const parsed = bulkCreateInstrumentsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    // Checked BEFORE parsing so a bad profile fails the whole upload cleanly,
    // rather than after some rows have already been created against it.
    if (await profileMissing(parsed.data.profileId)) {
      return reply.code(400).send(PROFILE_NOT_FOUND);
    }
    const locationId = parsed.data.functionalLocationId ?? null;
    if (await locationMissing(locationId)) {
      return reply.code(400).send(LOCATION_NOT_FOUND);
    }
    // Decided ONCE, before any row is created (2026-10-26): a refusal must
    // register nothing, not reject every row one by one. `createWithCredential`
    // re-checks each row inside its transaction and stays the authority; this
    // reads the same resolution, so the two cannot disagree.
    const { where: visibility, placeable } = await resolveVisibility(buildContext(req));
    if (placeable && !(locationId && placeable.has(locationId))) {
      return reply.code(400).send(placementRefusal(locationId));
    }

    const plan = await planBulkFile(req, parsed.data, visibility);
    const { rows, errors, warnings } = plan;
    const ctx = buildContext(req);

    // Every gate is decided ONCE, before anything is written, so a refusal
    // registers nothing and changes nothing.
    const refusal = createAttributesRefusal(plan);
    if (refusal) return reply.code(refusal.status).send(refusal.body);

    // ONE remark for every recorded value the file overwrites (2026-10-28) —
    // the rule the single attribute routes apply, asked once for the batch. The
    // plan is THIS request's, computed from the file again, never the preview's.
    const reason = readRemark(req);
    if (remarkRequired(plan.plans)) {
      const problem = validateAttributeRemark(reason);
      if (problem) return reply.code(400).send({ error: 'REMARK_REQUIRED', message: problem });
    }

    // The attribute cells answer to the role's attribute re-auth as the single
    // form's per-attribute writes do (audit 2026-10-12). A file with no filled
    // attribute cell to write is not an attribute write and is not asked.
    const writesAttributes = plan.plans.some((p) => (p.kind === 'create' && p.attributes) || p.kind === 'update');
    if (writesAttributes && needsReauth(plan.access) && !(req as unknown as { _reauthVerified?: boolean })._reauthVerified) {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (sentPassword) body._currentPassword = sentPassword;
      const { ok: signed } = await enforceReauthAlways('UPDATE_INSTRUMENT_ATTRIBUTE', req, reply);
      if (!signed) return;
    }

    const created: { id: string; code: string; name: string; token: string }[] = [];
    const updated: { id: string; code: string; row: number; changes: PlannedChange[] }[] = [];
    const unchanged: { row: number; code: string }[] = [];
    // One transaction per ROW, not one for the file: a row that fails — a code
    // registered meanwhile, a value changed meanwhile — becomes an error row
    // and does not roll back the other 199.
    for (const p of plan.plans) {
      if (p.kind === 'unchanged') { unchanged.push({ row: p.row, code: p.code }); continue; }
      if (p.kind === 'update') {
        try {
          const applied = await applyBulkChanges(p.id, p.code, p.changes, reason, ctx);
          if (applied.length > 0) updated.push({ id: p.id, code: p.code, row: p.row, changes: applied });
          else unchanged.push({ row: p.row, code: p.code });
        } catch (err) {
          if (err instanceof HandledRouteError) { errors.push({ row: p.row, message: err.body.message }); continue; }
          req.log.error({ err, row: p.row, code: p.code }, 'bulk upload: row not updated');
          errors.push({ row: p.row, message: `Not updated: ${(err as Error).message.slice(0, 200)}` });
        }
        continue;
      }
      const { attributes: _cells, ...identity } = rows[p.index];
      const attributes = p.attributes;
      try {
        const row = await createWithCredential(
          {
            ...sanitizeStrings(identity as unknown as Record<string, unknown>, IDENTITY_FIELDS),
            // One profile, and one location, for the whole upload — see the body schema.
            profileId: parsed.data.profileId,
            ...(locationId ? { functionalLocationId: locationId } : {}),
          },
          ctx,
          visibility,
        );
        created.push(row);
        // AFTER the instrument's own transaction, as the single form does with
        // its per-attribute POSTs: a bad attribute must not undo a registered
        // instrument, and each attribute is a §11 record of its own.
        //
        // A failure here is reported ON THIS ROW (audit 2026-10-12): it used to
        // escape the loop as a 500, after instruments had been created, and
        // their one-time tokens — returned only in this response — were lost.
        if (attributes) {
          try {
            await writeInitialAttributes(row.id, row.code, attributes, ctx);
          } catch (err) {
            req.log.error({ err, instrumentId: row.id, code: row.code }, 'bulk upload: attributes not written');
            errors.push({
              row: p.row,
              message: `Instrument "${row.code}" was registered, but its attributes were not written: ${(err as Error).message.slice(0, 200)}`,
            });
          }
        }
      } catch (err) {
        // Registered by someone else between the plan and this row.
        if (isDuplicateCode(err)) {
          errors.push({ row: p.row, column: plan.codeHeading, message: `Instrument ID "${p.code}" already exists` });
          continue;
        }
        // Any other failure fails THIS row, never the upload: the rows already
        // created must still get their tokens back.
        req.log.error({ err, row: p.row }, 'bulk upload: row not created');
        errors.push({ row: p.row, message: `Not created: ${(err as Error).message.slice(0, 200)}` });
      }
    }

    // Parse errors, plan errors and write errors are interleaved by source row
    // so the operator reads one ascending list against their spreadsheet.
    errors.sort((a, b) => a.row - b.row);

    return { created, updated, unchanged, errors, warnings };
  });

  // POST /api/instruments/bulk/preview — what an upload WOULD do, writing nothing
  app.post('/bulk/preview', {
    preHandler: [app.requirePermission('INSTRUMENT_CREATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Preview a bulk upload: which rows create, which update and what each change replaces',
      description: 'Runs the same plan `POST /bulk` runs, and writes nothing — no instrument, no attribute, no audit row, no re-auth. `remarkRequired` is the server\'s answer to whether the upload will demand a `reason`.',
      body: {
        type: 'object', required: ['csv', 'profileId'],
        properties: {
          csv: { type: 'string' },
          profileId: { type: 'string', format: 'uuid' },
          functionalLocationId: { type: 'string', format: 'uuid', nullable: true },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            create: { type: 'array', items: { type: 'object', properties: bulkRowRefProps } },
            update: { type: 'array', items: { type: 'object', properties: bulkUpdatedProps } },
            unchanged: { type: 'array', items: { type: 'object', properties: bulkRowRefProps } },
            errors: { type: 'array', items: { type: 'object', properties: { row: { type: 'integer' }, column: { type: 'string' }, message: { type: 'string' } } } },
            warnings: { type: 'array', items: { type: 'string' } },
            remarkRequired: { type: 'boolean' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const parsed = bulkCreateInstrumentsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    // The upload's own whole-file refusals, in its order, so the operator meets
    // them here rather than after signing.
    if (await profileMissing(parsed.data.profileId)) return reply.code(400).send(PROFILE_NOT_FOUND);
    const locationId = parsed.data.functionalLocationId ?? null;
    if (await locationMissing(locationId)) return reply.code(400).send(LOCATION_NOT_FOUND);
    const { where: visibility, placeable } = await resolveVisibility(buildContext(req));
    if (placeable && !(locationId && placeable.has(locationId))) {
      return reply.code(400).send(placementRefusal(locationId));
    }
    const plan = await planBulkFile(req, parsed.data, visibility);
    const refusal = createAttributesRefusal(plan);
    if (refusal) return reply.code(refusal.status).send(refusal.body);
    return {
      create: plan.plans.filter((p) => p.kind === 'create').map((p) => ({ row: p.row, code: p.code })),
      update: plan.plans.flatMap((p) => (p.kind === 'update' ? [{ id: p.id, code: p.code, row: p.row, changes: p.changes }] : [])),
      unchanged: plan.plans.filter((p) => p.kind === 'unchanged').map((p) => ({ row: p.row, code: p.code })),
      errors: plan.errors,
      warnings: plan.warnings,
      remarkRequired: remarkRequired(plan.plans),
    };
  });

  // PUT /api/instruments/:id — update
  app.put('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Update instrument',
      description: 'Update instrument metadata. `code` may be changed (2026-09-16): it is the MQTT client id and topic segment, so the retained broker slots keyed on the old code are cleared and republished under the new one — the DEVICE must reconnect with the new id. Name follows the code when it was the code.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' }, isActive: { type: 'boolean' },
          code: { type: 'string' },
          // Moving the instrument to another profile.
          profileId: { type: 'string', format: 'uuid' },
          instrumentType: { type: ['string', 'null'] }, manufacturer: { type: ['string', 'null'] },
          model: { type: ['string', 'null'] }, serialNumber: { type: ['string', 'null'] },
          description: { type: ['string', 'null'] }, expectedIntervalSec: { type: ['integer', 'null'] },
          location: { type: ['string', 'null'] }, area: { type: ['string', 'null'] },
          block: { type: ['string', 'null'] },
          isGateway: { type: 'boolean' },
          gatewayId: { type: ['string', 'null'], format: 'uuid', description: 'null unlinks this instrument from its gateway' },
        },
      },
      response: { 200: { type: 'object', properties: instrumentProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    // Configurable e-signature (audit 2026-10-03, SEC-7): a `code` change here
    // moves the device's MQTT identity. FIRST, before sanitizeStrings sees the body.
    const { ok: reauthOk } = await enforceReauth('UPDATE_INSTRUMENT', req, reply);
    if (!reauthOk) return;
    const { id } = req.params as { id: string };
    const parsed = updateInstrumentSchema.safeParse(sanitizeStrings((req.body ?? {}) as Record<string, unknown>));
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    const existing = await prisma.instrument.findFirst({ where: await visibleInstrumentWhere(req, id) });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    if (await profileMissing((parsed.data as { profileId?: string }).profileId)) {
      return reply.code(400).send(PROFILE_NOT_FOUND);
    }

    // MOVING an instrument to a profile that MEASURES DIFFERENTLY is a
    // SUPER_ADMIN act (2026-10-26). What a profile measures — its keys, its NMT /
    // NLT / MKT switches — decides what is monitored and alarmed; moving an
    // instrument into a profile without a measurement, or with a bound switched
    // off, would stop its alarms and clear the open ones without the reason and
    // the impact warning a profile edit requires. A move between profiles that
    // monitor identically stays open to Instrument Update, as before.
    const nextProfileId = (parsed.data as { profileId?: string }).profileId;
    if (nextProfileId && nextProfileId !== existing.profileId && req.user?.role !== 'SUPER_ADMIN') {
      const [from, to] = await Promise.all([measurementsForProfile(existing.profileId), measurementsForProfile(nextProfileId)]);
      if (!measurementsEquivalent(from, to)) {
        return reply.code(403).send({
          error: 'MEASUREMENTS_DIFFER',
          message: 'That profile measures this instrument differently; only a super admin may move it there.',
        });
      }
    }

    // The gateway target and the children a demotion lists are both read
    // inside the caller's scope (audit 2026-10-12).
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const invalid = await gatewayInvariantError(parsed.data, existing, visibility);
    if (invalid) return reply.code(invalid.status).send(invalid.body);

    const ctx = buildContext(req);
    /** The code as it stood under the row lock — what a rename has to clear on the broker. */
    let priorCode: string | null = null;
    const run = () => prisma.$transaction(async (tx) => {
      // FIRST statement of the transaction, and gated on the REQUESTED value,
      // never on a diff against `existing`.
      //
      // `existing` was read outside the transaction, so "unchanged" is a stale
      // verdict — but `data: parsed.data` below re-asserts the value in SQL
      // regardless. Gating the lock on the diff meant a whole-object PUT from a
      // form (the common case, not an exotic one) re-wrote `gatewayId` with no
      // lock and no re-check: enough to re-link a child to a gateway that had
      // been demoted in between, i.e. exactly the invariant this guard exists
      // to hold. Locking on what was ASKED FOR cannot go stale.
      await lockedGatewayRecheck(tx, {
        linkTo: parsed.data.gatewayId ?? null,
        disablingGatewayId: parsed.data.isGateway === false ? id : null,
        selfId: id,
        visibility,
        linkChanges: (parsed.data.gatewayId ?? null) !== existing.gatewayId,
      });

      // Re-read under those locks. This — not `existing` — decides what counts
      // as a transition, so the audit rows describe what actually changed.
      const before = await tx.instrument.findUnique({ where: { id } });
      if (!before) throw new GatewayInvariantViolation(404, { error: 'NOT_FOUND', message: 'Instrument not found.' });

      // D2/self, re-checked on the EFFECTIVE state (locked row + this request's
      // fields). `lockedGatewayRecheck` covers only the two cross-row rules; the
      // same-row ones were left to the pre-flight, which computes them from a
      // row read outside any transaction. Two ordinary UI actions defeat that,
      // because neither request carries the other's field:
      //
      //   A: PUT /C {isGateway:true}   (detail Save — no gatewayId)
      //   B: PUT /C {gatewayId:GW}     (gateway panel Link — no isGateway)
      //
      // B's pre-flight reads C before A commits, sees isGateway:false, allows
      // it. Both serialise on C's row lock, but B's `parsed.data` has no
      // `isGateway`, so nothing re-evaluates the rule and the commit lands
      // `isGateway && gatewayId` — the nested chain D2 forbids, which no CHECK
      // constraint catches (`instruments_gateway_not_self` covers self only).
      //
      // Both rows are already locked above, so this costs nothing. Mirrors
      // `gatewayInvariantError`'s own defaulting EXACTLY — `??` would be wrong
      // on `gatewayId`, turning an explicit `null` (unlink) back into the old
      // parent. Keep the two in step.
      const effIsGateway = parsed.data.isGateway ?? before.isGateway;
      const effGatewayId = parsed.data.gatewayId === undefined
        ? before.gatewayId
        : (parsed.data.gatewayId ?? null);
      // On a row that ALREADY holds `isGateway && gatewayId`, the pre-flight
      // above returns first and this never runs — see the operator note on
      // `gatewayInvariantError`'s NESTED_GATEWAY branch for what to do about
      // such a row. This copy is for the interleaving described above, where
      // neither request alone looks nested.
      if (effIsGateway && effGatewayId) {
        throw new GatewayInvariantViolation(400, {
          error: 'NESTED_GATEWAY',
          message: 'A gateway cannot itself be linked to another gateway. Unlink it first.',
        });
      }
      if (effGatewayId === id) {
        throw new GatewayInvariantViolation(400, {
          error: 'SELF_GATEWAY', message: 'An instrument cannot be its own gateway.',
        });
      }

      // Only a real transition is audited: a PUT that re-sends the current
      // gatewayId is not a link event, and a trail full of no-op links is a
      // trail nobody reads.
      const gatewayChanged = parsed.data.gatewayId !== undefined
        && (parsed.data.gatewayId ?? null) !== before.gatewayId;
      const modeChanged = parsed.data.isGateway !== undefined
        && parsed.data.isGateway !== before.isGateway;
      const [oldGatewayCode, newGatewayCode] = gatewayChanged
        ? [(await codeOf(before.gatewayId, tx)), (await codeOf(parsed.data.gatewayId, tx))]
        : [null, null];

      priorCode = before.code;
      // Name follows the code when it WAS the code (the 2026-09-04 rule: name =
      // code on every instrument) and no name was given alongside. An explicit
      // name in the same PUT wins; a name that already differed is left alone.
      const codeChanged = parsed.data.code !== undefined && parsed.data.code !== before.code;
      const data: Record<string, unknown> = { ...parsed.data };
      if (codeChanged && parsed.data.name === undefined && before.name === before.code) data.name = parsed.data.code;
      const row = await tx.instrument.update({ where: { id }, data: data as never });
      // EVERY editable field, on both sides. An omission is not cosmetic: a PUT
      // that changes only an omitted field produces a §11 row whose before and
      // after are IDENTICAL — a record that something changed but not what.
      // `code` is included (and is the emitter key the other INSTRUMENT_*
      // actions use) so the trail never has to fall back to a bare UUID.
      //
      // `isGateway`/`gatewayId` are in here even though each ALSO gets a
      // dedicated companion row below. The two carry different things and
      // neither substitutes for the other: the companion rows carry the
      // semantics (a signatureMeaning, the parent's resolved `code`), this row
      // carries the diff. Leaving them out was the whole defect — a
      // `PUT {isGateway:true}` then wrote an INSTRUMENT_UPDATED whose before
      // and after were byte-identical.
      //
      // This list is not kept in step by hand: the e2e test
      // "INSTRUMENT_UPDATED carries the code and a diff over every editable
      // field" derives its expected key set from `updateInstrumentSchema.shape`,
      // so adding a field to the PUT schema and forgetting it here FAILS.
      const audited = (i: typeof before) => ({
        code: i.code, name: i.name, isActive: i.isActive,
        instrumentType: i.instrumentType, manufacturer: i.manufacturer, model: i.model,
        serialNumber: i.serialNumber, description: i.description,
        expectedIntervalSec: i.expectedIntervalSec,
        location: i.location, area: i.area, block: i.block,
        isGateway: i.isGateway, gatewayId: i.gatewayId,
        // Moving an instrument between profiles changes which group an
        // inspector finds it under; the design records that through this row
        // rather than a dedicated action.
        profileId: i.profileId,
      });
      await auditLog({
        action: 'INSTRUMENT_UPDATED', targetType: 'Instrument', targetId: id,
        beforeValue: audited(before),
        afterValue: audited(row),
        signatureMeaning: `Instrument "${codeLabel(row.code)}" updated`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);

      // §11.10(e): these rows change WHICH credential may write this
      // instrument's telemetry, so they belong in the same transaction as the
      // mutation — an audit row that can outlive a rolled-back write is worse
      // than none.
      if (modeChanged) {
        await auditLog({
          action: parsed.data.isGateway ? 'INSTRUMENT_GATEWAY_ENABLED' : 'INSTRUMENT_GATEWAY_DISABLED',
          targetType: 'Instrument', targetId: id,
          beforeValue: { code: before.code, isGateway: before.isGateway },
          afterValue: { code: row.code, isGateway: row.isGateway },
          signatureMeaning: parsed.data.isGateway
            ? `Gateway mode enabled on instrument "${codeLabel(row.code)}"`
            : `Gateway mode disabled on instrument "${codeLabel(row.code)}"`,
          userId: ctx.userId, userRole: ctx.userRole,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      }
      if (gatewayChanged) {
        await auditLog({
          action: parsed.data.gatewayId ? 'INSTRUMENT_LINKED_TO_GATEWAY' : 'INSTRUMENT_UNLINKED_FROM_GATEWAY',
          targetType: 'Instrument', targetId: id,
          beforeValue: { code: before.code, gateway: oldGatewayCode, gatewayId: before.gatewayId },
          afterValue: { code: row.code, gateway: newGatewayCode, gatewayId: row.gatewayId },
          signatureMeaning: parsed.data.gatewayId
            ? `Instrument "${codeLabel(row.code)}" linked to gateway "${codeLabel(newGatewayCode ?? '')}"`
            : `Instrument "${codeLabel(row.code)}" unlinked from gateway "${codeLabel(oldGatewayCode ?? '')}"`,
          userId: ctx.userId, userRole: ctx.userRole,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      }
      return row;
    });

    // Two mirrored demote-and-link requests acquire two PARENT rows in opposite
    // orders, which the parent-before-self rule cannot order (see
    // gateway-invariants.ts). Postgres picks a victim, and the retry is
    // uncontended because the winner has committed by then. ONE retry only — a
    // repeat means a real lock-order bug and should surface as a 500 rather
    // than spin.
    //
    // The retry runs inside the same handling as the first attempt: the winner
    // has usually invalidated the loser's request (the gateway it wanted to
    // link to just stopped being one), so the second attempt very often ends in
    // a legitimate GatewayInvariantViolation that must still become its 4xx.
    let updated: Awaited<ReturnType<typeof run>> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        updated = await run();
        break;
      } catch (err) {
        // The locked re-check refused: the transaction — update and audit rows
        // alike — is already rolled back.
        if (err instanceof GatewayInvariantViolation) return reply.code(err.status).send(err.body);
        if (isDuplicateCode(err)) {
          return reply.code(409).send({ error: 'DUPLICATE_CODE', message: `An instrument with code "${parsed.data.code}" already exists.` });
        }
        if (isDeadlock(err) && attempt === 0) continue;
        throw err;
      }
    }
    if (!updated) throw new Error('Instrument update did not complete.');

    // A RENAME moves the broker's retained state before anything else is
    // announced, so the roster publishes below already speak the new code.
    if (priorCode !== null && priorCode !== updated.code) await afterCodeChange(id, priorCode, updated);

    // Deactivating an instrument must stop its ingest NOW, not in up to 10s:
    // resolveInstrumentByToken caches the resolved identity, and `isActive` is
    // read at resolution time.
    invalidateIngestAuthCache(id);

    // ...and an OPEN MQTT session must be dropped at the broker too (audit
    // 2026-10-12): EMQX asks the auth hook only at CONNECT. A rename kicks the
    // OLD client id — which is also what stops that device's messages being
    // attributed to whichever instrument is later given the old code — and a
    // deactivation kicks the current one. Best effort, never throws.
    if (priorCode !== null && priorCode !== updated.code) await kickMqttClient(priorCode, 'instrument code changed');
    if (existing.isActive && !updated.isActive) await kickMqttClient(updated.code, 'instrument deactivated');
    // DEVICE CERTIFICATES (final review, 2026-10-27): the hook decides whether a
    // certificate is required only at CONNECT, from the instrument's PROFILE and,
    // for a gateway, its children's. A profile move or a gateway link change can
    // flip that, so drop the instrument's session and those of its former and
    // new gateway — otherwise a plain-1883 device keeps delivering while its
    // card says its data is refused. Best effort, never throws.
    const profileMoved = existing.profileId !== updated.profileId;
    const relinked = existing.gatewayId !== updated.gatewayId;
    if (profileMoved || relinked) {
      if (updated.isActive) await kickMqttClient(updated.code, 'instrument profile or gateway changed');
      for (const gatewayId of new Set([existing.gatewayId, updated.gatewayId].filter((g): g is string => g !== null))) {
        const gatewayCode = await codeOf(gatewayId);
        if (gatewayCode) await kickMqttClient(gatewayCode, 'a child\'s profile or gateway link changed');
      }
    }

    // BOTH sides of a move: left to the 10s TTL a just-unlinked child stays
    // writable by its former gateway. The old parent is invalidated on EVERY
    // update, not only a re-link, because the cached child map also carries
    // `isActive` — deactivating a child must stop its gateway writing for it
    // just as immediately as it stops the child's own token.
    if (existing.gatewayId) invalidateChildMapCache(existing.gatewayId);
    if (parsed.data.gatewayId) invalidateChildMapCache(parsed.data.gatewayId);

    // BOTH sides of a move, for the same reason the cache invalidation above
    // does both: the old gateway lost a member and the new one gained it, and a
    // roster that still names a child someone else now owns is worse than none.
    // `updated.gatewayId` is the COMMITTED value, not `parsed.data.gatewayId` —
    // an update that omits `gatewayId` leaves the link untouched, and a rename
    // or a deactivation has to republish its CURRENT parent (both fields are in
    // the payload). Deduped, so the common single-gateway edit publishes once.
    for (const gwId of new Set([existing.gatewayId, updated.gatewayId].filter(Boolean))) {
      await announceRoster(gwId);
    }
    // The row itself is a gateway whose own membership can have changed here:
    // gateway mode was just turned ON (publish its roster), or a child's edit
    // has nothing to do with it. `announceRoster` no-ops when it is not one.
    if (updated.isGateway) await announceRoster(id);
    // Demoted. `gatewayInvariantError` refuses this while it still has children
    // (400 GATEWAY_HAS_CHILDREN), so the roster being cleared is always an empty
    // one — but leaving it retained would leave a `children` slot on an
    // instrument that is no longer a gateway, which is exactly the kind of
    // stale-forever message the delete path below exists to avoid. Keyed on
    // the code as it stood BEFORE this request (`existing.code`): a demote that
    // also renames has its old-code roster cleared by `afterCodeChange` above,
    // and clearing an already-clear slot is harmless.
    else if (existing.isGateway) await clearChildRoster(existing.code);

    const row = await prisma.instrument.findUnique({ where: { id }, include: { credentials: activeCredential, ...withProfileName } }); // post-write re-read; the write already resolved visibility
    return present((row ?? updated) as unknown as InstrumentRow);
  });

  // DELETE /api/instruments/:id — cascades the credential rows
  app.delete('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_DELETE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Delete instrument',
      description: 'Permanently delete an instrument and its credentials. Telemetry already written is retained. Deleting a gateway UNLINKS its children (ON DELETE SET NULL) — it never deletes them.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    // Configurable e-signature (audit 2026-10-03, SEC-7): this revokes the
    // device's credential in the same request.
    const { ok: reauthOk } = await enforceReauth('DELETE_INSTRUMENT', req, reply);
    if (!reauthOk) return;
    const { id } = req.params as { id: string };
    const existing = await prisma.instrument.findFirst({ where: await visibleInstrumentWhere(req, id) });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const ctx = buildContext(req);
    const orphaned = await prisma.$transaction(async (tx) => {
      // FIRST statement: lock this gateway before reading its children. An
      // unlocked read races a concurrent `PUT /C {gatewayId: this}` committing
      // between the read and the delete — C would be missing from `kids`, get no
      // unlink row, and still be unlinked by the SetNull cascade, which is
      // exactly the §11.10(e) gap the audit rows below exist to close. (It also
      // deadlocks on row locks alone: the delete holds this row and wants C
      // while the linker holds C and wants this row.)
      await lockInstrumentRows(tx, [id]);

      // `onDelete: SetNull` unlinks every child in the DATABASE, silently. That
      // is the same access-control event a PUT audits, so it gets the same rows
      // — read before the delete, written in the same transaction, one per
      // child. Without this, "when did S-4 stop being writable by GW-1, and who
      // did it?" has no answer in the trail (§11.10(e)).
      //
      // FOR UPDATE, not a plain read: unlinking takes no lock, so a
      // `PUT /C {gatewayId:null}` can commit between this read and the delete.
      // The cascade would then never touch C, yet we would still have written a
      // row saying C was unlinked BECAUSE this gateway was deleted — a false
      // statement, and a second unlink row for one unlink, in an immutable
      // trail. Waiting here re-qualifies the row and drops C. Order stays
      // `gateway -> children`, matching the link path, so no cycle.
      const kids = await tx.$queryRaw<{ id: string; code: string }[]>`
        SELECT id, code FROM instruments WHERE gateway_id = ${id} FOR UPDATE
      `;

      await tx.instrument.delete({ where: { id } });
      for (const kid of kids) {
        await auditLog({
          action: 'INSTRUMENT_UNLINKED_FROM_GATEWAY', targetType: 'Instrument', targetId: kid.id,
          beforeValue: { code: kid.code, gateway: existing.code, gatewayId: id },
          afterValue: { code: kid.code, gateway: null, gatewayId: null },
          signatureMeaning: `Instrument "${codeLabel(kid.code)}" unlinked from gateway "${codeLabel(existing.code)}" because that gateway was deleted`,
          userId: ctx.userId, userRole: ctx.userRole,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      }
      await auditLog({
        action: 'INSTRUMENT_DELETED', targetType: 'Instrument', targetId: id,
        beforeValue: { name: existing.name, code: existing.code },
        signatureMeaning: `Instrument "${codeLabel(existing.code)}" deleted`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return kids;
    });

    invalidateIngestAuthCache(id);
    // Its open MQTT session, if any, is dropped at the broker (see PUT).
    await kickMqttClient(existing.code, 'instrument deleted');
    // The deleted row's own child map, and — if it was itself a child — its
    // former parent's, which still lists it.
    invalidateChildMapCache(id);
    if (existing.gatewayId) invalidateChildMapCache(existing.gatewayId);
    // A deleted gateway's roster must not survive it. This is the one place in
    // the codebase that clears a retained slot, and it is deliberate: unlike a
    // stranded attribute slot (stale metadata about a code nothing can even
    // connect as any more), a stranded roster NAMES INSTRUMENTS THAT ARE STILL
    // LIVE and have just been orphaned by this very delete.
    if (existing.isGateway) await clearChildRoster(existing.code);
    // If it was itself a child, its former parent's roster still lists it.
    await announceRoster(existing.gatewayId);
    // Each orphaned child's ingest identity is cached too, and it no longer has
    // a gateway that may write for it.
    for (const kid of orphaned) invalidateIngestAuthCache(kid.id);
    return { success: true };
  });

  // POST /api/instruments/:id/regenerate-token
  //
  // `enforceReauthAlways`, not the admin-configurable `enforceReauth` (changed
  // 2026-08-06, after the same correction was applied to reveal/set). The
  // argument is the one made for those two, and it is stronger here: this
  // endpoint returns a live plaintext credential in its 200 body, and on a
  // stock install `system_config['action-reauth']` lists nothing — so it needed
  // INSTRUMENT_UPDATE and no password at all. It is also the most destructive
  // of the three: it kills the field device's current credential, which reveal
  // does not. Two hardened siblings and one opt-in was worse than either
  // consistent state.
  //
  // `REGENERATE_INSTRUMENT_TOKEN` was removed from `REAUTH_ACTIONS` at the same
  // time, for the same reason the other two were: every entry there is a
  // per-role policy toggle, and an always-on gate has no policy — the toggle
  // would render and change nothing. The action string still travels in the 401
  // body so a client can name the action it is being challenged for.
  app.post('/:id/regenerate-token', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Regenerate instrument access token',
      description: 'Revokes the current credential and issues a new one. The device stops authenticating until it is reconfigured. The new token is shown once. Requires INSTRUMENT_UPDATE and an ALWAYS-ON password re-auth (send it as the `x-reauth-password` header — it is not admin-configurable and cannot be turned off).',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: { type: 'object', properties: { token: { type: 'string' }, tokenPrefix: { type: 'string' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauthAlways('REGENERATE_INSTRUMENT_TOKEN', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const existing = await prisma.instrument.findFirst({ where: await visibleInstrumentWhere(req, id) });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const ctx = buildContext(req);
    const token = generateToken();
    await prisma.$transaction(async (tx) => {
      // Revoke rather than delete: the credential history is the §11 record of
      // which secret was live when a given reading arrived.
      await tx.instrumentCredential.updateMany({
        where: { instrumentId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.instrumentCredential.create({
        data: {
          instrumentId: id,
          tokenHash: hashToken(token),
          tokenPrefix: tokenPrefix(token),
          tokenEncrypted: encryptToken(token),
        },
      });
      await auditLog({
        action: 'INSTRUMENT_TOKEN_REGENERATED', targetType: 'Instrument', targetId: id,
        afterValue: { code: existing.code, tokenPrefix: tokenPrefix(token) },
        signatureMeaning: `Access token for instrument "${codeLabel(existing.code)}" regenerated; previous token revoked`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });

    // Without this the OLD token keeps authenticating for up to the cache TTL,
    // which would make "revoked immediately" untrue.
    invalidateIngestAuthCache(id);
    // A session already open on the OLD token is dropped at the broker; the
    // reconnect is judged against the new one (see PUT).
    await kickMqttClient(existing.code, 'access token regenerated');

    return { token, tokenPrefix: tokenPrefix(token) };
  });

  // GET /api/instruments/:id/token — reveal the live token.
  //
  // This endpoint IS the D5 reversal (spec 2026-08-04, reversed 2026-08-06 at
  // the operator's request). D5's reasoning — a retrievable credential is a
  // standing liability — was not wrong; it was outweighed by the cost of the
  // alternative, which is a site visit to reconfigure a device every time
  // somebody needs to know what its token is. Three controls pay for it:
  // INSTRUMENT_UPDATE (not the read permission — this is not a read of registry
  // metadata), a password re-auth, and an audit row per view. The audit row is
  // the one that matters: the token stays secret, but who looked at it never is.
  //
  // The re-auth is `enforceReauthAlways`, NOT the admin-configurable
  // `enforceReauth` (changed 2026-08-06, the day after this endpoint landed).
  // Configurable was wrong here: `system_config['action-reauth']` lists nothing
  // on a stock install, so a deployment that never opened the policy page would
  // hand out live device credentials to anyone holding INSTRUMENT_UPDATE with no
  // password at all — two of the three compensating controls the D5 reversal was
  // granted on, and no way to tell from the outside which install you are in.
  // A control that the reversal depends on cannot itself be opt-in.
  app.get('/:id/token', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Reveal the instrument access token',
      description: 'Returns the live plaintext token. Requires INSTRUMENT_UPDATE and an ALWAYS-ON password re-auth (send it as the `x-reauth-password` header — it is not admin-configurable and cannot be turned off), and writes an INSTRUMENT_TOKEN_VIEWED audit row. Unavailable for credentials issued before 2026-08-06.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: { type: 'object', properties: { token: { type: 'string' }, tokenPrefix: { type: 'string' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    // A GET carries no body, so the re-auth password arrives in the
    // `x-reauth-password` header — the alternate `enforceReauthAlways` already
    // accepts, and the reason a reveal does not have to become a POST.
    const { ok } = await enforceReauthAlways('REVEAL_INSTRUMENT_TOKEN', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const existing = await prisma.instrument.findFirst({ where: await visibleInstrumentWhere(req, id), select: { id: true, code: true } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const credential = await prisma.instrumentCredential.findFirst({
      where: { instrumentId: id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { tokenPrefix: true, tokenEncrypted: true },
    });
    if (!credential) {
      return reply.code(404).send({
        error: 'NO_CREDENTIAL',
        message: 'This instrument has no active credential. Regenerate its token.',
      });
    }

    // Three distinct failures, deliberately not collapsed into one "cannot show
    // token": each has a different remedy, and an operator staring at a device
    // that will not connect should not have to guess which one they are in.
    if (!credential.tokenEncrypted) {
      return reply.code(409).send({
        error: 'TOKEN_NOT_RECOVERABLE',
        message: 'This token was issued before tokens became viewable, so no recoverable copy exists. Regenerate the token to get a viewable one — the device must then be reconfigured.',
      });
    }
    if (!tokenKeyConfigured()) {
      return reply.code(503).send({
        error: 'TOKEN_KEY_MISSING',
        message: 'INSTRUMENT_TOKEN_KEY is not configured on the server, so stored tokens cannot be decrypted. Ingest is unaffected.',
      });
    }

    let token: string;
    try {
      token = decryptToken(credential.tokenEncrypted);
    } catch (err) {
      // A real alarm, not a validation failure: the ciphertext exists and a key
      // is present, so either the key has been ROTATED (every token silently
      // unviewable from here on) or a row has been tampered with. Logged with
      // the instrument, never with the ciphertext or any partial plaintext.
      req.log.error(
        { err, instrumentId: id, code: existing.code },
        'INSTRUMENT_TOKEN_DECRYPT_FAILED — wrong INSTRUMENT_TOKEN_KEY or tampered ciphertext',
      );
      return reply.code(500).send({
        error: 'TOKEN_DECRYPT_FAILED',
        message: 'The stored token could not be decrypted. The encryption key may have changed. Regenerate the token to issue a readable one.',
      });
    }

    // Inside a transaction, and written BEFORE the value is returned: a view
    // that could not be recorded must not happen at all (§11.10(e)). No row
    // lock is taken anywhere in this handler, so the lock-order rule at the top
    // of this file is not in play.
    const ctx = buildContext(req);
    await prisma.$transaction(async (tx) => {
      await auditLog({
        action: 'INSTRUMENT_TOKEN_VIEWED', targetType: 'Instrument', targetId: id,
        // The PREFIX only. Putting the token in an audit row would move the
        // secret into an immutable, widely-readable table — the exact opposite
        // of what the encryption is for.
        afterValue: { code: existing.code, tokenPrefix: credential.tokenPrefix },
        signatureMeaning: `Access token for instrument "${codeLabel(existing.code)}" revealed`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });

    return { token, tokenPrefix: credential.tokenPrefix };
  });

  // PUT /api/instruments/:id/token — set an operator-chosen token.
  //
  // For the case regeneration cannot serve: a device whose credential is fixed
  // in its firmware or its installer's config sheet, where the platform has to
  // match the device rather than the other way round.
  //
  // Same ALWAYS-ON re-auth as the reveal, and for a sharper reason: choosing a
  // token's VALUE is issuing a credential whose bytes the caller already knows.
  // Regeneration at least produces a secret the attacker has to read back
  // afterwards; this endpoint lets a borrowed session install one they picked in
  // advance, in one request, and the device keeps working for whoever has it.
  // That is not a setting an installation should be able to leave switched off.
  app.put('/:id/token', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Set a specific instrument access token',
      description: 'Replaces the credential with an operator-supplied token. Requires INSTRUMENT_UPDATE and an ALWAYS-ON password re-auth (`_currentPassword` in the body or the `x-reauth-password` header — not admin-configurable). The previous credential is revoked, so the device stops authenticating until it is reconfigured. The token value is never echoed back — only its prefix. Any length above the 8-character public prefix is accepted (the 32–128 bounds were removed 2026-08-06 so a credential fixed in device firmware can be entered verbatim); characters are restricted to `[A-Za-z0-9._-]` so the value survives an Authorization header, an MQTT username and a JSON line unescaped.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } },
      response: {
        200: { type: 'object', properties: { tokenPrefix: { type: 'string' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauthAlways('SET_INSTRUMENT_TOKEN', req, reply);
    if (!ok) return;

    // NOT run through `sanitizeStrings`: it strips HTML, and a token is an
    // opaque credential that must be stored byte-for-byte as the device will
    // present it. The Zod character class is far stricter than the sanitiser
    // anyway — `[A-Za-z0-9._-]` cannot contain markup.
    const parsed = setInstrumentTokenSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const token = parsed.data.token;

    const { id } = req.params as { id: string };
    const existing = await prisma.instrument.findFirst({ where: await visibleInstrumentWhere(req, id), select: { id: true, code: true } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const hash = hashToken(token);
    const prefix = tokenPrefix(token);
    // Encrypt BEFORE the transaction: a configured-but-broken key must fail the
    // whole request, not leave behind a credential nobody can ever read back.
    // A deployment with no key at all stores null and carries on, exactly as
    // issuance does.
    let encrypted: string | null;
    try {
      encrypted = encryptToken(token);
    } catch (err) {
      req.log.error({ err, instrumentId: id }, 'INSTRUMENT_TOKEN_KEY is configured but unusable');
      return reply.code(503).send({
        error: 'TOKEN_KEY_INVALID',
        message: 'INSTRUMENT_TOKEN_KEY is configured but unusable, so the token cannot be stored encrypted.',
      });
    }

    const ctx = buildContext(req);
    try {
      await prisma.$transaction(async (tx) => {
        // Serialise on the TOKEN, not on the instrument row, so two operators
        // racing to claim the same token cannot both pass the check below.
        // Two-argument form: a separate key space from the audit chain's
        // single-bigint lock, so there is no chance of collision. Taken BEFORE
        // `auditLog`, per the lock-order rule at the top of this file — and it
        // is not a row lock, so it orders against nothing else in this module.
        //
        // The classid MUST fit in int4: the two-argument overload is
        // `(int4, int4)`, and a literal above 2147483647 is typed `bigint` by
        // Postgres, which resolves to no function at all (42883). 20260806 is
        // the date this endpoint landed — arbitrary but stable and traceable.
        // `hashtext` returns int4, so the second argument needs no cast.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(20260806, hashtext(${hash}))`;

        // A token in use by a live credential elsewhere would make
        // authentication AMBIGUOUS: `resolveInstrumentByToken` seeks on the
        // prefix and returns the FIRST hash that matches, so the device that
        // "wins" would depend on row order. Revoked credentials are not
        // considered — they authenticate nothing.
        const clash = await tx.instrumentCredential.findMany({
          where: { tokenPrefix: prefix, revokedAt: null },
          select: { instrumentId: true, tokenHash: true },
        });
        for (const c of clash) {
          if (!tokenMatches(token, c.tokenHash)) continue;
          throw new HandledRouteError(409, {
            error: 'TOKEN_IN_USE',
            message: c.instrumentId === id
              ? 'This instrument is already using that token.'
              : 'That token is already in use by another instrument. Choose a different value.',
          });
        }

        // REVOKE-AND-INSERT, not update-in-place — the same shape as
        // `regenerate-token`, and for the same §11 reason. `instrument_credentials`
        // is the record of WHICH secret was live when a given reading arrived:
        // `createdAt`/`revokedAt` bound the window and `lastUsedAt` says it was
        // used inside it. Updating the hash in place would rewrite that history,
        // making every past reading appear to have been authenticated by a
        // credential that did not exist yet — an immutability breach in a table
        // an inspector reads alongside the telemetry.
        await tx.instrumentCredential.updateMany({
          where: { instrumentId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.instrumentCredential.create({
          data: { instrumentId: id, tokenHash: hash, tokenPrefix: prefix, tokenEncrypted: encrypted },
        });
        await auditLog({
          action: 'INSTRUMENT_TOKEN_SET', targetType: 'Instrument', targetId: id,
          // Prefix only — see the note on INSTRUMENT_TOKEN_VIEWED.
          afterValue: { code: existing.code, tokenPrefix: prefix },
          signatureMeaning: `Access token for instrument "${codeLabel(existing.code)}" replaced with an operator-supplied value; previous token revoked`,
          userId: ctx.userId, userRole: ctx.userRole,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      });
    } catch (err) {
      // Thrown from INSIDE the transaction on purpose: the throw is what rolls
      // the revoke back, so a refused set leaves the live credential untouched.
      if (err instanceof HandledRouteError) return reply.code(err.status).send(err.body);
      throw err;
    }

    // Same reason as regenerate: without this the OLD token keeps authenticating
    // for up to the 10s cache TTL, which would make "the previous token is
    // revoked" untrue for exactly as long as it takes to notice.
    invalidateIngestAuthCache(id);
    await kickMqttClient(existing.code, 'access token replaced');

    return { tokenPrefix: prefix };
  });

  // ---------------------------------------------------------------------------
  // Free-form attributes.
  //
  // A child table, one row per key (see the `InstrumentAttribute` model comment
  // for why this is not a JSONB column). Reading is on INSTRUMENT_READ — an
  // attribute is registry metadata, not a secret — while every write and delete
  // is on INSTRUMENT_UPDATE and audited by key.
  //
  // NO INSTRUMENT ROW LOCK is taken in any of these handlers, so the lock-order
  // rule at the top of this file is not in play. An attribute write cannot
  // violate a gateway invariant: it touches no column any invariant reads.
  // ---------------------------------------------------------------------------

  const attributeProps = {
    key: { type: 'string' },
    value: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  } as const;

  const attributeSelect = { key: true, value: true, createdAt: true, updatedAt: true } as const;
  // `slot` / `decimals` / `display` are computed, not stored. Declared here
  // because Fastify's serializer STRIPS anything absent from the response schema.
  const annotatedAttributeProps = {
    ...attributeProps,
    slot: { type: 'string', nullable: true },
    decimals: { type: 'integer', nullable: true },
    display: { type: 'string', nullable: true },
  } as const;

  /**
   * The mandatory remark, read identically by all three verbs.
   *
   * EXEMPT from HTML stripping — `sanitizeStrings` is called with `['reason']` so
   * the exemption is stated rather than achieved by reading round the sanitiser.
   * `stripHtml` empties anything tag-shaped, and a remark like "value < 20 per
   * SOP" would be silently blanked into a §11 record.
   */
  const readRemark = (req: FastifyRequest): string | null => {
    const body = sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['reason']);
    return typeof body.reason === 'string' ? body.reason : null;
  };

  /**
   * The per-role attribute gate, applied identically by POST, PUT and DELETE.
   *
   * ONE place, because three copies of "may this role touch this key, and did it
   * say why" is three chances for one of them to be forgotten — and the one that
   * is forgotten becomes the way round the control. Returns true when the reply
   * has already been sent.
   */
  const attributeWriteRefused = async (
    req: FastifyRequest, reply: FastifyReply,
    opts: { key: string; isNewKey: boolean; remark?: string | null; value?: string },
  ): Promise<boolean> => {
    // SENSOR OFFSETS (2026-10-01) — SUPER_ADMIN only, and a signed number.
    // Checked FIRST: to any other role the key does not exist (404 on an edit
    // or a delete, the same answer as a key the instrument does not have; 403
    // on an attempt to create one).
    if ((await offsetKeyTest())(opts.key)) {
      if (req.user?.role !== 'SUPER_ADMIN') {
        if (!opts.isNewKey) { reply.code(404).send(noSuchAttribute(opts.key)); return true; }
        reply.code(403).send({ error: 'ATTRIBUTE_RESTRICTED', message: 'Only a super admin can set a sensor offset.' });
        return true;
      }
      if (opts.value !== undefined && parseOffsetValue(opts.value) === null) {
        reply.code(400).send({ error: 'INVALID_OFFSET', message: SENSOR_OFFSET_VALUE_MESSAGE });
        return true;
      }
    }
    const access = await loadAttributeAccess(req.user?.role, req.user?.sub);
    const refusal = refuseAttributeWrite({
      access,
      // `requirePermission('INSTRUMENT_UPDATE')` already ran as a preHandler, so
      // reaching here means the role holds it. Passed explicitly anyway: the
      // shared rule must never be readable as "the mode alone decides".
      hasUpdatePermission: true,
      key: opts.key,
      isNewKey: opts.isNewKey,
      remark: opts.remark,
    });
    if (refusal) { reply.code(refusal.status).send(refusal.body); return true; }

    // AFTER the access and remark checks: no point asking for a password to
    // authorise something that is about to be refused anyway.
    if (needsReauth(access)) {
      const { ok } = await enforceReauthAlways('UPDATE_INSTRUMENT_ATTRIBUTE', req, reply);
      if (!ok) return true;
    }
    return false;
  };

  /** 404 body for an attribute key that is not on this instrument. */
  const noSuchAttribute = (key: string) => ({
    error: 'ATTRIBUTE_NOT_FOUND',
    message: `This instrument has no attribute named "${key}".`,
  });

  /**
   * Sanitise-then-trim a key arriving as a URL segment, so `PUT`/`DELETE`
   * resolve the same stored row that `POST` created. `POST` runs the identical
   * pair (route sanitiser, then the Zod transform) — if these two ever diverge,
   * an attribute becomes creatable but not editable.
   */
  function normaliseKey(raw: string): string {
    return String((sanitizeStrings({ key: raw }) as { key: unknown }).key ?? '').trim();
  }

  /**
   * Serialise concurrent writers of the SAME attribute. Without it, two
   * simultaneous sets of one key both read "absent" and both insert, and the
   * loser gets a P2002 500 instead of an update. Two-argument form — a different
   * key space from the audit chain's single-bigint lock — and the classid MUST
   * fit in int4 (a larger literal is typed `bigint`, for which no overload
   * exists: 42883). 20260807 is arbitrary but stable, and distinct from the
   * token endpoint's 20260806 so the two never queue behind each other.
   */
  async function lockAttribute(tx: Prisma.TransactionClient, instrumentId: string, key: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(20260807, hashtext(${`${instrumentId}:${key}`}))`;
  }

  /**
   * Everything the downlink needs, in the lookup each handler already does.
   * `gatewayId` is what decides the topic — the id, not the code, since
   * 2026-08-07 (see `attributeDownlinkTopic`). `code` is still selected because
   * the audit rows on these handlers name the instrument by it. Read OUTSIDE
   * any transaction, so the lock-order rule at the top of this file stays out
   * of play.
   */
  const attributeOwnerSelect = { code: true, gatewayId: true } as const;

  /**
   * The attribute columns a bulk file for this profile may carry: the
   * profile's own key list, each with its administered display name (the KEY
   * when none is set). Read here rather than in the parser so the parser stays
   * pure and its tests need no database.
   */
  async function bulkAttributeColumns(profileId: string): Promise<AttributeColumn[]> {
    const [profile, labelsRow] = await Promise.all([
      prisma.instrumentProfile.findUnique({ where: { id: profileId }, select: { attributeKeys: true } }),
      prisma.systemConfig.findUnique({ where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY } }),
    ]);
    const labels = coerceAttributeLabels(labelsRow?.configValue);
    const fold = (s: string) => s.trim().toLowerCase();
    return parseInstrumentAttributeKeys(profile?.attributeKeys).map((key) => {
      const hit = Object.keys(labels).find((k) => fold(k) === fold(key));
      return { key, label: hit ? labels[hit] : key };
    });
  }

  /**
   * Parse and PLAN a bulk file (2026-10-28) — the one path `POST /bulk/preview`
   * and `POST /bulk` both take, so what the operator reviewed is what is
   * written. Reads what the pure `planBulkUpload` needs: the profile's columns,
   * every instrument the file names (ignoring case), the caller's view, its
   * Attribute Access and whether it may change instruments at all.
   */
  async function planBulkFile(
    req: FastifyRequest,
    data: { csv: string; profileId: string },
    visibility: ScopeWhere | undefined,
  ) {
    // The file may carry the profile's ATTRIBUTES, headed by their administered
    // display names (2026-09-16). The parser maps a heading back to the KEY;
    // this is the one place the profile's list and the display-name map meet.
    // Sensor-offset columns exist only for a SUPER_ADMIN (2026-10-01): for anyone
    // else they are not columns of this profile, so a heading naming one is an
    // unknown heading — ignored with the parser's one warning, never written.
    const isOffset = await offsetKeyTest();
    const role = req.user?.role;
    const attributeColumns = (await bulkAttributeColumns(data.profileId))
      .filter((c) => role === 'SUPER_ADMIN' || !isOffset(c.key));
    const parsed = parseInstrumentCsv(data.csv, attributeColumns);
    const mayUpdate = role === 'SUPER_ADMIN' || (!!role && await roleHasPermission(role, 'INSTRUMENT_UPDATE'));
    const access = await loadAttributeAccess(role, req.user?.sub);
    const existing = await existingForBulk(parsed.rows.map((r) => r.code), visibility);
    const planned = planBulkUpload({
      rows: parsed.rows, rowNumbers: parsed.rowNumbers, codeHeading: parsed.codeHeading,
      headings: parsed.headings, identityColumns: parsed.identityColumns,
      profileId: data.profileId, existing, isOffset, mayUpdate,
      accessRefusal: (key, isNewKey) => attributeAccessRefusal({ access, hasUpdatePermission: mayUpdate, key, isNewKey }),
    });
    const errors: RowError[] = [...parsed.errors, ...planned.errors].sort((a, b) => a.row - b.row);
    return {
      rows: parsed.rows, codeHeading: parsed.codeHeading, plans: planned.plans as RowPlan[],
      errors, warnings: [...parsed.warnings, ...planned.warnings], access, mayUpdate,
    };
  }

  /**
   * Attribute cells on NEW instruments answer to the role's Attribute Access
   * rule for ADDING a key (audit 2026-10-12) — decided once for the whole file,
   * so a refusal registers nothing rather than a hundred instruments with their
   * attributes dropped. Cells on EXISTING instruments are judged per key by the
   * plan instead, and a refusal there fails only its row.
   */
  function createAttributesRefusal(plan: Awaited<ReturnType<typeof planBulkFile>>) {
    if (!plan.plans.some((p) => p.kind === 'create' && p.attributes)) return null;
    return refuseAttributeWrite({ access: plan.access, hasUpdatePermission: plan.mayUpdate, key: '', isNewKey: true });
  }

  /**
   * Every instrument a bulk file names, keyed by lower-cased code (codes are
   * unique ignoring case). An instrument OUTSIDE the caller's view is returned
   * as `visible: false` with nothing else read: the plan reports it as the
   * collision it always was.
   */
  async function existingForBulk(codes: string[], visibility: ScopeWhere | undefined): Promise<Map<string, ExistingInstrument>> {
    const out = new Map<string, ExistingInstrument>();
    if (codes.length === 0) return out;
    const lowered = [...new Set(codes.map((c) => c.toLowerCase()))];
    const hits = await prisma.$queryRaw<{ id: string; code: string }[]>`
      SELECT id, code FROM instruments WHERE lower(code) = ANY(${lowered}::text[])`;
    if (hits.length === 0) return out;
    const seen = new Set((await prisma.instrument.findMany({
      where: withVisibility({ id: { in: hits.map((h) => h.id) } }, visibility) as Prisma.InstrumentWhereInput,
      select: { id: true },
    })).map((r) => r.id));
    const rows = await prisma.instrument.findMany({
      where: { id: { in: [...seen] } },
      select: {
        id: true, code: true, profileId: true, profile: { select: { name: true } },
        attributes: { select: { key: true, value: true }, orderBy: { key: 'asc' } },
      },
    });
    for (const h of hits) out.set(h.code.toLowerCase(), { id: h.id, code: h.code, profileId: '', profileName: '', visible: false, attributes: [] });
    for (const r of rows) {
      out.set(r.code.toLowerCase(), { id: r.id, code: r.code, profileId: r.profileId, profileName: r.profile.name, visible: true, attributes: r.attributes });
    }
    return out;
  }

  /**
   * Write one existing instrument's planned changes (2026-10-28): ONE
   * transaction, every key locked FIRST and in key order — an attribute lock
   * taken after `auditLog` has taken the audit-chain lock could deadlock with a
   * single attribute write holding that key and waiting for the chain. Each
   * value is read again under its lock; one that already matches is skipped
   * (no write, no audit row), and one recorded since the file was checked is
   * not overwritten without a remark. One INSTRUMENT_ATTRIBUTE_SET per change,
   * exactly as `PUT /:id/attributes/:key` writes it; the device is told after
   * the commit. Returns what was applied, each `from` as read under the lock.
   */
  async function applyBulkChanges(
    instrumentId: string,
    code: string,
    changes: PlannedChange[],
    reason: string | null,
    ctx: ReturnType<typeof buildContext>,
  ): Promise<PlannedChange[]> {
    const ordered = [...changes].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const applied = await prisma.$transaction(async (tx) => {
      for (const c of ordered) await lockAttribute(tx, instrumentId, c.key);
      const done: PlannedChange[] = [];
      for (const c of ordered) {
        const before = await tx.instrumentAttribute.findUnique({
          where: { instrumentId_key: { instrumentId, key: c.key } }, select: { value: true },
        });
        if (before && before.value.trim() === c.to) continue;
        if (before && !reason) {
          throw new HandledRouteError(409, {
            error: 'CHANGED_SINCE_CHECKED',
            message: `"${c.column}" on "${code}" was recorded while the file was being checked. Upload the file again.`,
          });
        }
        await tx.instrumentAttribute.upsert({
          where: { instrumentId_key: { instrumentId, key: c.key } },
          create: { instrumentId, key: c.key, value: c.to },
          update: { value: c.to },
        });
        await auditLog({
          action: 'INSTRUMENT_ATTRIBUTE_SET', targetType: 'Instrument', targetId: instrumentId,
          // No `beforeValue` on a first fill — an absent attribute is not an empty one.
          ...(before ? { beforeValue: { code, attribute: c.key, value: before.value } } : {}),
          afterValue: { code, attribute: c.key, value: c.to },
          ...(before && reason ? { reason } : {}),
          signatureMeaning: before
            ? `Attribute "${c.key}" on instrument "${codeLabel(code)}" changed`
            : `Attribute "${c.key}" set on instrument "${codeLabel(code)}"`,
          userId: ctx.userId, userRole: ctx.userRole,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
        done.push({ ...c, from: before ? before.value : null });
      }
      return done;
    });
    if (applied.length > 0) {
      const owner = await prisma.instrument.findUnique({ where: { id: instrumentId }, select: attributeOwnerSelect });
      if (owner) for (const c of applied) await announceAttributeChange(instrumentId, owner, c.key, c.to);
    }
    // In the file's column order, as the preview showed them.
    return changes.flatMap((c) => applied.filter((a) => a.key === c.key));
  }

  /**
   * First-fill of several attributes on a just-created instrument (bulk
   * upload). Mirrors `POST /:id/attributes` for a NEW key: no remark (a first
   * fill is registration, not a change), one INSTRUMENT_ATTRIBUTE_SET audit
   * row per key in the same transaction as its write, the device told after
   * the commit. The Attribute Access gate is not consulted — the caller holds
   * INSTRUMENT_CREATE and is registering, exactly as the create form does.
   */
  async function writeInitialAttributes(
    instrumentId: string,
    code: string,
    attributes: Record<string, string>,
    ctx: ReturnType<typeof buildContext>,
  ): Promise<void> {
    const entries = Object.entries(attributes).filter(([, v]) => v.trim() !== '');
    if (entries.length === 0) return;
    await prisma.$transaction(async (tx) => {
      for (const [key, value] of entries) {
        await lockAttribute(tx, instrumentId, key);
        await tx.instrumentAttribute.upsert({
          where: { instrumentId_key: { instrumentId, key } },
          create: { instrumentId, key, value },
          update: { value },
        });
        await auditLog({
          action: 'INSTRUMENT_ATTRIBUTE_SET', targetType: 'Instrument', targetId: instrumentId,
          afterValue: { code, attribute: key, value },
          signatureMeaning: `Attribute "${key}" set on instrument "${codeLabel(code)}"`,
          userId: ctx.userId, userRole: ctx.userRole,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      }
    });
    const owner = await prisma.instrument.findUnique({ where: { id: instrumentId }, select: attributeOwnerSelect });
    if (!owner) return;
    for (const [key, value] of entries) await announceAttributeChange(instrumentId, owner, key, value);
  }

  /**
   * The broker side of a CODE change (2026-09-16). CALLED AFTER THE COMMIT.
   *
   * The code is the MQTT client id and every topic segment, so after a rename
   * every RETAINED slot keyed on the old code would read as current state to
   * anyone looking at the broker — the failure mode the 2026-09-04 migration
   * script existed to clean up. So: the instrument's own attribute slot is
   * cleared at the old code (an empty retained publish) and the complete set
   * republished at the new one; a gateway's roster moves the same way, and
   * each of its children's slots — which sit UNDER the gateway's code — move
   * with it. The parent roster of a renamed child, and the renamed gateway's
   * own new roster, are published by the caller's existing roster pass.
   *
   * What this cannot do: reconfigure the device. Its client id is the old
   * code until a technician changes it, and the auth hook now refuses that id.
   * Never throws — a broker failure must not turn a committed rename into an
   * error the operator would retry.
   */
  async function afterCodeChange(
    id: string,
    oldCode: string,
    row: { code: string; gatewayId: string | null; isGateway: boolean },
  ): Promise<void> {
    const log = (msg: string, meta?: Record<string, unknown>) => app.log.warn(meta ?? {}, `[downlink:rename] ${msg}`);
    const republish = async (instrument: { id: string; code: string }, gatewayCode: string | null) => {
      const rows = await prisma.instrumentAttribute.findMany({ where: { instrumentId: instrument.id }, select: { key: true, value: true } });
      await publishRetained(
        attributeDownlinkTopic(instrument.code, gatewayCode),
        // Offsets never reach a device (2026-10-01).
        JSON.stringify({ attributes: await withoutOffsets(Object.fromEntries(rows.map((r) => [r.key, r.value]))), changed: {}, ts: new Date().toISOString() }),
        'DOWNLINK NOT DELIVERED — the renamed instrument\'s attribute set was not republished under its new id',
        log,
      );
    };
    const clear = (topic: string) => publishRetained(
      topic, '',
      'STALE SLOT NOT CLEARED — the old id still reads as current on the broker',
      log,
    );
    try {
      invalidateIngestAuthCache(id);
      const gatewayCode = await codeOf(row.gatewayId);
      await clear(attributeDownlinkTopic(oldCode, gatewayCode));
      await republish({ id, code: row.code }, gatewayCode);
      if (row.gatewayId) invalidateChildMapCache(row.gatewayId);
      if (row.isGateway) {
        invalidateChildMapCache(id);
        await clearChildRoster(oldCode, log);
        const kids = await prisma.instrument.findMany({ where: { gatewayId: id }, select: { id: true, code: true } });
        for (const kid of kids) {
          await clear(attributeDownlinkTopic(kid.code, oldCode));
          await republish(kid, row.code);
        }
      }
    } catch (e) {
      log('could not move the broker state for the rename — the device may read stale slots', { id, oldCode, err: (e as Error).message });
    }
  }

  /**
   * Tell the device an attribute moved. CALLED AFTER THE COMMIT, never inside
   * the transaction — a retained message describing an edit that then rolled
   * back would leave the device permanently ahead of the platform.
   *
   * The complete set is re-read HERE rather than taken from inside the
   * transaction. An in-transaction read is internally consistent but blind to a
   * concurrent commit on a DIFFERENT key, so the retained message could
   * reconstruct a set that is missing an attribute — which is precisely what
   * carrying the complete set exists to prevent. Post-commit is the fresher
   * answer.
   *
   * Never throws. A broker failure, or even the re-read failing, must not turn
   * a committed attribute write into an error the operator would retry.
   */
  async function announceAttributeChange(
    instrumentId: string,
    owner: { code: string; gatewayId: string | null },
    changedKey: string,
    changedValue: string | null,
  ): Promise<void> {
    try {
      const rows = await prisma.instrumentAttribute.findMany({
        where: { instrumentId }, select: { key: true, value: true },
      });
      // The slot is keyed on CODES (2026-09-04): the gateway subscribes
      // `instruments/${clientid}/attributes/#` with its code as client id, so
      // a child's slot must sit under the gateway's code, not its id.
      const gateway = owner.gatewayId
        ? await prisma.instrument.findUnique({ where: { id: owner.gatewayId }, select: { code: true } })
        : null;
      await publishAttributeDownlink(
        {
          instrumentId,
          gatewayId: owner.gatewayId,
          code: owner.code,
          gatewayCode: gateway?.code ?? null,
          attributes: Object.fromEntries(rows.map((r) => [r.key, r.value])),
          changedKey,
          changedValue,
          ts: new Date(),
        },
        (msg, meta) => app.log.warn(meta ?? {}, `[downlink:attributes] ${msg}`),
      );
      // And the gateway's CHANGE event (2026-09-05): this child's code and
      // the ONE key that moved, nothing else — not retained.
      if (owner.gatewayId) {
        await announceChildAttributeChange(
          owner.gatewayId,
          { code: owner.code, key: changedKey, value: changedValue },
          (msg, meta) => app.log.warn(meta ?? {}, `[downlink:children-attributes] ${msg}`),
        );
      }
    } catch (e) {
      app.log.warn(
        { err: (e as Error).message, instrumentId, key: changedKey },
        '[downlink:attributes] could not build the downlink message — the device was NOT told about this change',
      );
    }
  }

  // GET /api/instruments/:id/attributes
  app.get('/:id/attributes', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'List an instrument\'s free-form attributes',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'object', properties: annotatedAttributeProps } } },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const exists = await prisma.instrument.findFirst({ where: await visibleInstrumentWhere(req, id), select: { id: true, profileId: true } });
    if (!exists) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    const all = await prisma.instrumentAttribute.findMany({
      where: { instrumentId: id }, select: attributeSelect, orderBy: { key: 'asc' },
    });
    // Sensor offsets are SUPER_ADMIN-only (2026-10-01): absent, not masked.
    const isOffset = await offsetKeyTest();
    const data = req.user?.role === 'SUPER_ADMIN' ? all : all.filter((a) => !isOffset(a.key));

    // A limit or a range is a reading, so it is shown at the same precision as
    // the reading it bounds — resolved here, from this instrument's own decimals
    // attributes and its PROFILE's mapping (2026-10-26), so the attributes panel
    // cannot quote a limit differently from the set-point column or the alarm row
    // that fired against it. `value` is untouched: `display` is presentation,
    // `value` is the record.
    const cfg = (await slotConfigForProfile(exists.profileId)).decimals;
    const dp = decimalsFor(cfg, data);
    return { data: data.map((a) => ({ ...a, ...annotateAttribute(cfg, dp, a) })) };
  });

  // GET /api/instruments/attribute-access/me — what THIS caller may do.
  //
  // The panel needs the rule to render the right affordances, and it must not
  // re-derive it: a second implementation eventually offers an Edit button the
  // server refuses, which reads as the app being broken rather than as a policy.
  // Registered before '/:id' for the same reason '/telemetry-overview' is.
  app.get('/attribute-access/me', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: "The caller's own instrument-attribute access",
      response: {
        200: {
          type: 'object',
          properties: {
            mode: { type: 'string', nullable: true },
            keys: { type: 'array', items: { type: 'string' } },
            requireReauth: { type: 'boolean' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const access = await loadAttributeAccess(req.user?.role, req.user?.sub);
    // Only the RULE is returned, not pre-computed verdicts. The panel rebuilds
    // the access object and calls the same shared functions the gate calls, so
    // there is one implementation of "may I" rather than a server opinion and a
    // client opinion that can disagree.
    return {
      mode: access?.mode ?? null,
      keys: access?.keys ?? [],
      requireReauth: needsReauth(access),
    };
  });

  // POST /api/instruments/:id/attributes — set (create OR update) one attribute
  app.post('/:id/attributes', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Set one free-form attribute',
      description: 'Idempotent on the key: setting an existing key updates it (200) rather than adding a second row (201 on first create). The key is trimmed, so " Room " and "Room" are the same attribute.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', required: ['key', 'value'],
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          // Mandatory when this OVERWRITES a recorded value; ignored on a first
          // fill. Bounded here as well as in the shared validator because
          // `signature_meaning` is VARCHAR(255) and `auditLog` does not truncate:
          // an over-long remark would write the attribute and THEN throw.
          reason: { type: 'string', maxLength: ATTRIBUTE_REMARK_MAX },
          _currentPassword: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object', properties: attributeProps },
        201: { type: 'object', properties: attributeProps },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = setInstrumentAttributeSchema.safeParse(
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const { key } = parsed.data;
    let value = parsed.data.value;
    // EXEMPT from HTML stripping, like every other free-text reason in this
    // codebase (see the alarms acknowledge route). `stripHtml` turns anything
    // tag-shaped into the empty string, so a remark reading "value < 20 per SOP"
    // would be silently blanked — and a §11 record whose reason vanished is worse
    // than one that never had a field. All three verbs read it the same way.
    const reason = readRemark(req);

    const existing = await prisma.instrument.findFirst({ where: await visibleInstrumentWhere(req, id), select: attributeOwnerSelect });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });

    // Whether this is a change or a first fill decides BOTH the access rule and
    // whether a remark is demanded, so it is read before the gate. Read again
    // inside the transaction under the row lock, which is the read that decides
    // create-vs-update; this one only classifies the request.
    const already = await prisma.instrumentAttribute.findUnique({
      where: { instrumentId_key: { instrumentId: id, key } },
      select: { key: true },
    });
    if (await attributeWriteRefused(req, reply, { key, isNewKey: !already, remark: reason, value })) return;
    // A sensor offset is stored with its sign always written (`2` → `+2`), so
    // the + / - the super admin chose reads back as chosen (2026-10-01).
    if ((await offsetKeyTest())(key)) value = formatOffsetValue(parseOffsetValue(value)!);

    const ctx = buildContext(req);
    const { row, created } = await prisma.$transaction(async (tx) => {
      await lockAttribute(tx, id, key);

      // Read inside the lock: this is what decides create-vs-update, and it is
      // also the audit row's `beforeValue`.
      const before = await tx.instrumentAttribute.findUnique({
        where: { instrumentId_key: { instrumentId: id, key } },
        select: attributeSelect,
      });
      const saved = await tx.instrumentAttribute.upsert({
        where: { instrumentId_key: { instrumentId: id, key } },
        create: { instrumentId: id, key, value },
        update: { value },
        select: attributeSelect,
      });

      // In the SAME transaction (§11.10(e)): a rollback must take the audit row
      // with it, and an attribute may be a calibration date rather than a note.
      await auditLog({
        action: 'INSTRUMENT_ATTRIBUTE_SET', targetType: 'Instrument', targetId: id,
        // No `beforeValue` at all on a create — an absent attribute is not an
        // empty one, and inventing `value: ''` would misreport the history.
        ...(before ? { beforeValue: { code: existing.code, attribute: key, value: before.value } } : {}),
        afterValue: { code: existing.code, attribute: key, value },
        // Only a CHANGE carries one — a first fill is not asked for a reason, and
        // writing an empty one would claim the operator gave a blank answer.
        ...(before && reason ? { reason } : {}),
        signatureMeaning: before
          ? `Attribute "${key}" on instrument "${existing.code}" changed`
          : `Attribute "${key}" set on instrument "${existing.code}"`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);

      return { row: saved, created: !before };
    });

    // Committed. Now, and only now, tell the device.
    await announceAttributeChange(id, existing, key, value);

    return reply.code(created ? 201 : 200).send(row);
  });

  // PUT /api/instruments/:id/attributes/:key — edit an EXISTING attribute
  app.put('/:id/attributes/:key', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Update an existing attribute\'s value',
      description: 'Does NOT create: POST is the upsert. A mistyped key here returns 404 rather than quietly adding a second attribute nobody asked for.',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, key: { type: 'string' } },
      },
      body: {
        type: 'object', required: ['value', 'reason'],
        properties: {
          value: { type: 'string' },
          // Required: this endpoint only ever CHANGES a recorded value.
          reason: { type: 'string', maxLength: ATTRIBUTE_REMARK_MAX },
          _currentPassword: { type: 'string' },
        },
      },
      response: { 200: { type: 'object', properties: attributeProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id, key: rawKey } = req.params as { id: string; key: string };
    const parsed = updateInstrumentAttributeSchema.safeParse(
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    let value = parsed.data.value;
    const key = normaliseKey(rawKey);
    const reason = readRemark(req);

    const existing = await prisma.instrument.findFirst({ where: await visibleInstrumentWhere(req, id), select: attributeOwnerSelect });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });
    if (!key) return reply.code(404).send(noSuchAttribute(rawKey));

    if (await attributeWriteRefused(req, reply, { key, isNewKey: false, remark: reason, value })) return;
    if ((await offsetKeyTest())(key)) value = formatOffsetValue(parseOffsetValue(value)!);

    const ctx = buildContext(req);
    try {
      const saved = await prisma.$transaction(async (tx) => {
        await lockAttribute(tx, id, key);

        const before = await tx.instrumentAttribute.findUnique({
          where: { instrumentId_key: { instrumentId: id, key } },
          select: attributeSelect,
        });
        // Thrown, not returned: the throw is what rolls the transaction back —
        // there is nothing to undo yet here, but keeping the shape means a
        // future statement added above cannot silently survive a 404.
        if (!before) throw new HandledRouteError(404, noSuchAttribute(key));

        const saved = await tx.instrumentAttribute.update({
          where: { instrumentId_key: { instrumentId: id, key } },
          data: { value },
          select: attributeSelect,
        });
        // Same action as POST: an edit and a re-set are the same event, and a
        // trail that distinguished them by which button was pressed would make
        // "every change to this attribute" a two-query question.
        await auditLog({
          action: 'INSTRUMENT_ATTRIBUTE_SET', targetType: 'Instrument', targetId: id,
          beforeValue: { code: existing.code, attribute: key, value: before.value },
          afterValue: { code: existing.code, attribute: key, value },
          reason: reason ?? undefined,
          signatureMeaning: `Attribute "${key}" on instrument "${codeLabel(existing.code)}" changed`,
          userId: ctx.userId, userRole: ctx.userRole,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
        return saved;
      });

      // Committed. Now, and only now, tell the device. A 404 above throws past
      // this line, so a refused edit never reaches a broker.
      await announceAttributeChange(id, existing, key, value);
      return saved;
    } catch (err) {
      if (err instanceof HandledRouteError) return reply.code(err.status).send(err.body);
      throw err;
    }
  });

  // DELETE /api/instruments/:id/attributes/:key
  app.delete('/:id/attributes/:key', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Remove an attribute',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, key: { type: 'string' } },
      },
      // A body on DELETE. Not a query string: the remark is free text an operator
      // types, and a query string ends up in access logs and browser history.
      body: {
        type: 'object', required: ['reason'],
        properties: {
          reason: { type: 'string', maxLength: ATTRIBUTE_REMARK_MAX },
          _currentPassword: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id, key: rawKey } = req.params as { id: string; key: string };
    const key = normaliseKey(rawKey);
    const reason = readRemark(req);

    const existing = await prisma.instrument.findFirst({ where: await visibleInstrumentWhere(req, id), select: attributeOwnerSelect });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });
    if (!key) return reply.code(404).send(noSuchAttribute(rawKey));

    // Removing a recorded value is a change like any other — the strongest one —
    // so it takes the same gate and the same mandatory remark.
    if (await attributeWriteRefused(req, reply, { key, isNewKey: false, remark: reason })) return;

    const ctx = buildContext(req);
    try {
      await prisma.$transaction(async (tx) => {
        await lockAttribute(tx, id, key);

        const before = await tx.instrumentAttribute.findUnique({
          where: { instrumentId_key: { instrumentId: id, key } },
          select: attributeSelect,
        });
        if (!before) throw new HandledRouteError(404, noSuchAttribute(key));

        await tx.instrumentAttribute.delete({
          where: { instrumentId_key: { instrumentId: id, key } },
        });
        // The removed VALUE is in `beforeValue`: once the row is gone this audit
        // record is the only place it survives, and "what did the calibration
        // date say before someone deleted it?" is exactly the §11 question.
        await auditLog({
          action: 'INSTRUMENT_ATTRIBUTE_REMOVED', targetType: 'Instrument', targetId: id,
          beforeValue: { code: existing.code, attribute: key, value: before.value },
          reason: reason ?? undefined,
          signatureMeaning: `Attribute "${key}" removed from instrument "${codeLabel(existing.code)}"`,
          userId: ctx.userId, userRole: ctx.userRole,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      });
    } catch (err) {
      if (err instanceof HandledRouteError) return reply.code(err.status).send(err.body);
      throw err;
    }

    // Committed. `null` in `changed` is what tells the device the attribute was
    // REMOVED rather than merely omitted — the re-read inside will no longer
    // contain the key, and both facts travel in the same message.
    await announceAttributeChange(id, existing, key, null);

    return { success: true };
  });
}
