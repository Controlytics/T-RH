import { RULE_ORIGINATOR_FIELDS } from '@digilog/shared';
import type { RuleContext } from '../../context.js';
import type { RuleMessage } from '../../message.js';
import { instrumentIdOf, isPlainObject, processPattern, type JsonObject } from '../action/support.js';
import { fetchToOf, withFetched } from './fetch.js';

/**
 * ORIGINATOR FIELDS — ThingsBoard's `TbGetOriginatorFieldsNode` (rule chains,
 * Task 5): `dataMapping` field → key, the fields read off the originator
 * INSTRUMENT (`services.instruments.fields`: id, name, code, label, type,
 * profileName, functionalLocation, isGateway, createdTime, additionalInfo).
 * The target key may be a pattern. With `ignoreNullStrings` an empty field is
 * left out. `Failure` for a field name outside that list (an imported typo is
 * named, not silently skipped), an originator that is not an instrument, or an
 * instrument that no longer exists.
 *
 * A ThingsBoard export from before 3.6 names the mapping `fieldsMapping`: the
 * import applies ThingsBoard's own v0 upgrade (`fieldsMapping` → `dataMapping`,
 * ruling CV-3, `@digilog/shared` `upgradeThingsboardConfig`), and the strict
 * document parse requires `dataMapping` — so no stored config reaches this
 * handler without it, and there is no fallback here (TB-P 5).
 */
export const ORIGINATOR_FIELDS_TYPE = 'tb:enrichment:originator-fields';

interface OriginatorFieldsConfig extends JsonObject {
  dataMapping: Record<string, string>;
  ignoreNullStrings?: boolean;
  fetchTo?: 'DATA' | 'METADATA';
}

export async function originatorFields(ctx: RuleContext<OriginatorFieldsConfig>, msg: RuleMessage): Promise<void> {
  const cfg = ctx.config;
  const instrumentId = instrumentIdOf(msg, 'Originator fields');
  const mapping = isPlainObject(cfg.dataMapping) ? cfg.dataMapping : {};
  const unknown = Object.keys(mapping).filter((f) => !(RULE_ORIGINATOR_FIELDS as readonly string[]).includes(f));
  if (unknown.length > 0) {
    throw new Error(`ORIGINATOR_FIELD_UNKNOWN: ${unknown.map((f) => `"${f}"`).join(', ')} is not a field here (fields: ${RULE_ORIGINATOR_FIELDS.join(', ')})`);
  }
  const fields = await ctx.services.instruments.fields(instrumentId);
  if (!fields) throw new Error(`INSTRUMENT_NOT_FOUND: instrument ${instrumentId} does not exist`);
  const entries: [string, string][] = [];
  for (const [field, target] of Object.entries(mapping)) {
    const key = processPattern(String(target), msg).trim();
    const value = fields[field] ?? '';
    if (!key || (cfg.ignoreNullStrings === true && value === '')) continue;
    entries.push([key, value]);
  }
  ctx.tellNext(withFetched(msg, fetchToOf(cfg.fetchTo, 'METADATA'), entries, 'Originator fields'), 'Success');
}
