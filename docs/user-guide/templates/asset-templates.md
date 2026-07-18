# Asset Templates

Templates define reusable blueprints for entity types.

## Fields
- Name, Category, Description, Icon
- Attribute Schema (14 data types: INTEGER, FLOAT, BOOLEAN, TEXT, FILE, URL, DATE, DATETIME, DROPDOWN, etc.)
- Checklist Schema (14 question types)
- Relationship Constraints (max connections, max parents)

## Versioning
Every edit creates a new version. Instances track which version they were created from.

## Phase 2: Filter Templates
Templates can be used for filter entities. When an entity created from a template is assigned a filter profile, it gains filter-specific fields (filter_profile_id, current_lifecycle_state, current_cycle_id, filter_set) and can participate in the cleaning pipeline workflow.

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
