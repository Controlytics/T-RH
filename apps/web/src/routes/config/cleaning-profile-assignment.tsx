import { useState, useEffect, useMemo } from 'react';
import useSWR, { mutate } from 'swr';
import { apiClient, api } from '../../lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';

type AssignmentMode = 'BY_FILTER_SIZE' | 'BY_ENTITY' | 'BY_AHU' | 'BY_BLOCK' | 'BY_FILTER_SET';

interface AssignmentRule {
  matchValue: string;
  profileId: string;
}

interface AssignmentConfig {
  mode: AssignmentMode;
  rules: AssignmentRule[];
}

interface CleaningProfile {
  id: string;
  name: string;
  status?: string;  // 2026-05-29 bug fix #5: filter dropdown to ACTIVE only.
}

// A-01 Wave 5 (2026-05-29): AssetInstance + AssetTemplate types removed.
// This file now reads from /api/hierarchy/{blocks,areas,ahus,filters} which
// returns typed rows directly — no template detection needed.

const MODE_OPTIONS: { value: AssignmentMode; label: string; description: string }[] = [
  { value: 'BY_ENTITY', label: 'By Individual Filter', description: 'Assign a cleaning profile to each filter individually' },
  // 2026-05-29 bug fix #2: relabel — the underlying attribute is `micronSize`
  // (configured via Filter Field Options config page); BY_FILTER_SIZE enum
  // value preserved for backward-compat with stored configs.
  { value: 'BY_FILTER_SIZE', label: 'By Micron Size', description: 'Assign based on the filter micron-size attribute' },
  { value: 'BY_AHU', label: 'By AHU', description: 'Assign based on which AHU the filter belongs to' },
  { value: 'BY_BLOCK', label: 'By Block / Area', description: 'Assign based on the parent block or area in the hierarchy' },
  { value: 'BY_FILTER_SET', label: 'By Filter Set (A/B)', description: 'Assign based on filter set designation' },
];

