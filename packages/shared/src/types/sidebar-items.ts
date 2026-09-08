export interface SidebarItem {
  id: string;
  label: string;
  icon: string;
  description: string;
  /** Optional UI group — items sharing a group render nested under a collapsible
   *  header in the sidebar AND in the Sidebar config tab. Ungrouped items render
   *  at the top level. */
  group?: string;
}

/**
 * All available sidebar navigation items.
 * Single source of truth — sidebar.tsx imports this instead of hardcoding.
 * To add a new sidebar item: add it here and it will automatically appear
 * in the Sidebar Configuration page for role/user visibility settings.
 */
export const SIDEBAR_ITEMS: SidebarItem[] = [
  { id: 'home', label: 'Home', icon: '\u{1F3E0}', description: 'Module Guide — how each module works, step by step' },
  { id: 'dashboard', label: 'Dashboard', icon: '\u{1F3E0}', description: 'Main dashboard view' },
  { id: 'functional-locations', label: 'Functional Locations', icon: '\u{1F5FA}', description: 'Block and Area grouping for instruments' },
  { id: 'alarms', label: 'Alarms', icon: '\u{1F6A8}', description: 'Limit excursions raised by alarm rules, and their acknowledgement' },
  { id: 'users', label: 'Users', icon: '\u{1F465}', description: 'User management' },
  { id: 'admin-requests', label: 'Admin Requests', icon: '\u{1F4CB}', description: 'Review and process user requests' },
  { id: 'configuration', label: 'Configuration', icon: '⚙️', description: 'System settings' },
  { id: 'notifications', label: 'Notifications', icon: '\u{1F514}', description: 'Notification center' },
  { id: 'audit', label: 'Audit Trail', icon: '\u{1F4DD}', description: 'Activity logs' },
  { id: 'system-health', label: 'System Health', icon: '\u{1F4CA}', description: 'Server and system metrics' },
  { id: 'instruments', label: 'Instruments', icon: '\u{1F4E1}', description: 'Instrument registry and telemetry' },
  { id: 'debug-traces', label: 'Debug Traces', icon: '\u{1F50D}', description: 'Pipeline debug trace viewer' },
  // 2026-09-07: the Instrument History widget, moved off the dashboard onto its
  // own page. `/data-report`; gated on INSTRUMENT_READ through the tree.
  { id: 'data-report', label: 'Data Report', icon: '\u{1F4C4}', description: 'Readings of a Block, an Area or chosen instruments over a period, with the Data Report download' },
  // 2026-09-07: the report review workflow. `/reports`; gated on REPORT_REVIEW_READ through the tree.
  { id: 'reports', label: 'Reports', icon: '\u{1F4D1}', description: 'Report requests awaiting approval, and approved reports to download' },
  // 2026-09-08: every instrument's details and attributes in one table, editable
  // in place. `/settings`; gated on INSTRUMENT_READ / INSTRUMENT_UPDATE through the tree.
  { id: 'settings', label: 'Settings', icon: '\u{1F6E0}\uFE0F', description: "Every instrument's details and attributes in one table, editable in place" },
];
