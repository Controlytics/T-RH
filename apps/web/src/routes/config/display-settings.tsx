import { useState } from 'react';
import { FieldIdsPage } from './field-ids';
import { AuditTemplatesConfigPage } from './audit-templates';
import { PaginationConfigPage } from './pagination';
import { PageHeader } from '@/components/ui/page-header';

/**
 * Display Settings — one SUPER_ADMIN page combining Field ID Names, Audit Text
 * Templates, and Pagination Settings into tabs. Each tab is an independent
 * editor backed by its own config key (field-ids / audit-templates / pagination)
 * and keeps its own Save. Replaces the three standalone pages (2026-06-29).
 */
type TabKey = 'fields' | 'audit' | 'pagination';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'fields', label: 'Field IDs' },
  { key: 'audit', label: 'Audit Text' },
  { key: 'pagination', label: 'Pagination' },
];

export function DisplaySettingsPage() {
  const [tab, setTab] = useState<TabKey>('fields');

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <PageHeader
        title='Display Settings'
        description='Field display names, audit-trail wording, and list page sizes.'
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Configuration', to: '/config' }, { label: 'Display Settings' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        }
      />

      {/* Tab bar */}
      <div className="seg w-full sm:w-fit">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            // aria-pressed is what PAINTS the active segment (see .seg-btn in
            // app.css), so the look and the announced state cannot drift apart.
            aria-pressed={tab === t.key}
            className="seg-btn flex-1 sm:flex-none"
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Active panel */}
      <div>
        {tab === 'fields' && <FieldIdsPage />}
        {tab === 'audit' && <AuditTemplatesConfigPage />}
        {tab === 'pagination' && <PaginationConfigPage />}
      </div>
    </div>
  );
}
