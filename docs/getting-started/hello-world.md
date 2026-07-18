# Hello World — Quick Start

## 1. Login
Navigate to your DigiLog instance and login:
- **URL:** http://34.232.224.0 (or your instance IP)
- **Username:** superadmin
- **Password:** Admin@123
- **Swagger:** http://34.232.224.0/docs

## 2. Create an Entity Template
1. Go to **Assets > Templates**
2. Click **Create Template**
3. Name: "Temperature Sensor", Category: "Sensor"
4. Add an attribute: key=location, type=string, required=true
5. Add an alarm rule: name="High Temp", type=THRESHOLD, field=temperature, condition=> 100, severity=CRITICAL
6. Save

## 3. Create an Entity Instance
1. Go to **Assets**
2. Click **Create Entity**
3. Select template "Temperature Sensor"
4. Name: "Sensor-01", fill location attribute
5. Save

## 4. Provision Connectivity
1. Open Sensor-01 > **Connectivity** tab
2. Click **Provision Credential**
3. Copy the access token

## 5. Send Telemetry
Use any of the auto-generated code snippets (Python, Node.js, cURL, Arduino, ESP32) from the Connectivity tab, or:
```bash
curl -X POST http://34.232.224.0/api/data/telemetry \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"temperature": 72.5, "humidity": 45}'
```

## 6. Verify
- Check entity > **Telemetry** tab for the data
- Send temperature > 100 to trigger the alarm
- Check **Alarms** dashboard

## 7. Try Digital Filter Management (Phase 2)
1. Go to **Cleaning Profiles** and create a pipeline with stages and checklist nodes
2. Go to **Filter Profiles** and assign a cleaning profile to a filter
3. Start a cleaning cycle via **Filter Operations**
4. Advance through stages, submit checklists, and track cycle completion
5. View cycle history and filter events for full traceability

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
