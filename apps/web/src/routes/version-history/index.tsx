/**
 * Version History — cross-entity audit-history viewer.
 *
 * Surfaces the three versioned-definition histories DigiLog tracks server-side:
 *   - FilterCleaningProfile lineage (Phase A.2)
 *   - ChecklistProfile sidecar    (Phase A.1)
 *   - EquipmentGroup composite    (Phase A.4)
 *
 * (FilterProfile has a server-side version sidecar too, but there is no
 * user-facing Filter Profiles page, so it is intentionally not shown here.)
 *
 * Gated by the VERSION_HISTORY_VIEW permission. SUPER_ADMIN by default;
 * assignable to other roles via Role Privileges → Audit / Versions.
 *
 * v1 layout: tab bar across the top, master-detail per tab. Click an entity in
 * the left list, the right pane lists its archived versions newest-first.
 * Click a version row to see the frozen snapshot in a modal (JSON pretty-print
 * for v1; structured per-entity viewer is a follow-up).
 */
import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import useSWR from 'swr';
import { useDatetimeFormat } from '../../hooks/use-datetime-format';

export type EntityKind = 'cleaning-profile' | 'checklist-profile' | 'equipment-group';

const ENTITY_KINDS: EntityKind[] = ['cleaning-profile', 'checklist-profile', 'equipment-group'];
function isEntityKind(s: string | null): s is EntityKind {
  return s !== null && (ENTITY_KINDS as string[]).includes(s);
}

const TABS: { id: EntityKind; label: string; listEndpoint: string; itemLabel: (it: any) => string; }[] = [
  {
    id: 'cleaning-profile',
    label: 'Cleaning Profiles',
    listEndpoint: '/api/filter-cleaning-profiles?page=1&limit=200',
    itemLabel: it => `${it.name ?? '(unnamed)'} · v${it.version ?? '?'}`,
  },
  {
    id: 'checklist-profile',
    label: 'Checklist Profiles',
    listEndpoint: '/api/checklist-profiles?page=1&limit=200',
    itemLabel: it => `${it.name ?? '(unnamed)'} · v${it.version ?? '?'}`,
  },
  {
    id: 'equipment-group',
    label: 'Equipment Groups',
    listEndpoint: '/api/equipment-groups',
    itemLabel: it => `${it.name ?? '(unnamed)'} · v${it.version ?? '?'}`,
  },
];

function versionsEndpoint(kind: EntityKind, id: string): string {
  switch (kind) {
    case 'cleaning-profile': return `/api/filter-cleaning-profiles/${id}/versions`;
    case 'checklist-profile': return `/api/checklist-profiles/${id}/versions`;
    case 'equipment-group': return `/api/equipment-groups/${id}/versions`;
  }
}

function snapshotEndpoint(kind: EntityKind, id: string, version: number): string {
  switch (kind) {
    case 'cleaning-profile': return `/api/filter-cleaning-profiles/${id}/versions/${version}`;
    case 'checklist-profile': return `/api/checklist-profiles/${id}/versions/${version}`;
    case 'equipment-group': return `/api/equipment-groups/${id}/versions/${version}`;
  }
}

