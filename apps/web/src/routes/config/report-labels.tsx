import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { REPORT_DEFS, type ReportLabelsConfig } from '@/lib/report-labels';

export function ReportLabelsPage() {
  const { user } = useAuth();
  const perms = (user?.permissions as string[] | undefined) ?? [];
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const canWrite = isSuperAdmin || perms.includes('CONFIG_UPDATE');
  const { toast } = useToast();
  const { data, mutate } = useSWR<ReportLabelsConfig>('/api/config/report-labels/current', { revalidateOnMount: true });
  const [config, setConfig] = useState<ReportLabelsConfig>({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && typeof data === 'object') setConfig(data);
  }, [data]);

  const setTitle = (reportKey: string, value: string) => {
    setConfig(prev => ({ ...prev, [reportKey]: { ...prev[reportKey], title: value } }));
    setDirty(true);
  };
  const setSubtitle = (reportKey: string, value: string) => {
    setConfig(prev => ({ ...prev, [reportKey]: { ...prev[reportKey], subtitle: value } }));
    setDirty(true);
  };
  const setColumn = (reportKey: string, colKey: string, value: string) => {
    setConfig(prev => ({
      ...prev,
      [reportKey]: { ...prev[reportKey], columns: { ...prev[reportKey]?.columns, [colKey]: value } },
    }));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiClient.put('/api/config/report-labels', config);
      mutate();
      setDirty(false);
      toast.success('Saved', 'Report labels updated');
    } catch (e: any) {
      toast.error('Error', e.message || 'Failed to save');
    }
    setSaving(false);
  };

  const handleReset = () => {
    setConfig({});
    setDirty(true);
  };

  const inputCls = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 bg-white focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

  return (
    <div className="space-y-5">
      {/* Panel toolbar */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-sm text-slate-500 max-w-2xl">Customize report titles, subtitles, and table column headers — applied to both the on-screen view and the PDF. Leave a field blank to keep the built-in label. (Logo &amp; company name are set on the Identity tab / Branding.)</p>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={handleReset} disabled={!canWrite}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-slate-600 border border-slate-200 hover:bg-slate-50 transition-colors disabled:opacity-50">
            Reset all
          </button>
          <button onClick={handleSave} disabled={saving || !dirty || !canWrite}
            title={!canWrite ? 'CONFIG_UPDATE permission required' : undefined}
            className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-teal-500 to-cyan-600 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed">
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      {REPORT_DEFS.map((def) => {
        const ov = config[def.key] ?? {};
        return (
          <div key={def.key} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
            <h2 className="text-lg font-bold text-slate-800">{def.name}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">Report Title / Heading</label>
                <input type="text" value={ov.title ?? ''} placeholder={def.defaultTitle}
                  onChange={(e) => setTitle(def.key, e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">Subtitle <span className="font-normal text-slate-400">(blank = auto period/totals)</span></label>
                <input type="text" value={ov.subtitle ?? ''} placeholder="Auto-generated"
                  onChange={(e) => setSubtitle(def.key, e.target.value)} className={inputCls} />
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-500 mb-2">Table Column Headers</p>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {def.columns.map((col) => (
                  <div key={col.key}>
                    <label className="block text-[11px] text-slate-400 mb-1">{col.default}</label>
                    <input type="text" value={ov.columns?.[col.key] ?? ''} placeholder={col.default}
                      onChange={(e) => setColumn(def.key, col.key, e.target.value)} className={inputCls} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}

      <div className="flex justify-end">
        <button onClick={handleSave} disabled={saving || !dirty || !canWrite}
          className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-teal-500 to-cyan-600 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed">
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
