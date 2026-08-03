/**
 * Phase 5E — FROZEN LITERAL SNAPSHOTS of the derived maps.
 *
 * THIS FILE HAS ZERO IMPORTS FROM LIVE SOURCE FILES.
 * Regenerated 2026-08-01: added the data-injection group (16 nodes) to
 * PERMISSION_TREE, bringing FEATURE_PRIVILEGES/FEATURE_TO_PERMISSION_MAP to
 * 42 entries and SIDEBAR_PRIVILEGE_MAP to 9 sections.
 *
 * Re-regenerated 2026-08-01 (finding I4, final branch review): 8 of the 16
 * data-injection nodes have no UI yet — gateways.tsx, profiles.tsx and
 * instruments.tsx are read-only tables (only hierarchy.tsx has full CRUD;
 * instrument-wizard.tsx has Create only) — so `gateways.create/edit/delete`,
 * `instruments.edit/delete`, and `comm_profiles.create/edit/delete` were
 * marked `configurable: false` in permission-tree.ts. That drops
 * FEATURE_PRIVILEGES/FEATURE_TO_PERMISSION_MAP from 42 to 34 entries (the
 * permission constants, gates, and routes themselves are unchanged — only
 * the role-config picker toggle is hidden). SIDEBAR_PRIVILEGE_MAP is
 * unaffected (built from `visibilityPrivilegeIds`, not `configurable`).
 *
 * Re-regenerated 2026-08-03 (P3 Task 12): the three alarm nodes
 * (`alarms.view`, `alarms.acknowledge`, `alarms.thresholds`) joined the
 * data-injection group as `configurable: true` — unlike the eight above, they
 * ship with UI in Task 13 — taking FEATURE_PRIVILEGES and
 * FEATURE_TO_PERMISSION_MAP from 34 to 37 entries. SIDEBAR_PRIVILEGE_MAP is
 * again unaffected: `alarms.view` was deliberately NOT added to the group's
 * `visibilityPrivilegeIds`, so reaching the Data Injection sidebar entry still
 * requires one of the four P1 view privileges. Revisit with the Task 13 UI.
 */

interface FeaturePrivilegeSnapshot {
  id: string;
  label: string;
  category: string;
  icon: string;
}

interface SidebarSectionSnapshot {
  sidebarId: string;
  label: string;
  icon: string;
  description: string;
  privilegeIds: string[];
}

