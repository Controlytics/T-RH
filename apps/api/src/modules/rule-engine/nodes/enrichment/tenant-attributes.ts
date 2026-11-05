import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleContext } from '../../context.js';
import type { RuleMessage } from '../../message.js';
import { isPlainObject, processPattern, type JsonObject } from '../action/support.js';
import { fetchToOf, withFetched } from './fetch.js';

/**
 * TENANT ATTRIBUTES, read here as APPLICATION ATTRIBUTES — ThingsBoard's
 * `TbGetTenantAttributeNode` (rule chains, Task 5). This system has one tenant,
 * the application; its "attributes" are the key / value list under
 * Configuration → Application Attributes (`services.appAttributes()`, cached
 * 10 s). `dataMapping` source → target, both may be patterns; a source the
 * list does not hold is left out. ThingsBoard can also fetch the tenant's
 * latest telemetry or entity fields (`dataToFetch`): the application has
 * neither, so anything but ATTRIBUTES fails, naming why.
 */
export const TENANT_ATTRIBUTES_TYPE = 'tb:enrichment:tenant-attributes';

interface TenantAttributesConfig extends JsonObject {
  dataMapping: Record<string, string>;
  dataToFetch?: 'ATTRIBUTES' | 'LATEST_TELEMETRY' | 'FIELDS';
  fetchTo?: 'DATA' | 'METADATA';
}

export async function tenantAttributes(ctx: RuleContext<TenantAttributesConfig>, msg: RuleMessage): Promise<void> {
  const cfg = ctx.config;
  const what = cfg.dataToFetch ?? 'ATTRIBUTES';
  if (what !== 'ATTRIBUTES') {
    throw new Error(`TENANT_DATA_UNSUPPORTED: the application has attributes only (Configuration → Application Attributes); "${what}" cannot be fetched here`);
  }
  const attributes = await ctx.services.appAttributes();
  const entries: [string, string][] = [];
  for (const [source, target] of Object.entries(isPlainObject(cfg.dataMapping) ? cfg.dataMapping : {})) {
    const from = processPattern(source, msg).trim();
    const to = processPattern(String(target), msg).trim();
    if (!from || !to || !Object.prototype.hasOwnProperty.call(attributes, from)) continue;
    entries.push([to, attributes[from]]);
  }
  ctx.tellNext(withFetched(msg, fetchToOf(cfg.fetchTo, 'METADATA'), entries, 'Tenant attributes'), RULE_RELATION_SUCCESS);
}
