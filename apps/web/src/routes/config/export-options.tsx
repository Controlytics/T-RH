import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { EXPORT_SURFACES, type ExportFormat } from '@/lib/export-surfaces';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';

type Matrix = Record<string, Record<string, string>>; // role -> surfaceKey -> format

interface Role { name: string; displayName: string; }

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'BOTH', label: 'Both' },
  { value: 'PDF', label: 'PDF only' },
  { value: 'EXCEL', label: 'Excel only' },
  { value: 'NONE', label: 'None' },
];

const FMT_CLS: Record<string, string> = {
  BOTH: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  PDF: 'bg-sky-50 text-sky-700 border-sky-200',
  EXCEL: 'bg-amber-50 text-amber-700 border-amber-200',
  NONE: 'bg-slate-100 text-slate-500 border-slate-200',
};

export function ExportOptionsPage() {
  const { toast } = useToast();
  const { data: matrixData, mutate } = useSWR<Matrix>('/api/config/export-options');
  const { data: rolesData } = useSWR<Role[]>('/api/roles/active', { revalidateOnMount: true, dedupingInterval: 0 });

  const [draft, setDraft] = useState<Matrix>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (matrixData) setDraft(matrixData); }, [matrixData]);

  // SUPER_ADMIN always gets both — not editable here.
  const roles = useMemo(() => (rolesData ?? []).filter((r) => r.name !== 'SUPER_ADMIN'), [rolesData]);

  const cell = (role: string, surface: string): string => draft[role]?.[surface] ?? 'BOTH';

  const setCell = (role: string, surface: string, value: string) =>
    setDraft((d) => ({ ...d, [role]: { ...(d[role] ?? {}), [surface]: value } }));

  const setWholeRole = (role: string, value: string) =>
    setDraft((d) => ({ ...d, [role]: Object.fromEntries(EXPORT_SURFACES.map((s) => [s.key, value])) }));

  const save = async () => {
    setSaving(true);
    try {
      await apiClient.put('/api/config/export-options', draft);
      await mutate(draft, false);
      toast.success('Saved', 'Export options updated for all roles.');
    } catch (err: any) {
      toast.error('Save failed', err?.message ?? 'Could not save export options.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* This page had no header because it had no ROUTE — the config def
          pointed at /config/export-options and nothing was registered there, so
          nobody ever arrived. It gets the same header as its siblings now. */}
      <PageHeader
        title="Export Options"
        description="Which export formats each role may use on each page. Unset cells default to Both, and SUPER_ADMIN always has both."
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Configuration', to: '/config' }, { label: 'Export Options' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
        }
        actions={
          <Button onClick={save} loading={saving} loadingText="Saving…">
            Save Changes
          </Button>
        }
      />

      {roles.length === 0 ? (
        <div className="text-sm text-slate-400 py-12 text-center">No roles to configure.</div>
      ) : (
        <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white">
          <table className="tbl w-full border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-4 py-3 text-[0.6875rem] font-bold text-slate-500 uppercase tracking-wider sticky left-0 bg-slate-50">Page</th>
                {roles.map((r) => (
                  <th key={r.name} className="px-3 py-2 text-center min-w-[130px]">
                    <div className="text-[0.75rem] font-bold text-slate-700">{r.displayName || r.name}</div>
                    <select value="" onChange={(e) => { if (e.target.value) setWholeRole(r.name, e.target.value); }}
                      className="ctl mt-1">
                      <option value="">set all…</option>
                      {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {EXPORT_SURFACES.map((s) => (
                <tr key={s.key} className="hover:bg-slate-50/40">
                  <td className="px-4 py-2.5 text-[0.8125rem] font-medium text-slate-700 whitespace-nowrap sticky left-0 bg-white">{s.label}</td>
                  {roles.map((r) => {
                    const val = cell(r.name, s.key);
                    return (
                      <td key={r.name} className="px-3 py-2 text-center">
                        <select value={val} onChange={(e) => setCell(r.name, s.key, e.target.value)}
                          className={`ctl ctl-sm w-full font-semibold ${FMT_CLS[val] ?? FMT_CLS.BOTH}`}>
                          {FORMATS.map((f) => <option key={f.value} value={f.value} className="bg-white text-slate-700">{f.label}</option>)}
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
