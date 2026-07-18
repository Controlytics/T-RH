import { useState } from 'react';
import { ReportPageTitlesPage } from './report-page-titles';
import { ReportLabelsPage } from './report-labels';
import { ReportSignatoriesPage } from './report-signatories';
import { ExportOptionsPage } from './export-options';

/**
 * Report Configuration — one page combining the report-config editors into tabs.
 * Each tab is an independent editor backed by its own config key/endpoint
 * (report-page-titles / report-labels / report-signatories / export-options), so
 * each keeps its own Save. Replaces the standalone config pages (2026-06-29).
 */
type TabKey = 'identity' | 'labels' | 'signatories' | 'export';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'identity', label: 'Identity' },
  { key: 'labels', label: 'Labels' },
  { key: 'signatories', label: 'Signatories' },
  { key: 'export', label: 'Export' },
];

export function ReportConfigPage() {
  const [tab, setTab] = useState<TabKey>('identity');

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="grid place-items-center w-11 h-11 rounded-2xl bg-gradient-to-br from-cyan-500 to-teal-600 text-white shadow-lg shadow-cyan-500/20">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </span>
        <div>
          <h1 className="text-xl font-bold text-slate-800 leading-tight">Report Configuration</h1>
          <p className="text-sm text-slate-500">Identity, labels, signatories, and export formats for all reports — header/footer text, per-report titles &amp; columns, per-role signature labels, and per-role PDF/Excel access.</p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-full sm:w-fit">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex-1 sm:flex-none px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
              tab === t.key ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Active panel */}
      <div>
        {tab === 'identity' && <ReportPageTitlesPage />}
        {tab === 'labels' && <ReportLabelsPage />}
        {tab === 'signatories' && <ReportSignatoriesPage />}
        {tab === 'export' && <ExportOptionsPage />}
      </div>
    </div>
  );
}
