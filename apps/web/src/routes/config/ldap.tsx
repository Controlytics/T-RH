import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { api } from '../../lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { Button } from '@/components/ui/button';

interface RoleMappingRow {
  ldapGroup: string;
  role: string;
}

interface LdapConfig {
  enabled: boolean;
  serverUrl: string;
  bindDN: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string;
  usernameAttribute: string;
  emailAttribute: string;
  fullNameAttribute: string;
  departmentAttribute: string;
  groupAttribute: string;
  tlsRejectUnauthorized: boolean;
  connectionTimeout: number;
  roleMappings: RoleMappingRow[];
  defaultRole: string;
  syncAttributes: boolean;
  requiredGroups: string[];
  strictRoleMapping: boolean;
}

const DEFAULTS: LdapConfig = {
  enabled: false,
  serverUrl: '',
  bindDN: '',
  bindPassword: '',
  searchBase: '',
  searchFilter: '(sAMAccountName={{username}})',
  usernameAttribute: 'sAMAccountName',
  emailAttribute: 'mail',
  fullNameAttribute: 'displayName',
  departmentAttribute: 'department',
  groupAttribute: 'memberOf',
  // MUST match the backend DEFAULT_CONFIG (ldap.service.ts). This was `false`
  // while the backend used `true`: the form seeds from these DEFAULTS before
  // SWR resolves the saved config, so an admin who opened the page and hit Save
  // quickly wrote `tlsRejectUnauthorized: false` — silently disabling
  // certificate verification on an ldaps:// bind, which lets an on-path attacker
  // present any self-signed certificate and harvest the service-account
  // password plus every user's password in cleartext. That is the exact finding
  // the backend default was changed to fix; the stale copy here reintroduced it
  // through the UI.
  tlsRejectUnauthorized: true,
  connectionTimeout: 5000,
  roleMappings: [],
  defaultRole: 'OPERATOR',
  syncAttributes: true,
  requiredGroups: [],
  strictRoleMapping: false,
};

