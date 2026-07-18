# Unified Namespace (UNS)

ISA-95 hierarchical topic structure for all entities.

## Levels
Enterprise > Site > Area > Line > Cell > Entity

## Paths
Auto-generated from entity hierarchy. Example: MyPlant/Area1/Line1/Sensor01
Path format: `digilog/v1/{Enterprise}/{Site}/{Area}/{Line}/{Cell}/{EntityName}`

## Wildcards (MQTT)
- `+` (single level): `Plant/+/Line1/#`
- `#` (multi level, must be last): `Plant/Area1/#`

## Auto-Provisioning
Entity creation auto-generates UNS mapping and provisions device credentials if the template has IoT enabled.

## Cascade Move
Moving an entity in the hierarchy triggers cascade updates to all descendant UNS paths. An impact report shows all affected paths before confirmation is required.

## Browse
Config > UNS to view the full namespace tree with entity count, device count, and connectivity summary per node. Search by path pattern with wildcard support.

## API
```
GET  /api/uns/tree                          — Full UNS tree
GET  /api/uns/entity/:entityId              — Get entity UNS mapping
PUT  /api/uns/entity/:entityId              — Override UNS path
POST /api/uns/entity/:entityId/move         — Initiate move (impact report)
POST /api/uns/entity/:entityId/move/confirm — Confirm cascade
GET  /api/uns/search?path=pattern           — Wildcard search
```

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
