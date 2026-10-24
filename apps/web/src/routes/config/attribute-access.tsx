import { useState } from 'react';
import { PageHero } from '@/components/ui/page-hero';
import { Tabs, TabPanel } from '@/components/ui/tabs';
import { AttributeAccessTab } from './roles-components/attribute-access-tab';
import { UserAttributeAccess } from './roles-components/user-attribute-access';

/**
 * Configuration → ATTRIBUTE EDIT ACCESS (2026-10-24, operator: "who can edit
 * which attributes … configurable role wise or user wise"). Moved here from
 * Roles & Access → Attribute Access, plus a per-USER rule combined with the
 * role's (the user may change a key if either allows it). ONE rule, enforced by
 * the server wherever an attribute is edited — the Settings page, the
 * instrument detail Attributes panel, bulk upload, profile key removal.
 * SUPER_ADMIN only (the route guard and the card's section).
 */
type Tab = 'roles' | 'users';
const TABS: { id: Tab; label: string }[] = [
  { id: 'roles', label: 'Roles' },
  { id: 'users', label: 'Users' },
];

export function AttributeAccessConfigPage() {
  const [tab, setTab] = useState<Tab>('roles');
  return (
    <div className="space-y-6">
      <PageHero
        title="Attribute Edit Access"
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Configuration', to: '/config' }, { label: 'Attribute Edit Access' }]}
      />
      <Tabs
        tabs={TABS}
        active={tab}
        onChange={setTab}
        idPrefix="attribute-access"
        variant="segmented"
        aria-label="Attribute edit access"
        className="w-full sm:w-fit"
      />
      <TabPanel id={tab} idPrefix="attribute-access">
        {tab === 'roles' && <AttributeAccessTab />}
        {tab === 'users' && <UserAttributeAccess />}
      </TabPanel>
    </div>
  );
}