export default function LdapConfigPage() {
  // 2026-05-26 audit fix (PA-FE-1): gate Save / Test / Enable on CONFIG_UPDATE.
  const { user } = useAuth();
  const perms = (user?.permissions as string[] | undefined) ?? [];
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const canWrite = isSuperAdmin || perms.includes('CONFIG_UPDATE');
  const { data: savedConfig, mutate } = useSWR<LdapConfig>('/api/ldap/config');
  const { data: rolesData } = useSWR<Array<{ name: string; displayName: string }>>('/api/roles/active', { revalidateOnMount: true, dedupingInterval: 0 });
  const reauth = useReauth();

  const [config, setConfig] = useState<LdapConfig>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    // Array fields are re-defaulted explicitly: a config row saved before these
    // fields existed spreads them in as undefined, and the render path calls
    // .map/.length on them.
    if (savedConfig) setConfig({
      ...DEFAULTS,
      ...savedConfig,
      roleMappings: savedConfig.roleMappings ?? [],
      requiredGroups: savedConfig.requiredGroups ?? [],
    });
  }, [savedConfig]);

  const updateField = (key: keyof LdapConfig, value: any) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  // Audit 2026-05-04 fix #5 (web-routes review H2): LDAP config edits
  // (bind credentials + base-DN) can redirect every login to an attacker-
  // controlled directory. Distinct UPDATE_LDAP_CONFIG action key (vs
  // UPDATE_LOGIN_SECURITY) so the audit trail makes the source-of-trust
  // change explicit.
  const handleSave = () => {
    setSaving(true);
    setSaveMsg(null);
    reauth.execute(
      'UPDATE_LDAP_CONFIG',
      async (password?: string) => {
        if (password) await api.putWithReauth('/api/ldap/config', config, password);
        else await api.put('/api/ldap/config', config);
      },
      {
        onSuccess: () => {
          mutate();
          setSaveMsg({ type: 'success', text: 'LDAP configuration saved successfully' });
          setTimeout(() => setSaveMsg(null), 5000);
          setSaving(false);
        },
        onError: (e: any) => {
          setSaveMsg({ type: 'error', text: e.message || 'Failed to save' });
          setSaving(false);
        },
      },
    );
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post<{ success: boolean; message: string }>('/api/ldap/test-connection', config);
      setTestResult(result);
    } catch (e: any) {
      setTestResult({ success: false, message: e.message || 'Test failed' });
    }
    setTesting(false);
  };

  const addRoleMapping = () => {
    updateField('roleMappings', [...config.roleMappings, { ldapGroup: '', role: config.defaultRole }]);
  };

  const updateRoleMapping = (index: number, field: 'ldapGroup' | 'role', value: string) => {
    const updated = [...config.roleMappings];
    updated[index] = { ...updated[index], [field]: value };
    updateField('roleMappings', updated);
  };

  const removeRoleMapping = (index: number) => {
    updateField('roleMappings', config.roleMappings.filter((_, i) => i !== index));
  };

  const addRequiredGroup = () => updateField('requiredGroups', [...config.requiredGroups, '']);

  const updateRequiredGroup = (index: number, value: string) => {
    const updated = [...config.requiredGroups];
    updated[index] = value;
    updateField('requiredGroups', updated);
  };

  const removeRequiredGroup = (index: number) => {
    updateField('requiredGroups', config.requiredGroups.filter((_, i) => i !== index));
  };

  return (
    <div className="p-6 space-y-6 animate-fade-in max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/config" className="p-2 rounded-xl hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </Link>
          <div className="p-3 rounded-[var(--radius-card)] bg-gradient-to-br from-green-500 to-emerald-600 shadow-[var(--elev-2)]">
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
            </svg>
          </div>
          <div>
            <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] text-slate-900">LDAP / Active Directory</h1>
            <p className="text-sm text-slate-500 mt-0.5">Configure LDAP authentication and user provisioning</p>
          </div>
        </div>
        <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium ${config.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
          <span className={`w-2 h-2 rounded-full ${config.enabled ? 'bg-emerald-500' : 'bg-slate-400'}`}></span>
          {config.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>

      {/* Messages */}
      {saveMsg && (
        <div className={`rounded-xl border p-4 text-sm flex items-center gap-2 ${saveMsg.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={saveMsg.type === 'success' ? 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' : 'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'} /></svg>
          {saveMsg.text}
        </div>
      )}

      {/* Enable Toggle */}
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 shadow-[var(--elev-1)] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-slate-800">Enable LDAP Authentication</h3>
            <p className="text-sm text-slate-500 mt-1">When enabled, users can authenticate via LDAP/Active Directory. Local authentication remains available for Super Admin.</p>
          </div>
          <button onClick={() => updateField('enabled', !config.enabled)}
            className={`relative w-14 h-7 rounded-full transition-colors ${config.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`}>
            <span className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${config.enabled ? 'translate-x-7' : 'translate-x-0.5'}`}></span>
          </button>
        </div>
      </div>

      {/* Connection Settings */}
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 shadow-[var(--elev-1)] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
          <h3 className="font-semibold text-slate-800 flex items-center gap-2">
            <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" /></svg>
            Connection Settings
          </h3>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Server URL <span className="text-red-500">*</span></label>
              <input value={config.serverUrl} onChange={e => updateField('serverUrl', e.target.value)} placeholder="ldaps://ad.company.com:636"
                className="ctl w-full font-mono" />
              <p className="text-xs text-slate-400 mt-1">Use ldaps:// for secure connection (port 636) or ldap:// for plain (port 389)</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Bind DN <span className="text-red-500">*</span></label>
              <input value={config.bindDN} onChange={e => updateField('bindDN', e.target.value)} placeholder="CN=svc_digilog,OU=Service Accounts,DC=company,DC=com"
                className="ctl w-full font-mono" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Bind Password <span className="text-red-500">*</span></label>
              <input type="password" value={config.bindPassword} onChange={e => updateField('bindPassword', e.target.value)} placeholder="Service account password"
                className="ctl w-full" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Connection Timeout (ms)</label>
              <input type="number" value={config.connectionTimeout} onChange={e => updateField('connectionTimeout', Number(e.target.value))}
                className="ctl w-full" />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={config.tlsRejectUnauthorized} onChange={e => updateField('tlsRejectUnauthorized', e.target.checked)}
                  className="ctl-check" />
                <span className="text-sm text-slate-700">Verify TLS Certificate</span>
              </label>
            </div>
          </div>

          {/* Test Connection */}
          <div className="flex items-center gap-4 pt-2">
            <Button variant="success" onClick={handleTest} disabled={testing || !config.serverUrl || !canWrite}
              title={!canWrite ? 'CONFIG_UPDATE permission required' : undefined}>
              {testing ? (
                <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>Testing...</>
              ) : (
                <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>Test Connection</>
              )}
            </Button>
            {testResult && (
              <span className={`text-sm font-medium ${testResult.success ? 'text-emerald-600' : 'text-red-600'}`}>
                {testResult.message}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Search Settings */}
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 shadow-[var(--elev-1)] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
          <h3 className="font-semibold text-slate-800 flex items-center gap-2">
            <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            User Search Settings
          </h3>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Search Base DN <span className="text-red-500">*</span></label>
            <input value={config.searchBase} onChange={e => updateField('searchBase', e.target.value)} placeholder="OU=Users,DC=company,DC=com"
              className="ctl w-full font-mono" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Search Filter</label>
            <input value={config.searchFilter} onChange={e => updateField('searchFilter', e.target.value)} placeholder="(sAMAccountName={{username}})"
              className="ctl w-full font-mono" />
            <p className="text-xs text-slate-400 mt-1">Use {'{{username}}'} as placeholder for the login username</p>
            <p className="text-xs text-slate-500 mt-1.5">
              To restrict sign-in to one Active Directory group, add a <span className="font-mono">memberOf</span> clause:
            </p>
            <code className="mt-1 block text-[11px] bg-slate-50 border border-slate-200 rounded-lg p-2 text-slate-600 break-all">
              (&amp;(sAMAccountName={'{{username}}'})(memberOf:1.2.840.113556.1.4.1941:=CN=DigiLog-Users,OU=Groups,DC=company,DC=com))
            </code>
            <p className="text-xs text-slate-400 mt-1">
              The <span className="font-mono">1.2.840.113556.1.4.1941</span> rule makes AD follow nested groups —
              required when employees are members of role sub-groups rather than the parent group directly.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Username Attribute</label>
              <input value={config.usernameAttribute} onChange={e => updateField('usernameAttribute', e.target.value)}
                className="ctl w-full font-mono" />
              <p className="text-xs text-slate-400 mt-1">AD: sAMAccountName, OpenLDAP: uid</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Group Attribute</label>
              <input value={config.groupAttribute} onChange={e => updateField('groupAttribute', e.target.value)}
                className="ctl w-full font-mono" />
            </div>
          </div>
        </div>
      </div>

      {/* Attribute Mapping */}
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 shadow-[var(--elev-1)] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
          <h3 className="font-semibold text-slate-800 flex items-center gap-2">
            <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
            Attribute Mapping
          </h3>
        </div>
        <div className="p-6">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Full Name</label>
              <input value={config.fullNameAttribute} onChange={e => updateField('fullNameAttribute', e.target.value)}
                className="ctl w-full font-mono" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <input value={config.emailAttribute} onChange={e => updateField('emailAttribute', e.target.value)}
                className="ctl w-full font-mono" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Department</label>
              <input value={config.departmentAttribute} onChange={e => updateField('departmentAttribute', e.target.value)}
                className="ctl w-full font-mono" />
            </div>
          </div>
          <div className="mt-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={config.syncAttributes} onChange={e => updateField('syncAttributes', e.target.checked)}
                className="ctl-check" />
              <span className="text-sm text-slate-700">Sync attributes on every login</span>
            </label>
          </div>
        </div>
      </div>

      {/* Access Restriction */}
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 shadow-[var(--elev-1)] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-800 flex items-center gap-2">
              <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
              Access Restriction
            </h3>
            <button onClick={addRequiredGroup} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-green-50 text-green-700 rounded-lg hover:bg-green-100">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
              Add Group
            </button>
          </div>
        </div>
        <div className="p-6 space-y-3">
          <p className="text-sm text-slate-600">
            Only directory users who belong to at least one of these groups may sign in.
            Enter the full group DN or just its name.
          </p>
          <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800">
            <span className="font-medium">List the groups your employees are actually in.</span>{' '}
            This check reads <span className="font-mono text-xs">memberOf</span>, which reports only
            direct membership — it does not follow nesting. If your staff sit in role sub-groups
            (Admin, Supervisor, QA…) inside a parent group, list the <em>sub-groups</em>. Entering
            the parent group here matches nobody and refuses every login.
            Nesting belongs in the Search Filter above, via the matching rule.
          </div>
          {config.requiredGroups.length === 0 ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              <p className="font-medium">No restriction configured — every user in the directory can sign in.</p>
              <p className="mt-1 text-amber-700">
                Anyone your directory can authenticate will be created here automatically with the
                default role below. Add the group your company uses for this application, or scope
                the Search Filter above, or both.
              </p>
            </div>
          ) : (
            config.requiredGroups.map((group, i) => (
              <div key={i} className="flex items-center gap-3">
                <input value={group} onChange={e => updateRequiredGroup(i, e.target.value)} placeholder="CN=DigiLog-Users,OU=Groups,DC=company,DC=com"
                  className="ctl flex-1 font-mono" />
                <Button variant="ghost" size="icon" onClick={() => removeRequiredGroup(i)}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </Button>
              </div>
            ))
          )}
          <div className="pt-2 border-t border-slate-100">
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" checked={config.strictRoleMapping} onChange={e => updateField('strictRoleMapping', e.target.checked)}
                className="ctl-check mt-0.5" />
              <span className="text-sm text-slate-700">
                Refuse login when a mapped role does not exist
                <span className="block text-xs text-slate-400 mt-0.5">
                  Off (recommended): admit the user at the default role and record the mismatch in the audit trail.
                  On: a typo in a mapping locks out everyone in that group.
                </span>
              </span>
            </label>
          </div>
        </div>
      </div>

      {/* Group-to-Role Mapping */}
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 shadow-[var(--elev-1)] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-800 flex items-center gap-2">
              <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              Group-to-Role Mapping
            </h3>
            <button onClick={addRoleMapping} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-green-50 text-green-700 rounded-lg hover:bg-green-100">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
              Add Mapping
            </button>
          </div>
        </div>
        <div className="p-6 space-y-3">
          {config.roleMappings.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-4">No group mappings configured. Users will be assigned the default role.</p>
          ) : (
            config.roleMappings.map((mapping, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="flex-1">
                  <input value={mapping.ldapGroup} onChange={e => updateRoleMapping(i, 'ldapGroup', e.target.value)} placeholder="CN=Admins,OU=Groups,DC=company,DC=com"
                    className="ctl w-full font-mono" />
                </div>
                <svg className="w-5 h-5 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg>
                <select value={mapping.role} onChange={e => updateRoleMapping(i, 'role', e.target.value)}
                  className="ctl w-48">
                  {rolesData?.map(r => <option key={r.name} value={r.name}>{r.displayName}</option>)}
                </select>
                <Button variant="ghost" size="icon" onClick={() => removeRoleMapping(i)}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </Button>
              </div>
            ))
          )}
          <div className="pt-2">
            <label className="block text-sm font-medium text-slate-700 mb-1">Default Role (when no group matches)</label>
            <select value={config.defaultRole} onChange={e => updateField('defaultRole', e.target.value)}
              className="ctl w-64">
              {rolesData?.map(r => <option key={r.name} value={r.name}>{r.displayName}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <div className="flex justify-end gap-3 pb-6">
        <Link to="/config">
          <Button variant="ghost">Cancel</Button>
        </Link>
        <Button variant="success" onClick={handleSave} disabled={saving || !canWrite}
          title={!canWrite ? 'CONFIG_UPDATE permission required' : undefined}>
          {saving ? 'Saving...' : 'Save Configuration'}
        </Button>
      </div>

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={() => { reauth.cancel(); setSaving(false); }}
        actionLabel="Update LDAP Configuration"
      />
    </div>
  );
}