export function VersionHistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // CHVH (2026-05-02): deep-link via ?entity=<kind>&id=<uuid>&v=<n>. Lands the
  // page on the right tab + selects the entity + opens the snapshot modal at
  // version v. Used by the Pinned Versions chips on the cleaning-cycle
  // timeline page.
  const initialTab = isEntityKind(searchParams.get('entity')) ? (searchParams.get('entity') as EntityKind) : 'cleaning-profile';
  const [tab, setTab] = useState<EntityKind>(initialTab);
  const [selected, setSelected] = useState<{ kind: EntityKind; id: string; name: string } | null>(null);
  const [snapshot, setSnapshot] = useState<{ kind: EntityKind; id: string; version: number } | null>(null);

  // On first mount with a deep-link, synthesize the selection + snapshot from
  // the URL so the user lands directly in the right view. We don't have the
  // entity name yet (we'd need to wait for the list to load); use the id as a
  // placeholder label and let the entity-list selection update it once data
  // arrives.
  useEffect(() => {
    const entity = searchParams.get('entity');
    const id = searchParams.get('id');
    const v = searchParams.get('v');
    if (isEntityKind(entity) && id) {
      setSelected({ kind: entity, id, name: id.slice(0, 8) + '…' });
      if (v) setSnapshot({ kind: entity, id, version: Number(v) });
    }
    // Eslint exhaustive-deps would want searchParams here, but we only want to
    // run this once on mount — manual nav within the page should NOT re-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tabConfig = TABS.find(t => t.id === tab)!;
  // Reset selection when tab changes -- different entity kinds have different IDs.
  const onTabChange = (next: EntityKind) => {
    setTab(next);
    setSelected(null);
    setSnapshot(null);
    // Clear the deep-link params so back/forward doesn't reopen the modal.
    if (searchParams.has('entity') || searchParams.has('id') || searchParams.has('v')) {
      setSearchParams({}, { replace: true });
    }
  };

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="p-3 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/25">
          <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Version History</h1>
          <p className="text-sm text-slate-500">Audit-replay history for versioned definitions. Updates archive the previous state into a sidecar; cycles pin to a specific version at start.</p>
        </div>
      </div>

      <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => onTabChange(t.id)}
            className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-all ${
              tab === t.id ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <EntityList
          tabConfig={tabConfig}
          selectedId={selected?.id ?? null}
          onSelect={(id, name) => { setSelected({ kind: tab, id, name }); setSnapshot(null); }}
        />
        <div className="md:col-span-2 bg-white rounded-2xl border-2 border-slate-200 p-6 shadow-sm min-h-[20rem]">
          {selected ? (
            <VersionTimeline
              kind={selected.kind}
              entityId={selected.id}
              entityName={selected.name}
              onPickVersion={v => setSnapshot({ kind: selected.kind, id: selected.id, version: v })}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-slate-400">
              Pick an entity on the left to see its version timeline.
            </div>
          )}
        </div>
      </div>

      {snapshot && (
        <SnapshotModal
          kind={snapshot.kind}
          entityId={snapshot.id}
          version={snapshot.version}
          onClose={() => setSnapshot(null)}
        />
      )}
    </div>
  );
}

