import type { RuleContext } from '../../context.js';
import type { RuleMessage } from '../../message.js';
import { instrumentIdOf } from '../action/support.js';
import { fetchAttributes, type AttributeFetchConfig } from './fetch.js';

/**
 * ORIGINATOR ATTRIBUTES — ThingsBoard's `TbGetAttributesNode` (rule chains,
 * Task 5): the originator instrument's attributes (client / shared / server —
 * one table here) and latest readings, into the metadata or the data. See
 * `fetchAttributes` for the prefixes and the absent-key rule. `Failure` for an
 * originator that is not an instrument.
 */
export const ORIGINATOR_ATTRIBUTES_TYPE = 'tb:enrichment:originator-attributes';

export async function originatorAttributes(ctx: RuleContext<AttributeFetchConfig>, msg: RuleMessage): Promise<void> {
  const instrumentId = instrumentIdOf(msg, 'Originator attributes');
  ctx.tellNext(await fetchAttributes(ctx, msg, instrumentId, 'Originator attributes'), 'Success');
}
