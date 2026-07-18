import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import useSWR, { mutate } from 'swr';
import { apiClient, api } from '../../lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { formatByLeastCount } from '@/lib/format-by-least-count';
import { Pagination } from '@/components/ui/pagination';

interface Instrument {
  id?: string;
  description: string;
  stageKey: string;
  serialNumber: string;
  instrumentId: string;
  uom: string;
  instrumentMin: number;
  instrumentMax: number;
  operatingMin: number;
  operatingMax: number;
  leastCount: number;
  // Auto-fetch (2026-06-13): the JSON key for this instrument inside the group's
  // single reading endpoint (e.g. "air_pressure"). autoFetchEnabled is derived
  // server-side (group has readingUrl AND this has responseKey).
  responseKey?: string;
  autoFetchEnabled?: boolean;
}

interface EquipmentGroup {
  id: string;
  name: string;
  blockId: string;
  isActive: boolean;
  readingUrl?: string;
  instruments: Instrument[];
  block?: { id: string; name: string };
}

const DEFAULT_INSTRUMENTS: Instrument[] = [
  { description: 'Compressed Air Pressure', stageKey: 'WASH_IN', serialNumber: '', instrumentId: '', uom: 'bar', instrumentMin: 0, instrumentMax: 10, operatingMin: 0, operatingMax: 10, leastCount: 0.1, responseKey: 'air_pressure' },
  { description: 'RO Water Pressure', stageKey: 'WASH_IN', serialNumber: '', instrumentId: '', uom: 'bar', instrumentMin: 0, instrumentMax: 10, operatingMin: 0, operatingMax: 10, leastCount: 0.1, responseKey: 'ro_water_pressure' },
  { description: 'Dryer Temperature', stageKey: 'DRY_IN', serialNumber: '', instrumentId: '', uom: '\u00b0C', instrumentMin: 0, instrumentMax: 100, operatingMin: 0, operatingMax: 100, leastCount: 0.5, responseKey: 'dryer_temperature' },
];

function generateValues(opMin: number, opMax: number, leastCount: number): number[] {
  const values: number[] = [];
  if (leastCount <= 0 || opMin >= opMax) return values;
  for (let v = opMin, i = 0; v <= opMax + 1e-9 && i < 10000; v = Math.round((v + leastCount) * 1e10) / 1e10, i++) {
    values.push(v);
  }
  return values;
}

const STAGE_CONFIG: Record<string, { bg: string; text: string; border: string; icon: string }> = {
  WASH_IN: { bg: 'bg-sky-50', text: 'text-sky-700', border: 'border-sky-200', icon: 'M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z' },
  DRY_IN: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', icon: 'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z' },
};

