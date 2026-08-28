import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { FormField, FormSection, FormActions } from '@/components/ui/form-field';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { useAuth } from '@/hooks/use-auth';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { apiClient } from '@/lib/api-client';

interface SettingDef {
  key: string;
  type: string;
  label: string;
  description?: string;
  required?: boolean;
  default?: any;
  placeholder?: string;
  group?: string;
  options?: { value: string | number; label: string }[];
  dynamicOptionsSource?: string;
  min?: number;
  max?: number;
  maskedInApi?: boolean;
  visibleWhen?: { field: string; value: any; operator?: string };
  helpText?: string;
  width?: 'full' | 'half';
}

interface ManifestEntry {
  moduleKey: string;
  moduleName: string;
  description: string;
  icon: string;
  category: string;
  requiresReauth: boolean;
  hasCustomPage: boolean;
  settings: SettingDef[];
}

function isVisible(setting: SettingDef, values: Record<string, any>): boolean {
  if (!setting.visibleWhen) return true;
  const { field, value, operator = 'eq' } = setting.visibleWhen;
  const actual = values[field];
  if (operator === 'eq') return actual === value;
  if (operator === 'neq') return actual !== value;
  if (operator === 'in') return Array.isArray(value) && value.includes(actual);
  return true;
}

function groupSettings(settings: SettingDef[]) {
  const map = new Map<string, SettingDef[]>();
  for (const s of settings) {
    const group = s.group ?? 'General';
    if (!map.has(group)) map.set(group, []);
    map.get(group)!.push(s);
  }
  return [...map.entries()].map(([name, items]) => ({ name, items }));
}

