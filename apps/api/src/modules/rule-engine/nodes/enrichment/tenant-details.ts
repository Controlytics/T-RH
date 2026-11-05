import { RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleContext } from '../../context.js';
import type { RuleMessage } from '../../message.js';
import type { JsonObject } from '../action/support.js';
import { fetchToOf, withFetched } from './fetch.js';

/**
 * TENANT DETAILS, read here as APPLICATION DETAILS — ThingsBoard's
 * `TbGetTenantDetailsNode` (rule chains, Task 5). The chosen details from
 * `services.appDetails()`: TITLE (the report company name, else Branding's),
 * APP_NAME, SERVER_NAME (the host name), SERVER_VERSION. Each is added under
 * ThingsBoard's own naming, `tenant_` + the detail in camel case
 * (`tenant_title`, `tenant_appName`, …). A ThingsBoard detail this system has
 * no value for (COUNTRY, EMAIL, … from an import) and an empty one are left
 * out, as ThingsBoard leaves out an empty field. Default destination: the data.
 */
export const TENANT_DETAILS_TYPE = 'tb:enrichment:tenant-details';

interface TenantDetailsConfig extends JsonObject {
  detailsList?: string[];
  fetchTo?: 'DATA' | 'METADATA';
}

/** `SERVER_VERSION` → `tenant_serverVersion`. */
export function tenantDetailKey(detail: string): string {
  const camel = detail.toLowerCase().replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  return `tenant_${camel}`;
}

export async function tenantDetails(ctx: RuleContext<TenantDetailsConfig>, msg: RuleMessage): Promise<void> {
  const wanted = Array.isArray(ctx.config.detailsList) ? ctx.config.detailsList : [];
  const details = wanted.length > 0 ? await ctx.services.appDetails() : {};
  const entries: [string, string][] = [];
  for (const detail of [...new Set(wanted)]) {
    const value = Object.prototype.hasOwnProperty.call(details, detail) ? details[detail] : '';
    if (value) entries.push([tenantDetailKey(detail), value]);
  }
  ctx.tellNext(withFetched(msg, fetchToOf(ctx.config.fetchTo, 'DATA'), entries, 'Tenant details'), RULE_RELATION_SUCCESS);
}
