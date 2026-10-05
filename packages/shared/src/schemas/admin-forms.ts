import { z } from 'zod';

/**
 * Client-side schemas for the four write forms that had none (audit
 * 2026-10-03, WEB-15): LDAP, notification rules and templates, help articles,
 * the New Instrument form. The server stays authoritative — these exist so a
 * mistake is named beside the field before a round trip that, on three of the
 * four, also costs a re-authentication. Each rule here is one the server
 * already enforces or one a wrong value would silently defeat (an LDAP URL
 * without a scheme never binds; it just fails every login).
 *
 * They live beside the other form schemas so the web app does not grow a
 * direct `zod` dependency of its own.
 */

const LDAP_URL = /^ldaps?:\/\/\S+$/i;

export const ldapConfigFormSchema = z.object({
  enabled: z.boolean(),
  serverUrl: z.string().trim(),
  bindDN: z.string().trim(),
  bindPassword: z.string(),
  searchBase: z.string().trim(),
  searchFilter: z.string().trim().min(1, 'Search filter is required'),
  usernameAttribute: z.string().trim().min(1, 'Username attribute is required'),
  connectionTimeout: z.number().int('Whole milliseconds').min(100, 'At least 100 ms').max(120_000, 'At most 120000 ms'),
  requiredGroups: z.array(z.string()),
  roleMappings: z.array(z.object({ ldapGroup: z.string(), role: z.string() })),
}).passthrough().superRefine((v, ctx) => {
  // A URL may be left blank only while LDAP is OFF; once typed it must carry a
  // scheme, or the service account never binds and every directory login fails
  // with nothing on this page to say why.
  if (v.serverUrl && !LDAP_URL.test(v.serverUrl)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['serverUrl'], message: 'Must start with ldap:// or ldaps://' });
  }
  if (v.enabled) {
    if (!v.serverUrl) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['serverUrl'], message: 'Server URL is required when LDAP is enabled' });
    if (!v.bindDN) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bindDN'], message: 'Bind DN is required when LDAP is enabled' });
    if (!v.searchBase) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['searchBase'], message: 'Search base is required when LDAP is enabled' });
  }
  v.requiredGroups.forEach((g, i) => {
    if (!g.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requiredGroups', i], message: 'Enter the group, or remove the row' });
  });
  v.roleMappings.forEach((m, i) => {
    if (!m.ldapGroup.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['roleMappings', i], message: 'Enter the group, or remove the row' });
  });
});

export const notificationRecipientSchema = z.object({
  recipientType: z.enum(['ROLE', 'GROUP', 'USER']),
  roleValue: z.string().optional(),
  groupId: z.string().optional(),
  userId: z.string().optional(),
}).passthrough();

export const notificationRuleFormSchema = z.object({
  name: z.string().trim().min(1, 'Rule name is required'),
  eventTypes: z.array(z.string()).min(1, 'Choose at least one event type'),
  cooldownMinutes: z.number().int('Whole minutes').min(0, 'Cannot be negative'),
  priority: z.number().int('A whole number'),
  recipients: z.array(notificationRecipientSchema),
}).passthrough().superRefine((v, ctx) => {
  v.recipients.forEach((r, i) => {
    const chosen = r.recipientType === 'ROLE' ? r.roleValue : r.recipientType === 'GROUP' ? r.groupId : r.userId;
    if (!chosen) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipients', i], message: `Choose a ${r.recipientType.toLowerCase()}, or remove the row` });
    }
  });
});

export const notificationTemplateFormSchema = z.object({
  name: z.string().trim().min(1, 'Template name is required'),
  channel: z.enum(['EMAIL', 'SMS']),
  subject: z.string().optional(),
  bodyTemplate: z.string().trim().min(1, 'Body template is required'),
}).passthrough();

/** The create form: every field. */
export const helpArticleFormSchema = z.object({
  key: z.string().trim().min(1, 'Key is required')
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters, digits and single hyphens only'),
  title: z.string().trim().min(1, 'Title is required'),
  category: z.string().min(1, 'Choose a category'),
  content: z.string().trim().min(1, 'Content is required'),
  sortOrder: z.number().int('A whole number').min(0, 'Cannot be negative'),
});

/** The edit form: the key is read-only and blank content keeps the existing text. */
export const helpArticleEditSchema = helpArticleFormSchema.omit({ key: true, content: true }).extend({
  content: z.string(),
});

/**
 * The New Instrument form's FIXED fields. The Instrument ID carries no rule
 * beyond non-empty (2026-09-16, operator) — see `codeSchema`; the profile is
 * what decides which attributes are asked for, so it is required too.
 */
export const instrumentCreateFormSchema = z.object({
  code: z.string().trim().min(1, 'Instrument ID is required'),
  profileId: z.string().min(1, 'Choose a profile'),
});

/** `safeParse` failure → `{ field: [messages] }`, the shape the pages render from. */
export type FormFieldErrors = Partial<Record<string, string[]>>;
export function formFieldErrors(error: z.ZodError): FormFieldErrors {
  const out: FormFieldErrors = {};
  for (const issue of error.issues) {
    // `recipients.1` for an indexed row, `serverUrl` for a plain field.
    const key = issue.path.join('.') || '_';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}