export function EquipmentGroupsConfigPage() {
  const navigate = useNavigate();
  // Phase 5C: button gating via useCan(<node>) — resolves from PERMISSION_TREE gate,
  // which matches the real backend enforcement (no drift).
  const can = useCan();
  const reauth = useReauth();
  const canCreate = can('equipment_groups.create'); // gate: ['EG_CREATE'] — SAME as old EG_CREATE check
  const canEdit = can('equipment_groups.edit');     // gate: ['EG_EDIT'] — SAME as old EG_EDIT check (Edit button)
  const canDelete = can('equipment_groups.delete'); // gate: ['EG_DELETE'] — SAME as old EG_DELETE check
  // A-01 wave 5: migrated from /api/assets/templates + /api/assets/instances to the
  // typed hierarchy endpoint. /api/hierarchy/blocks returns only block-kind rows —
  // no templateKind heuristic or join needed. Equipment instances are not fetched
  // here (instruments are embedded in the EquipmentGroup payload via g.instruments[]).
  // Equipment-kind typed home is a deferred A-01 D1 decision; no carve-out needed.
  const { data: blocksData } = useSWR('/api/hierarchy/blocks');
  const blocks = (blocksData?.data ?? []) as any[];
  const [selectedBlockId, setSelectedBlockId] = useState<string>('');
  // 2026-07-16: active groups only. There is no Enable/Disable toggle anymore
  // (a block may have multiple active groups). Inactive rows are soft-deleted
  // groups — not re-enableable — so they stay hidden.
  const groupsKey = selectedBlockId ? `/api/equipment-groups?blockId=${selectedBlockId}` : null;
  const { data: groupsData } = useSWR(groupsKey);

  const [editing, setEditing] = useState<{ group: Partial<EquipmentGroup>; isNew: boolean } | null>(null);
  // Auto-fetch (2026-06-13): ONE group-level main toggle drives all instrument
  // URLs. When on, the URL panel + "Get Latest Values" show; an instrument is
  // auto-fetch iff the toggle is on AND its URL is filled.
  const [autoFetchOn, setAutoFetchOn] = useState(false);
  const [latestValues, setLatestValues] = useState<Record<string, { value?: number; error?: string; loading?: boolean }>>({});
  const [fetchingLatest, setFetchingLatest] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedToast, setSavedToast] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [previewInst, setPreviewInst] = useState<number | null>(null);
  // M8 (2026-05-04): soft-lock dialog when admin edits a group that is in use
  // by active cycles. Backend snapshot-then-bump (Phase A.4) protects validation
  // — pinned cycles continue to validate against EquipmentGroupVersion at the
  // pin. The dialog is a heads-up, not a block.
  const [editConflict, setEditConflict] = useState<{ group: EquipmentGroup; activeCount: number } | null>(null);

  useEffect(() => {
    if (blocks.length > 0 && !selectedBlockId) setSelectedBlockId(blocks[0].id);
  }, [blocks.length]);

  const groups: EquipmentGroup[] = Array.isArray(groupsData) ? groupsData : [];

  // Pagination — slice the rendered cards; stat cards keep counting `groups`.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  useEffect(() => { setPage(1); }, [selectedBlockId]);
  const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedGroups = groups.slice((safePage - 1) * pageSize, safePage * pageSize);

  const handleCreate = () => {
    setEditing({ group: { name: '', blockId: selectedBlockId, instruments: DEFAULT_INSTRUMENTS.map(d => ({ ...d })) }, isNew: true });
    setAutoFetchOn(false);
    setLatestValues({});
    setError('');
  };

  const openEditor = (g: EquipmentGroup) => {
    setEditing({ group: { ...g, instruments: g.instruments.map(i => ({ ...i })) }, isNew: false });
    // Main toggle reflects whether any instrument currently auto-fetches.
    setAutoFetchOn(g.instruments.some(i => i.autoFetchEnabled));
    setLatestValues({});
    setError('');
  };

  // "Get Latest Values": fetch the group's ONE reading endpoint and map each
  // instrument's responseKey to a value in the read-only display fields.
  const handleGetLatestValues = async () => {
    if (!editing || fetchingLatest) return;
    const url = (editing.group.readingUrl ?? '').trim();
    if (!url) { setError('Enter the readings URL first'); return; }
    const insts = editing.group.instruments ?? [];
    setFetchingLatest(true); setError('');
    setLatestValues(() => { const next: Record<string, any> = {}; insts.forEach((_, idx) => { next[String(idx)] = { loading: true }; }); return next; });
    try {
      const r = await apiClient.post<{ ok: boolean; reading?: Record<string, number>; error?: string }>('/api/equipment-groups/test-url', { url });
      const reading = r.reading ?? {};
      setLatestValues(() => {
        const next: Record<string, any> = {};
        insts.forEach((i, idx) => {
          if (!r.ok) { next[String(idx)] = { error: r.error || 'Failed' }; return; }
          const k = (i.responseKey ?? '').trim();
          const v = k ? reading[k] : undefined;
          next[String(idx)] = typeof v === 'number' ? { value: v } : { error: k ? `Key "${k}" not in response` : 'No key set' };
        });
        return next;
      });
      if (!r.ok) setError(r.error || 'Failed to fetch readings');
    } catch (e: any) {
      setError(e?.message || 'Request failed');
    } finally {
      setFetchingLatest(false);
    }
  };

  const handleEdit = async (g: EquipmentGroup) => {
    // M8 (2026-05-04): inline-derived active-cycle check. The cycles list
    // returns equipmentGroupId on each row (CleaningCycle column, not stripped
    // by the response schema), so we filter client-side. Fail-open on fetch
    // error — the soft-lock is informational; a transient network blip must
    // never wedge admin work.
    try {
      const res = await apiClient.get<{ data: any[] }>('/api/filters/cycles?status=IN_PROGRESS&limit=100');
      const activeCount = (res.data ?? []).filter((c: any) => c.equipmentGroupId === g.id).length;
      if (activeCount > 0) {
        setEditConflict({ group: g, activeCount });
        return;
      }
    } catch {
      // swallow — proceed straight to the editor
    }
    openEditor(g);
  };

  // Audit 2026-05-04 fix (web-routes review C4): equipment-group CRUD
  // bypassed reauth despite CREATE/UPDATE/DELETE_EQUIPMENT_GROUP actions
  // existing in packages/shared/src/types/reauth-actions.ts:99-101.
  const handleDelete = (g: EquipmentGroup) => {
    if (!confirm(`Delete equipment group "${g.name}"?`)) return;
    setDeleteError('');
    reauth.execute(
      'DELETE_EQUIPMENT_GROUP',
      async (password?: string) => {
        if (password) {
          await api.deleteWithReauth(`/api/equipment-groups/${g.id}`, password);
        } else {
          await apiClient.delete(`/api/equipment-groups/${g.id}`);
        }
      },
      {
        onSuccess: () => mutate(groupsKey),
        onError: (e: any) => setDeleteError(e.message || 'Failed to delete'),
      },
    );
  };

  // 2026-07-16: `handleToggleActive` removed — no Enable/Disable. A block may
  // have multiple active equipment groups; delete is the only removal path.

  const updateInstrument = (idx: number, field: string, value: any) => {
    if (!editing) return;
    const instruments = [...(editing.group.instruments ?? [])];
    instruments[idx] = { ...instruments[idx], [field]: value };
    setEditing({ ...editing, group: { ...editing.group, instruments } });
  };

  const handleSave = async () => {
    if (!editing) return;
    const { group, isNew } = editing;
    if (!group.name?.trim()) { setError('Group name is required'); return; }
    for (let i = 0; i < 3; i++) {
      const inst = group.instruments![i];
      if (!inst.instrumentId?.trim()) { setError(`Instrument ID is required for ${inst.description}`); return; }
      if (!inst.uom?.trim()) { setError(`UOM is required for ${inst.description}`); return; }
      if (inst.leastCount <= 0) { setError(`Least Count must be > 0 for ${inst.description}`); return; }
      if (inst.instrumentMin >= inst.instrumentMax) { setError(`Min Range must be less than Max Range for ${inst.description}`); return; }
      if (inst.operatingMin < inst.instrumentMin || inst.operatingMin > inst.instrumentMax) { setError(`Operating Min must be within instrument range for ${inst.description}`); return; }
      if (inst.operatingMax < inst.instrumentMin || inst.operatingMax > inst.instrumentMax) { setError(`Operating Max must be within instrument range for ${inst.description}`); return; }
      if (inst.operatingMin >= inst.operatingMax) { setError(`Operating Min must be less than Operating Max for ${inst.description}`); return; }
    }
    // Auto-fetch on → one valid reading URL + at least one instrument key.
    if (autoFetchOn) {
      const u = (group.readingUrl ?? '').trim();
      if (!u) { setError('Auto-fetch is on — enter the readings URL, or turn auto-fetch off.'); return; }
      try {
        const p = new URL(u);
        if (p.protocol !== 'http:' && p.protocol !== 'https:') throw new Error('scheme');
      } catch { setError('Readings URL must be a valid http(s) URL.'); return; }
      if (!group.instruments!.some(i => (i.responseKey ?? '').trim())) {
        setError('Auto-fetch is on — set a response key for at least one instrument.'); return;
      }
    }
    setSaving(true); setError('');
    const payload = {
      name: group.name!.trim(),
      blockId: group.blockId,
      readingUrl: autoFetchOn ? (group.readingUrl ?? '').trim() : '',
      instruments: group.instruments!.map(i => ({
        serialNumber: i.serialNumber, instrumentId: i.instrumentId, uom: i.uom,
        instrumentMin: Number(i.instrumentMin), instrumentMax: Number(i.instrumentMax),
        operatingMin: Number(i.operatingMin), operatingMax: Number(i.operatingMax),
        leastCount: Number(i.leastCount),
        // Backend derives autoFetchEnabled from readingUrl + responseKey.
        responseKey: autoFetchOn ? (i.responseKey ?? '').trim() : '',
      })),
    };
    reauth.execute(
      isNew ? 'CREATE_EQUIPMENT_GROUP' : 'UPDATE_EQUIPMENT_GROUP',
      async (password?: string) => {
        if (isNew) {
          if (password) await api.postWithReauth('/api/equipment-groups', payload, password);
          else await apiClient.post('/api/equipment-groups', payload);
        } else {
          if (password) await api.putWithReauth(`/api/equipment-groups/${group.id}`, payload, password);
          else await apiClient.put(`/api/equipment-groups/${group.id}`, payload);
        }
      },
      {
        onSuccess: () => {
          mutate(groupsKey);
          setEditing(null);
          setSavedToast(isNew ? 'Equipment group created' : 'Equipment group saved');
          setTimeout(() => setSavedToast(''), 3000);
          setSaving(false);
        },
        onError: (e: any) => {
          setError(e.message || 'Failed to save');
          setSaving(false);
        },
      },
    );
  };

  const getStageConfig = (key: string) => STAGE_CONFIG[key] ?? { bg: 'bg-slate-50', text: 'text-slate-600', border: 'border-slate-200', icon: '' };

  return (
    <div className="p-6 space-y-6">
      {/* Success toast */}
      {savedToast && (
        <div className="fixed top-6 right-6 z-50 px-5 py-3 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl shadow-lg font-semibold text-sm">
          {savedToast}
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate('/config')}
            className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 hover:text-slate-700 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-500 to-teal-600 flex items-center justify-center text-white shadow-lg shadow-cyan-500/25">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-800">Equipment Groups</h1>
            <p className="text-sm text-slate-500">Configure instrument groups per cleaning block</p>
          </div>
        </div>
        {canCreate && (
          <button onClick={handleCreate} disabled={!selectedBlockId}
            className="px-5 py-2.5 bg-gradient-to-r from-cyan-600 to-teal-600 text-white rounded-xl hover:from-cyan-500 hover:to-teal-500 disabled:opacity-40 transition-all text-sm font-semibold shadow-lg shadow-cyan-500/25 flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            Add Equipment Group
          </button>
        )}
      </div>

      {/* Stats + Block Selector */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="md:col-span-2 bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Select Block</label>
          <select value={selectedBlockId} onChange={e => setSelectedBlockId(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-800 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100 outline-none">
            <option value="">-- Select Block --</option>
            {blocks.map((b: any) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
        <div className="bg-gradient-to-br from-cyan-500 to-teal-600 rounded-2xl p-4 text-white shadow-lg shadow-cyan-500/20">
          <div className="text-2xl font-bold">{groups.length}</div>
          <div className="text-cyan-100 text-sm font-medium">Equipment Groups</div>
        </div>
        <div className="bg-gradient-to-br from-teal-500 to-cyan-600 rounded-2xl p-4 text-white shadow-lg shadow-teal-500/20">
          <div className="text-2xl font-bold">{groups.reduce((s, g) => s + g.instruments.length, 0)}</div>
          <div className="text-teal-100 text-sm font-medium">Total Instruments</div>
        </div>
      </div>

      {deleteError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm flex items-center justify-between">
          <span>{deleteError}</span>
          <button onClick={() => setDeleteError('')} className="text-red-400 hover:text-red-600 ml-4">&times;</button>
        </div>
      )}

      {!selectedBlockId && (
        <div className="text-center py-20">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-cyan-50 flex items-center justify-center">
            <svg className="w-8 h-8 text-cyan-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5" /></svg>
          </div>
          <p className="text-slate-500 font-medium">Select a block to view its equipment groups</p>
        </div>
      )}

      {selectedBlockId && groups.length === 0 && (
        <div className="text-center py-20">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-slate-100 flex items-center justify-center">
            <svg className="w-8 h-8 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37" /></svg>
          </div>
          <p className="text-slate-500 font-medium">No equipment groups for this block</p>
          <p className="text-sm text-slate-400 mt-1">Click "Add Equipment Group" to create one</p>
        </div>
      )}

      {/* Group Cards */}
      <div className="space-y-5">
        {pagedGroups.map(g => (
          <div key={g.id} className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm hover:shadow-lg transition-shadow">
            <div className="h-1.5 bg-gradient-to-r from-cyan-400 to-teal-500" />
            <div className="flex items-center justify-between px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-100 to-teal-100 flex items-center justify-center">
                  <svg className="w-5 h-5 text-cyan-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                </div>
                <div>
                  <h3 className="text-lg font-bold text-slate-800">{g.name}</h3>
                  <p className="text-xs text-slate-400">{g.instruments.length} instruments configured</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {canEdit && (
                  <button onClick={() => handleEdit(g)}
                    className="px-4 py-2 text-sm font-medium text-cyan-600 bg-cyan-50 hover:bg-cyan-100 rounded-xl transition-colors">
                    Edit
                  </button>
                )}
                {canDelete && (
                  <button onClick={() => handleDelete(g)}
                    className="px-4 py-2 text-sm font-medium text-red-500 bg-red-50 hover:bg-red-100 rounded-xl transition-colors">
                    Delete
                  </button>
                )}
              </div>
            </div>
            <div className="px-6 pb-5">
              <div className="grid gap-3 md:grid-cols-3">
                {g.instruments.map((inst, idx) => {
                  const sc = getStageConfig(inst.stageKey);
                  return (
                    <div key={inst.id ?? idx} className={`rounded-xl border p-4 ${sc.border} ${sc.bg}`}>
                      <div className="flex items-center justify-between mb-3">
                        <span className={`text-sm font-bold ${sc.text}`}>{inst.description}</span>
                        <div className="flex items-center gap-1">
                          {inst.autoFetchEnabled && (
                            <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full border border-cyan-200 text-cyan-700 bg-cyan-50" title={inst.responseKey ? `Auto-fetch key: ${inst.responseKey}` : 'Auto-fetch enabled'}>
                              Auto
                            </span>
                          )}
                          <span className={`px-2 py-0.5 text-[10px] font-semibold rounded-full border ${sc.border} ${sc.text} bg-white/60`}>
                            {inst.stageKey.replace('_', ' ')}
                          </span>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="bg-white/70 rounded-lg p-2">
                          <div className="text-slate-400 mb-0.5">Instrument ID</div>
                          <div className="font-mono font-semibold text-slate-700">{inst.instrumentId || '—'}</div>
                        </div>
                        <div className="bg-white/70 rounded-lg p-2">
                          <div className="text-slate-400 mb-0.5">UOM</div>
                          <div className="font-semibold text-slate-700">{inst.uom}</div>
                        </div>
                        <div className="bg-white/70 rounded-lg p-2">
                          <div className="text-slate-400 mb-0.5">Range</div>
                          <div className="font-semibold text-slate-700">{formatByLeastCount(inst.instrumentMin, inst.leastCount)} – {formatByLeastCount(inst.instrumentMax, inst.leastCount)}</div>
                        </div>
                        <div className="bg-white/70 rounded-lg p-2">
                          <div className="text-slate-400 mb-0.5">Operating</div>
                          <div className="font-semibold text-slate-700">{formatByLeastCount(inst.operatingMin, inst.leastCount)} – {formatByLeastCount(inst.operatingMax, inst.leastCount)}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ))}
      </div>

      {selectedBlockId && groups.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm">
          <Pagination
            page={safePage}
            pageSize={pageSize}
            totalItems={groups.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>
      )}

      {/* Create / Edit Dialog */}
      {editing && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setEditing(null)}>
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="h-1.5 bg-gradient-to-r from-cyan-500 via-teal-500 to-emerald-500" />
            <div className="px-6 py-4 border-b border-slate-100 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-teal-600 flex items-center justify-center text-white">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={editing.isNew ? "M12 4v16m8-8H4" : "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"} /></svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-800">{editing.isNew ? 'Add Equipment Group' : 'Edit Equipment Group'}</h2>
                  <p className="text-xs text-slate-400">Configure instruments and their operating parameters</p>
                </div>
              </div>
            </div>
            <div className="p-6 space-y-5 overflow-y-auto flex-1">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Group Name *</label>
                  <input className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 text-sm focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100 outline-none" placeholder="e.g. Equipment Group 1"
                    value={editing.group.name ?? ''} onChange={e => setEditing({ ...editing, group: { ...editing.group, name: e.target.value } })} />
                </div>
                {editing.isNew && (
                  <div>
                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Block</label>
                    <select value={editing.group.blockId ?? ''} onChange={e => setEditing({ ...editing, group: { ...editing.group, blockId: e.target.value } })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 text-sm focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100 outline-none">
                      {blocks.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </div>
                )}
              </div>

              {/* Auto-fetch MAIN toggle (2026-06-13): one switch enables the URL
                  panel below for the whole group. Off = manual readings. */}
              <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-700">Auto-fetch instrument readings</div>
                  <div className="text-xs text-slate-400 mt-0.5">Pull readings from instrument APIs during cleaning. Turn on to enter URLs below; off keeps manual entry.</div>
                </div>
                <button type="button" onClick={() => setAutoFetchOn(v => !v)} aria-pressed={autoFetchOn}
                  className={`relative w-12 h-7 rounded-full transition-colors shrink-0 ${autoFetchOn ? 'bg-cyan-500' : 'bg-slate-300'}`}>
                  <span className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${autoFetchOn ? 'translate-x-5' : ''}`} />
                </button>
              </div>

              {editing.group.instruments?.map((inst, idx) => {
                const sc = getStageConfig(inst.stageKey);
                return (
                  <div key={idx} className={`rounded-2xl border-2 ${sc.border} overflow-hidden`}>
                    <div className={`px-4 py-3 ${sc.bg} flex items-center justify-between`}>
                      <h3 className={`text-sm font-bold ${sc.text} flex items-center gap-2`}>
                        <span className={`w-6 h-6 rounded-lg bg-white/60 flex items-center justify-center text-xs font-bold`}>{idx + 1}</span>
                        {inst.description}
                        <span className={`px-2 py-0.5 text-[10px] rounded-full border ${sc.border} bg-white/60`}>{inst.stageKey.replace('_', ' ')}</span>
                      </h3>
                      <button onClick={() => setPreviewInst(previewInst === idx ? null : idx)}
                        className="text-xs text-cyan-600 hover:text-cyan-700 font-semibold bg-white/80 px-3 py-1 rounded-lg">
                        {previewInst === idx ? 'Hide' : 'Preview'}
                      </button>
                    </div>
                    <div className="p-4 bg-white space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div>
                          <label className="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">S.No</label>
                          <input className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 text-sm focus:border-cyan-400 outline-none"
                            value={inst.serialNumber} onChange={e => updateInstrument(idx, 'serialNumber', e.target.value)} />
                        </div>
                        <div>
                          <label className="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">Instrument ID *</label>
                          <input className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 text-sm focus:border-cyan-400 outline-none"
                            value={inst.instrumentId} onChange={e => updateInstrument(idx, 'instrumentId', e.target.value)} placeholder="e.g. CAP-001" />
                        </div>
                        <div>
                          <label className="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">UOM *</label>
                          <input className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 text-sm focus:border-cyan-400 outline-none"
                            value={inst.uom} onChange={e => updateInstrument(idx, 'uom', e.target.value)} />
                        </div>
                        <div>
                          <label className="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">Least Count *</label>
                          <input type="number" step="any" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 text-sm focus:border-cyan-400 outline-none"
                            value={inst.leastCount} onChange={e => updateInstrument(idx, 'leastCount', parseFloat(e.target.value) || 0)} />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div>
                          <label className="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">Instrument Min *</label>
                          <input type="number" step="any" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 text-sm focus:border-cyan-400 outline-none"
                            value={inst.instrumentMin} onChange={e => updateInstrument(idx, 'instrumentMin', parseFloat(e.target.value) || 0)} />
                        </div>
                        <div>
                          <label className="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">Instrument Max *</label>
                          <input type="number" step="any" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 text-sm focus:border-cyan-400 outline-none"
                            value={inst.instrumentMax} onChange={e => updateInstrument(idx, 'instrumentMax', parseFloat(e.target.value) || 0)} />
                        </div>
                        <div>
                          <label className="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">Operating Min *</label>
                          <input type="number" step="any" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 text-sm focus:border-cyan-400 outline-none"
                            value={inst.operatingMin} onChange={e => updateInstrument(idx, 'operatingMin', parseFloat(e.target.value) || 0)} />
                        </div>
                        <div>
                          <label className="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">Operating Max *</label>
                          <input type="number" step="any" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 text-sm focus:border-cyan-400 outline-none"
                            value={inst.operatingMax} onChange={e => updateInstrument(idx, 'operatingMax', parseFloat(e.target.value) || 0)} />
                        </div>
                      </div>
                      {previewInst === idx && (
                        <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                          <p className="text-xs text-slate-500 mb-2 font-medium">Dropdown values ({formatByLeastCount(inst.operatingMin, inst.leastCount)} to {formatByLeastCount(inst.operatingMax, inst.leastCount)}, step {inst.leastCount}):</p>
                          <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                            {generateValues(inst.operatingMin, inst.operatingMax, inst.leastCount).slice(0, 100).map((v, i) => (
                              <span key={i} className="px-2 py-0.5 bg-white text-slate-600 border border-slate-200 rounded-md text-xs font-mono">{formatByLeastCount(v, inst.leastCount)} {inst.uom}</span>
                            ))}
                            {generateValues(inst.operatingMin, inst.operatingMax, inst.leastCount).length > 100 && (
                              <span className="text-xs text-slate-400 px-2 py-0.5">...and more</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Consolidated auto-fetch panel — shown when the main toggle is on.
                  ONE reading endpoint for the group + a response key per instrument
                  + Get Latest Values + read-only latest-value displays. */}
              {autoFetchOn && (
                <div className="rounded-2xl border-2 border-cyan-200 overflow-hidden">
                  <div className="px-4 py-3 bg-cyan-50 flex items-center justify-between gap-3">
                    <h3 className="text-sm font-bold text-cyan-800 flex items-center gap-2">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                      Instrument Auto-Fetch
                    </h3>
                    <button type="button" onClick={handleGetLatestValues} disabled={fetchingLatest}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-50">
                      {fetchingLatest
                        ? <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>}
                      {fetchingLatest ? 'Fetching…' : 'Get Latest Values'}
                    </button>
                  </div>
                  <div className="p-4 bg-white space-y-4">
                    <div>
                      <label className="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">Readings URL (one endpoint for all instruments)</label>
                      <input type="url" placeholder="http://192.168.1.x:port/readings"
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 text-sm focus:border-cyan-400 outline-none font-mono"
                        value={editing.group.readingUrl ?? ''} onChange={e => setEditing({ ...editing, group: { ...editing.group, readingUrl: e.target.value } })} />
                      <p className="text-[11px] text-slate-400 mt-1">Must return JSON like <code className="font-mono text-slate-500">{'{ "reading": { "air_pressure": 6.2, ... } }'}</code>. Each instrument reads its own value via the key below.</p>
                    </div>
                    {(editing.group.instruments ?? []).map((inst, idx) => {
                      const lv = latestValues[String(idx)];
                      return (
                        <div key={idx} className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 items-end">
                          <div>
                            <label className="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">{inst.description} — response key</label>
                            <input type="text" placeholder="e.g. air_pressure"
                              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 text-sm focus:border-cyan-400 outline-none font-mono"
                              value={inst.responseKey ?? ''} onChange={e => updateInstrument(idx, 'responseKey', e.target.value)} />
                          </div>
                          <div className="md:w-40">
                            <label className="text-[10px] font-semibold text-slate-400 uppercase mb-1 block">Latest value</label>
                            <div className={`px-3 py-2 rounded-lg text-sm border ${lv?.error ? 'bg-red-50 border-red-200 text-red-600' : lv?.value !== undefined ? 'bg-emerald-50 border-emerald-200 text-emerald-700 font-semibold' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>
                              {lv?.loading ? 'Fetching…' : lv?.error ? lv.error : lv?.value !== undefined ? `${lv.value} ${inst.uom}` : '—'}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {error && (
                <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 flex items-center justify-between">
                  <span>{error}</span>
                  <button onClick={() => setError('')} className="text-red-400 hover:text-red-600 ml-4">&times;</button>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex gap-3 shrink-0">
              <button onClick={() => setEditing(null)}
                className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200 transition-colors">Cancel</button>
              <button onClick={handleSave} disabled={saving}
                className="flex-1 py-2.5 bg-gradient-to-r from-cyan-600 to-teal-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50 hover:from-cyan-500 hover:to-teal-500 shadow-lg shadow-cyan-500/25 flex items-center justify-center gap-2">
                {saving && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                {saving ? 'Saving...' : 'Save Equipment Group'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* M8 (2026-05-04): soft-lock advisory when admin attempts to edit a
          group that is in use by active cycles. Backend snapshot-then-bump
          (Phase A.4) protects validation integrity — pinned cycles continue
          to validate against the EquipmentGroupVersion at the pin. The dialog
          is a heads-up; admin can proceed. */}
      {editConflict && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setEditConflict(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="h-1.5 bg-gradient-to-r from-amber-400 to-orange-500" />
            <div className="px-6 py-5 space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center text-amber-600 shrink-0">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                </div>
                <div>
                  <h2 className="text-base font-bold text-slate-800">Group is in use</h2>
                  <p className="text-sm text-slate-600 mt-1">
                    This group is in use by {editConflict.activeCount} active cycle{editConflict.activeCount === 1 ? '' : 's'}. Edits will only affect future cycles; existing cycles use the pinned version.
                  </p>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex gap-3">
              <button onClick={() => setEditConflict(null)}
                className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200 transition-colors">Cancel</button>
              <button
                onClick={() => { const g = editConflict.group; setEditConflict(null); openEditor(g); }}
                className="flex-1 py-2.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-xl text-sm font-semibold hover:from-amber-400 hover:to-orange-400 shadow-lg shadow-amber-500/25">
                Proceed with edit
              </button>
            </div>
          </div>
        </div>
      )}

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={() => { reauth.cancel(); setSaving(false); }}
        actionLabel="Equipment Group"
      />
    </div>
  );
}
