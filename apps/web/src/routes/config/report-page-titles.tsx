import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { useBranding } from '@/hooks/use-branding';
import { Button } from '@/components/ui/button';

type Draft = { companyName?: string; appName?: string };

/**
 * Identity tab of the combined Report Configuration page — company & application
 * name shown in every report header + footer (blank → Branding). Rendered as a
 * panel (no page chrome); the parent provides the title + tab bar.
 */
export function ReportPageTitlesPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const { branding } = useBranding();
  const perms = (user?.permissions as string[] | undefined) ?? [];
  const canWrite = user?.role === 'SUPER_ADMIN' || perms.includes('CONFIG_UPDATE');

  const { data, mutate } = useSWR<Draft>('/api/config/report-page-titles', { revalidateOnMount: true });
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (data) setDraft(data); }, [data]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(data ?? {});
  const set = (key: keyof Draft, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      await apiClient.put('/api/config/report-page-titles', draft);
      await mutate(draft, false);
      toast.success('Saved', 'Report identity updated.');
    } catch (e: any) {
      toast.error('Save failed', e?.message ?? 'Could not save report identity.');
    } finally { setSaving(false); }
  };

  // Was a cyan focus ring, which matches no theme this product ships.
  const inputCls = 'ctl w-full';

  const FIELDS = [
    { key: 'companyName' as const, label: 'Company name', brandingVal: branding.companyName },
    { key: 'appName' as const, label: 'Application name', brandingVal: branding.appName },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-sm text-slate-500 max-w-2xl">Company &amp; application name shown in the header and footer of every report. Leave blank to use the values from <span className="font-medium text-slate-600">Branding</span>; the logo always comes from Branding.</p>
        <Button className="shrink-0" onClick={save} disabled={!canWrite || !dirty || saving}
          title={!canWrite ? 'CONFIG_UPDATE permission required' : undefined}>
          {saving ? 'Saving…' : 'Save Changes'}
        </Button>
      </div>

      <div className="bg-white border border-slate-200 rounded-[var(--radius-card)] shadow-[var(--elev-1)] divide-y divide-slate-100">
        {FIELDS.map((f) => {
          const value = draft[f.key] ?? '';
          return (
            <div key={f.key} className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
              <div className="min-w-0">
                <label className="block text-[0.8125rem] font-semibold text-slate-700">{f.label}</label>
                <p className="text-xs text-slate-500 mt-0.5">Shown in the report header &amp; footer.</p>
              </div>
              <div>
                <input type="text" value={value} disabled={!canWrite}
                  placeholder={f.brandingVal || '(from Branding)'}
                  onChange={(e) => set(f.key, e.target.value)} className={inputCls} />
                <p className="text-[0.6875rem] text-slate-400 mt-1">
                  {value.trim()
                    ? <>Reports show: <span className="text-slate-600 font-medium">{value}</span></>
                    : <>Blank — using Branding: <span className="text-slate-600 font-medium">{f.brandingVal || '—'}</span></>}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
