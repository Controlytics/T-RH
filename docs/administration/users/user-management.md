# User Management

## Roles (6 hierarchical)
| Role | Level | Description |
|------|-------|-------------|
| SUPER_ADMIN | 6 | Full access, system configuration |
| ADMIN | 5 | User & config management |
| SUPERVISOR | 4 | Audit, approvals, assets |
| MAINTENANCE | 3 | Audit, asset CRUD, filter operations |
| OPERATOR | 2 | Audit read, asset view, checklist submission |
| VIEWER | 1 | Read-only audit |

## User Lifecycle
Created (with temporary password) > Force password change > Active > Can be Disabled/Locked/Expired

## Features
- Configurable User ID format (prefix, sequential, etc.) via `user-id` config
- Password policy (history, expiration, complexity) via `password-policy` config
- Account lockout after failed attempts via `login-security` config
- Bulk operations (up to 50 users)
- Session termination on role/status change

## Default Login
- **Username:** superadmin
- **Password:** Admin@123

## Phase 2 Roles
All 6 roles can be assigned Phase 2 filter management privileges (FILTER_OPERATE, FILTER_BYPASS, FCP_READ/CREATE/UPDATE, FP_READ/CREATE, CYCLE_READ, EVENT_READ, PM_READ/CREATE/UPDATE/EXECUTE) via the `role-privileges` config definition.

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
