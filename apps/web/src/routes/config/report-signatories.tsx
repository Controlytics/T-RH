import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { REPORT_TYPES } from '@/lib/report-types';

type Matrix = Record<string, Record<string, string>>; // role -> reportKey -> label

interface Role { name: string; displayName: string; }

// The selectable signature labels. The printed value is always the User ID of
// whoever generated the report; this picks the label per role per report.
const LABELS = ['Printed By', 'Reviewed By', 'Approved By'] as const;

const LABEL_CLS: Record<string, string> = {
  'Printed By': 'bg-sky-50 text-sky-700 border-sky-200',
  'Reviewed By': 'bg-amber-50 text-amber-700 border-amber-200',
  'Approved By': 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

export function ReportSignatoriesPage() {
  const { toast } = useToast();
  const { data: matrixData, mutate } = useSWR<Matrix>('/api/config/report-signatories');
  const { data: rolesData } = useSWR<Role[]>('/api/roles/active', { revalidateOnMount: true, dedupingInterval: 0 });

  const [draft, setDraft] = useState<Matrix>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (matrixData) setDraft(matrixData); }, [matrixData]);

  // SUPER_ADMIN always uses "Printed By" — not editable here.
  const roles = useMemo(() => (rolesData ?? []).filter((r) => r.name !== 'SUPER_ADMIN'), [rolesData]);

  const cell = (role: string, reportKey: string): string => draft[role]?.[reportKey] ?? 'Printed By';

  const setCell = (role: string, reportKey: string, value: string) =>
    setDraft((d) => ({ ...d, [role]: { ...(d[role] ?? {}), [reportKey]: value } }));

  const setWholeRole = (role: string, value: string) =>
    setDraft((d) => ({ ...d, [role]: Object.fromEntries(REPORT_TYPES.map((rt) => [rt.key, value])) }));

  const save = async () => {
    setSaving(true);
    try {
      await apiClient.put('/api/config/report-signatories', draft);
      await mutate(draft, false);
      toast.success('Saved', 'Report signatories updated for all roles.');
    } catch (err: any) {
      toast.error('Save failed', err?.message ?? 'Could not save report signatories.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-slate-500 max-w-2xl">
          For each report and role, choose the signature label that prints before the User ID at the
          bottom of the report. The User ID is always whoever generated it; this only changes the label.
          Unset cells default to <span className="font-semibold text-sky-700">Printed By</span>. SUPER_ADMIN always uses Printed By.
        </p>
        <button onClick={save} disabled={saving}
          className="shrink-0 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-teal-500 to-cyan-600 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed">
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>

      {roles.length === 0 ? (
        <div className="text-sm text-slate-400 py-12 text-center">No roles to configure.</div>
      ) : (
        <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider sticky left-0 bg-slate-50">Report</th>
                {roles.map((r) => (
                  <th key={r.name} className="px-3 py-2 text-center min-w-[140px]">
                    <div className="text-[12px] font-bold text-slate-700">{r.displayName || r.name}</div>
                    <select value="" onChange={(e) => { if (e.target.value) setWholeRole(r.name, e.target.value); }}
                      className="mt-1 text-[10px] text-slate-400 bg-transparent border border-slate-200 rounded px-1 py-0.5 cursor-pointer">
                      <option value="">set all…</option>
                      {LABELS.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {REPORT_TYPES.map((rt) => (
                <tr key={rt.key} className="hover:bg-slate-50/40">
                  <td className="px-4 py-2.5 text-[13px] font-medium text-slate-700 whitespace-nowrap sticky left-0 bg-white">{rt.label}</td>
                  {roles.map((r) => {
                    const val = cell(r.name, rt.key);
                    return (
                      <td key={r.name} className="px-3 py-2 text-center">
                        <select value={val} onChange={(e) => setCell(r.name, rt.key, e.target.value)}
                          className={`text-[12px] font-semibold rounded-md border px-2 py-1 cursor-pointer outline-none ${LABEL_CLS[val] ?? LABEL_CLS['Printed By']}`}>
                          {LABELS.map((l) => <option key={l} value={l} className="bg-white text-slate-700">{l}</option>)}
                        </select>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