export function CleaningProfileAssignmentPage() {
  const { toast } = useToast();

  const { data: configData } = useSWR<AssignmentConfig>('/api/config/cleaning-profile-assignment');
  const { data: profilesData } = useSWR<{ data: CleaningProfile[] }>('/api/filter-cleaning-profiles?limit=100');
  // A-01 Wave 5 (2026-05-29): migrated off /api/assets/instances + /api/assets/templates
  // to the typed-table /api/hierarchy/* endpoints. Removes the template-kind
  // detection + Set-membership filtering that this file previously needed.
  // Each endpoint returns only the rows of its kind, so no client-side
  // filtering by kind is needed. AHUs / Blocks / Areas / Filters are
  // separate calls (SWR dedupes per-key) — cheaper than one nested expand
  // because each piece is consumed in a different `useMemo`.
  const { data: blocksData }  = useSWR<{ data: any[] }>('/api/hierarchy/blocks');
  const { data: areasData }   = useSWR<{ data: any[] }>('/api/hierarchy/areas?limit=500');
  const { data: ahusData }    = useSWR<{ data: any[] }>('/api/hierarchy/ahus?limit=500');
  const { data: filtersData } = useSWR<{ data: any[] }>('/api/hierarchy/filters');

  const [mode, setMode] = useState<AssignmentMode>('BY_ENTITY');
  const [rules, setRules] = useState<AssignmentRule[]>([]);
  const [saving, setSaving] = useState(false);

  const profiles: CleaningProfile[] = profilesData?.data ?? (Array.isArray(profilesData) ? profilesData as any : []);
  // Direct typed-table data — no kind filtering needed (endpoints are kind-scoped).
  const blockInstances:  Array<{ id: string; name: string | null }> = blocksData?.data ?? [];
  const areaInstances:   Array<{ id: string; name: string | null }> = areasData?.data ?? [];
  const ahuInstances:    Array<{ id: string; name: string | null }> = ahusData?.data ?? [];
  const filterInstances: Array<{ id: string; name: string | null; attributes?: Record<string, any> | null }> = filtersData?.data ?? [];

  useEffect(() => {
    if (configData) {
      setMode(configData.mode || 'BY_ENTITY');
      setRules(configData.rules || []);
    }
  }, [configData]);

  // A-01 Wave 5 (2026-05-29): filterInstances / ahuInstances / blockInstances
  // come directly from /api/hierarchy/{filters,ahus,blocks,areas}. No more
  // template-Set membership filtering. BY_BLOCK mode label is "Block / Area"
  // — concatenate blocks + areas into one pool (preserves prior behaviour).
  const blockAndAreaInstances = useMemo(
    () => [...blockInstances, ...areaInstances],
    [blockInstances, areaInstances],
  );

  // Unique micron sizes from filter instances (attributes.micronSize is the
  // canonical key written by the Filter Field Options config page).
  const filterSizes = useMemo(() => {
    const sizes = new Set<string>();
    filterInstances.forEach(i => {
      const fs = (i.attributes as any)?.micronSize;
      if (fs) sizes.add(String(fs));
    });
    return Array.from(sizes).sort();
  }, [filterInstances]);

  // 2026-05-29 bug fix #5: only ACTIVE cleaning profiles are valid targets.
  // Archived profiles were previously selectable and would silently fail
  // at cycle start. Preserve any currently-saved-but-now-archived rule
  // value in the dropdown so it remains visible / editable.
  const activeProfiles = useMemo(() => {
    const currentlyReferenced = new Set(rules.map(r => r.profileId).filter(Boolean));
    return profiles.filter(p => p.status === 'ACTIVE' || !p.status || currentlyReferenced.has(p.id));
  }, [profiles, rules]);

  const handleModeChange = (newMode: AssignmentMode) => {
    // 2026-05-29 bug fix #6: warn before clobbering existing configured rules.
    // Previously a stray click on a different mode silently wiped a saved
    // setup (audit trail showed an operator's BY_FILTER_SET config wiped by
    // a subsequent BY_BLOCK mode-switch + save).
    const hasConfiguredRules = rules.some(r => r.matchValue && r.profileId);
    if (hasConfiguredRules && newMode !== mode) {
      const ok = window.confirm(
        `Switching mode will reset the ${rules.length} currently-configured rule${rules.length === 1 ? '' : 's'}. Continue?`,
      );
      if (!ok) return;
    }
    setMode(newMode);
    if (newMode === 'BY_FILTER_SET') {
      // 2026-05-29 bug fix #1: seed with the canonical SET_A / SET_B values
      // that match what filter_details.filter_set stores. The previous 'A'/'B'
      // seeds never matched any filter at resolution time (resolver compared
      // 'B' === 'SET_B' → always false → fell through to default).
      setRules([
        { matchValue: 'SET_A', profileId: '' },
        { matchValue: 'SET_B', profileId: '' },
      ]);
    } else {
      setRules([]);
    }
  };

  const addRule = () => {
    setRules(prev => [...prev, { matchValue: '', profileId: '' }]);
  };

  const removeRule = (index: number) => {
    setRules(prev => prev.filter((_, i) => i !== index));
  };

  const updateRule = (index: number, field: keyof AssignmentRule, value: string) => {
    setRules(prev => prev.map((r, i) => i === index ? { ...r, [field]: value } : r));
  };

  // Operator request 2026-05-25: prevent a second rule from being created for
  // an entity (block / AHU / filter / size) that already has one. Two rules
  // for the same key would race against each other in resolveFilterProfile()
  // — the first match wins, the second is dead data.
  //
  // We surface this two ways:
  //   1. Each rule's match-value dropdown excludes values used by OTHER rules
  //      (the current rule's own value stays visible so the user can see what
  //      they picked).
  //   2. The "Add Rule" button disables once every possible value has been
  //      assigned. matchValue=''-rules (operator picked a profile but no
  //      target yet) don't count as "used" for either calculation.
  // BY_FILTER_SET is exempt — it's seeded with both A and B at mode-change
  // time and the UI doesn't let the operator add/remove rows for it.
  const usedValuesByOtherRules = (currentIndex: number) =>
    new Set(
      rules
        .filter((_, idx) => idx !== currentIndex)
        .map(r => r.matchValue)
        .filter(Boolean),
    );

  const totalAvailableForMode = () => {
    switch (mode) {
      case 'BY_FILTER_SIZE': return filterSizes.length;
      case 'BY_ENTITY':      return filterInstances.length;
      case 'BY_AHU':         return ahuInstances.length;
      case 'BY_BLOCK':       return blockAndAreaInstances.length;
      default:               return Infinity;
    }
  };
  // 2026-05-29 bug fix #4: previously fired when total === 0 (0 >= 0 is true),
  // so Add Rule was permanently disabled in any mode whose pool was empty
  // (BY_ENTITY with no detected filter templates, BY_FILTER_SIZE with no
  // micron sizes configured, etc.). Now requires the pool to be non-empty
  // before we ever disable Add Rule. The "pool empty" state surfaces as the
  // empty-state hint in the table area instead of an unclickable button.
  const totalForMode = totalAvailableForMode();
  const allOptionsAssigned =
    mode !== 'BY_FILTER_SET'
    && totalForMode > 0
    && rules.filter(r => r.matchValue).length >= totalForMode;

  // Audit 2026-05-04 fix #5 (web-routes review H — lower-blast config
  // surfaces). UPDATE_CONFIG_PAGE umbrella; backend mirror in
  // static-routes/cleaning-profile-assignment.routes.ts.
  const reauthCpa = useReauth();
  const handleSave = () => {
    setSaving(true);
    const body = { mode, rules };
    reauthCpa.execute(
      'UPDATE_CONFIG_PAGE',
      async (password?: string) => {
        if (password) await api.putWithReauth('/api/config/cleaning-profile-assignment', body, password);
        else await apiClient.put('/api/config/cleaning-profile-assignment', body);
      },
      {
        onSuccess: () => {
          mutate('/api/config/cleaning-profile-assignment');
          toast.success('Configuration saved', 'Cleaning profile assignment updated successfully.');
          setSaving(false);
        },
        onError: (e: any) => {
          toast.error('Save failed', e.message || 'Failed to save configuration');
          setSaving(false);
        },
      },
    );
  };

  const getInstanceName = (id: string) => {
    // A-01 Wave 5: search across all hierarchy pools (was: single legacy
    // instances[] array). Order: filters → ahus → areas → blocks.
    const inst =
      filterInstances.find(i => i.id === id) ||
      ahuInstances.find(i => i.id === id) ||
      areaInstances.find(i => i.id === id) ||
      blockInstances.find(i => i.id === id);
    return inst?.name || id;
  };

  const getProfileName = (id: string) => {
    const p = profiles.find(pr => pr.id === id);
    return p?.name || '';
  };

  const renderMatchDropdown = (rule: AssignmentRule, index: number) => {
    // Used elsewhere → hide from this row's options (the row's own current
    // value stays visible so the user can still see what they picked).
    const used = usedValuesByOtherRules(index);

    switch (mode) {
      case 'BY_FILTER_SIZE': {
        const available = filterSizes.filter(s => s === rule.matchValue || !used.has(s));
        return (
          <select
            value={rule.matchValue}
            onChange={e => updateRule(index, 'matchValue', e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
          >
            <option value="">Select filter dimensions...</option>
            {available.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        );
      }

      case 'BY_ENTITY': {
        const available = filterInstances.filter(f => f.id === rule.matchValue || !used.has(f.id));
        return (
          <select
            value={rule.matchValue}
            onChange={e => updateRule(index, 'matchValue', e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
          >
            <option value="">Select filter...</option>
            {available.map(f => (
              <option key={f.id} value={f.id}>{f.name || f.id}</option>
            ))}
          </select>
        );
      }

      case 'BY_AHU': {
        const available = ahuInstances.filter(a => a.id === rule.matchValue || !used.has(a.id));
        return (
          <select
            value={rule.matchValue}
            onChange={e => updateRule(index, 'matchValue', e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
          >
            <option value="">Select AHU...</option>
            {available.map(a => (
              <option key={a.id} value={a.id}>{a.name || a.id}</option>
            ))}
          </select>
        );
      }

      case 'BY_BLOCK': {
        const available = blockAndAreaInstances.filter(b => b.id === rule.matchValue || !used.has(b.id));
        return (
          <select
            value={rule.matchValue}
            onChange={e => updateRule(index, 'matchValue', e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
          >
            <option value="">Select block / area...</option>
            {available.map(b => (
              <option key={b.id} value={b.id}>{b.name || b.id}</option>
            ))}
          </select>
        );
      }

      case 'BY_FILTER_SET':
        return (
          <div className="px-3 py-2 rounded-lg bg-slate-100 border border-slate-200 text-sm font-medium text-slate-700">
            {/* 2026-05-29 bug fix #1: matchValue is now stored as 'SET_A'/'SET_B'
                (matching filter_details.filter_set) but legacy saved configs
                may still hold 'A'/'B' — strip the optional SET_ prefix for
                display. Both formats render as "Set A" / "Set B". */}
            Set {rule.matchValue.replace(/^SET_/, '')}
          </div>
        );

      default:
        return null;
    }
  };

  const getMatchColumnLabel = () => {
    switch (mode) {
      case 'BY_FILTER_SIZE': return 'Filter Dimensions';
      case 'BY_ENTITY': return 'Filter';
      case 'BY_AHU': return 'AHU';
      case 'BY_BLOCK': return 'Block / Area';
      case 'BY_FILTER_SET': return 'Filter Set';
      default: return 'Match';
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-6">
        {/* Panel toolbar */}
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-slate-500 max-w-2xl">Configure how cleaning profiles are automatically assigned to filters.</p>
          <button
            onClick={handleSave}
            disabled={saving}
            className="shrink-0 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-teal-500 to-cyan-600 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save Configuration'}
          </button>
        </div>

        {/* Mode Selector */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="px-6 py-4 border-b border-slate-100">
            <h2 className="text-base font-semibold text-slate-800">Assignment Mode</h2>
            <p className="text-sm text-slate-500 mt-0.5">Choose how cleaning profiles are matched to filters. Direct filter-profile assignments always take priority over config-based rules.</p>
          </div>
          <div className="p-6 space-y-3">
            {MODE_OPTIONS.map(opt => (
              <label
                key={opt.value}
                className={`flex items-start gap-3 p-4 rounded-lg border-2 cursor-pointer transition-all ${
                  mode === opt.value
                    ? 'border-blue-500 bg-blue-50/50'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <input
                  type="radio"
                  name="assignment-mode"
                  value={opt.value}
                  checked={mode === opt.value}
                  onChange={() => handleModeChange(opt.value)}
                  className="mt-0.5 w-4 h-4 text-blue-600 border-slate-300 focus:ring-blue-500"
                />
                <div>
                  <div className="font-medium text-slate-800 text-sm">{opt.label}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{opt.description}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Rules Table */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-800">Assignment Rules</h2>
              <p className="text-sm text-slate-500 mt-0.5">
                {rules.length === 0
                  ? 'No rules configured. Add rules to map values to cleaning profiles.'
                  : `${rules.length} rule${rules.length === 1 ? '' : 's'} configured`
                }
              </p>
            </div>
            {mode !== 'BY_FILTER_SET' && (
              <button
                onClick={addRule}
                disabled={allOptionsAssigned}
                title={allOptionsAssigned ? `Every ${getMatchColumnLabel().toLowerCase()} already has a rule` : undefined}
                className="px-4 py-2 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 font-medium text-sm transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-slate-100"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Rule
              </button>
            )}
          </div>

          <div className="p-6">
            {rules.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <svg className="w-12 h-12 mx-auto mb-3 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                <p className="text-sm">No assignment rules yet</p>
                <p className="text-xs mt-1">Click "Add Rule" to create your first mapping</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider pb-3 pr-4">{getMatchColumnLabel()}</th>
                      <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider pb-3 pr-4">Cleaning Profile</th>
                      <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wider pb-3 w-16">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rules.map((rule, index) => (
                      <tr key={index} className="group">
                        <td className="py-3 pr-4 w-[45%]">
                          {renderMatchDropdown(rule, index)}
                        </td>
                        <td className="py-3 pr-4 w-[45%]">
                          <select
                            value={rule.profileId}
                            onChange={e => updateRule(index, 'profileId', e.target.value)}
                            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                          >
                            <option value="">Select profile...</option>
                            {activeProfiles.map(p => (
                              <option key={p.id} value={p.id}>{p.name}{p.status && p.status !== 'ACTIVE' ? ` (${p.status.toLowerCase()})` : ''}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-3 text-right w-16">
                          {mode !== 'BY_FILTER_SET' && (
                            <button
                              onClick={() => removeRule(index)}
                              className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                              title="Remove rule"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Info Banner */}
        <div className="bg-blue-50 rounded-xl border border-blue-200 p-5">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="text-sm text-blue-800">
              <p className="font-medium mb-1">How profile assignment works</p>
              <ul className="space-y-1 text-blue-700 text-xs list-disc list-inside">
                <li>A filter with a direct profile assignment (via Filter Profiles) always uses that profile, regardless of this config.</li>
                <li>This config-based assignment is a fallback for filters without a direct profile.</li>
                <li>When starting a cleaning cycle, the system resolves the profile using this priority: direct assignment, then config rules.</li>
                <li>If no match is found in the rules, the filter will show "No Profile Assigned".</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      <ReauthDialog
        open={reauthCpa.isOpen}
        password={reauthCpa.password}
        error={reauthCpa.error}
        isVerifying={reauthCpa.isVerifying}
        onPasswordChange={reauthCpa.setPassword}
        onConfirm={reauthCpa.confirm}
        onCancel={() => { reauthCpa.cancel(); setSaving(false); }}
        actionLabel="Update Cleaning Profile Assignment"
      />
    </div>
  );
}