function EntityList({
  tabConfig,
  selectedId,
  onSelect,
}: {
  tabConfig: typeof TABS[number];
  selectedId: string | null;
  onSelect: (id: string, name: string) => void;
}) {
  const { data, error } = useSWR<any>(tabConfig.listEndpoint);
  // Endpoints differ: paginated wrappers return { data: [...] }; equipment-groups list returns the array directly.
  const items: any[] = Array.isArray(data) ? data : (data?.data ?? []);

  if (error) {
    return (
      <div className="bg-white rounded-2xl border-2 border-red-200 p-4 text-sm text-red-700">
        Failed to load: {error.message}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="bg-white rounded-2xl border-2 border-slate-200 p-4 text-sm text-slate-400">Loading…</div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="bg-white rounded-2xl border-2 border-slate-200 p-4 text-sm text-slate-400">
        No {tabConfig.label.toLowerCase()} yet.
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border-2 border-slate-200 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide font-semibold text-slate-500">
        {items.length} {tabConfig.label}
      </div>
      <div className="divide-y divide-slate-100 max-h-[32rem] overflow-y-auto">
        {items.map(it => (
          <button
            key={it.id}
            onClick={() => onSelect(it.id, it.name ?? it.id)}
            className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${
              selectedId === it.id ? 'bg-indigo-50 border-l-2 border-indigo-500' : ''
            }`}
          >
            <div className="text-sm font-medium text-slate-800">{tabConfig.itemLabel(it)}</div>
            {it.description && <div className="text-xs text-slate-500 mt-0.5 truncate">{it.description}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

function VersionTimeline({
  kind,
  entityId,
  entityName,
  onPickVersion,
}: {
  kind: EntityKind;
  entityId: string;
  entityName: string;
  onPickVersion: (v: number) => void;
}) {
  const { data, error } = useSWR<any>(versionsEndpoint(kind, entityId));

  if (error) {
    return <div className="text-sm text-red-700">Failed to load versions: {error.message}</div>;
  }
  if (!data) {
    return <div className="text-sm text-slate-400">Loading version history…</div>;
  }

  // Endpoint shapes vary slightly across the four entities:
  //   cleaning-profile (A.2): { lineageId, versions: [...] }
  //   checklist-profile (A.1): array of versions directly
  //   equipment-group (A.4): { groupId, currentVersion, versions: [...] }
  const versions: any[] = Array.isArray(data) ? data : (data.versions ?? []);
  const currentVersion: number | undefined = data.currentVersion;
  const lineageInfo: string | undefined = data.lineageId ? `Lineage ${data.lineageId.slice(0, 8)}…` : undefined;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">{entityName}</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {currentVersion !== undefined && <>Current version <strong>v{currentVersion}</strong> · </>}
            {versions.length} archived version{versions.length === 1 ? '' : 's'}
            {lineageInfo && <> · {lineageInfo}</>}
          </p>
        </div>
      </div>

      {versions.length === 0 ? (
        <div className="text-sm text-slate-400 py-8 text-center">
          No archived versions yet. The first version is created lazily on first edit — the live row IS v1 until then.
        </div>
      ) : (
        <ol className="relative border-l-2 border-slate-200 ml-3 space-y-4">
          {versions.map(v => {
            const versionNumber: number = v.versionNumber ?? v.version;
            return (
              <VersionTimelineRow
                key={`${v.id ?? versionNumber}`}
                kind={kind}
                entityId={entityId}
                versionNumber={versionNumber}
                changeNotes={v.changeNotes}
                createdAt={v.createdAt}
                createdBy={v.createdBy}
                onPickVersion={onPickVersion}
              />
            );
          })}
        </ol>
      )}
    </div>
  );
}

function VersionTimelineRow({
  kind,
  entityId,
  versionNumber,
  changeNotes,
  createdAt,
  createdBy,
  onPickVersion,
}: {
  kind: EntityKind;
  entityId: string;
  versionNumber: number;
  changeNotes: string | null;
  createdAt: string | null;
  createdBy: string | null;
  onPickVersion: (v: number) => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const { formatDateTime } = useDatetimeFormat();
  const canCompare = versionNumber > 1; // nothing to compare v1 against — there's no v0.

  return (
    <li className="ml-4">
      <span className="absolute -left-2 w-4 h-4 rounded-full bg-indigo-500 border-2 border-white" />
      <div className="bg-slate-50 border border-slate-200 rounded-xl">
        <button
          onClick={() => onPickVersion(versionNumber)}
          className="w-full text-left px-4 py-3 hover:bg-indigo-50 hover:border-indigo-300 transition-colors rounded-xl"
        >
          <div className="flex items-baseline gap-3">
            <span className="text-sm font-semibold text-slate-800">v{versionNumber}</span>
            {changeNotes && <span className="text-xs text-slate-500">— {changeNotes}</span>}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            {createdAt && <>Archived {formatDateTime(createdAt)}</>}
            {createdBy && <> · by {createdBy.slice(0, 8)}…</>}
          </div>
        </button>
        {canCompare && (
          <div className="border-t border-slate-200 px-4 py-2">
            <button
              onClick={() => setShowDiff(s => !s)}
              className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
            >
              {showDiff ? 'Hide comparison' : `Compare with v${versionNumber - 1}`}
            </button>
            {showDiff && (
              <div className="mt-2 pt-2 border-t border-slate-100">
                {/* Cleaning-profile saves regenerate every node/connection id, so a
                    field-level diff is pure noise (same WASH_IN as both removed +
                    added). Show the whole before/after profile instead. */}
                {kind === 'cleaning-profile'
                  ? <VersionCompare kind={kind} entityId={entityId} curr={versionNumber} prev={versionNumber - 1} />
                  : <VersionDiff kind={kind} entityId={entityId} curr={versionNumber} prev={versionNumber - 1} />}
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function VersionDiff({
  kind,
  entityId,
  curr,
  prev,
}: {
  kind: EntityKind;
  entityId: string;
  curr: number;
  prev: number;
}) {
  // Two parallel SWR fetches. Snapshots are immutable so they cache forever.
  const { data: prevData, error: prevErr } = useSWR<any>(snapshotEndpoint(kind, entityId, prev));
  const { data: currData, error: currErr } = useSWR<any>(snapshotEndpoint(kind, entityId, curr));

  if (prevErr || currErr) {
    return <div className="text-xs text-red-700">Failed to load snapshots: {(prevErr ?? currErr).message}</div>;
  }
  if (!prevData || !currData) {
    return <div className="text-xs text-slate-400">Loading diff…</div>;
  }
  const changes = diffSnapshots(kind, prevData, currData);
  if (changes.length === 0) {
    return <div className="text-xs text-slate-500 italic">No diffable changes between v{prev} and v{curr}.</div>;
  }
  return (
    <ul className="text-xs space-y-1">
      {changes.map((c, i) => <DiffLine key={i} change={c} />)}
    </ul>
  );
}

// Before/after viewer — renders the full structured snapshot of both versions
// side by side (stacks on narrow screens). Used for cleaning profiles, whose
// per-save id churn makes a field-level diff unreadable.
function VersionCompare({
  kind,
  entityId,
  curr,
  prev,
}: {
  kind: EntityKind;
  entityId: string;
  curr: number;
  prev: number;
}) {
  const { data: prevData, error: prevErr } = useSWR<any>(snapshotEndpoint(kind, entityId, prev));
  const { data: currData, error: currErr } = useSWR<any>(snapshotEndpoint(kind, entityId, curr));

  if (prevErr || currErr) {
    return <div className="text-xs text-red-700">Failed to load snapshots: {(prevErr ?? currErr).message}</div>;
  }
  if (!prevData || !currData) {
    return <div className="text-xs text-slate-400">Loading comparison…</div>;
  }
  // Cleaning profiles: show the pipeline FLOW before vs after (visual, not text).
  const flowCol = (tag: string, tint: string, snap: any) => (
    <div className="min-w-0">
      <div className="mb-2 flex items-center gap-2">
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${tint}`}>{tag}</span>
        {snap.status && <StatusBadge active={snap.status === 'ACTIVE'} label={snap.status} />}
        <span className="text-[11px] text-slate-400">{(snap.stages ?? []).length} nodes</span>
      </div>
      <ProfileFlow stages={snap.stages ?? []} connections={snap.connections ?? []} />
    </div>
  );
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {flowCol(`Before · v${prev}`, 'bg-slate-100 text-slate-600', prevData)}
      {flowCol(`After · v${curr}`, 'bg-indigo-100 text-indigo-700', currData)}
    </div>
  );
}

// Friendly labels for fields whose camelCase split reads awkwardly.
const FIELD_LABELS: Record<string, string> = {
  isActive: 'Active', stateKey: 'State key', nodeType: 'Node type', flowMode: 'Flow mode',
  requiresJustification: 'Requires justification', sortOrder: 'Order', questionType: 'Question type',
  operatingMin: 'Operating min', operatingMax: 'Operating max', instrumentMin: 'Instrument min',
  instrumentMax: 'Instrument max', leastCount: 'Least count', maxCleaningCycles: 'Max cleaning cycles',
  blockRestriction: 'Block restriction', cleaningReasons: 'Cleaning reasons', serialNumber: 'Serial number',
  alarmOnForwardSkip: 'Alarm on forward skip', alarmOnBackwardJump: 'Alarm on backward jump',
  alarmOnOutOfSequence: 'Alarm on out-of-sequence',
};

// "alarmOnForwardSkip" → "Alarm on forward skip"; "state_key" → "State key".
function humanizeKey(k: string): string {
  if (FIELD_LABELS[k]) return FIELD_LABELS[k];
  const words = k
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// "stages[Wash In].stateKey" → "Stages “Wash In” › State key".
function humanizePath(path: string): string {
  return path
    .split('.')
    .map((seg) => {
      const m = seg.match(/^([A-Za-z0-9_]+)(?:\[(.*)\])?$/);
      if (!m) return seg;
      const base = humanizeKey(m[1]);
      return m[2] !== undefined ? `${base} “${m[2]}”` : base;
    })
    .join(' › ');
}

// Render any snapshot value as plain, human-readable text. `fmtDate`, when
// provided, formats ISO date-time strings per the app's date/time config
// (falls back to a raw locale string only if omitted).
function formatVal(v: any, fmtDate?: (s: string) => string): string {
  if (v === null || v === undefined || v === '') return '(none)';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]/.test(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return fmtDate ? fmtDate(v) : d.toLocaleString();
    }
    return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  }
  if (Array.isArray(v)) {
    return v.length === 0
      ? '(none)'
      : v.map((x) => (x && typeof x === 'object' ? (x.name ?? x.label ?? x.key ?? JSON.stringify(x)) : String(x))).join(', ');
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v).filter(([k]) => !META_FIELDS.has(k));
    if (entries.length === 0) return '(empty)';
    return entries.map(([k, val]) => `${humanizeKey(k)}: ${typeof val === 'boolean' ? (val ? 'Yes' : 'No') : String(val)}`).join('; ');
  }
  return String(v);
}

