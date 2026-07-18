import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { themeButton } from '@/lib/theme-styles';

// One page that gathers every "who-does-what" role assignment across the app:
// PM Schedule workflow, Replacement Schedule workflow, QNN visibility, Guest
// requests. Each section reads/writes its own config key via
// /api/config/dynamic/<key>. The defs behind these keys stay registered
// (hasCustomPage:false) only so those dynamic endpoints exist — this page is
// their single editing surface (the standalone config cards were removed).

const CONFIG_KEYS = ['pm-schedule-approval', 'replacement-schedule-approval', 'qnn-notifications', 'guest-cleaning-requests', 'block-change-approval', 'stage-interlock', 'pm-schedule-settings'] as const;
type CfgKey = (typeof CONFIG_KEYS)[number];

const CROSS_BLOCK_MODES = [
  { v: 'NONE', label: 'No restriction', hint: 'Any filter can be cleaned in any block — nothing is shown or asked.' },
  { v: 'CONFIRM', label: 'Self-confirm', hint: 'The operator confirms “Continue with cleaning?” and proceeds.' },
  { v: 'APPROVAL', label: 'Needs approval', hint: 'The operator submits a request that an approver must approve before cleaning.' },
] as const;

function useRoleOptions(): { name: string; label: string }[] {
  // Always refetch on mount and bypass the 5s dedupe window, so a role created
  // or renamed on the Roles & Access page shows up here immediately. With the
  // global SWR config (dedupingInterval: 5000) this hook could serve a stale
  // cached snapshot right after a role change — which reads as "roles don't
  // update dynamically". Mirrors the role-access page's own roles fetch.
  const { data } = useSWR<any>('/api/roles/active', { revalidateOnMount: true, dedupingInterval: 0 });
  const raw = Array.isArray(data) ? data : (data?.data ?? []);
  // value = role NAME (configs store names); label = displayName for the UI so
  // renamed roles read correctly.
  return raw
    .map((r: any) => (typeof r === 'string'
      ? { name: r, label: r }
      : { name: r.name ?? r.value ?? '', label: r.displayName ?? r.name ?? r.value ?? '' }))
    .filter((r: { name: string }) => r.name);
}

// ── Section icons (outline, 20px) ─────────────────────────────────────────
const Icons = {
  pm: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  ),
  replacement: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  ),
  qnn: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  ),
  guest: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
    </svg>
  ),
  block: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  ),
  interlock: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  ),
  pmSettings: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  ),
};

const EMPTY_CFG: Record<CfgKey, Record<string, any>> = {
  'pm-schedule-approval': {}, 'replacement-schedule-approval': {}, 'qnn-notifications': {}, 'guest-cleaning-requests': {}, 'block-change-approval': {}, 'stage-interlock': {}, 'pm-schedule-settings': {},
};