export const FEATURE_PRIVILEGES_SNAPSHOT: FeaturePrivilegeSnapshot[] = [
  {
    "id": "users.create",
    "label": "Create Users",
    "category": "User Management",
    "icon": "user-plus"
  },
  {
    "id": "users.view",
    "label": "View Users",
    "category": "User Management",
    "icon": "user"
  },
  {
    "id": "users.edit",
    "label": "Edit Users",
    "category": "User Management",
    "icon": "user-edit"
  },
  {
    "id": "users.delete",
    "label": "Delete Users",
    "category": "User Management",
    "icon": "user-minus"
  },
  {
    "id": "users.enable_disable",
    "label": "Enable/Disable Accounts",
    "category": "User Management",
    "icon": "toggle"
  },
  {
    "id": "users.unlock",
    "label": "Unlock Accounts",
    "category": "User Management",
    "icon": "unlock"
  },
  {
    "id": "users.reset_password",
    "label": "Reset Passwords",
    "category": "User Management",
    "icon": "key"
  },
  {
    "id": "config.view",
    "label": "View Configuration",
    "category": "System",
    "icon": "settings"
  },
  {
    "id": "config.edit",
    "label": "Edit Configuration",
    "category": "System",
    "icon": "settings-edit"
  },
  {
    "id": "config.field_ids",
    "label": "Update Field Labels",
    "category": "System",
    "icon": "tag"
  },
  {
    "id": "roles.manage",
    "label": "Manage Roles",
    "category": "System",
    "icon": "shield"
  },
  {
    "id": "notifications.view",
    "label": "View Notifications",
    "category": "System",
    "icon": "bell"
  },
  {
    "id": "notifications.delete",
    "label": "Delete Notifications",
    "category": "System",
    "icon": "bell"
  },
  {
    "id": "audit.view",
    "label": "View Audit Trail",
    "category": "System",
    "icon": "clipboard"
  },
  {
    "id": "audit.export",
    "label": "Export Audit Trail",
    "category": "System",
    "icon": "clipboard"
  },
  {
    "id": "audit.delete",
    "label": "Delete Audit Record (permanent)",
    "category": "System",
    "icon": "trash"
  },
  {
    "id": "dashboard.view",
    "label": "View Dashboards",
    "category": "Dashboards",
    "icon": "layout"
  },
  {
    "id": "dashboard.create",
    "label": "Create Dashboards",
    "category": "Dashboards",
    "icon": "plus"
  },
  {
    "id": "dashboard.manage",
    "label": "Manage Dashboards",
    "category": "Dashboards",
    "icon": "settings"
  },
  {
    "id": "dashboard.assign",
    "label": "Assign Dashboards",
    "category": "Dashboards",
    "icon": "link"
  },
  {
    "id": "admin_requests.approve",
    "label": "Approve Admin Requests",
    "category": "User Management",
    "icon": "check-circle"
  },
  {
    "id": "admin_requests.reject",
    "label": "Reject Admin Requests",
    "category": "User Management",
    "icon": "x-circle"
  },
  {
    "id": "debug.view",
    "label": "View Debug Traces",
    "category": "Debug Traces",
    "icon": "terminal"
  },
  {
    "id": "debug.manage",
    "label": "Manage Debug Traces",
    "category": "Debug Traces",
    "icon": "terminal"
  },
  {
    "id": "backup.export",
    "label": "Export / Download Backups",
    "category": "Backup & Restore",
    "icon": "download"
  },
  {
    "id": "backup.restore",
    "label": "Restore from Backup",
    "category": "Backup & Restore",
    "icon": "upload"
  },
  {
    "id": "hierarchy.view",
    "label": "View Hierarchy",
    "category": "Data Injection",
    "icon": "sitemap"
  },
  {
    "id": "hierarchy.create",
    "label": "Create Hierarchy Node",
    "category": "Data Injection",
    "icon": "plus"
  },
  {
    "id": "hierarchy.edit",
    "label": "Edit Hierarchy Node",
    "category": "Data Injection",
    "icon": "edit"
  },
  {
    "id": "hierarchy.delete",
    "label": "Delete Hierarchy Node",
    "category": "Data Injection",
    "icon": "trash"
  },
  {
    "id": "gateways.view",
    "label": "View Gateways",
    "category": "Data Injection",
    "icon": "router"
  },
  {
    "id": "instruments.view",
    "label": "View Instruments",
    "category": "Data Injection",
    "icon": "cpu"
  },
  {
    "id": "instruments.create",
    "label": "Create Instrument",
    "category": "Data Injection",
    "icon": "plus"
  },
  {
    "id": "comm_profiles.view",
    "label": "View Communication Profiles",
    "category": "Data Injection",
    "icon": "plug"
  },
  {
    "id": "alarms.view",
    "label": "View Alarms",
    "category": "Data Injection",
    "icon": "bell"
  },
  {
    "id": "alarms.acknowledge",
    "label": "Acknowledge Alarm",
    "category": "Data Injection",
    "icon": "check"
  },
  {
    "id": "alarms.thresholds",
    "label": "Manage Alarm Thresholds",
    "category": "Data Injection",
    "icon": "sliders"
  }
];

