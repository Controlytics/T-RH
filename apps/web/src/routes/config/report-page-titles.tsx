import { hasEffectivePermission } from '@digilog/shared';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { useBranding } from '@/hooks/use-branding';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
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
  const canWrite = user?.role === 'SUPER_ADMIN' || hasEffectivePermission(perms, 'CONFIG_UPDATE');

  const { data, mutate } = useSWR<Draft>('/api/config/report-page-titles', { revalidateOnMount: true });
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (data) setDraft(data); }, [data]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(data ?? {});
  const set = (key: keyof Draft, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  // Re-authenticated as UPDATE_CONFIG_PAGE on the server (audit 2026-10-03,
  // API-18); the shared hook asks for the password when the role's matrix
  // requires it and replays the save after a retroactive 401.
  const reauth = useReauth();
  const save = async () => {
    setSaving(true);
    await reauth.execute('UPDATE_CONFIG_PAGE', async (password?) => {
      if (password) await apiClient.putWithReauth('/api/config/report-page-titles', draft, password);
      else await apiClient.put('/api/config/report-page-titles', draft);
      await mutate(draft, false);
      toast.success('Saved', 'Report identity updated.');
    }, {
      onSuccess: () => setSaving(false),
      onError: (e: any) => { toast.error('Save failed', e?.message ?? 'Could not save report identity.'); setSaving(false); },
      onCancel: () => setSaving(false),
    });
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

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Report Page Titles"
      />
    </div>
  );
}