// Stable deep-equality for plain JSON config values (object keys order-insensitive).
// Used to detect which sections actually changed, so Save All only PUTs — and
// therefore only audit-logs (CONFIG_CHANGED) — the keys the user edited.
function jsonEqual(a: any, b: any): boolean {
  const norm = (v: any): any =>
    Array.isArray(v) ? v.map(norm)
    : (v && typeof v === 'object'
        ? Object.keys(v).sort().reduce((o: any, k) => { o[k] = norm(v[k]); return o; }, {})
        : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

// ── Primitives ─────────────────────────────────────────────────────────────
// These MUST stay at module scope. Declared inside RoleAssignmentsPage they got
// a new component identity on every render, so React remounted the whole card
// subtree — the number inputs below lost focus after each keystroke.

/** A single workflow step (Upload / Review / Approve) — a role picker with a
 *  step number, rendered as a vertical, connected sequence. */
const WorkflowStep = ({ cfg, patch, roles, k, field, n, last, title, blankLabel }: {
  cfg: Record<CfgKey, Record<string, any>>;
  patch: (key: CfgKey, field: string, value: any) => void;
  roles: { name: string; label: string }[];
  k: CfgKey; field: string; n: number; last?: boolean; title: string; blankLabel: string;
}) => (
  <div className="relative flex gap-3">
    {/* connector line down to the next step */}
    {!last && <span className="absolute left-[13px] top-7 bottom-[-14px] w-px bg-slate-200" aria-hidden />}
    <span className="relative z-10 mt-0.5 shrink-0 grid place-items-center w-[26px] h-[26px] rounded-full bg-cyan-600 text-white text-[12px] font-bold ring-4 ring-white">
      {n}
    </span>
    <label className="flex-1 min-w-0">
      <span className="block text-[13px] font-semibold text-slate-700">{title}</span>
      <select value={cfg[k]?.[field] ?? ''} onChange={(e) => patch(k, field, e.target.value)}
        className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-400">
        <option value="">{blankLabel}</option>
        {roles.map((r) => <option key={r.name} value={r.name}>{r.label}</option>)}
      </select>
    </label>
  </div>
);

const Switch = ({ on, onClick }: { on: boolean; onClick: () => void }) => (
  <button type="button" onClick={onClick} aria-pressed={on}
    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 ${on ? 'bg-cyan-600' : 'bg-slate-300'}`}>
    <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
  </button>
);

/** Multi-role picker rendered as toggle chips. */
const RoleChips = ({ cfg, roles, toggleArr, k, field }: {
  cfg: Record<CfgKey, Record<string, any>>;
  roles: { name: string; label: string }[];
  toggleArr: (key: CfgKey, field: string, role: string) => void;
  k: CfgKey; field: string;
}) => {
  const sel: string[] = Array.isArray(cfg[k]?.[field]) ? cfg[k][field] : [];
  if (roles.length === 0) {
    return <div className="text-sm text-slate-400 border border-dashed border-slate-200 rounded-lg px-3 py-6 text-center">No roles defined yet. Create one on Roles &amp; Access.</div>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {roles.map((r) => {
        const active = sel.includes(r.name);
        return (
          <button type="button" key={r.name} onClick={() => toggleArr(k, field, r.name)} aria-pressed={active}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 ${
              active
                ? 'bg-cyan-600 border-cyan-600 text-white shadow-sm'
                : 'bg-white border-slate-200 text-slate-600 hover:border-cyan-300 hover:text-cyan-700'
            }`}>
            <svg className={`w-3.5 h-3.5 transition-opacity ${active ? 'opacity-100' : 'opacity-0 w-0 -ml-1.5'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
            {r.label}
          </button>
        );
      })}
    </div>
  );
};

const Card = ({ icon, tint, title, desc, wide, children }: {
  icon: React.ReactNode; tint: 'cyan' | 'teal'; title: string; desc: string; wide?: boolean; children: React.ReactNode;
}) => (
  <section className={`flex flex-col bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden ${wide ? 'lg:col-span-2' : ''}`}>
    <header className="flex items-start gap-3 px-5 py-4 border-b border-slate-100 bg-slate-50/60">
      <span className={`shrink-0 grid place-items-center w-10 h-10 rounded-xl ${tint === 'cyan' ? 'bg-cyan-50 text-cyan-700' : 'bg-teal-50 text-teal-700'}`}>
        {icon}
      </span>
      <div className="min-w-0">
        <h2 className="text-[15px] font-bold text-slate-800 leading-tight">{title}</h2>
        <p className="text-xs text-slate-500 mt-0.5">{desc}</p>
      </div>
    </header>
    <div className="p-5 flex-1">{children}</div>
  </section>
);

const WorkflowToggle = ({ on, onClick, hint }: { on: boolean; onClick: () => void; hint?: string }) => (
  <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3 mb-5">
    <div className="min-w-0">
      <span className="block text-[13px] font-semibold text-slate-700">Review &amp; approval workflow</span>
      <span className="text-xs text-slate-500">
        {on ? 'Uploads must be reviewed, then approved.' : 'Uploads are approved in a single step.'}
        {hint && <span className="ml-1 text-slate-400">{hint}</span>}
      </span>
    </div>
    <Switch on={on} onClick={onClick} />
  </div>
);

export function RoleAssignmentsPage() {
  const { toast } = useToast();
  const roles = useRoleOptions();
  const [cfg, setCfg] = useState<Record<CfgKey, Record<string, any>>>(EMPTY_CFG);
  // Last-saved (or last-loaded) snapshot — Save All diffs against this.
  const [baseline, setBaseline] = useState<Record<CfgKey, Record<string, any>>>(EMPTY_CFG);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const entries = await Promise.all(CONFIG_KEYS.map(async (k) => {
        try { return [k, (await apiClient.get<any>(`/api/config/dynamic/${k}`)) ?? {}] as const; }
        catch { return [k, {}] as const; }
      }));
      if (!alive) return;
      const obj = Object.fromEntries(entries) as Record<CfgKey, Record<string, any>>;
      setCfg(obj);
      // Independent clone so editing cfg never mutates the comparison baseline.
      setBaseline(JSON.parse(JSON.stringify(obj)));
      setLoaded(true);
    })();
    return () => { alive = false; };
  }, []);

  const patch = (key: CfgKey, field: string, value: any) => {
    setCfg((p) => ({ ...p, [key]: { ...p[key], [field]: value } }));
  };

  const toggleArr = (key: CfgKey, field: string, role: string) => {
    const cur: string[] = Array.isArray(cfg[key]?.[field]) ? cfg[key][field] : [];
    patch(key, field, cur.includes(role) ? cur.filter((r) => r !== role) : [...cur, role]);
  };

  // Only the sections whose value differs from the saved baseline get written.
  const changedKeys = loaded ? CONFIG_KEYS.filter((k) => !jsonEqual(cfg[k] ?? {}, baseline[k] ?? {})) : [];
  const dirty = changedKeys.length > 0;

  const saveAll = async () => {
    if (changedKeys.length === 0) return;
    setSaving(true);
    try {
      await Promise.all(changedKeys.map((k) => apiClient.put(`/api/config/dynamic/${k}`, cfg[k])));
      // Advance the baseline for just the keys we saved.
      setBaseline((b) => ({ ...b, ...Object.fromEntries(changedKeys.map((k) => [k, JSON.parse(JSON.stringify(cfg[k]))])) }));
      toast.success('Saved', changedKeys.length === 1 ? '1 section updated.' : `${changedKeys.length} sections updated.`);
    } catch (e: any) {
      toast.error('Save failed', e?.message ?? 'Could not save role assignments.');
    } finally { setSaving(false); }
  };

  if (!loaded) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-56 rounded-2xl border border-slate-200 bg-white animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  // Replacement workflow inherits the PM toggle until explicitly set here.
  const rsWf = cfg['replacement-schedule-approval']?.workflowEnabled;
  const pmWfOn = cfg['pm-schedule-approval']?.workflowEnabled === true;
  const rsInheriting = typeof rsWf !== 'boolean';
  const rsEffective = rsInheriting ? pmWfOn : rsWf === true;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header / action bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid place-items-center w-11 h-11 rounded-2xl bg-gradient-to-br from-cyan-500 to-teal-600 text-white shadow-lg shadow-cyan-500/20">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zm6 0a3 3 0 10-2.5-1.35M9 9a3 3 0 10-2.5 4.65" />
            </svg>
          </span>
          <div>
            <h1 className="text-xl font-bold text-slate-800 leading-tight">Role Assignments</h1>
            <p className="text-sm text-slate-500">Decide which roles run each workflow and see each notification. Super Admin always has access.</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {dirty && (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-amber-600">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              Unsaved changes
            </span>
          )}
          <button onClick={saveAll} disabled={saving || !dirty}
            className="px-4 py-2.5 text-white rounded-xl text-sm font-semibold shadow-sm transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            style={themeButton}>
            {saving ? 'Saving…' : 'Save All'}
          </button>
        </div>
      </div>

      {/* 2-up grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <Card icon={Icons.pm} tint="cyan" title="PM Schedule Workflow"
          desc="Who uploads, reviews, and approves PM schedules.">
          <WorkflowToggle on={pmWfOn} onClick={() => patch('pm-schedule-approval', 'workflowEnabled', !pmWfOn)} />
          <div className="space-y-3.5">
            <WorkflowStep cfg={cfg} patch={patch} roles={roles} k="pm-schedule-approval" field="uploadRole" n={1} title="Upload" blankLabel="Anyone with permission" />
            <WorkflowStep cfg={cfg} patch={patch} roles={roles} k="pm-schedule-approval" field="reviewRole" n={2} title="Review" blankLabel="Anyone with permission" />
            <WorkflowStep cfg={cfg} patch={patch} roles={roles} k="pm-schedule-approval" field="approvalRole" n={3} last title="Approve" blankLabel="Anyone with permission" />
          </div>
        </Card>

        <Card icon={Icons.replacement} tint="cyan" title="Replacement Schedule Workflow"
          desc="Who uploads, reviews, and approves replacement schedules. Leave a field on “Inherit from PM” to reuse the PM setting.">
          <WorkflowToggle on={rsEffective}
            onClick={() => patch('replacement-schedule-approval', 'workflowEnabled', !rsEffective)}
            hint={rsInheriting ? '(inheriting from PM)' : undefined} />
          <div className="space-y-3.5">
            <WorkflowStep cfg={cfg} patch={patch} roles={roles} k="replacement-schedule-approval" field="uploadRole" n={1} title="Upload" blankLabel="Inherit from PM" />
            <WorkflowStep cfg={cfg} patch={patch} roles={roles} k="replacement-schedule-approval" field="reviewRole" n={2} title="Review" blankLabel="Inherit from PM" />
            <WorkflowStep cfg={cfg} patch={patch} roles={roles} k="replacement-schedule-approval" field="approvalRole" n={3} last title="Approve" blankLabel="Inherit from PM" />
          </div>
        </Card>

        <Card icon={Icons.qnn} tint="teal" title="QNN Notifications"
          desc="Which roles see Quality Notification (QNN) entries in the Notifications center.">
          <RoleChips cfg={cfg} roles={roles} toggleArr={toggleArr} k="qnn-notifications" field="visibleRoles" />
        </Card>

        <Card icon={Icons.guest} tint="teal" title="Guest Cleaning Requests"
          desc="Which roles receive guest filter-cleaning requests sent from the login page.">
          <RoleChips cfg={cfg} roles={roles} toggleArr={toggleArr} k="guest-cleaning-requests" field="recipientRoles" />
        </Card>

        <Card icon={Icons.block} tint="cyan" wide title="Cross-Block Cleaning"
          desc="How cleaning a filter in a block other than its home block is handled, and who approves it.">
          {(() => {
            const bk: CfgKey = 'block-change-approval';
            const mode = (cfg[bk]?.mode as string) ?? 'CONFIRM';
            const active = CROSS_BLOCK_MODES.find((m) => m.v === mode) ?? CROSS_BLOCK_MODES[1];
            return (
              <div className="space-y-4">
                {/* Mode — segmented control */}
                <div className="flex flex-wrap items-center gap-3">
                  <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
                    {CROSS_BLOCK_MODES.map((m) => (
                      <button type="button" key={m.v} onClick={() => patch(bk, 'mode', m.v)} aria-pressed={mode === m.v}
                        className={`px-3.5 py-1.5 rounded-lg text-[13px] font-semibold transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 ${
                          mode === m.v ? 'bg-white text-cyan-700 shadow-sm border border-slate-200' : 'text-slate-500 hover:text-slate-700'
                        }`}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500 flex-1 min-w-[200px]">{active.hint}</p>
                </div>

                {/* Approval settings — only relevant when a request must be approved */}
                {mode === 'APPROVAL' && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-slate-100">
                    <label className="block">
                      <span className="block text-[13px] font-semibold text-slate-700 mb-1">Approval role</span>
                      <select value={cfg[bk]?.approvalRole ?? ''} onChange={(e) => patch(bk, 'approvalRole', e.target.value)}
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-400">
                        <option value="">Anyone with permission</option>
                        {roles.map((r) => <option key={r.name} value={r.name}>{r.label}</option>)}
                      </select>
                      <span className="mt-1 block text-[11px] text-slate-400">Super Admin can always approve.</span>
                    </label>

                    <label className="block">
                      <span className="block text-[13px] font-semibold text-slate-700 mb-1">Auto-expire (hours)</span>
                      <input type="number" min={0} value={cfg[bk]?.autoExpireHours ?? 24}
                        onChange={(e) => patch(bk, 'autoExpireHours', e.target.value === '' ? '' : Math.max(0, Number(e.target.value)))}
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-400" />
                      <span className="mt-1 block text-[11px] text-slate-400">0 = approved requests never expire.</span>
                    </label>

                    <div>
                      <span className="block text-[13px] font-semibold text-slate-700 mb-1">Require reason</span>
                      <div className="flex items-center gap-2 h-[38px]">
                        <Switch on={cfg[bk]?.requireReason !== false}
                          onClick={() => patch(bk, 'requireReason', !(cfg[bk]?.requireReason !== false))} />
                        <span className="text-xs text-slate-500">{cfg[bk]?.requireReason !== false ? 'Operator must give a reason' : 'Reason optional'}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </Card>

        <Card icon={Icons.interlock} tint="cyan" wide title="Cleaning Stage Interlock"
          desc="Require a QA approval signature after Wash Out and after Dry Out before a filter can continue cleaning.">
          {(() => {
            const ik: CfgKey = 'stage-interlock';
            const on = cfg[ik]?.enabled === true;
            const diff = cfg[ik]?.requireDifferentApprover !== false;
            return (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
                  <div className="min-w-0">
                    <span className="block text-[13px] font-semibold text-slate-700">Stage interlock</span>
                    <span className="text-xs text-slate-500">
                      {on
                        ? 'Wash Out and Dry Out pause for an approver signature before the operator can advance.'
                        : 'Off — cleaning advances without a QA approval gate.'}
                    </span>
                  </div>
                  <Switch on={on} onClick={() => patch(ik, 'enabled', !on)} />
                </div>

                {on && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-slate-100">
                    <label className="block">
                      <span className="block text-[13px] font-semibold text-slate-700 mb-1">Wash Out approver</span>
                      <select value={cfg[ik]?.washOutApproverRole ?? ''} onChange={(e) => patch(ik, 'washOutApproverRole', e.target.value)}
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-400">
                        <option value="">Super Admin only</option>
                        {roles.map((r) => <option key={r.name} value={r.name}>{r.label}</option>)}
                      </select>
                      <span className="mt-1 block text-[11px] text-slate-400">Plus Super Admin, always.</span>
                    </label>

                    <label className="block">
                      <span className="block text-[13px] font-semibold text-slate-700 mb-1">Dry Out approver</span>
                      <select value={cfg[ik]?.dryOutApproverRole ?? ''} onChange={(e) => patch(ik, 'dryOutApproverRole', e.target.value)}
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-400">
                        <option value="">Super Admin only</option>
                        {roles.map((r) => <option key={r.name} value={r.name}>{r.label}</option>)}
                      </select>
                      <span className="mt-1 block text-[11px] text-slate-400">Plus Super Admin, always.</span>
                    </label>

                    <div>
                      <span className="block text-[13px] font-semibold text-slate-700 mb-1">Different approver</span>
                      <div className="flex items-center gap-2 h-[38px]">
                        <Switch on={diff} onClick={() => patch(ik, 'requireDifferentApprover', !diff)} />
                        <span className="text-xs text-slate-500">{diff ? 'Operator can’t approve own stage' : 'Same person may approve'}</span>
                      </div>
                      <span className="mt-1 block text-[11px] text-slate-400">Recommended for 21 CFR Part 11.</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </Card>

        <Card icon={Icons.pmSettings} tint="teal" wide title="PM Schedule Settings"
          desc="Turn preventive-maintenance scheduling on, set the default tolerance, and choose who sees and is notified about tasks.">
          {(() => {
            const pk: CfgKey = 'pm-schedule-settings';
            const on = cfg[pk]?.enabled === true;
            const overdueSep = cfg[pk]?.showOverdueSeparately !== false;
            const visibility = (cfg[pk]?.taskVisibility as string) ?? 'GLOBAL';
            return (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
                  <div className="min-w-0">
                    <span className="block text-[13px] font-semibold text-slate-700">PM scheduling</span>
                    <span className="text-xs text-slate-500">
                      {on ? 'Preventive-maintenance tasks are generated and shown on My Tasks.' : 'Off — all PM endpoints are disabled.'}
                    </span>
                  </div>
                  <Switch on={on} onClick={() => patch(pk, 'enabled', !on)} />
                </div>

                {on && (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-slate-100">
                      <label className="block">
                        <span className="block text-[13px] font-semibold text-slate-700 mb-1">Default tolerance (days)</span>
                        <input type="number" min={0} max={365} value={cfg[pk]?.defaultToleranceDays ?? 3}
                          onChange={(e) => patch(pk, 'defaultToleranceDays', e.target.value === '' ? '' : Math.min(365, Math.max(0, Number(e.target.value))))}
                          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-400" />
                        <span className="mt-1 block text-[11px] text-slate-400">Used when a CSV row leaves tolerance blank (± days).</span>
                      </label>

                      <label className="block">
                        <span className="block text-[13px] font-semibold text-slate-700 mb-1">Task visibility</span>
                        <select value={visibility} onChange={(e) => patch(pk, 'taskVisibility', e.target.value)}
                          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-400">
                          <option value="GLOBAL">Everyone with PM access</option>
                          <option value="PER_USER">Per-user assignment (not yet implemented)</option>
                          <option value="ROLE_GATED">Role-gated (not yet implemented)</option>
                        </select>
                        {visibility !== 'GLOBAL' && (
                          <span className="mt-1 block text-[11px] text-amber-600">Not yet implemented — the task list will error until this is GLOBAL.</span>
                        )}
                      </label>

                      <div>
                        <span className="block text-[13px] font-semibold text-slate-700 mb-1">Show overdue separately</span>
                        <div className="flex items-center gap-2 h-[38px]">
                          <Switch on={overdueSep} onClick={() => patch(pk, 'showOverdueSeparately', !overdueSep)} />
                          <span className="text-xs text-slate-500">{overdueSep ? 'Own “Overdue” section' : 'Hidden'}</span>
                        </div>
                      </div>
                    </div>

                    <div className="pt-4 border-t border-slate-100">
                      <span className="block text-[13px] font-semibold text-slate-700 mb-1">Overdue notification roles</span>
                      <span className="mb-2 block text-[11px] text-slate-400">Roles that receive overdue + completion alerts for AHU filter-cleaning tasks. Empty = Admin.</span>
                      <RoleChips cfg={cfg} roles={roles} toggleArr={toggleArr} k={pk} field="overdueNotificationRoles" />
                    </div>
                  </>
                )}
              </div>
            );
          })()}
        </Card>
      </div>
    </div>
  );
}
