import { publishRetained, type PublishLogger } from './attribute-downlink.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

/**
 * The CHILD ATTRIBUTES BUNDLE — every child's complete attribute set in ONE
 * retained message on the gateway (operator, 2026-09-05: *"one message for all
 * children with full set, go"*).
 *
 * The per-child slots (`instruments/<gw>/attributes/<child>`) STAY. This is a
 * third slot beside them and the roster, not a replacement: a device that reads
 * the per-child slots keeps working, and the recovery property those slots
 * exist for — MQTT retains only the LAST message per topic, so one shared slot
 * would hand a reconnecting gateway only whichever child changed last — is
 * carried here by the bundle being the WHOLE set every time.
 *
 *   instruments/<gatewayCode>/children/attributes
 *
 * A sibling of the roster, under `/children/`, for the reason the roster is a
 * sibling of `/attributes/`: `instruments/<gw>/attributes` is the GATEWAY'S OWN
 * attribute slot (a gateway is a standalone instrument on that path), so the
 * bundle cannot live there. The last segment is `attributes`, which the bridge
 * already drops by suffix as its own downlink, and which no instrument code may
 * end in (`instrumentCodeTopicViolation`), so it collides with nothing.
 *
 * Republished on every attribute change of any child AND on every membership
 * change — a newly linked child's set must appear and an unlinked child's must
 * go — and CLEARED (zero-byte retained) with the roster when a gateway is
 * deleted or demoted. Failures are logged and swallowed like every downlink:
 * the database is the truth, the broker is one way of telling the device.
 */

export function childAttributesBundleTopic(gatewayCode: string): string {
  return `instruments/${gatewayCode}/children/attributes`;
}

export interface BundleChild {
  code: string;
  isActive: boolean;
  attributes: Record<string, string>;
}

/** What just moved, for a device that is already connected. Null on a
 *  membership-driven republish, where no single attribute changed. */
export interface BundleChange {
  code: string;
  key: string;
  /** `null` = the attribute was REMOVED. */
  value: string | null;
}

/** The identity key in every block — the SAME key the telemetry batch uses
 *  (operator, 2026-09-05: "can u do same for attributes also"). */
export const BUNDLE_ID_KEY = 'devN';

/**
 * One block per child: `devN` first, then the child's attributes as plain
 * keys — the telemetry batch's shape, mirrored. An attribute literally named
 * `devN` cannot exist on the wire in this form; none does here, and the
 * registration form is where that would have to be refused if one ever tried.
 */
export type BundleBlock = { [BUNDLE_ID_KEY]: string } & Record<string, string>;

export interface ChildAttributesBundlePayload {
  gateway: string;
  /** Every child, sorted by code, each block carrying its COMPLETE set. */
  devices: BundleBlock[];
  /** `{devN, key, value}` — the change that prompted this publish, or null. */
  changed: { devN: string; key: string; value: string | null } | null;
  ts: string;
}

/**
 * Pure. Children sorted by code and attribute keys sorted, so an unchanged
 * state serialises byte-identically and a device diffing two messages sees a
 * difference only when one exists. A removed attribute is ABSENT from its
 * child's block and named in `changed` with `null` — the same two halves the
 * per-child payload carries, for the same reason.
 *
 * Every child is listed, active or not — the ROSTER is where a child's active
 * flag lives, and a block is its attributes alone, exactly as a telemetry block
 * is its readings alone.
 */
export function buildChildAttributesBundle(
  gatewayCode: string,
  children: readonly BundleChild[],
  changed: BundleChange | null,
  ts: Date,
): ChildAttributesBundlePayload {
  const sorted = [...children].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const devices = sorted.map((c) => {
    const block: Record<string, string> = { [BUNDLE_ID_KEY]: c.code };
    for (const k of Object.keys(c.attributes).sort()) if (k !== BUNDLE_ID_KEY) block[k] = c.attributes[k];
    return block as BundleBlock;
  });
  return {
    gateway: gatewayCode,
    devices,
    changed: changed ? { devN: changed.code, key: changed.key, value: changed.value } : null,
    ts: ts.toISOString(),
  };
}

const bundleLog: PublishLogger = (msg, meta) => logger.warn(`[downlink:children-attributes] ${msg}`, meta ?? '');

export async function publishChildAttributesBundle(
  gatewayCode: string,
  children: readonly BundleChild[],
  changed: BundleChange | null,
  ts: Date,
  log?: PublishLogger,
): Promise<void> {
  await publishRetained(
    childAttributesBundleTopic(gatewayCode),
    JSON.stringify(buildChildAttributesBundle(gatewayCode, children, changed, ts)),
    'BUNDLE NOT DELIVERED — the gateway was not handed its children\'s attributes',
    log ?? bundleLog,
  );
}

export async function clearChildAttributesBundle(gatewayCode: string, log?: PublishLogger): Promise<void> {
  await publishRetained(
    childAttributesBundleTopic(gatewayCode),
    '',
    'BUNDLE NOT CLEARED — the broker still holds children\'s attributes for a deleted gateway',
    log ?? bundleLog,
  );
}

/** Every child of the gateway with its complete attribute set, from the database. */
export async function loadBundleChildren(gatewayId: string): Promise<BundleChild[]> {
  const rows = await prisma.instrument.findMany({
    where: { gatewayId },
    select: { code: true, isActive: true, attributes: { select: { key: true, value: true } } },
  });
  return rows.map((r) => ({
    code: r.code,
    isActive: r.isActive,
    attributes: Object.fromEntries(r.attributes.map((a) => [a.key, a.value])),
  }));
}

/**
 * Read the gateway's whole membership and publish the bundle. Never throws —
 * a broker or database failure must not fail the operator's committed edit.
 * Reads AFTER the commit, like `announceAttributeChange`, so a concurrent edit
 * on another child cannot be missing from a message that claims to be complete.
 */
export async function announceChildAttributesBundle(
  gatewayId: string,
  changed: BundleChange | null,
  log?: PublishLogger,
): Promise<void> {
  try {
    const gw = await prisma.instrument.findUnique({ where: { id: gatewayId }, select: { isGateway: true, code: true } });
    if (!gw?.isGateway) return;
    await publishChildAttributesBundle(gw.code, await loadBundleChildren(gatewayId), changed, new Date(), log);
  } catch (e) {
    (log ?? bundleLog)('bundle NOT DELIVERED — could not read the children\'s attributes', {
      gatewayId, err: (e as Error).message,
    });
  }
}
