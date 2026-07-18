# MQTT Setup

Powered by **Mosquitto 2.0** broker (Phase 1 of windows-friendly-rewrite swapped from EMQX, 2026-04-29).

## Connection
- Host: your Windows server IP (e.g. `192.168.1.22`), Port: **1883 (TCP)**
- Username: entity access token, Password: empty
- TLS / WebSocket ports: not enabled in the default install — turn them on in `mosquitto/mosquitto.windows.conf` if needed

## Topics
- `v1/devices/me/telemetry` — send telemetry
- `v1/devices/me/attributes` — update attributes
- `v1/devices/me/events` — send device events

## ACL Rules
Devices are authorized via **Mosquitto v2 dynamic-security** (instead of HTTP webhook callbacks). The API regenerates `dynamic-security.json` from active `DeviceCredential` rows on demand:

```
POST /api/internal/mqtt/refresh-acl
Authorization: Bearer <MOSQUITTO_REFRESH_TOKEN>
```

After every refresh-acl call, copy `<repo>/mosquitto/dynamic-security.json` into `C:\Program Files\mosquitto\` and `Restart-Service mosquitto` (the broker reads dynsec at startup).

The API's server-side MQTT client subscribes to `digilog/v1/#` for all entity data.

## QoS
0 (at most once), 1 (at least once, recommended), 2 (exactly once)

## LWT (Last Will and Testament)
Device disconnection is detected via LWT messages and ConnectivityStatus is updated to OFFLINE.

## Dashboard
**Mosquitto has no web dashboard.** Logs at `C:\Program Files\mosquitto\mosquitto.log`. Inspect dynsec via `Get-Content "C:\Program Files\mosquitto\dynamic-security.json" | ConvertFrom-Json`. (The legacy EMQX dashboard at port 18083 is no longer used.)

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
