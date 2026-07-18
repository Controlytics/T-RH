export interface SidebarItem {
  id: string;
  label: string;
  icon: string;
  description: string;
  /** Optional UI group — items sharing a group render nested under a collapsible
   *  header in the sidebar AND in the Sidebar config tab (e.g. all report pages
   *  under "Reports"). Ungrouped items render at the top level. */
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
  { id: 'users', label: 'Users', icon: '\u{1F465}', description: 'User management' },
  { id: 'admin-requests', label: 'Admin Requests', icon: '\u{1F4CB}', description: 'Review and process user requests' },
  { id: 'configuration', label: 'Configuration', icon: '\u2699\uFE0F', description: 'System settings' },
  { id: 'notifications', label: 'Notifications', icon: '\u{1F514}', description: 'Notification center' },
  { id: 'audit', label: 'Audit Trail', icon: '\u{1F4DD}', description: 'Activity logs' },
  { id: 'report-reviews', label: 'Report Reviews', icon: '✅', description: 'Review/approve reports sent to you' },
  { id: 'stage-approvals', label: 'Stage Approvals', icon: '\u{1F6E1}️', description: 'Approve cleaning stages (Wash Out / Dry Out) sent to you' },
  { id: 'system-health', label: 'System Health', icon: '\u{1F4CA}', description: 'Server and system metrics' },
  { id: 'debug-traces', label: 'Debug Traces', icon: '\u{1F50D}', description: 'Pipeline debug trace viewer' },
  { id: 'filter-list', label: 'Filters', icon: '\u{1F50D}', description: 'Filter inventory by block' },
  { id: 'filter-retirements', label: 'Retirement List', icon: '\u{1F6AB}', description: 'Retired filter inventory' },
  { id: 'filter-replacements', label: 'Replacement List', icon: '\u{1F504}', description: 'Filter replacement history' },
  { id: 'filter-operations', label: 'Filter Operations', icon: '\u{1F527}', description: 'Filter cleaning operations' },
  // 2026-06-11: rfid-track-record + quality-notifications are real Reports-group
  // sidebar items that were missing from this configurable list — so the moment
  // an admin saved a role's sidebar config, these two got dropped (and admins
  // couldn't re-enable them). Added so they appear in the Sidebar config tab.
  { id: 'rfid-track-record', label: 'RFID Track Record', icon: '\u{1F4E1}', description: 'RFID scan history per filter', group: 'Reports' },
  { id: 'cleaning-cycles', label: 'Filter Cleaning Record', icon: '\u{1F504}', description: 'Cleaning cycle history and timeline', group: 'Reports' },
  { id: 'filter-lifecycle-report', label: 'Filter Lifecycle Report', icon: '\u{1F4CA}', description: 'Per-filter cleaning lifecycle, cycle by cycle', group: 'Reports' },
  { id: 'checklists', label: 'Checklists', icon: '\u{1F4CB}', description: 'Checklist profile management' },
  { id: 'cleaning-profiles', label: 'Cleaning Profiles', icon: '\u{1F9F9}', description: 'Cleaning pipeline profiles' },
  { id: 'equipment-groups', label: 'Equipment Groups', icon: '\u2699\uFE0F', description: 'Equipment group configuration' },
  { id: 'pm-schedules', label: 'PM Schedules', icon: '\u{1F4C5}', description: 'Preventive maintenance scheduling' },
  { id: 'my-tasks', label: 'My Tasks', icon: '\u{1F3AF}', description: 'Filters due for cleaning based on PM schedules' },
  { id: 'deviations', label: 'Deviations', icon: '⚠', description: 'Overdue PM cleaning deviations + audit trail', group: 'Reports' },
  { id: 'quality-notifications', label: 'Quality Notifications', icon: '\u{1F4C4}', description: 'QNN report (visibility also gated by the qnn-notifications config)', group: 'Reports' },
  { id: 'approvals', label: 'Approvals', icon: '\u2705', description: 'Block change approval requests' },
  { id: 'version-history', label: 'Version History', icon: '\u{1F570}️', description: 'Audit history of versioned definitions (cleaning profiles, filter profiles, checklist profiles, equipment groups)' },
];
