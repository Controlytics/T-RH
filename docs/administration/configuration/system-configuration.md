# System Configuration

35 config definitions with auto-discovery at startup. All operational limits are stored in the database (SystemConfig table), not environment variables.

## Config Definitions
| Key | Description |
|-----|-------------|
| action-reauth | Actions requiring re-authentication |
| alarm-columns | Alarm dashboard column configuration |
| audit-templates | Audit trail template definitions |
| backup | Backup and restore settings |
| branding | Application branding (logo, name) |
| datetime | Date/time format preferences |
| field-ids | Entity field ID format configuration |
| filter-cleaning-reasons | Configurable cleaning reason codes with justification support |
| filter-lifecycle-states | Filter lifecycle state definitions |
| filter-pm-schedule | PM schedule configuration for filters |
| help | Help article settings |
| login-security | Login attempt limits, lockout policy |
| notification-email | SMTP/OAuth2 email delivery settings |
| notification-logs | Notification logging configuration |
| notification-rules | Notification rule definitions |
| notification-slack | Slack webhook integration |
| notification-sms | SMS delivery (AWS SNS/Twilio/Vonage) |
| notification-telegram | Telegram bot integration |
| pagination | Default page sizes and limits |
| password-policy | Password complexity, expiration, history |
| ~~retention~~ | ~~Data retention policies per hypertable~~ *(removed 2026-06-17 — Phase 7 tear-out; no hypertables)* |
| role-privileges | Role-to-privilege mapping (52+ privileges) |
| roles | Role hierarchy definitions |
| session | Session timeout, idle warning, single-tab |
| sidebar-config | Navigation sidebar structure |
| ~~uns~~ | ~~Unified Namespace settings~~ *(removed 2026-06-17 — Phase 7 tear-out)* |
| user-id | User ID format (prefix, sequential, etc.) |

## Categories
- **Security:** Password Policy, Login Security, Session Management, Action Re-authentication
- **Display:** DateTime Format, Branding, Pagination, Field IDs, ~~Alarm Columns~~ *(removed 2026-05-17)*, Audit Templates
- **Integrations:** Email (SMTP/OAuth2), SMS (AWS SNS/Twilio/Vonage), Telegram, Slack, Notification Rules ~~, UNS~~ *(UNS removed 2026-06-17)*
- **Filter Management:** Filter Cleaning Reasons, Filter Lifecycle States, Filter PM Schedule
- **Advanced:** ~~Data Retention~~ *(removed 2026-06-17)*, Backup & Restore, System Health, Help Articles, Debug Traces

## API
- `GET /api/config/registry/manifest` — List all config modules
- `GET /api/config/dynamic/:moduleKey` — Get config for a module
- `PUT /api/config/dynamic/:moduleKey` — Update config (audit trail, some require reauth)

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