function DiffLine({ change }: { change: DiffChange }) {
  const { formatDateTime } = useDatetimeFormat();
  const meta = {
    changed: { box: 'bg-amber-50 border-amber-200', tag: 'Changed', tagColor: 'text-amber-700' },
    added: { box: 'bg-emerald-50 border-emerald-200', tag: 'Added', tagColor: 'text-emerald-700' },
    removed: { box: 'bg-rose-50 border-rose-200', tag: 'Removed', tagColor: 'text-rose-700' },
  }[change.kind];
  return (
    <li className={`border rounded-lg px-2.5 py-1.5 ${meta.box}`}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className={`text-[10px] font-bold uppercase tracking-wide ${meta.tagColor}`}>{meta.tag}</span>
        <span className="font-semibold text-slate-800">{humanizePath(change.path)}</span>
      </div>
      {change.kind === 'changed' && (
        <div className="mt-1 flex items-center gap-2 flex-wrap">
          <span className="px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-500">{formatVal(change.oldValue, formatDateTime)}</span>
          <span className="text-slate-400">→</span>
          <span className="px-1.5 py-0.5 rounded bg-white border border-slate-300 font-medium text-slate-900">{formatVal(change.newValue, formatDateTime)}</span>
        </div>
      )}
      {change.kind === 'added' && change.newValue !== undefined && (
        <div className="mt-1"><span className="px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-700">{formatVal(change.newValue, formatDateTime)}</span></div>
      )}
      {change.kind === 'removed' && change.oldValue !== undefined && (
        <div className="mt-1"><span className="px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-500 line-through">{formatVal(change.oldValue, formatDateTime)}</span></div>
      )}
    </li>
  );
}

