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
  { id: 'users', label: 'Users', icon: '\u{1F465}', description: 'User management' },
  { id: 'admin-requests', label: 'Admin Requests', icon: '\u{1F4CB}', description: 'Review and process user requests' },
  { id: 'configuration', label: 'Configuration', icon: '⚙️', description: 'System settings' },
  { id: 'notifications', label: 'Notifications', icon: '\u{1F514}', description: 'Notification center' },
  { id: 'audit', label: 'Audit Trail', icon: '\u{1F4DD}', description: 'Activity logs' },
  { id: 'system-health', label: 'System Health', icon: '\u{1F4CA}', description: 'Server and system metrics' },
  { id: 'debug-traces', label: 'Debug Traces', icon: '\u{1F50D}', description: 'Pipeline debug trace viewer' },
];
