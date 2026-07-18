# 21 CFR Part 11 Compliance

DigiLog implements the following 21 CFR Part 11 requirements across both core IoT data logging and Phase 2 Digital Filter Management.

## Subpart B — Electronic Records

### 11.10 Controls for Closed Systems
| Requirement | Implementation |
|------------|----------------|
| (a) System validation | Comprehensive test suites (1,344 tests, 0 failures) |
| (b) Generate accurate copies | Backup/restore with SHA-256 integrity, CSV/JSON/PDF export |
| (c) Record protection | PostgreSQL 18 with role-based access, Prisma ORM (57 models), encrypted connections |
| (d) System access limits | 6 hierarchical roles, 52+ permissions, session management |
| (e) Audit trail | SHA-256 hash-chain, before/after snapshots, immutable via DB trigger |
| (f) Operational checks | Input validation, schema enforcement, rate limiting, input sanitization (lib/sanitize.ts) |
| (g) Authority checks | Permission-based route guards, re-authentication for sensitive ops (action-reauth config) |
| (h) Device checks | Device credential validation, IP allowlists, rate limiting |
| (i) Training | Role-based UI, 28+ in-app help articles with version history |
| (j) Written policies | Configurable password policy, session timeout, audit retention (35 config definitions) |
| (k) Documentation | API docs (Swagger at /docs), architecture docs, test documentation |

### 11.30 Controls for Open Systems
- HTTPS support — Fastify TLS via mkcert (or any CA-issued cert) on port 3000; reverse proxy in front (Nginx / IIS) is optional / customer-choice after Phase 4 of the windows-friendly-rewrite
- JWT token authentication with 30-minute refresh
- Session idle timeout with configurable warning
- Single-tab enforcement per user

## Subpart C — Electronic Signatures

### 11.50 Signature Manifestations
- Each signature includes: signer name, date/time, meaning (Performed By/Checked By/Verified By)
- Displayed with the signed record

### 11.70 Signature/Record Linking
- Electronic signatures linked via SHA-256 hash chains
- recordHash = SHA-256(record data)
- signatureHash = SHA-256(recordHash + userId + timestamp)
- Re-authentication required for each signature

### 11.100 General Requirements
- Unique user IDs (configurable format via user-id config: prefix, sequential, etc.)
- Password expiration policies (configurable via password-policy config)
- Account lockout after failed attempts (configurable via login-security config)

### 11.200 Electronic Signature Components
- Username + password re-authentication for each signature event
- Biometric signatures not currently supported
- Signatures bound to individual records, not reusable

## Filter Operations Compliance (Phase 2)

- All filter state transitions recorded as immutable events with SHA-256 checksums
- Checklist answers stored with timestamps and performer identity
- Bypass deviations require FILTER_BYPASS privilege, justification, and are logged as BYPASS_DEVIATION events
- Cleaning cycle lifecycle tracked from start to completion with full event chain
- Organization scoping ensures cross-tenant data isolation
- PM schedule execution logged with electronic signatures
- Filter retirement and replacement tracked with full audit trail
- Bulk upload operations audited with before/after state tracking

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
