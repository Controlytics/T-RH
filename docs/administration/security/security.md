# Security

## Authentication
- JWT tokens with 30-minute auto-refresh
- Session management with idle timeout and warning
- Single-tab enforcement per user
- Re-authentication required for sensitive operations (managed via `action-reauth` config)
- Configurable login security (lockout after failed attempts, via `login-security` config)

## Input Sanitization
All text inputs are sanitized to strip HTML tags (XSS prevention) via lib/sanitize.ts.

## Device Security
- Unique access tokens per entity
- Optional IP allowlists
- Rate limiting (configurable per credential)
- ~~MQTT TLS support (port 8883)~~ *(removed 2026-06-17 — Phase 7 tear-out; no MQTT broker)*

## Data Security
- PostgreSQL role-based access
- ~~TimescaleDB compression for data at rest~~ *(removed 2026-06-17 — Phase 7 tear-out; vanilla PostgreSQL 18)*
- SHA-256 hash-chain audit trail
- Backup integrity verification
- Organization scoping ensures cross-tenant data isolation

## Password Policy
Configurable via `password-policy` config:
- Complexity requirements (min length, uppercase, lowercase, numbers, special chars)
- Password history (prevent reuse)
- Password expiration
- Account lockout after failed attempts

## Phase 2 Filter Security
- All filter state transitions require authenticated user context
- Bypass operations require FILTER_BYPASS privilege and deviation justification
- Checklist submissions within pipeline are bound by electronic signatures
- Organization-scoped data isolation for multi-tenant filter management

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
