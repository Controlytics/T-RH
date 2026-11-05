import { z } from 'zod';
import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import {
  RULE_ENGINE_ATTRIBUTES_CONFIG_KEY, APPLICATION_ATTRIBUTE_KEY_MAX, APPLICATION_ATTRIBUTE_VALUE_MAX, APPLICATION_ATTRIBUTES_MAX,
  invalidateRuleEngineConfigCache,
} from '../../rule-engine/config.js';

/**
 * Configuration → Application Attributes (rule chains, 2026-11-03; spec §10).
 *
 * ThingsBoard's "tenant attributes": a list of `{ key, value }` the Tenant
 * attributes node adds to a message (site name, line, a shift supervisor's
 * e-mail …). This install is one tenant, so the list belongs to the
 * application. Read ONLY through `getApplicationAttributes()`
 * (`modules/rule-engine/config.ts`), which returns a key → value map;
 * `afterUpdate` drops its 10 s cache.
 *
 * The generic validator does not check a `json` setting, so the zod schema is
 * the control: every entry is `{ key, value }` text, a key is not blank once
 * trimmed, and no two keys differ only by case (the node looks a key up by
 * name; two spellings of one key would make the answer depend on order).
 * SUPER_ADMIN only; each change is a CONFIG_CHANGED audit row.
 */
export const ruleEngineAttributesDef: ModuleConfigDefinition = {
  moduleKey: RULE_ENGINE_ATTRIBUTES_CONFIG_KEY,
  moduleName: 'Application Attributes',
  description: 'Key / value pairs a rule chain\'s Tenant attributes node adds to a message — site name, line, a contact address.',
  icon: 'tag',
  category: 'system',
  sortOrder: 18,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  // Re-auth on save is governed by the UPDATE_CONFIG_PAGE entry under Action
  // Re-authentication (audit 2026-10-12 #7; ruling D8-1): this SUPER_ADMIN def had no
  // action at all, so no policy could ever ask for the password here.
  reauthAction: 'UPDATE_CONFIG_PAGE',
  hasCustomPage: false,
  settings: [
    {
      key: 'attributes',
      type: 'json',
      label: 'Attributes',
      description: 'A list of { "key": "…", "value": "…" }. A rule chain\'s Tenant attributes node fetches them by key.',
      default: [],
      required: true,
      group: 'Application Attributes',
    },
  ],
  zodSchema: z.object({
    attributes: z.array(z.object({
      key: z.string({ required_error: 'Every attribute needs a key', invalid_type_error: 'An attribute key must be text' })
        .trim()
        .min(1, 'An attribute key cannot be blank')
        .max(APPLICATION_ATTRIBUTE_KEY_MAX, `An attribute key must be ${APPLICATION_ATTRIBUTE_KEY_MAX} characters or fewer`),
      value: z.string({ required_error: 'Every attribute needs a value', invalid_type_error: 'An attribute value must be text' })
        .max(APPLICATION_ATTRIBUTE_VALUE_MAX, `An attribute value must be ${APPLICATION_ATTRIBUTE_VALUE_MAX} characters or fewer`),
    }).strict(), { required_error: 'Attributes are required', invalid_type_error: 'Attributes must be a list' })
      .max(APPLICATION_ATTRIBUTES_MAX, `At most ${APPLICATION_ATTRIBUTES_MAX} attributes`),
  }).superRefine((v, ctx) => {
    const seen = new Map<string, string>();
    for (const { key } of v.attributes) {
      const folded = key.trim().toLowerCase();
      const first = seen.get(folded);
      if (first !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${key.trim()}" repeats the attribute key "${first}"` });
      } else {
        seen.set(folded, key.trim());
      }
    }
  }),
  hooks: {
    afterUpdate: async () => { invalidateRuleEngineConfigCache(); },
  },
};
