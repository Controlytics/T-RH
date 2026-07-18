# Entities & Hierarchy

Entities represent physical equipment in a hierarchical tree following ISA-95. Managed via 65 Prisma models with 25 enums, including typed-hierarchy sidecars (Block/Area/AHU/Filter).

## Entity Templates
Templates define the blueprint: attribute schema (14 data types), checklist fields (14 question types), and relationship constraints. Every edit creates a new version.

## Entity Instances
Instances are created from templates with: unique name, UNS path, status (Active/Inactive/Under Maintenance/Decommissioned/Quarantine), attributes, and relationships.

## Hierarchy
Parent-child relationships form a tree: Enterprise > Site > Area > Line > Equipment > Sensor. Each entity has a UNS path auto-generated from its position.

## Relationships (12 types)
CONTAINS/CONTAINED_IN, FEEDS/FED_BY, DEPENDS_ON/DEPENDED_ON_BY, MONITORS/MONITORED_BY, BACKS_UP/BACKED_UP_BY, CONNECTED_TO, CUSTOM.

## Identifiers
QR Code, RFID, NFC, Barcode, Manual — for physical equipment tagging and mobile checklist scanning.

## Filter-Specific Entity Fields (Phase 2)

Asset instances can be designated as filters with additional fields:
- `filter_profile_id` — Links to a filter profile (which links to a cleaning profile)
- `current_lifecycle_state` — Current cleaning stage (e.g., WASH_IN, DRY_OUT, STORAGE_IN, READY_FOR_USE)
- `current_cycle_id` — Active cleaning cycle reference
- `filter_set` — SET_A or SET_B for dual-set AHU management

## Equipment Groups (Phase 2)
Entities can be organized into equipment groups (AHUs) for dashboard management with dual-set filter tracking, PM scheduling, and bulk operations.

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
