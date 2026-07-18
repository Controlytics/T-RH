# Acceptance Criteria

Per-feature "it's done when…" bullets. QA signs a feature off only when every bullet for that feature is green. Each item is grounded in what's implemented in the code as of 2026-04-20.

---

## Auth

- Login accepts a valid username/password pair; invalid ones increment a lockout counter and lock the account after the configured threshold.
- JWT refresh returns a new access + refresh pair; the old refresh is revoked.
- `/api/auth/me` returns the user, roles, permissions, and expiry.
- Forgot-password issues a reset email (or, in dev, returns the reset link).
- Change-password enforces the active password policy.
- Reauth (`POST /api/auth/verify`) is required for every action listed in the reauth-config; the reauth window is configurable.
- Public paths (login, forgot-password, beacon-logout, health) authenticate per their own rules — no JWT needed. *(internal MQTT, WebSocket, and device-token endpoints were removed 2026-06-17..2026-07-03 with the MQTT/WebSocket/data-ingestion tear-out.)*

## Users & roles

- User CRUD works for the 11 user endpoints under `/api/users`.
- Role CRUD works; deleting a role fails if any active users are assigned to it.
- `GET /api/roles/active` is reachable without auth (contact-admin page depends on it).
- Permission catalog is exhaustive — all **109** permissions enumerated in `@digilog/shared/PERMISSIONS` appear in the backend `permissions/all` response.
- Creatable-role matrix enforces that e.g. an ADMIN cannot create a SUPER_ADMIN.
- Bulk delete removes multiple users in one call with appropriate audit rows.
- Enable / disable / unlock / reset-password all log to audit with the actor.

## Config

- Every `*/current` endpoint returns the current config with the correct Zod-valid shape.
- `PUT` on a config tab sends only that tab's fields; fields from other tabs are preserved (verify by editing two tabs sequentially).
- `config-discovery.ts` auto-registers dynamic configs on boot — the `/registry/manifest` endpoint lists them.
- Branding change applies across all pages without reload (CSS vars on `:root`).
- Password policy change is enforced on the next login / change-password call.
- Session config change takes effect after cache TTL (1 min).

## Audit

- Every mutation on business data produces exactly one audit row.
- Audit rows carry: actor, timestamp, action, entity type, entity ID (UUID hidden in UI), pre/post snapshot.
- Hash-chain verification succeeds over a random sample of 50 consecutive rows.
- Manual tampering with an audit row breaks the chain and is detectable by the verification helper in `lib/hash-chain.ts`.

## Assets & hierarchy

- Template attribute schema enforces `dataType`, `required`, and `dropdownOptions` on instance create/update.
- Template versions are retained; reading an older version returns its historical schema.
- Instance tree returns the full hierarchy below a given node.
- Bulk-upload-filters accepts a CSV and reports per-row success / failure.
- One identifier per entity is enforced — a second identifier request fails with a clear error.
- Identifier lookup by value is O(1) and works both online and offline (via the cached identifier map).

## ~~Rule chain + ingestion~~ *(REMOVED — rule-chain 2026-05-17; data-ingestion / TimescaleDB / MQTT / retention 2026-06-17. All criteria below are obsolete.)*

- ~~77 node types registered and returned by `/api/rule-chains/node-types`.~~
- ~~Chain save compiles without error for a valid graph…~~
- ~~`/api/data/telemetry` with a valid device token inserts into TimescaleDB via the batcher.~~
- ~~MQTT ingestion reaches the same pipeline as HTTP.~~
- ~~Debug trace endpoint shows every pipeline step for a message…~~ *(the `/api/debug/traces` inspector SURVIVES but was repurposed 2026-06-12 onto `audit_trail` — it no longer shows ingestion pipeline steps.)*
- ~~Retention execute deletes rows older than the configured window…~~

## Queries & dashboards *(only Dashboards survive)*

