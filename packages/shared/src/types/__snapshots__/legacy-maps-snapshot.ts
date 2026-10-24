/**
 * Phase 5E — FROZEN LITERAL SNAPSHOTS of the derived maps.
 *
 * THIS FILE HAS ZERO IMPORTS FROM LIVE SOURCE FILES.
 * Regenerated after the domain strip (2026-07-18): the oracle now reflects the
 * core-only PERMISSION_TREE.
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
    "id": "instruments.view",
    "label": "View Instruments",
    "category": "Instruments",
    "icon": "radio"
  },
  {
    "id": "instruments.create",
    "label": "Create Instruments",
    "category": "Instruments",
    "icon": "plus"
  },
  {
    "id": "instruments.edit",
    "label": "Edit Instruments / Manage Token",
    "category": "Instruments",
    "icon": "edit"
  },
  {
    "id": "instruments.delete",
    "label": "Delete Instruments",
    "category": "Instruments",
    "icon": "trash"
  },
  {
    "id": "functional_locations.view",
    "label": "View Functional Locations",
    "category": "Functional Locations",
    "icon": "map"
  },
  {
    "id": "functional_locations.create",
    "label": "Create Functional Locations",
    "category": "Functional Locations",
    "icon": "plus"
  },
  {
    "id": "functional_locations.edit",
    "label": "Edit Functional Locations / Link Instruments",
    "category": "Functional Locations",
    "icon": "edit"
  },
  {
    "id": "functional_locations.delete",
    "label": "Delete Functional Locations",
    "category": "Functional Locations",
    "icon": "trash"
  },
  {
    "id": "alarm_webhooks.view",
    "label": "View Alarm Webhooks",
    "category": "Alarms",
    "icon": "bell"
  },
  {
    "id": "alarm_webhooks.manage",
    "label": "Create / Edit / Delete / Test Alarm Webhooks",
    "category": "Alarms",
    "icon": "settings-edit"
  },
  {
    "id": "alarms.view",
    "label": "View Alarms",
    "category": "Alarms",
    "icon": "bell"
  },
  {
    "id": "alarms.acknowledge",
    "label": "Acknowledge Alarms",
    "category": "Alarms",
    "icon": "check"
  },
  {
    "id": "data_report.view",
    "label": "View Data Report",
    "category": "Data Report",
    "icon": "file-text"
  },
  {
    "id": "reports.view",
    "label": "View Reports",
    "category": "Reports",
    "icon": "file-text"
  },
  {
    "id": "reports.approve",
    "label": "Approve / Reject Reports",
    "category": "Reports",
    "icon": "check"
  },
  {
    "id": "settings.view",
    "label": "View Settings",
    "category": "Settings",
    "icon": "settings"
  },
  {
    "id": "settings.edit",
    "label": "Edit Settings",
    "category": "Settings",
    "icon": "settings-edit"
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
  "instruments.view": [
    "INSTRUMENT_READ"
  ],
  "instruments.create": [
    "INSTRUMENT_CREATE",
    "INSTRUMENT_READ"
  ],
  "instruments.edit": [
    "INSTRUMENT_UPDATE",
    "INSTRUMENT_READ"
  ],
  "instruments.delete": [
    "INSTRUMENT_DELETE",
    "INSTRUMENT_READ"
  ],
  "functional_locations.view": [
    "FUNCTIONAL_LOCATION_READ"
  ],
  "functional_locations.create": [
    "FUNCTIONAL_LOCATION_CREATE",
    "FUNCTIONAL_LOCATION_READ"
  ],
  "functional_locations.edit": [
    "FUNCTIONAL_LOCATION_UPDATE",
    "FUNCTIONAL_LOCATION_READ"
  ],
  "functional_locations.delete": [
    "FUNCTIONAL_LOCATION_DELETE",
    "FUNCTIONAL_LOCATION_READ"
  ],
  "alarm_webhooks.view": [
    "ALARM_RULE_READ"
  ],
  "alarm_webhooks.manage": [
    "ALARM_RULE_MANAGE",
    "ALARM_RULE_READ"
  ],
  "alarms.view": [
    "ALARM_READ"
  ],
  "alarms.acknowledge": [
    "ALARM_ACKNOWLEDGE",
    "ALARM_READ"
  ],
  "data_report.view": [
    "INSTRUMENT_READ"
  ],
  "reports.view": [
    "REPORT_REVIEW_READ"
  ],
  "reports.approve": [
    "REPORT_REVIEW_APPROVE",
    "REPORT_REVIEW_READ"
  ],
  "settings.view": [
    "INSTRUMENT_READ"
  ],
  "settings.edit": [
    "INSTRUMENT_UPDATE",
    "INSTRUMENT_READ"
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
      "config.edit",
      "backup.export",
      "backup.restore"
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
    "sidebarId": "instruments",
    "label": "Instruments",
    "icon": "📡",
    "description": "Instrument registry and telemetry",
    "privilegeIds": [
      "instruments.view",
      "instruments.create",
      "instruments.edit",
      "instruments.delete"
    ]
  },
  {
    "sidebarId": "functional-locations",
    "label": "Functional Locations",
    "icon": "🗺️",
    "description": "Block and Area grouping for instruments",
    "privilegeIds": [
      "functional_locations.view",
      "functional_locations.create",
      "functional_locations.edit",
      "functional_locations.delete"
    ]
  },
  {
    "sidebarId": "alarms",
    "label": "Alarms",
    "icon": "🚨",
    "description": "Limit excursions raised by alarm rules, and their acknowledgement",
    "privilegeIds": [
      "alarms.view",
      "alarms.acknowledge"
    ]
  },
  {
    "sidebarId": "data-report",
    "label": "Data Report",
    "icon": "📄",
    "description": "Readings of a Block, an Area or chosen instruments over a period, with the Data Report download",
    "privilegeIds": [
      "data_report.view"
    ]
  },
  {
    "sidebarId": "reports",
    "label": "Reports",
    "icon": "📑",
    "description": "Report requests awaiting approval, and approved reports to download",
    "privilegeIds": [
      "reports.view",
      "reports.approve"
    ]
  },
  {
    "sidebarId": "settings",
    "label": "Settings",
    "icon": "🛠️",
    "description": "Every instrument's details and attributes in one table, editable in place",
    "privilegeIds": [
      "settings.view",
      "settings.edit"
    ]
  }
];
