import { useState } from 'react';
import { FieldIdsPage } from './field-ids';
import { AuditTemplatesConfigPage } from './audit-templates';
import { PaginationConfigPage } from './pagination';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs, TabPanel } from '@/components/ui/tabs';

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
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Configuration', to: '/config' }, { label: 'Display Settings' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        }
      />

      {/* Tab bar — <Tabs> since 2026-08-29 (audit M4). Keeps the `.seg`
          treatment via variant="segmented"; what it adds is the keyboard
          contract (arrow keys, roving tabindex, real aria-controls) that four
          other hand-rolled bars were each missing in their own way. */}
      <Tabs
        tabs={TABS.map((t) => ({ id: t.key, label: t.label }))}
        active={tab}
        onChange={setTab}
        idPrefix="display-settings"
        variant="segmented"
        aria-label="Display settings sections"
        className="w-full sm:w-fit"
      />

      {/* Active panel */}
      <TabPanel id={tab} idPrefix="display-settings">
        {tab === 'fields' && <FieldIdsPage />}
        {tab === 'audit' && <AuditTemplatesConfigPage />}
        {tab === 'pagination' && <PaginationConfigPage />}
      </TabPanel>
    </div>
  );
}
