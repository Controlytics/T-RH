# Checklists

Mobile-friendly digital inspection forms with 21 CFR Part 11 compliance.

## Field Types (14)
PASS_FAIL, YES_NO, YES_NO_NA, MCQ, MULTI_SELECT, TEXT, NUMERIC, DROPDOWN, PHOTO, DATE_TIME, SIGNATURE, YES_NO_COMMENT, CALCULATED, CONDITIONAL

## 3-Step Approval
1. Performed By (operator fills and signs)
2. Checked By (reviewer checks and signs)
3. Verified By (final approval with signature)

## Access
- Entity detail > Checklist tab
- QR code scan (opens /checklist/{entityId})
- Mobile-optimized UI with camera and signature pad

## Electronic Signatures
Each step requires re-authentication. Signatures include SHA-256 hash of the record data per 21 CFR Part 11 sections 11.50 and 11.70.

## Checklist Profiles (Phase 2)

Checklist Profiles are reusable question templates that can be attached to cleaning pipeline CHECKLIST nodes. Managed via the checklist-profiles API module.

### Question Types (10 for Pipeline Checklists)
| Type | Description |
|------|-------------|
| YES_NO | Yes/No toggle buttons |
| YES_NO_NA | Yes/No/N/A toggle buttons |
| PASS_FAIL | Pass/Fail with color-coded buttons |
| TEXT | Free-text textarea |
| NUMERIC | Number input |
| DROPDOWN | Single-select dropdown |
| MULTI_SELECT | Multi-select checkbox buttons |
| DATE_TIME | Date/time picker |
| PHOTO | Photo capture |
| SIGNATURE | Electronic signature |

### Pipeline Integration
When a CHECKLIST node is placed between two STAGE nodes in a cleaning profile pipeline:
1. After completing the preceding stage, the checklist dialog appears automatically
2. User must answer all required questions
3. Checklist cannot be skipped (no dismiss/skip button)
4. Server enforces completion — advance() blocks if checklist pending
5. Answers are stored as CHECKLIST_COMPLETED events in the audit trail

### API Endpoints
```
GET  /api/checklist-profiles     — List checklist profiles
POST /api/checklist-profiles     — Create checklist profile
GET  /api/checklist-profiles/:id — Get checklist profile detail
PUT  /api/checklist-profiles/:id — Update checklist profile
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
