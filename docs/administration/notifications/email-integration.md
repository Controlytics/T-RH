# Email Integration

Configure SMTP or OAuth2 email delivery for notifications. One of 4 notification channels (Email, SMS, Telegram, Slack).

## SMTP Setup
Host, port, username, password, from address. Supports TLS/STARTTLS.
Note: Use family: 4 for IPv4-only SMTP servers (e.g., smtp.office365.com).

## OAuth2
Client ID, client secret, refresh token for Gmail/Outlook OAuth2 authentication.

## Templates
Customizable email templates with variable substitution.

## Configuration
Managed via the `notification-email` config definition. Access at Config > Notification Email.

## Phase 2 Usage
Email notifications can be triggered for filter operations:
- PM schedule reminders and overdue alerts
- Cleaning cycle completion notifications
- Bypass deviation alerts
- Filter retirement notices

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
