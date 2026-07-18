# Roles & Permissions

## 52+ Privileges

### User Management
USER_CREATE, USER_READ, USER_UPDATE, USER_DELETE, USER_ENABLE_DISABLE, USER_UNLOCK, USER_RESET_PASSWORD

### Configuration
CONFIG_READ, CONFIG_UPDATE, FIELD_ID_UPDATE, ROLE_MANAGE

### Assets
ASSET_VIEW, ASSET_CREATE, ASSET_UPDATE, ASSET_DELETE, ASSET_TEMPLATE_MANAGE, ASSET_RELATIONSHIP_MANAGE, ASSET_IDENTIFIER_MANAGE

### Audit & Compliance
AUDIT_READ, AUDIT_EXPORT, APPROVAL_REQUEST, APPROVAL_REVIEW

### Data & Integration
UNS_VIEW, UNS_MANAGE, RULE_CHAIN_VIEW, RULE_CHAIN_UPDATE, RULE_CHAIN_MANAGE, READ_DEBUG_TRACE, MANAGE_DEBUG_TRACE
DATA_INGEST, DATA_VIEW, DATA_MANAGE, DATA_EXPORT
ALARM_VIEW, ALARM_MANAGE
QR_CODE_GENERATE, HELP_MANAGE
CHECKLIST_SUBMIT, CHECKLIST_REVIEW, CHECKLIST_APPROVE
RETENTION_MANAGE, SYSTEM_CONFIG_MANAGE

### Phase 2 Filter Management Privileges

| Permission | Description |
|------------|-------------|
| FILTER_OPERATE | Start cycles, advance stages, submit checklists |
| FILTER_BYPASS | Bypass stages with deviation logging |
| FCP_READ | View cleaning profiles |
| FCP_CREATE | Create cleaning profiles |
| FCP_UPDATE | Update cleaning profiles |
| FP_READ | View filter profiles |
| FP_CREATE | Create filter profiles |
| CYCLE_READ | View cleaning cycles |
| EVENT_READ | View filter events |
| CHECKLIST_SUBMIT | Submit checklists (shared with core) |
| PM_READ | View PM schedules |
| PM_CREATE | Create PM schedules |
| PM_UPDATE | Update PM schedules |
| PM_EXECUTE | Execute PM tasks |

## Permission Constants (109 total — verified 2026-04-29)

The system defines 102 permission string constants in `packages/shared/src/types/permissions.ts` (verify with `grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts`). These are grouped into categories (User Management, Configuration, Assets, Audit, Data, Alarms, Filters, PM, Checklists, Reports, etc.) and referenced by the RBAC plugin to gate every API endpoint.

## Feature Privileges (91 total — verified 2026-04-29)

Feature privileges are defined in `packages/shared/src/types/feature-privileges.ts`. Each privilege maps a UI toggle (e.g. `filters.operate`) to the permission constant(s) it requires. The `FEATURE_TO_PERMISSION_MAP` object provides this mapping so the frontend can show/hide controls based on the user's role.

### Filters Page Controls (6 toggles)
| Privilege Key | Controls |
|---------------|----------|
| `filters.operate` | Start cycles, advance stages |
| `filters.bypass` | Bypass stages with deviation |
| `filters.viewCycles` | View cleaning cycle history |
| `filters.viewEvents` | View filter event log |
| `filters.profiles` | Manage filter-to-profile assignments |
| `filters.cleaningProfiles` | Manage cleaning pipeline profiles |

### Checklist Page Controls (4 toggles)
| Privilege Key | Controls |
|---------------|----------|
| `checklists.view` | View checklist profiles |
| `checklists.create` | Create new checklist profiles |
| `checklists.update` | Edit existing checklist profiles |
| `checklists.delete` | Delete checklist profiles |

### Cleaning Profile Page Controls (4 toggles)
| Privilege Key | Controls |
|---------------|----------|
| `cleaningProfiles.view` | View cleaning profiles |
| `cleaningProfiles.create` | Create cleaning profiles |
| `cleaningProfiles.update` | Edit cleaning profiles |
| `cleaningProfiles.delete` | Delete cleaning profiles |

### Equipment Group Controls (4 toggles)
| Privilege Key | Controls |
|---------------|----------|
| `equipmentGroups.view` | View equipment groups |
| `equipmentGroups.create` | Create equipment groups |
| `equipmentGroups.update` | Edit equipment groups |
| `equipmentGroups.delete` | Delete equipment groups |

### PM Page Controls (4 toggles)
| Privilege Key | Controls |
|---------------|----------|
| `pm.view` | View PM schedules |
| `pm.create` | Create PM schedules |
| `pm.update` | Edit PM schedules |
| `pm.execute` | Execute PM tasks |

### SUPER_ADMIN Bypass

Users with the `SUPER_ADMIN` role bypass all permission checks. The RBAC plugin short-circuits authorization for this role, granting access to every endpoint and every UI feature without requiring individual privileges.

### FEATURE_TO_PERMISSION_MAP

Located in `packages/shared/src/types/feature-privileges.ts`, this exported object maps each feature privilege key to the array of permission constants it requires. The frontend reads the user's granted permissions and checks this map to determine which UI controls to render. The config page at `/config/role-privileges` uses this map to build the toggle grid.

## Hierarchy Rules
- Users can only manage users at equal or lower hierarchy levels
- Custom roles can be created with any permission subset
- Role changes invalidate active sessions
- Privileges are managed via the `role-privileges` config definition

---

## Phase 3 Update (2026-04-07)

**RFID & Offline Operations:**
- RFID Scanner Android app (`rfid_scan_app/`) for KC-series UHF readers
- RFID keyboard guard prevents UKB tag input leaking into random fields
- Offline cleaning operations via IndexedDB queue + sync engine
- Cached identifier→filter map for offline RFID lookup
- "Data Synced" indicator in mobile header
- One identifier per entity (backend-enforced)
- Responsive layout with collapsible sidebar
- Error popups replace inline banners
- User creation auto-assigns org for admins
- `/api/roles/active` public endpoint for contact-admin page

See `CHANGELOG.md` for full details.
