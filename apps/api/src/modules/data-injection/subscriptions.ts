/**
 * Derives what to subscribe to, and the base topic each instrument publishes
 * under.
 *
 * P1 derives an instrument's topic as
 *   prefix / <INSTRUMENT's hierarchy ancestry> / [gateway] / instrument / category
 * (`instruments/routes.ts` passes `getAncestryPath(inst.hierarchyNodeId)`).
 *
 * The ancestry is the INSTRUMENT's, not the gateway's. So one gateway whose
 * instruments sit in three hierarchy nodes publishes under THREE different base
 * topics, and a single `<gateway>/#` filter would miss two of them. Subscriptions
 * are therefore per distinct base topic, not per gateway.
 *
 * A base topic identifies exactly one gateway: it ends in the gateway slug and
 * is prefixed by an ancestry that pins the hierarchy node, and gateway slugs are
 * unique within a node.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { configRepository } from '../config/config.repository.js';
import type { UnsSettings } from '../instruments/topic-resolver.js';
import type { ResolverRow } from './telemetry.repository.js';

/** Must match uns-settings.def.ts's declared defaults, as instruments/routes.ts does. */
const DEFAULT_UNS: UnsSettings = { prefix: '', separator: '/', includeGateway: true };

/**
 * Deliberately identical to `unsSettings()` in instruments/routes.ts, including
 * the type-matched overlay. If the two ever diverge, ingestion would subscribe to
 * topics the UI does not display — the same value must produce the same topic on
 * both sides.
 */
export async function unsSettings(): Promise<UnsSettings> {
  const stored = await configRepository.getSystemConfig('uns-settings');
  const value = (stored?.configValue as Partial<UnsSettings> | null) ?? {};
  const merged = { ...DEFAULT_UNS };
  for (const key of Object.keys(DEFAULT_UNS) as (keyof UnsSettings)[]) {
    if (typeof value[key] === typeof DEFAULT_UNS[key]) {
      (merged as Record<string, unknown>)[key] = value[key];
    }
  }
  return merged;
}

/**
 * `prefix / ancestry… / [gateway]` — everything an instrument's topic contains
 * BEFORE its own slug. Mirrors resolveTopics' segment assembly exactly: empty
 * segments are dropped, so a blank prefix or a null gateway simply vanishes.
 */
export function buildBaseTopic(
  settings: UnsSettings, ancestry: string[], gatewaySlug: string | null,
): string {
  return [
    settings.prefix,
    ...ancestry,
    settings.includeGateway ? gatewaySlug : null,
  ]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(settings.separator);
}

/** Root→leaf slugs for MANY nodes in one query. getAncestryPath does one node. */
export async function ancestryForNodes(nodeIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (nodeIds.length === 0) return out;
  const rows = await prisma.$queryRaw<{ nodeId: string; slug: string }[]>`
    SELECT n.id AS "nodeId", a.slug
    FROM hierarchy_nodes n
    JOIN hierarchy_nodes a ON a.path @> n.path
    WHERE n.id IN (${Prisma.join(nodeIds)})
    ORDER BY n.id, nlevel(a.path)`;
  for (const r of rows) {
    const list = out.get(r.nodeId) ?? [];
    list.push(r.slug);
    out.set(r.nodeId, list);
  }
  return out;
}

export interface DerivedSubscription {
  gatewayId: string;
  gatewaySlug: string;
  baseTopic: string;
}

/**
 * Every distinct base topic for one communication profile: the bases its
 * instruments publish under (topic-addressed) plus each gateway's own base
 * (payload-addressed batches, which carry no instrument segment).
 */
export async function buildSubscriptions(profileId: string): Promise<DerivedSubscription[]> {
  const settings = await unsSettings();

  const gateways = await prisma.gateway.findMany({
    where: { isActive: true, communicationProfileId: profileId },
    select: {
      id: true, slug: true, hierarchyNodeId: true,
      instruments: {
        where: { isActive: true },
        select: { hierarchyNodeId: true },
      },
    },
  });
  if (gateways.length === 0) return [];

  const nodeIds = [...new Set(gateways.flatMap(
    g => [g.hierarchyNodeId, ...g.instruments.map(i => i.hierarchyNodeId)],
  ))];
  const ancestry = await ancestryForNodes(nodeIds);

  // Keyed by baseTopic so duplicates collapse — an instrument in the gateway's
  // own node produces the same base as the gateway itself.
  const byBase = new Map<string, DerivedSubscription>();
  for (const g of gateways) {
    const nodes = [g.hierarchyNodeId, ...g.instruments.map(i => i.hierarchyNodeId)];
    for (const nodeId of nodes) {
      const base = buildBaseTopic(settings, ancestry.get(nodeId) ?? [], g.slug);
      if (base.length === 0) continue;
      byBase.set(base, { gatewayId: g.id, gatewaySlug: g.slug, baseTopic: base });
    }
  }
  return [...byBase.values()];
}

/** Every active instrument with the base topic it publishes under. */
export async function instrumentBaseTopics(): Promise<ResolverRow[]> {
  const settings = await unsSettings();
  const instruments = await prisma.instrument.findMany({
    where: { isActive: true },
    select: {
      id: true, slug: true, deviceKey: true, gatewayId: true,
      hierarchyNodeId: true, gateway: { select: { slug: true } },
    },
  });
  if (instruments.length === 0) return [];

  const ancestry = await ancestryForNodes([...new Set(instruments.map(i => i.hierarchyNodeId))]);

  return instruments.map(i => ({
    id: i.id,
    slug: i.slug,
    deviceKey: i.deviceKey,
    gatewayId: i.gatewayId,
    baseTopic: buildBaseTopic(settings, ancestry.get(i.hierarchyNodeId) ?? [], i.gateway?.slug ?? null),
  }));
}
