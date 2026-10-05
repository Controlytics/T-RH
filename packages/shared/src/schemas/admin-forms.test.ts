import { describe, it, expect } from 'vitest';
import {
  ldapConfigFormSchema, notificationRuleFormSchema, notificationTemplateFormSchema,
  helpArticleFormSchema, helpArticleEditSchema, instrumentCreateFormSchema, formFieldErrors,
} from './admin-forms.js';

/** audit 2026-10-03, WEB-15 — the client-side schemas for the four write forms. */

const ldapBase = {
  enabled: false, serverUrl: '', bindDN: '', bindPassword: '', searchBase: '',
  searchFilter: '(sAMAccountName={{username}})', usernameAttribute: 'sAMAccountName',
  connectionTimeout: 5000, requiredGroups: [], roleMappings: [],
};

const errorsOf = (r: { success: boolean; error?: any }) => (r.success ? {} : formFieldErrors(r.error));

describe('ldapConfigFormSchema', () => {
  it('accepts a blank URL while LDAP is off, refuses one without a scheme once typed', () => {
    expect(ldapConfigFormSchema.safeParse(ldapBase).success).toBe(true);
    const e = errorsOf(ldapConfigFormSchema.safeParse({ ...ldapBase, serverUrl: 'ad.company.com:636' }));
    expect(e.serverUrl).toEqual(['Must start with ldap:// or ldaps://']);
    expect(ldapConfigFormSchema.safeParse({ ...ldapBase, serverUrl: 'LDAPS://ad.company.com:636' }).success).toBe(true);
    expect(ldapConfigFormSchema.safeParse({ ...ldapBase, serverUrl: 'ldap://ad.company.com' }).success).toBe(true);
  });

  it('requires the URL, bind DN and search base once LDAP is enabled', () => {
    const e = errorsOf(ldapConfigFormSchema.safeParse({ ...ldapBase, enabled: true }));
    expect(Object.keys(e).sort()).toEqual(['bindDN', 'searchBase', 'serverUrl']);
  });

  it('names a blank list row by its index', () => {
    const e = errorsOf(ldapConfigFormSchema.safeParse({
      ...ldapBase, requiredGroups: ['CN=Ops', ''], roleMappings: [{ ldapGroup: ' ', role: 'ADMIN' }],
    }));
    expect(Object.keys(e).sort()).toEqual(['requiredGroups.1', 'roleMappings.0']);
  });

  it('keeps the fields it does not judge (passthrough) so the saved row is whole', () => {
    const r = ldapConfigFormSchema.safeParse({ ...ldapBase, tlsRejectUnauthorized: true, defaultRole: 'OPERATOR' });
    expect(r.success && (r.data as any).tlsRejectUnauthorized).toBe(true);
  });
});

describe('notificationRuleFormSchema', () => {
  const rule = { name: 'Chiller', eventTypes: ['ALARM_RAISED'], cooldownMinutes: 0, priority: 0, recipients: [] };
  it('requires a name and at least one event type', () => {
    const e = errorsOf(notificationRuleFormSchema.safeParse({ ...rule, name: ' ', eventTypes: [] }));
    expect(e.name).toEqual(['Rule name is required']);
    expect(e.eventTypes).toEqual(['Choose at least one event type']);
  });
  it('refuses a recipient row with nothing chosen, by index', () => {
    const e = errorsOf(notificationRuleFormSchema.safeParse({
      ...rule,
      recipients: [{ recipientType: 'ROLE', roleValue: 'QA' }, { recipientType: 'USER', userId: '' }, { recipientType: 'GROUP', groupId: 'g1' }],
    }));
    expect(Object.keys(e)).toEqual(['recipients.1']);
    expect(e['recipients.1']![0]).toMatch(/Choose a user/);
  });
  it('refuses a negative or fractional cooldown', () => {
    expect(errorsOf(notificationRuleFormSchema.safeParse({ ...rule, cooldownMinutes: -1 })).cooldownMinutes).toBeDefined();
    expect(errorsOf(notificationRuleFormSchema.safeParse({ ...rule, cooldownMinutes: 1.5 })).cooldownMinutes).toBeDefined();
  });
});

describe('notificationTemplateFormSchema', () => {
  it('requires a name, a known channel and a body', () => {
    const e = errorsOf(notificationTemplateFormSchema.safeParse({ name: '', channel: 'FAX', bodyTemplate: '  ' }));
    expect(Object.keys(e).sort()).toEqual(['bodyTemplate', 'channel', 'name']);
    expect(notificationTemplateFormSchema.safeParse({ name: 'x', channel: 'SMS', bodyTemplate: 'Alert' }).success).toBe(true);
  });
});

describe('help article schemas', () => {
  const article = { key: 'audit-guide', title: 'Audit guide', category: 'audit', content: 'Body', sortOrder: 0 };
  it('accepts a well-formed article and refuses a key with spaces, capitals or a trailing hyphen', () => {
    expect(helpArticleFormSchema.safeParse(article).success).toBe(true);
    for (const key of ['Audit Guide', 'audit-', '-audit', 'audit--guide', '']) {
      expect(errorsOf(helpArticleFormSchema.safeParse({ ...article, key })).key).toBeDefined();
    }
  });
  it('the edit schema ignores the key and lets blank content keep the existing text', () => {
    expect(helpArticleEditSchema.safeParse({ ...article, key: 'IGNORED KEY', content: '' }).success).toBe(true);
    expect(errorsOf(helpArticleEditSchema.safeParse({ ...article, title: ' ' })).title).toEqual(['Title is required']);
  });
});

describe('instrumentCreateFormSchema', () => {
  it('requires an Instrument ID and a profile, and puts NO other rule on the ID', () => {
    const e = errorsOf(instrumentCreateFormSchema.safeParse({ code: '  ', profileId: '' }));
    expect(e.code).toEqual(['Instrument ID is required']);
    expect(e.profileId).toEqual(['Choose a profile']);
    // `/`, `+` and `#` all pass — the registration guard went on 2026-09-16.
    for (const code of ['CWH/RDU/001-00', 'a+b', 'x#y', 'telemetry']) {
      expect(instrumentCreateFormSchema.safeParse({ code, profileId: 'p1' }).success).toBe(true);
    }
  });
  it('trims the ID it hands back', () => {
    const r = instrumentCreateFormSchema.safeParse({ code: ' CWH/RDU/001-00 ', profileId: 'p1' });
    expect(r.success && r.data.code).toBe('CWH/RDU/001-00');
  });
});