// ─── Snapshot diff engine ────────────────────────────────────────────────

export type DiffChange =
  | { kind: 'changed'; path: string; oldValue: unknown; newValue: unknown; context?: string }
  | { kind: 'added';   path: string; newValue?: unknown; context?: string }
  | { kind: 'removed'; path: string; oldValue?: unknown; context?: string };

// Fields that change every version (timestamps, author, version pointer) — never
// useful in an admin-edit diff. Filter both the top level and nested refs.
const META_FIELDS = new Set([
  'createdAt', 'updatedAt', 'createdBy', 'updatedBy',
  'versionNumber', 'version', 'changeNotes',
  'profileId', 'groupId', 'id', 'lineageId',
]);

// Per-kind: which arrays should be diffed by their item key (vs treated as scalar).
const KEY_BY: Record<EntityKind, Record<string, string>> = {
  'cleaning-profile': { stages: 'id', connections: 'id', cleaningReasons: 'key' },
  'checklist-profile': { questions: 'id' },
  'equipment-group':  { instruments: 'id' },
};

export function diffSnapshots(kind: EntityKind, prev: any, curr: any): DiffChange[] {
  const out: DiffChange[] = [];
  const keys = new Set([...Object.keys(prev ?? {}), ...Object.keys(curr ?? {})]);
  for (const key of keys) {
    if (META_FIELDS.has(key)) continue;
    const a = prev?.[key];
    const b = curr?.[key];
    if (Object.is(a, b)) continue;

    const arrayKey = KEY_BY[kind][key];
    if (arrayKey && Array.isArray(a) && Array.isArray(b)) {
      const aIdx = new Map<unknown, any>(a.map(item => [item?.[arrayKey], item]));
      const bIdx = new Map<unknown, any>(b.map(item => [item?.[arrayKey], item]));
      for (const [id, bItem] of bIdx.entries()) {
        const aItem = aIdx.get(id);
        if (aItem === undefined) {
          out.push({ kind: 'added', path: `${key}[${labelFor(bItem)}]`, newValue: summarize(bItem), context: `${arrayKey}=${String(id).slice(0, 8)}…` });
        } else {
          // Recurse on object diff, prefix the path.
          const subOut = diffObject(aItem, bItem, `${key}[${labelFor(bItem)}]`);
          out.push(...subOut);
        }
      }
      for (const [id, aItem] of aIdx.entries()) {
        if (!bIdx.has(id)) {
          out.push({ kind: 'removed', path: `${key}[${labelFor(aItem)}]`, oldValue: summarize(aItem), context: `${arrayKey}=${String(id).slice(0, 8)}…` });
        }
      }
      continue;
    }

    if (a === undefined) {
      out.push({ kind: 'added', path: key, newValue: b });
    } else if (b === undefined) {
      out.push({ kind: 'removed', path: key, oldValue: a });
    } else if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      out.push(...diffObject(a, b, key));
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ kind: 'changed', path: key, oldValue: a, newValue: b });
    }
  }
  return out;
}

function diffObject(a: any, b: any, prefix: string): DiffChange[] {
  const out: DiffChange[] = [];
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of keys) {
    if (META_FIELDS.has(key)) continue;
    const va = a?.[key];
    const vb = b?.[key];
    if (Object.is(va, vb)) continue;
    if (JSON.stringify(va) === JSON.stringify(vb)) continue;
    if (va === undefined) out.push({ kind: 'added', path: `${prefix}.${key}`, newValue: vb });
    else if (vb === undefined) out.push({ kind: 'removed', path: `${prefix}.${key}`, oldValue: va });
    else out.push({ kind: 'changed', path: `${prefix}.${key}`, oldValue: va, newValue: vb });
  }
  return out;
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// A human label for a keyed list item. Real stages carry a stateKey (WASH_IN…);
// the pipeline's structural nodes (START / END / CHECKLIST) have no stateKey or
// name, so fall back to a readable node-type label ("Start" / "End" / "Checklist")
// before the last-resort id slice — never show a raw UUID where a name belongs.
function labelFor(item: any): string {
  return (
    item?.name ??
    item?.stateKey ??
    item?.question ??
    item?.description ??
    item?.key ??
    (item?.nodeType ? titleCase(item.nodeType) : undefined) ??
    (typeof item?.id === 'string' ? `${item.id.slice(0, 8)}…` : '?')
  );
}

