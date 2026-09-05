import { publishRetained, EVENT_PUBLISH_OPTIONS, type PublishLogger } from './attribute-downlink.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

/**
 * The CHILD ATTRIBUTE CHANGE — the gateway's one attribute topic to subscribe
 * to (operator, 2026-09-05, three times in one day: *"one message for all
 * children with full set"*; then, on seeing the retained dump arrive on
 * subscribe, *"when ever any instrument attribute value was changed send at
 * that time only"*; then, on seeing the changed child's whole set arrive,
 * *"only changed key should sent"*). So:
 *
 *   instruments/<gatewayCode>/children/attributes
 *
 * is an EVENT carrying exactly the change: the child's code under `devN` and
 * the ONE key that moved, in the telemetry batch's shape —
 *
 *   {"gateway":"IOTGW01","devices":[{"devN":"CWH/RDU/002-01","Location":"LCMS Room-II"}]}
 *
 * A removed key carries `null`. Published only when a child's attribute
 * changes (in the app, or from a device report), QoS 1, NOT retained, so a
 * subscriber is handed nothing until something moves. Membership changes
 * publish nothing here; the roster (`…/children`) carries membership,
 * retained. The per-child slots (`…/attributes/<child>`) stay RETAINED and
 * carry the COMPLETE set — the recovery path for a device that wants state on
 * connect. Under `/children/` because `instruments/<gw>/attributes` is the
 * gateway's OWN slot. Failures are logged and swallowed like every downlink.
 */

export function childAttributesBundleTopic(gatewayCode: string): string {
  return `instruments/${gatewayCode}/children/attributes`;
}

export interface BundleChange {
  code: string;
  key: string;
  /** `null` = the attribute was REMOVED. */
  value: string | null;
}

/** The identity key in every block — the SAME key the telemetry batch uses. */
export const BUNDLE_ID_KEY = 'devN';

export interface ChildAttributeChangePayload {
  gateway: string;
  /** One block: `devN`, then the one key that changed. */
  devices: [Record<string, string | null>];
}

/** Pure. Exactly the change, nothing else — no timestamp (operator,
 *  2026-09-05: "remove the time stamp"; the audit row carries when). A key
 *  literally named `devN` cannot be carried in this form; none exists and
 *  registration is where one would have to be refused. */
export function buildChildAttributeChange(
  gatewayCode: string,
  change: BundleChange,
): ChildAttributeChangePayload {
  const block: Record<string, string | null> = { [BUNDLE_ID_KEY]: change.code };
  if (change.key !== BUNDLE_ID_KEY) block[change.key] = change.value;
  return { gateway: gatewayCode, devices: [block] };
}

const changeLog: PublishLogger = (msg, meta) => logger.warn(`[downlink:children-attributes] ${msg}`, meta ?? '');

export async function publishChildAttributeChange(
  gatewayCode: string,
  change: BundleChange,
  log?: PublishLogger,
): Promise<void> {
  await publishRetained(
    childAttributesBundleTopic(gatewayCode),
    JSON.stringify(buildChildAttributeChange(gatewayCode, change)),
    'CHANGE NOT DELIVERED — the gateway was not told about this attribute change',
    log ?? changeLog,
    EVENT_PUBLISH_OPTIONS,
  );
}

/**
 * Publish one child's change on its gateway's topic. Never throws. Only the
 * gateway's code is read — the change already holds everything the message
 * carries. A child with no gateway publishes nothing here (it has its own
 * retained slot).
 */
export async function announceChildAttributeChange(
  gatewayId: string,
  change: BundleChange,
  log?: PublishLogger,
): Promise<void> {
  try {
    const gw = await prisma.instrument.findUnique({ where: { id: gatewayId }, select: { isGateway: true, code: true } });
    if (!gw?.isGateway) return;
    await publishChildAttributeChange(gw.code, change, log);
  } catch (e) {
    (log ?? changeLog)('change NOT DELIVERED — could not read the gateway', { gatewayId, err: (e as Error).message });
  }
}
