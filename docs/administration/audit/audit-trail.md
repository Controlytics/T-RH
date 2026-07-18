# Audit Trail

Tamper-evident log of all system activities, including Phase 2 Digital Filter Management operations.

## What Gets Logged

### Core Operations
- User actions (login/logout, password changes, session events)
- Entity operations (CRUD, status changes, relationship changes)
- Configuration changes (all 23 config modules)
- Data operations (backup/restore, exports)
- Checklist submissions and approvals (3-step workflow)
- Rule chain create/update/delete with version tracking

### Phase 2 Filter Operations
- Filter cycle start, stage advance, cycle completion
- Checklist submissions within cleaning pipeline
- Stage bypass with deviation justification
- PM schedule create/update/execute
- Filter retirement and replacement
- Cleaning profile create/update
- Filter profile assignment changes

## Entry Fields
Timestamp, User, Role, Action, Target, Before/After Value, IP, User Agent, Session ID, Checksum

## Integrity
SHA-256 hash-chain -- each entry hashes the previous. Modification breaks the chain and is detectable.

## Compliance
Satisfies 21 CFR Part 11 sections 11.10(e), 11.10(k)(2), 11.50, 11.70.

All filter operations are recorded as immutable events with SHA-256 checksums, electronic signatures, and deviation tracking.

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
