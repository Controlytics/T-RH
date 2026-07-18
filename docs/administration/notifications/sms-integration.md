# SMS Integration

Multi-provider SMS delivery. One of 4 notification channels (Email, SMS, Telegram, Slack).

## Providers
- **AWS SNS** — Region, access key, secret key, sender ID
- **Twilio** — Account SID, auth token, from number
- **Vonage** — API key, API secret, from number

## Configuration
Managed via the `notification-sms` config definition. Access at Config > Notification SMS.

## Note
AWS SNS sandbox mode limits to verified numbers only. Exit sandbox for production.

## Additional Channels
- **Telegram** — Bot token and chat ID configuration via `notification-telegram` config
- **Slack** — Webhook URL configuration via `notification-slack` config

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
