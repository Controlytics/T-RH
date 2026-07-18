# Alarms

Real-time monitoring with lifecycle management.

## Alarm Types
- **Threshold**: value exceeds limit (e.g., temperature > 100)
- **Rate of Change**: value changes too rapidly
- **Absence**: expected data stops arriving

## Lifecycle
ACTIVE -> ACKNOWLEDGED -> CLEARED (or MANUALLY_CLEARED)

## Severity
WARNING, ALARM, CRITICAL

## Management
- Auto-created by rule chains (Create Alarm node) — 77 node types across 8 categories
- Auto-cleared when condition resolves (Clear Alarm node)
- Manual acknowledge/clear with electronic signature (21 CFR Part 11)
- Dashboard with filtering by severity, status, entity, type, date range, assignee
- Real-time badge count in sidebar via WebSocket
- Bulk acknowledge for selected alarms

## Notifications
Alarm events can trigger notifications via 4 channels: Email, SMS, Telegram, Slack (configured via notification rules).

## Phase 2 Integration
Filter management operations can generate alarms:
- PM schedule overdue alerts
- Bypass deviation warnings
- Equipment group alerts
These alarms follow the same lifecycle and appear in the unified alarm dashboard.

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
