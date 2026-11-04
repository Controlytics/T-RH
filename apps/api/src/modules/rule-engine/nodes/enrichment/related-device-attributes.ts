import type { RuleContext } from '../../context.js';
import type { RuleMessage } from '../../message.js';
import { instrumentIdOf, isPlainObject } from '../action/support.js';
import { fetchAttributes, type AttributeFetchConfig } from './fetch.js';

/**
 * RELATED DEVICE ATTRIBUTES — ThingsBoard's `TbGetDeviceAttrNode` (rule
 * chains, Task 5), narrowed to the ONE relation this system has: the gateway
 * link. `deviceRelationsQuery.direction` keeps ThingsBoard's meaning, the same
 * one Check relation presence reads:
 *  - `TO` the originator — the GATEWAY the originator instrument is on;
 *  - `FROM` the originator (a gateway) — the first instrument on it, by code
 *    (ThingsBoard also takes the first related device it finds).
 * `relationType`, `maxLevel` and `deviceTypes` are kept for export and not
 * applied: the gateway link answers every type, is one level, and profile
 * names are not ThingsBoard device types (its default `['default']` would match
 * nothing here). Then the related instrument's attributes and latest readings,
 * exactly as Originator attributes fetches them. No related instrument →
 * `Failure` with ThingsBoard's wording.
 */
export const RELATED_DEVICE_ATTRIBUTES_TYPE = 'tb:enrichment:related-device-attributes';

type RelatedConfig = AttributeFetchConfig & { deviceRelationsQuery?: unknown };

export const NO_RELATED_DEVICE = 'Failed to find related device to message originator using relation query specified in the configuration!';

export async function relatedDeviceAttributes(ctx: RuleContext<RelatedConfig>, msg: RuleMessage): Promise<void> {
  const originatorId = instrumentIdOf(msg, 'Related device attributes');
  const query = isPlainObject(ctx.config.deviceRelationsQuery) ? ctx.config.deviceRelationsQuery : {};
  const direction = query.direction === 'TO' ? 'TO' : 'FROM';
  let relatedId: string | null = null;
  if (direction === 'TO') {
    relatedId = (await ctx.services.instruments.gatewayOf(originatorId))?.id ?? null;
  } else {
    const child = await ctx.services.prisma.instrument.findFirst({
      where: { gatewayId: originatorId }, orderBy: { code: 'asc' }, select: { id: true },
    });
    relatedId = child?.id ?? null;
  }
  if (!relatedId) throw new Error(NO_RELATED_DEVICE);
  ctx.tellNext(await fetchAttributes(ctx, msg, relatedId, 'Related device attributes'), 'Success');
}
