import { useState } from 'react';
import { CleaningProfileAssignmentPage } from './cleaning-profile-assignment';
import { CleaningReasonsConfigPage } from './filter-cleaning-reasons';
import { FilterFieldOptionsConfigPage } from './filter-field-options';

/**
 * Filter Setup — one SUPER_ADMIN page combining Cleaning Profile Assignment,
 * Filter Cleaning Reasons, and Filter Field Options into tabs. Each tab is an
 * independent editor backed by its own config/endpoint and keeps its own Save.
 * Replaces the three standalone config pages (2026-06-29).
 */
type TabKey = 'assignment' | 'reasons' | 'fields';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'assignment', label: 'Profile Assignment' },
  { key: 'reasons', label: 'Cleaning Reasons' },
  { key: 'fields', label: 'Field Options' },
];

export function FilterSetupPage() {
  const [tab, setTab] = useState<TabKey>('assignment');

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="grid place-items-center w-11 h-11 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg shadow-amber-500/20">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.879a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
        </span>
        <div>
          <h1 className="text-xl font-bold text-slate-800 leading-tight">Filter Setup</h1>
          <p className="text-sm text-slate-500">Cleaning-profile assignment rules, cleaning reasons, and filter add/edit dropdown options.</p>
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
        {tab === 'assignment' && <CleaningProfileAssignmentPage />}
        {tab === 'reasons' && <CleaningReasonsConfigPage />}
        {tab === 'fields' && <FilterFieldOptionsConfigPage />}
      </div>
    </div>
  );
}