export function DynamicConfigPage() {
  const { moduleKey } = useParams<{ moduleKey: string }>();
  const navigate = useNavigate();
  // 2026-05-26 audit fix (PA-FE-1): gate Save on CONFIG_UPDATE.
  // dynamic-config.tsx renders every module's settings page that
  // doesn't have a hardcoded route, so this gate covers many config
  // surfaces with one change.
  const { user } = useAuth();
  const perms = (user?.permissions as string[] | undefined) ?? [];
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const canWrite = isSuperAdmin || perms.includes('CONFIG_UPDATE');
  const reauth = useReauth();

  const { data: manifest } = useSWR<ManifestEntry[]>(
    '/api/config/registry/manifest',
    { revalidateOnMount: true, dedupingInterval: 5000 }
  );
  const moduleDef = manifest?.find(m => m.moduleKey === moduleKey);

  const { data: savedValues, error: savedValuesError, mutate } = useSWR(
    moduleKey ? `/api/config/dynamic/${moduleKey}` : null,
    { revalidateOnMount: true, dedupingInterval: 0 }
  );

  const [values, setValues] = useState<Record<string, any>>({});
  /**
   * The values as they stand on the server, serialised — the baseline the Save
   * button compares against.
   *
   * Set in the same effect that seeds `values`, so it is exactly what was
   * applied, and updated again after a successful save. Without the second
   * update the button stayed lit after saving until the next keystroke, which
   * reads as "it didn't save".
   *
   * It cannot be `savedValues` directly: that carries only the keys ever
   * written, while `values` also holds the defaults for keys nobody has
   * touched, so a first-load comparison would always report unsaved changes.
   */
  const [baseline, setBaseline] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  // Cache of dynamically loaded options, keyed by dynamicOptionsSource URL.
  const [dynamicOptions, setDynamicOptions] = useState<Record<string, { value: string | number; label: string }[]>>({});

  // Fetch options for any settings that declare a dynamicOptionsSource. Each
  // unique URL is fetched once per module view. The response is expected to
  // be an array of objects; field mapping is resilient:
  //   value ← item.value ?? item.name ?? item.id
  //   label ← item.label ?? item.displayName ?? item.name ?? item.id
  useEffect(() => {
    if (!moduleDef) return;
    const urls = Array.from(new Set(
      moduleDef.settings
        .map(s => s.dynamicOptionsSource)
        .filter((u): u is string => !!u && !(u in dynamicOptions))
    ));
    if (urls.length === 0) return;
    let cancelled = false;
    (async () => {
      const results: Record<string, { value: string | number; label: string }[]> = {};
      for (const url of urls) {
        try {
          const data = await apiClient.get<any>(url);
          const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
          results[url] = list.map((item: any) => ({
            value: item.value ?? item.name ?? item.id,
            label: item.label ?? item.displayName ?? item.name ?? String(item.id ?? ''),
          }));
        } catch {
          results[url] = [];
        }
      }
      if (!cancelled) setDynamicOptions(prev => ({ ...prev, ...results }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleDef]);

  useEffect(() => {
    if (!moduleDef) return;
    // Defaults UNDER the stored value, never instead of it.
    //
    // The API returns the stored row verbatim with no merge, and a row written
    // before a setting existed simply has no key for it. Seeding from
    // `savedValues` alone therefore rendered every NEWLY ADDED setting as an
    // empty field — and saving that page then PERSISTED the blank, turning "this
    // install has not been asked yet" into "this install says: nothing". For a
    // key-mapping setting that is silent: the mapping resolves to no keys and the
    // feature quietly stops working with a green save behind it.
    const merged: Record<string, any> = {};
    for (const s of moduleDef.settings) {
      if (s.default !== undefined) merged[s.key] = s.default;
    }
    Object.assign(merged, savedValues ?? {});
    setValues(merged);
    setBaseline(JSON.stringify(merged));
  }, [savedValues, moduleDef]);

  if (!moduleDef) {
    // A module that is not in the manifest is a FAULT, not an empty screen —
    // either the URL is wrong or the registry did not load — so this is an
    // ErrorState rather than an EmptyState. Telling someone "nothing to
    // configure here" when the registry failed to arrive sends them looking for
    // a setting that exists.
    return (
      <div className="mx-auto max-w-2xl py-16">
        <ErrorState
          title="Configuration not found"
          detail={`No configuration module is registered under "${moduleKey}". It may have been renamed or removed.`}
        />
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => navigate('/config')}>Back to Configuration</Button>
        </div>
      </div>
    );
  }

  // D4(b): if the GET returned a permission error (401/403), show a clear
  // message instead of a blank form. SWR puts the thrown error object here;
  // api-client.ts attaches `status` on structured errors and throws objects
  // with `error` field (e.g. 'UNAUTHORIZED', 'FORBIDDEN') for 4xx responses.
  if (savedValuesError) {
    const isPermissionError =
      savedValuesError?.status === 401 ||
      savedValuesError?.status === 403 ||
      savedValuesError?.error === 'UNAUTHORIZED' ||
      savedValuesError?.error === 'FORBIDDEN' ||
      savedValuesError?.error === 'INSUFFICIENT_PERMISSIONS';
    if (isPermissionError) {
      return (
        <div className="mx-auto max-w-2xl py-16">
          <ErrorState
            title={`${moduleDef.moduleName} is not available to you`}
            detail="Your role does not carry permission to view this configuration. An administrator can grant it under Roles & Access."
          />
          <div className="mt-4 flex justify-center">
            <Button variant="outline" onClick={() => navigate('/config')}>Back to Configuration</Button>
          </div>
        </div>
      );
    }
  }

  if (moduleDef.settings.length === 0) {
    // Genuinely empty rather than broken: the module exists and simply keeps its
    // settings on a page of its own.
    return (
      <div className="mx-auto max-w-2xl py-10">
        <EmptyState
          title={`${moduleDef.moduleName} has its own page`}
          description="This module is configured on a dedicated screen rather than through the standard settings form."
          action={<Button variant="outline" onClick={() => navigate('/config')}>Back to Configuration</Button>}
        />
      </div>
    );
  }

  const handleChange = (key: string, value: any) => {
    setValues(prev => ({ ...prev, [key]: value }));
    setSuccess('');
    setError('');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      // 2026-05-26 audit fix (PA-CLEANUP-2): pre-fix this constructed
      // `UPDATE_${KEY}` from the URL path. For `session` that produced
      // `UPDATE_SESSION` — which is NOT declared in shared types.
      // The declared key is `UPDATE_SESSION_CONFIG`. Maintain a small
      // override map for the keys that don't follow the suffix-strip
      // convention; the BE hardcoded fallback in config/routes.ts:99
      // already enforces reauth, so the failure mode pre-fix was that
      // operators got a retroactive 401 instead of a clean dialog.
      const reauthActionByModuleKey: Record<string, string> = {
        session: 'UPDATE_SESSION_CONFIG',
        datetime: 'UPDATE_DATETIME_CONFIG',
      };
      const action =
        reauthActionByModuleKey[moduleKey!] ??
        `UPDATE_${moduleKey!.toUpperCase().replace(/-/g, '_')}`;
      await reauth.execute(action, async (password?) => {
        const body = { ...values };
        if (password) (body as any)._currentPassword = password;
        await apiClient.put(`/api/config/dynamic/${moduleKey}`, body);
        mutate();
      }, {
        onSuccess: () => {
          // Before the revalidation lands, so the button goes quiet the moment
          // the save succeeds rather than on the next keystroke.
          setBaseline(JSON.stringify(values));
          setSuccess('Settings saved successfully');
          setSaving(false);
        },
        onError: (err: any) => {
          setError(err?.message || 'Failed to save');
          setSaving(false);
        },
      });
    } catch (err: any) {
      setError(err?.message || 'Failed to save');
      setSaving(false);
    }
  };

  const groups = groupSettings(moduleDef.settings);
  // A real comparison, not a "touched" flag: undoing an edit by hand disables
  // the button again, and re-saving an unchanged form is not offered.
  const dirty = JSON.stringify(values) !== baseline;

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-4">
      <PageHeader
        title={moduleDef.moduleName}
        description={moduleDef.description}
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Configuration', to: '/config' }, { label: moduleDef.moduleName }]}
        actions={
          <Button variant="outline" onClick={() => navigate('/config')}>
            Back to Configuration
          </Button>
        }
      />

      {/* Save feedback sits ABOVE the form, where the eye returns after pressing
          a button at the foot of it — not beside the button, which a long form
          has already scrolled past. */}
      {success && (
        <div
          role="status"
          className="flex items-center gap-2.5 rounded-[var(--radius-card)] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-800"
        >
          <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 shrink-0 fill-emerald-600">
            <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.53 5.28-4 4a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 1 1 1.06-1.06L7 8.69l3.47-3.47a.75.75 0 1 1 1.06 1.06Z" />
          </svg>
          {success}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2.5 rounded-[var(--radius-card)] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-800"
        >
          <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 shrink-0 fill-rose-600">
            <path d="M8 1.5 15 14H1L8 1.5Zm0 4.25a.75.75 0 0 0-.75.75v3a.75.75 0 0 0 1.5 0v-3A.75.75 0 0 0 8 5.75Zm0 5.5a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z" />
          </svg>
          {error}
        </div>
      )}

      {groups.map(group => (
        <FormSection key={group.name} title={group.name} columns={2}>
            {group.items
              .filter(s => isVisible(s, values))
              .map(setting => {
                /*
                 * How a setting claims its width.
                 *
                 * The old page put every field on its own full-width row, which
                 * is what made these screens read as a questionnaire. They are a
                 * two-column grid now, so the rule is inverted: a field takes ONE
                 * cell unless it needs both.
                 *
                 * The types listed here are not a style preference — a JSON
                 * blob, a multi-line template or a list of checkboxes squeezed
                 * into half a row is unusable, and `width: 'full'` remains the
                 * def author's explicit override.
                 */
                const spansBothColumns =
                  setting.width === 'full' ||
                  setting.type === 'textarea' ||
                  setting.type === 'json' ||
                  setting.type === 'multiselect';

                return (
                <div key={setting.key} className={spansBothColumns ? 'md:col-span-2' : undefined}>
                  <FormField
                    label={setting.label}
                    required={setting.required}
                    helper={setting.helpText}
                    htmlFor={`cfg-${setting.key}`}
                  >

                  {setting.type === 'boolean' ? (
                    <Checkbox
                      id={`cfg-${setting.key}`}
                      checked={values[setting.key] ?? false}
                      onChange={e => handleChange(setting.key, e.target.checked)}
                      label={setting.description || `Enable ${setting.label.toLowerCase()}`}
                    />
                  ) : setting.type === 'select' ? (
                    (() => {
                      const liveOptions = setting.dynamicOptionsSource ? (dynamicOptions[setting.dynamicOptionsSource] ?? []) : [];
                      const staticOptions = setting.options ?? [];
                      const combined = [...staticOptions, ...liveOptions];
                      // Deduplicate by value (string-compared), keeping the first occurrence
                      const seen = new Set<string>();
                      const finalOptions = combined.filter(o => {
                        const k = String(o.value);
                        if (seen.has(k)) return false;
                        seen.add(k);
                        return true;
                      });
                      const currentValue = values[setting.key] ?? '';
                      const loading = setting.dynamicOptionsSource && !(setting.dynamicOptionsSource in dynamicOptions);
                      return (
                        <Select
                          id={`cfg-${setting.key}`}
                          value={currentValue}
                          onChange={e => handleChange(setting.key, e.target.value)}
                          disabled={!!loading}
                        >
                          {/* The placeholder NAMES the thing being chosen rather
                              than saying "Select...", which tells an operator
                              scanning a long form nothing about which field
                              they are on. */}
                          <option value="">{loading ? 'Loading…' : `Select ${setting.label.toLowerCase()}`}</option>
                          {!loading && finalOptions.length === 0 && (
                            <option value="" disabled>No options available</option>
                          )}
                          {finalOptions.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                          {/* If the saved value isn't in the loaded list, still render it so the user sees what's stored */}
                          {currentValue && !finalOptions.some(o => String(o.value) === String(currentValue)) && !loading && (
                            <option key={`stale-${currentValue}`} value={currentValue}>{currentValue} (not found)</option>
                          )}
                        </Select>
                      );
                    })()
                  ) : setting.type === 'multiselect' ? (
                    (() => {
                      const liveOptions = setting.dynamicOptionsSource ? (dynamicOptions[setting.dynamicOptionsSource] ?? []) : [];
                      const staticOptions = setting.options ?? [];
                      const combined = [...staticOptions, ...liveOptions];
                      const seen = new Set<string>();
                      const finalOptions = combined.filter(o => { const k = String(o.value); if (seen.has(k)) return false; seen.add(k); return true; });
                      const selected: string[] = Array.isArray(values[setting.key]) ? values[setting.key] : [];
                      const loading = setting.dynamicOptionsSource && !(setting.dynamicOptionsSource in dynamicOptions);
                      const toggle = (val: string) => {
                        const next = selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val];
                        handleChange(setting.key, next);
                      };
                      return (
                        // A bordered, scroll-capped group rather than an
                        // unbounded stack: a dynamic source can return dozens of
                        // options, and letting them push the Save button off the
                        // screen is how a form loses someone's work.
                        <div className="max-h-56 space-y-2.5 overflow-y-auto rounded-[var(--radius-control)] border border-slate-300 bg-white p-3">
                          {loading && <p className="text-[13px] text-slate-400">Loading…</p>}
                          {!loading && finalOptions.length === 0 && (
                            <p className="text-[13px] text-slate-400">No options available</p>
                          )}
                          {finalOptions.map(opt => (
                            <Checkbox
                              key={opt.value}
                              checked={selected.includes(String(opt.value))}
                              onChange={() => toggle(String(opt.value))}
                              label={opt.label}
                            />
                          ))}
                        </div>
                      );
                    })()
                  ) : setting.type === 'number' ? (
                    <Input
                      id={`cfg-${setting.key}`}
                      type="number"
                      value={values[setting.key] ?? ''}
                      min={setting.min}
                      max={setting.max}
                      onChange={e => handleChange(setting.key, e.target.value ? Number(e.target.value) : '')}
                      placeholder={setting.placeholder}
                    />
                  ) : setting.type === 'secret' ? (
                    <Input
                      id={`cfg-${setting.key}`}
                      type="password"
                      value={values[setting.key] ?? ''}
                      onChange={e => handleChange(setting.key, e.target.value)}
                      placeholder={setting.placeholder || '••••••••'}
                    />
                  ) : setting.type === 'textarea' || setting.type === 'json' ? (
                    <textarea
                      id={`cfg-${setting.key}`}
                      value={typeof values[setting.key] === 'object' ? JSON.stringify(values[setting.key], null, 2) : (values[setting.key] ?? '')}
                      onChange={e => {
                        try { handleChange(setting.key, JSON.parse(e.target.value)); }
                        catch { handleChange(setting.key, e.target.value); }
                      }}
                      rows={setting.type === 'json' ? 8 : 4}
                      placeholder={setting.placeholder}
                      // Matches Input's treatment exactly — hairline border, the
                      // themed focus ring, the same radius. There is no Textarea
                      // primitive yet and this is the only place that needs one.
                      className="w-full rounded-[var(--radius-control)] border border-slate-300 bg-white px-3 py-2 text-[14px] text-slate-800 transition-colors placeholder:text-slate-400 hover:border-slate-400 focus:border-[var(--theme-primary,#2a78d6)] focus:outline-none focus:ring-2 focus:ring-[var(--theme-primary,#2a78d6)]/25 font-[family-name:var(--font-mono)]"
                    />
                  ) : setting.type === 'color' ? (
                    <div className="flex items-center gap-2">
                      <input
                        id={`cfg-${setting.key}`}
                        type="color"
                        value={values[setting.key] ?? '#000000'}
                        onChange={e => handleChange(setting.key, e.target.value)}
                        // h-10 so the swatch matches the text field beside it;
                        // they were 40px and 38px before, which is visible.
                        className="h-10 w-12 cursor-pointer rounded-[var(--radius-control)] border border-slate-300 bg-white p-1"
                      />
                      <Input
                        value={values[setting.key] ?? ''}
                        onChange={e => handleChange(setting.key, e.target.value)}
                        placeholder="#000000"
                        className="w-36 font-[family-name:var(--font-mono)]"
                      />
                    </div>
                  ) : (
                    <Input
                      id={`cfg-${setting.key}`}
                      type={setting.type === 'email' ? 'email' : setting.type === 'url' ? 'url' : 'text'}
                      value={values[setting.key] ?? ''}
                      onChange={e => handleChange(setting.key, e.target.value)}
                      placeholder={setting.placeholder}
                    />
                  )}
                  </FormField>
                </div>
                );
              })}
        </FormSection>
      ))}

      {/*
        STICKY. These forms run past a screenful on most modules, and a Save
        button below the fold on a page an operator has scrolled through is the
        single most common way a configuration change is lost. The note carries
        the §11 consequence, because saving here is an audited act.
      */}
      <FormActions
        sticky
        className="rounded-[var(--radius-card)] border border-slate-200 shadow-[var(--elev-1)]"
        note={dirty ? 'Unsaved changes. Saving is recorded in the audit trail.' : 'Changes are recorded in the audit trail.'}
      >
        <Button variant="outline" onClick={() => navigate('/config')}>Cancel</Button>
        <Button
          onClick={handleSave}
          loading={saving}
          loadingText="Saving…"
          disabled={!canWrite || !dirty}
          title={!canWrite ? 'CONFIG_UPDATE permission required' : !dirty ? 'No unsaved changes' : undefined}
        >
          {dirty ? 'Save Changes' : 'Saved'}
        </Button>
      </FormActions>

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Save Configuration"
      />
    </div>
  );
}
