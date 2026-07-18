import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';

type Matrix = Record<string, boolean>; // role -> enabled

interface Role { name: string; displayName: string; }

/**
 * Schedule AHU Filters — ONE page, BOTH matrices. Per role, two independent
 * toggles: "PM Schedule" and "Replacement Schedule" decide whether that role
 * may expand an AHU to see its filters on the respective page. Stored under two
 * separate config keys (pm-schedule-filters / replacement-schedule-filters) and
 * gated independently on each page; only this editing UI is unified.
 */
export function ReplacementScheduleFiltersPage() {
  const { toast } = useToast();
  const { data: pmData, mutate: mutatePm } = useSWR<Matrix>('/api/config/pm-schedule-filters');
  const { data: repData, mutate: mutateRep } = useSWR<Matrix>('/api/config/replacement-schedule-filters');
  const { data: rolesData } = useSWR<Role[]>('/api/roles/active', { revalidateOnMount: true, dedupingInterval: 0 });

  const [pmDraft, setPmDraft] = useState<Matrix>({});
  const [repDraft, setRepDraft] = useState<Matrix>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (pmData) setPmDraft(pmData); }, [pmData]);
  useEffect(() => { if (repData) setRepDraft(repData); }, [repData]);

  // SUPER_ADMIN always sees the filters — not editable here.
  const roles = useMemo(() => (rolesData ?? []).filter((r) => r.name !== 'SUPER_ADMIN'), [rolesData]);

  const togglePm = (role: string) => setPmDraft((d) => ({ ...d, [role]: !d[role] }));
  const toggleRep = (role: string) => setRepDraft((d) => ({ ...d, [role]: !d[role] }));

  const save = async () => {
    setSaving(true);
    try {
      await Promise.all([
        apiClient.put('/api/config/pm-schedule-filters', pmDraft),
        apiClient.put('/api/config/replacement-schedule-filters', repDraft),
      ]);
      await Promise.all([mutatePm(pmDraft, false), mutateRep(repDraft, false)]);
      toast.success('Saved', 'AHU filter visibility updated for PM and Replacement schedules.');
    } catch (err: any) {
      toast.error('Save failed', err?.message ?? 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const Switch = ({ on, onClick }: { on: boolean; onClick: () => void }) => (
    <button onClick={onClick}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${on ? 'bg-emerald-500' : 'bg-slate-300'}`}
      aria-pressed={on}>
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  );

  return (
    <div className="p-6 max-w-[760px] mx-auto">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Schedule AHU Filters</h1>
          <p className="text-sm text-slate-500 mt-1">
            For each role, choose whether it can expand an AHU to see the filters under it — set
            independently for the PM Schedule and Replacement Schedule pages. Disabled (default) hides them.
            SUPER_ADMIN always sees them.
          </p>
        </div>
        <button onClick={save} disabled={saving}
          className="shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-gradient-to-r from-teal-500 to-cyan-600 shadow-sm disabled:opacity-50">
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>

      {roles.length === 0 ? (
        <div className="text-sm text-slate-400 py-12 text-center">No roles to configure.</div>
      ) : (
        <div className="border border-slate-200 rounded-xl bg-white overflow-hidden">
          <div className="flex items-center px-4 py-2.5 bg-slate-50 border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <div className="flex-1">Role</div>
            <div className="w-28 text-center">PM Schedule</div>
            <div className="w-28 text-center">Replacement</div>
          </div>
          <div className="divide-y divide-slate-100">
            {roles.map((r) => (
              <div key={r.name} className="flex items-center px-4 py-3">
                <div className="flex-1 text-[14px] font-medium text-slate-700">{r.displayName || r.name}</div>
                <div className="w-28 flex justify-center"><Switch on={!!pmDraft[r.name]} onClick={() => togglePm(r.name)} /></div>
                <div className="w-28 flex justify-center"><Switch on={!!repDraft[r.name]} onClick={() => toggleRep(r.name)} /></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
