import { useState } from 'react';
import { BrandingConfigPage } from './branding';
import DashboardCardsConfig from './dashboard-cards';

/**
 * Branding & Dashboard — one SUPER_ADMIN page combining the Branding editor and
 * the Dashboard Cards visibility matrix into tabs. Each tab is an independent
 * editor backed by its own config key (branding / dashboard-cards) and keeps its
 * own Save. Replaces the two standalone config pages (2026-06-29).
 */
type TabKey = 'branding' | 'dashboard';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'branding', label: 'Branding' },
  { key: 'dashboard', label: 'Dashboard Cards' },
];

export function AppearanceConfigPage() {
  const [tab, setTab] = useState<TabKey>('branding');

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="grid place-items-center w-11 h-11 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-lg shadow-violet-500/20">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
          </svg>
        </span>
        <div>
          <h1 className="text-xl font-bold text-slate-800 leading-tight">Branding &amp; Dashboard</h1>
          <p className="text-sm text-slate-500">Logo, colors, themes, and company/app name — plus which dashboard cards each role sees.</p>
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
        {tab === 'branding' && <BrandingConfigPage />}
        {tab === 'dashboard' && <DashboardCardsConfig />}
      </div>
    </div>
  );
}