export const FEATURE_TO_PERMISSION_MAP_SNAPSHOT: Record<string, string[]> = {
  "users.create": [
    "USER_CREATE",
    "USER_READ"
  ],
  "users.view": [
    "USER_READ"
  ],
  "users.edit": [
    "USER_UPDATE",
    "USER_READ"
  ],
  "users.delete": [
    "USER_DELETE",
    "USER_READ"
  ],
  "users.enable_disable": [
    "USER_ENABLE_DISABLE",
    "USER_READ"
  ],
  "users.unlock": [
    "USER_UNLOCK",
    "USER_READ"
  ],
  "users.reset_password": [
    "USER_RESET_PASSWORD",
    "USER_READ"
  ],
  "config.view": [
    "CONFIG_READ"
  ],
  "config.edit": [
    "CONFIG_UPDATE",
    "CONFIG_READ"
  ],
  "config.field_ids": [
    "FIELD_ID_UPDATE",
    "CONFIG_READ"
  ],
  "roles.manage": [
    "ROLE_MANAGE"
  ],
  "notifications.view": [
    "NOTIFICATION_VIEW"
  ],
  "notifications.delete": [
    "NOTIFICATION_DELETE"
  ],
  "audit.view": [
    "AUDIT_READ"
  ],
  "audit.export": [
    "AUDIT_EXPORT",
    "AUDIT_READ"
  ],
  "audit.delete": [
    "AUDIT_DELETE",
    "AUDIT_READ"
  ],
  "dashboard.view": [
    "DASHBOARD_VIEW"
  ],
  "dashboard.create": [
    "DASHBOARD_CREATE",
    "DASHBOARD_VIEW"
  ],
  "dashboard.manage": [
    "DASHBOARD_MANAGE",
    "DASHBOARD_VIEW"
  ],
  "dashboard.assign": [
    "DASHBOARD_ASSIGN",
    "DASHBOARD_VIEW"
  ],
  "admin_requests.approve": [
    "ADMIN_REQUEST_APPROVE"
  ],
  "admin_requests.reject": [
    "ADMIN_REQUEST_REJECT"
  ],
  "debug.view": [
    "READ_DEBUG_TRACE"
  ],
  "debug.manage": [
    "MANAGE_DEBUG_TRACE"
  ],
  "backup.export": [
    "BACKUP_EXPORT"
  ],
  "backup.restore": [
    "BACKUP_RESTORE"
  ],
  "hierarchy.view": [
    "HIERARCHY_VIEW"
  ],
  "hierarchy.create": [
    "HIERARCHY_CREATE",
    "HIERARCHY_VIEW"
  ],
  "hierarchy.edit": [
    "HIERARCHY_UPDATE",
    "HIERARCHY_VIEW"
  ],
  "hierarchy.delete": [
    "HIERARCHY_DELETE",
    "HIERARCHY_VIEW"
  ],
  "gateways.view": [
    "GATEWAY_VIEW"
  ],
  "instruments.view": [
    "INSTRUMENT_VIEW"
  ],
  "instruments.create": [
    "INSTRUMENT_CREATE",
    "INSTRUMENT_VIEW",
    "HIERARCHY_VIEW",
    "GATEWAY_VIEW",
    "COMM_PROFILE_VIEW"
  ],
  "comm_profiles.view": [
    "COMM_PROFILE_VIEW"
  ],
  "alarms.view": [
    "ALARM_VIEW",
    "INSTRUMENT_VIEW"
  ],
  "alarms.acknowledge": [
    "ALARM_ACKNOWLEDGE",
    "ALARM_VIEW"
  ],
  "alarms.thresholds": [
    "ALARM_THRESHOLD_MANAGE",
    "ALARM_VIEW",
    "INSTRUMENT_VIEW"
  ]
};

export const SIDEBAR_PRIVILEGE_MAP_SNAPSHOT: SidebarSectionSnapshot[] = [
  {
    "sidebarId": "dashboard",
    "label": "Dashboard",
    "icon": "🏠",
    "description": "Main dashboard view",
    "privilegeIds": []
  },
  {
    "sidebarId": "users",
    "label": "Users",
    "icon": "👥",
    "description": "User management",
    "privilegeIds": [
      "users.view",
      "users.create",
      "users.edit",
      "users.delete",
      "users.reset_password",
      "users.unlock",
      "users.enable_disable"
    ]
  },
  {
    "sidebarId": "admin-requests",
    "label": "Admin Requests",
    "icon": "📋",
    "description": "Review and process user requests",
    "privilegeIds": [
      "admin_requests.approve",
      "admin_requests.reject"
    ]
  },
  {
    "sidebarId": "configuration",
    "label": "Configuration",
    "icon": "⚙️",
    "description": "System settings",
    "privilegeIds": [
      "config.view",
      "config.edit"
    ]
  },
  {
    "sidebarId": "notifications",
    "label": "Notifications",
    "icon": "🔔",
    "description": "Notification center",
    "privilegeIds": [
      "notifications.view",
      "notifications.manage",
      "notifications.delete"
    ]
  },
  {
    "sidebarId": "audit",
    "label": "Audit Trail",
    "icon": "📝",
    "description": "Activity logs",
    "privilegeIds": [
      "audit.view",
      "audit.export"
    ]
  },
  {
    "sidebarId": "system-health",
    "label": "System Health",
    "icon": "📊",
    "description": "System health monitoring",
    "privilegeIds": []
  },
  {
    "sidebarId": "debug-traces",
    "label": "Debug Traces",
    "icon": "🐛",
    "description": "Pipeline debug traces",
    "privilegeIds": [
      "debug.view",
      "debug.manage"
    ]
  },
  {
    "sidebarId": "data-injection",
    "label": "Data Injection",
    "icon": "🔗",
    "description": "Instruments, gateways and industrial communication",
    "privilegeIds": [
      "hierarchy.view",
      "gateways.view",
      "instruments.view",
      "comm_profiles.view"
    ]
  }
];