function summarize(item: any): string {
  return labelFor(item);
}

function SnapshotModal({
  kind,
  entityId,
  version,
  onClose,
}: {
  kind: EntityKind;
  entityId: string;
  version: number;
  onClose: () => void;
}) {
  const { data, error } = useSWR<any>(snapshotEndpoint(kind, entityId, version));
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl border-2 border-slate-200 shadow-2xl max-w-4xl w-full max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-semibold text-slate-800">Frozen snapshot · v{version}</h3>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowRaw(s => !s)}
              className="text-xs text-slate-500 hover:text-slate-800 px-3 py-1 border border-slate-200 rounded-lg"
            >
              {showRaw ? 'Hide raw JSON' : 'Show raw JSON'}
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
          </div>
        </div>
        <div className="px-6 py-4 overflow-y-auto flex-1 space-y-4">
          {error && <div className="text-sm text-red-700">Failed to load snapshot: {error.message}</div>}
          {!data && !error && <div className="text-sm text-slate-400">Loading…</div>}
          {data && <SnapshotBody kind={kind} data={data} />}
          {data && showRaw && (
            <details open className="bg-slate-50 border border-slate-200 rounded-xl">
              <summary className="px-4 py-2 cursor-pointer text-xs font-semibold text-slate-600">Raw JSON</summary>
              <pre className="text-xs px-4 pb-4 overflow-x-auto whitespace-pre-wrap break-words">
                {JSON.stringify(data, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Structured snapshot viewers ────────────────────────────────────────

function SnapshotBody({ kind, data }: { kind: EntityKind; data: any }) {
  switch (kind) {
    case 'cleaning-profile': return <CleaningProfileSnapshot data={data} />;
    case 'checklist-profile': return <ChecklistProfileSnapshot data={data} />;
    case 'equipment-group': return <EquipmentGroupSnapshot data={data} />;
  }
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs uppercase tracking-wide text-slate-500 w-32 shrink-0">{label}</span>
      <span className="text-sm text-slate-800">{value ?? <span className="text-slate-400">—</span>}</span>
    </div>
  );
}

function StatusBadge({ active, label }: { active: boolean; label?: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'}`}>
      {label ?? (active ? 'Active' : 'Inactive')}
    </span>
  );
}

// ─── Read-only pipeline flow renderer ───────────────────────────────────
// Mirrors the cleaning-profile editor canvas (same node colors + bezier wiring)
// but static: draws the stored node positions + connections as an SVG that
// scales to fit its container. This is the visual "how the flow looks" view.
const FLOW_NODE_W = 160;
const FLOW_NODE_H = 64;
const FLOW_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  START: { bg: '#166534', border: '#22c55e', text: '#bbf7d0' },
  END: { bg: '#991b1b', border: '#ef4444', text: '#fecaca' },
  STAGE: { bg: '#1e40af', border: '#3b82f6', text: '#bfdbfe' },
  CHECKLIST: { bg: '#6b21a8', border: '#a855f7', text: '#e9d5ff' },
};
function flowBezier(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.abs(x2 - x1) * 0.5;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}
function flowNodeLabel(n: any): string {
  if (n.nodeType === 'STAGE' && n.stateKey) return n.stateKey.replace(/_/g, ' ');
  if (n.nodeType === 'CHECKLIST') return 'Checklist';
  return titleCase(n.nodeType ?? '');
}

function ProfileFlow({ stages, connections }: { stages: any[]; connections: any[] }) {
  const nodes = (stages ?? []).filter((s) => typeof s?.positionX === 'number' && typeof s?.positionY === 'number');
  if (nodes.length === 0) {
    return <div className="text-xs text-slate-400 italic py-6 text-center border border-dashed border-slate-200 rounded-xl">No saved flow layout for this version.</div>;
  }
  const byId = new Map<string, any>(nodes.map((n) => [n.id, n]));
  const PAD = 28;
  const minX = Math.min(...nodes.map((n) => n.positionX)) - PAD;
  const minY = Math.min(...nodes.map((n) => n.positionY)) - PAD;
  const maxX = Math.max(...nodes.map((n) => n.positionX + FLOW_NODE_W)) + PAD;
  const maxY = Math.max(...nodes.map((n) => n.positionY + FLOW_NODE_H)) + PAD;
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 overflow-hidden">
      <svg viewBox={`${minX} ${minY} ${w} ${h}`} width="100%" style={{ height: 'auto', maxHeight: 380, display: 'block' }} preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="vh-flow-arrow" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
            <path d="M0,0 L9,3.5 L0,7 Z" fill="#94a3b8" />
          </marker>
        </defs>
        {(connections ?? []).map((c, i) => {
          const from = byId.get(c.fromStageId);
          const to = byId.get(c.toStageId);
          if (!from || !to) return null;
          const x1 = from.positionX + FLOW_NODE_W, y1 = from.positionY + FLOW_NODE_H / 2;
          const x2 = to.positionX, y2 = to.positionY + FLOW_NODE_H / 2;
          return <path key={c.id ?? i} d={flowBezier(x1, y1, x2, y2)} fill="none" stroke="#94a3b8" strokeWidth={2} markerEnd="url(#vh-flow-arrow)" />;
        })}
        {nodes.map((n, i) => {
          const colors = FLOW_COLORS[n.nodeType] ?? FLOW_COLORS.STAGE;
          const label = flowNodeLabel(n);
          const sub = n.nodeType === 'CHECKLIST' ? (n.configuration?.checklistProfileName ?? '') : '';
          const cx = n.positionX + FLOW_NODE_W / 2;
          const cy = n.positionY + FLOW_NODE_H / 2;
          return (
            <g key={n.id ?? i}>
              <rect x={n.positionX} y={n.positionY} width={FLOW_NODE_W} height={FLOW_NODE_H} rx={12} fill={colors.bg} stroke={colors.border} strokeWidth={2} />
              <text x={cx} y={sub ? cy - 2 : cy} textAnchor="middle" dominantBaseline="middle" fill={colors.text} fontSize={14} fontWeight={700}>{label}</text>
              {sub && <text x={cx} y={cy + 14} textAnchor="middle" dominantBaseline="middle" fill={colors.text} fontSize={10} opacity={0.85}>{sub.length > 22 ? `${sub.slice(0, 22)}…` : sub}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function CleaningProfileSnapshot({ data }: { data: any }) {
  const stages: any[] = Array.isArray(data.stages) ? data.stages : [];
  const connections: any[] = Array.isArray(data.connections) ? data.connections : [];
  const reasons: any[] = Array.isArray(data.cleaningReasons) ? data.cleaningReasons : [];
  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
        <h4 className="font-semibold text-slate-800">{data.name ?? '(unnamed)'}</h4>
        {data.description && <p className="text-sm text-slate-600">{data.description}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 pt-2">
          <MetaRow label="Version" value={`v${data.version ?? '?'}`} />
          <MetaRow label="Status" value={<StatusBadge active={data.status === 'ACTIVE'} label={data.status} />} />
          <MetaRow label="Lineage" value={data.lineageId ? <code className="text-xs text-slate-500">{data.lineageId.slice(0, 8)}…</code> : null} />
          <MetaRow label="Flow mode" value={data.flowMode} />
          <MetaRow label="Alarm: forward skip" value={String(data.alarmOnForwardSkip ?? false)} />
          <MetaRow label="Alarm: backward jump" value={String(data.alarmOnBackwardJump ?? false)} />
          <MetaRow label="Alarm: out of sequence" value={String(data.alarmOnOutOfSequence ?? false)} />
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <h5 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Pipeline flow</h5>
        <ProfileFlow stages={stages} connections={connections} />
      </div>

      {reasons.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h5 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Cleaning reasons ({reasons.length})</h5>
          <ul className="text-sm space-y-1">
            {reasons.map((r: any, i: number) => (
              <li key={r.key ?? i} className="flex items-baseline gap-3">
                <code className="text-xs text-slate-500">{r.key}</code>
                <span className="text-slate-800">{r.name ?? r.label}</span>
                {r.requiresJustification && <StatusBadge active={true} label="Justification required" />}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <h5 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Pipeline stages ({stages.length})</h5>
        {stages.length === 0 ? (
          <p className="text-sm text-slate-400">No stages.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-500 border-b border-slate-200">
              <tr><th className="text-left py-1 pr-2">Order</th><th className="text-left py-1 pr-2">Type</th><th className="text-left py-1 pr-2">State key</th><th className="text-left py-1">Configuration</th></tr>
            </thead>
            <tbody>
              {[...stages].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((s: any) => (
                <tr key={s.id ?? `${s.sortOrder}-${s.nodeType}`} className="border-b border-slate-100 last:border-0">
                  <td className="py-1 pr-2 text-slate-500">{s.sortOrder ?? '—'}</td>
                  <td className="py-1 pr-2"><code className="text-xs">{s.nodeType}</code></td>
                  <td className="py-1 pr-2 text-slate-700">{s.stateKey ?? '—'}</td>
                  <td className="py-1 text-xs text-slate-500 truncate max-w-md">{s.configuration ? JSON.stringify(s.configuration) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <h5 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Connections ({connections.length})</h5>
        {connections.length === 0 ? (
          <p className="text-sm text-slate-400">No connections.</p>
        ) : (
          <ul className="text-sm space-y-1">
            {connections.map((c: any, i: number) => (
              <li key={c.id ?? i} className="flex items-baseline gap-2 text-slate-700">
                <code className="text-xs text-slate-500">{(c.fromStageId ?? '').slice(0, 8)}…</code>
                <span className="text-slate-400">→</span>
                <code className="text-xs text-slate-500">{(c.toStageId ?? '').slice(0, 8)}…</code>
                {c.label && <span className="text-xs text-slate-500">({c.label})</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ChecklistProfileSnapshot({ data }: { data: any }) {
  const questions: any[] = Array.isArray(data.questions) ? data.questions : [];
  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
        <h4 className="font-semibold text-slate-800">{data.name ?? '(unnamed)'}</h4>
        {data.description && <p className="text-sm text-slate-600">{data.description}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 pt-2">
          <MetaRow label="Version" value={`v${data.versionNumber ?? '?'}`} />
          <MetaRow label="Status" value={<StatusBadge active={data.isActive !== false} />} />
          <MetaRow label="Question count" value={questions.length} />
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <h5 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Questions ({questions.length})</h5>
        {questions.length === 0 ? (
          <p className="text-sm text-slate-400">No questions.</p>
        ) : (
          <ol className="space-y-2">
            {[...questions].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((q: any) => (
              <li key={q.id} className="border border-slate-200 rounded-lg p-3 bg-slate-50">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-slate-500">#{q.sortOrder ?? '?'}</span>
                  <span className="font-medium text-sm text-slate-800">{q.question}</span>
                  {q.required && <StatusBadge active={true} label="Required" />}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-0.5 mt-1 text-xs text-slate-500">
                  <span>Type: <code>{q.questionType ?? q.type}</code></span>
                  {q.section && <span>Section: {q.section}</span>}
                  {Array.isArray(q.options) && q.options.length > 0 && <span>Options: {q.options.length}</span>}
                </div>
                {q.description && <p className="text-xs text-slate-500 mt-1 italic">{q.description}</p>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function EquipmentGroupSnapshot({ data }: { data: any }) {
  const instruments: any[] = Array.isArray(data.instruments) ? data.instruments : [];
  // Group by stage so the layout matches the operator's reading workflow.
  const byStage = instruments.reduce<Record<string, any[]>>((acc, i) => {
    const k = i.stageKey ?? 'OTHER';
    (acc[k] ||= []).push(i);
    return acc;
  }, {});
  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
        <h4 className="font-semibold text-slate-800">{data.name ?? '(unnamed)'}</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 pt-2">
          <MetaRow label="Version" value={`v${data.versionNumber ?? '?'}`} />
          <MetaRow label="Status" value={<StatusBadge active={data.isActive !== false} />} />
          <MetaRow label="Block" value={data.blockId ? <code className="text-xs text-slate-500">{data.blockId.slice(0, 8)}…</code> : null} />
          <MetaRow label="Instruments" value={instruments.length} />
        </div>
      </div>

      {Object.entries(byStage).map(([stage, items]) => (
        <div key={stage} className="bg-white border border-slate-200 rounded-xl p-4">
          <h5 className="text-xs uppercase tracking-wide text-slate-500 mb-2">{stage} ({items.length})</h5>
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left py-1 pr-2">Description</th>
                <th className="text-left py-1 pr-2">Instrument ID</th>
                <th className="text-left py-1 pr-2">SN</th>
                <th className="text-left py-1 pr-2">UOM</th>
                <th className="text-left py-1 pr-2">Operating range</th>
                <th className="text-left py-1 pr-2">Instrument range</th>
                <th className="text-left py-1">Least count</th>
              </tr>
            </thead>
            <tbody>
              {[...items].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((inst: any) => (
                <tr key={inst.id ?? `${stage}-${inst.sortOrder}`} className="border-b border-slate-100 last:border-0">
                  <td className="py-1 pr-2 font-medium text-slate-800">{inst.description}</td>
                  <td className="py-1 pr-2"><code className="text-xs">{inst.instrumentId}</code></td>
                  <td className="py-1 pr-2 text-slate-600">{inst.serialNumber}</td>
                  <td className="py-1 pr-2 text-slate-600">{inst.uom}</td>
                  <td className="py-1 pr-2 text-slate-700">{inst.operatingMin}–{inst.operatingMax}</td>
                  <td className="py-1 pr-2 text-slate-500">{inst.instrumentMin}–{inst.instrumentMax}</td>
                  <td className="py-1 text-slate-500">{inst.leastCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