- ~~Telemetry latest returns the latest non-null value per key; timeseries respects `from`/`to`/`interval`.~~ *(removed 2026-06-17 with the queries/TimescaleDB tear-out)*
- ~~Alarms list supports severity filter, per-entity filter, acknowledged/cleared filters.~~ *(removed 2026-05-17 with the alarm tear-out)*
- ~~Exports return a jobId; `/status/:jobId` polls to completion…~~ *(the telemetry/alarm query-export jobs were removed 2026-06-17)*
- Dashboard widgets render with data from the adapter endpoint; widget catalog is complete. *(survives; the `timeseries_chart` widget returns `[]` cleanly post-TimescaleDB removal.)*

## Cleaning cycle (Phase 3 core)

- Start cycle requires a reason and records it.
- Advance blocks if a pending checklist is unchecked — server returns 409/400.
- Bypass requires a remark and logs a deviation.
- Retire + replace transitions are allowed only from valid states per the state machine.
- Cycle auto-completes when the terminal stage is reached.
- `current-state` returns next valid actions.
- `batch-states` handles up to N filters in one call (N = configured batch cap).

## PM schedule

- CSV template download includes all columns for the current filter template (dynamic).
- Upload rejects past-date entries.
- Approve / reject / resubmit / edit flows work; pending counts update in real time.
- `/due` returns tasks whose next-due timestamp is ≤ now.
- `/my-tasks` on the frontend shows only the current user's due tasks.

## RFID & offline

- RFID keyboard guard is active site-wide (verify by typing into a non-`data-rfid` field while "scanning").
- Scan dialog resolves the filter name + parent AHU within 300 ms of tag detection.
- Offline queue persists across tablet reload.
- Reconnect triggers sync within ~15 s; replayed events preserve `offlinePerformedAt` timestamps on the server.
- "Data Synced" indicator appears when filters + templates + reasons + identifier map are all cached.
- Online check is driven by `/api/health` poll, not `navigator.onLine` alone.

## Reports

- Template editor saves a valid template and creates a new version.
- Generate accepts a template + date range + filter selection and creates a pending report.
- Sign requires reauth; signature captured with name + timestamp + signature image.
- Reject records the reason.
- PDF download respects the configured header/footer/records-per-page/compact.

## Admin requests + block-change

- Admin request creation requires a requester Employee ID (schema-enforced).
- Approval **executes** the requested action (create user, unlock, reset, modify).
- Audit trail has two rows per request: creation + execution.
- Block-change requests are single-use (re-approving a consumed request fails).
- Every approval screen requires a mandatory remark.

## Backup / restore

- Export produces a ZIP covering all 64 tables (count-verify against `pg_tables`).
- Restore rehydrates all tables in a single transaction; two-pass self-referential fixup handles FKs that point inside the same table.
- Non-superuser DB roles can run the export/restore (does not require `SUPERUSER`).

## Super-admin data console

- List, edit, delete on all 8 surfaces (cleaning-cycles, filter-events, audit-trail, alarms, notifications, admin-requests, block-change-requests, pm-entries).
- Every mutation logs to audit with the super-admin actor.
- Only users with the super-admin role can reach any `/api/super-admin/*` endpoint.

## System health

- `/api/system-health` returns green for Postgres + the graphile-worker queue. *(The TimescaleDB, Mosquitto/MQTT, ingestion-worker, maintenance-worker, and Redis checks were removed 2026-05..2026-06-17 with those subsystems.)*
- The `/system-health` page renders per-service status cards, refresh on 15-s interval.

---

## Cross-cutting

- All pages use the same light theme; no dark styles anywhere (verify by a visual scan of a random 10 pages).
- Theme change persists across logout + login.
- Sidebar visibility respects `SIDEBAR_PRIVILEGE_MAP` — creating a role with limited permissions hides the relevant items.
- Error popups (not inline banners) are used for terminal errors.
- Remarks mandatory on every approval/decision UI (except filter cleaning stages).
- Single-tab enforcement prevents two simultaneous sessions in different tabs of the same browser.
