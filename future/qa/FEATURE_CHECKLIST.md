# Feature Checklist

A QA-friendly enumeration of **every feature area the codebase actually implements**, plus a quick "how do I verify it" hint. Do not trust older `*_REQUIREMENTS.md` documents — if it's listed here, the code actually exists.

Legend: ☐ to verify, ✅ verified, ❌ blocked.

---

## 1. Auth & session

- ☐ Login with valid credentials redirects to dashboard
- ☐ Invalid credentials show the right error + bump the lockout counter
- ☐ Forgot password sends an email (or renders the link in dev)
- ☐ Change password self-service works for the current user
- ☐ Session expires after configured hours (default 8h in seed)
- ☐ Single-tab enforcement blocks second tab (BroadcastChannel)
- ☐ Logout + beacon-logout on tab close revokes refresh token
- ☐ Reauth dialog appears for protected actions (e.g., report sign, sensitive config update)

**Where:** `/login`, `/forgot-password`, `/change-password`, `/profile`.

## 2. Users, roles, permissions

- ☐ Create, edit, delete, enable/disable/unlock/reset-password
- ☐ Bulk delete
- ☐ Password reset self-requests appear in `/users/reset-requests`
- ☐ Roles: create, edit, delete, clone-from-template; `creatable` matrix gates who can create whom
- ☐ `/api/roles/active` is public (contact-admin page must render without auth)
- ☐ Permission catalog has **102 permissions** (verify against `PERMISSIONS` in `@digilog/shared`)
- ☐ **83 feature privileges** + `FEATURE_TO_PERMISSION_MAP` (each maps to BOTH frontend visibility perm AND backend route perm)
- ☐ **26 sidebar items** + `SIDEBAR_PRIVILEGE_MAP` filters by current role
- ☐ Role scope (`ORGANIZATION`, `TENANT`, etc.) respected on every listing endpoint

**Where:** `/users`, `/config/roles`, `/config/access-matrix`.

## 3. Config surface (34 config pages)

- ☐ Each config page loads from `/api/config/.../current` (or `/api/config/:key`)
- ☐ `PUT` sends only the page's own fields; unrelated fields are preserved server-side
- ☐ Password policy (complexity, expiry, history)
- ☐ Branding (logo upload, company, theme preset — 10 presets)
- ☐ Datetime (locale + format)
- ☐ User-ID (dynamic prefix/sequence rules, `/validate` endpoint)
- ☐ Field IDs (label + required overrides per field)
- ☐ Action reauth (**92** reauth actions across 16 categories)
- ☐ Audit templates (default + category + custom overrides)
- ~~☐ Alarm columns (which columns appear in the alarm table)~~ *(removed 2026-05-17 with the alarm tear-out)*
- ☐ Pagination (rows per page default)
- ☐ Dashboard cards (which dashboard cards are visible)
- ☐ Cleaning profile assignment (per-filter-set)
- ☐ AHU filter-set config (mode select, overrides)
- ☐ Filter data management (super-admin console — edit/delete cleaning cycles, events, notifications, admin-requests, block-change-requests, PM entries, audit trail; *the alarms tab was removed 2026-05-17*)
- ☐ Tablet access (per-feature toggles)
- ☐ Report settings (header/footer/pagination/compact)
- ~~☐ UNS (tree view, entity move-confirm)~~ *(removed 2026-06-17 with the UNS tear-out)*
- ☐ Help article manager (versioned)
- ~~☐ Retention policies (execute, execute-range, delete-keys, delete-records)~~ *(removed 2026-06-17 with the data-ingestion tear-out)*
- ☐ Backup / restore (dynamic — all 64 tables)
- ☐ LDAP (config, test-connection, status)

**Where:** `/config/...` (30+ pages).

## 4. Audit trail + 21 CFR compliance

- ☐ Every mutation on business data creates an audit row
- ☐ Rows are hash-chained — manual corruption breaks the chain and is detected
- ☐ Audit list supports filter + bulk delete (super-admin only)
- ☐ Reports can be signed with reauth (e-sig)
- ☐ Approvals / rejections require mandatory remarks (except filter cleaning stages)
- ☐ Audit trail rendered via `ReportPageWrapper` with configured header/footer

**Where:** `/audit`, `/reports`.

## 5. Assets (templates + instances + identifiers)

- ☐ Templates CRUD with dynamic attribute schema (typed + required + dropdownOptions)
- ☐ Template versions tracked
- ☐ Instances CRUD + bulk-upload-filters + tree view + status + lifecycle-state
- ☐ Relationships CRUD (with inverse-relationship map)
- ☐ Identifiers CRUD + lookup by value + one-per-entity enforcement
- ☐ Create dialog renders from `attributeSchema` (not a static form)
- ☐ Hierarchy: Block → Area → AHU → Filter visual builder with create/connect/edit/delete

**Where:** `/assets`, `/assets/templates`, `/filter-list`, `/ahus/:id`.

## ~~6. IoT ingestion + rule chain + queries~~ *(REMOVED — rule-chain 2026-05-17; data-ingestion / UNS / queries / connectivity / TimescaleDB / MQTT 2026-06-17. This entire section is obsolete.)*

- ~~☐ HTTP: `/api/data/telemetry`, `/attributes`, `/checklist`, `/binary`, `/event`, `/rpc` device-token auth~~
- ~~☐ MQTT: Mosquitto 2.0 dynamic-security via `POST /api/internal/mqtt/refresh-acl`~~
- ~~☐ Rule chain editor supports all 77 node types~~
- ~~☐ Chain save compiles; `/debug` shows traces~~
- ~~☐ Queries: telemetry latest/timeseries/keys, attributes + history…~~
- ~~☐ Exports: async job returned; `/status/:jobId` polls~~
- ~~☐ Alarms: list, summary, ack, clear, per-entity~~
- ~~☐ Retention: config + execute + execute-range + delete-keys/records~~
- ~~☐ UNS: tree, search, entity CRUD, move + confirm~~
- ~~☐ Connectivity: per-entity snippets + token issue/revoke + history~~

**Where:** ~~`/rule-chains`, `/alarms`, `/debug/traces`, `/config/retention`, `/config/uns`~~ — *all removed. (The `/debug/traces` page survives but was repurposed 2026-06-12 onto `audit_trail`.)*

## 7. Cleaning cycle state machine (Phase 3 core)

- ☐ Start cycle picks a reason, records user + time
- ☐ Advance flows through stages defined by the assigned cleaning profile
- ☐ CHECKLIST node between stages blocks Advance until checklist is submitted — enforced server-side
- ☐ Bypass records a deviation with a mandatory remark
- ☐ Retire + Replace flows work; retirements/replacements are listable
- ☐ Terminate cycle closes without completion
- ☐ Cycle auto-completes when the last stage leads to END
- ☐ Filter current-state endpoint returns state + next valid actions
- ☐ Batch-state endpoint supports multi-filter views

**Where:** `/filters`, `/filters/:id/operate`, `/cleaning-cycles`.

## 8. PM schedules + my tasks

- ☐ Download CSV template
- ☐ Upload CSV — past-date entries rejected
- ☐ Approvals (approve / reject / resubmit / edit) with pending counts
- ☐ Due endpoint returns tasks due now
- ☐ Per-entity history + CRUD
- ☐ Per-user `/my-tasks` view

**Where:** `/pm-schedules`, `/my-tasks`, `/approvals`.

## 9. RFID + offline (Phase 3/4)

- ☐ RFID keyboard guard blocks tag bursts on non-`data-rfid="true"` inputs
- ☐ Scan dialog identifies filter + parent AHU after tag detected
- ☐ One-identifier-per-entity enforced on create
- ☐ Data Synced indicator appears when cache loaded
- ☐ Going offline: new cleaning actions queue in IndexedDB
- ☐ Going back online: sync engine replays FIFO within ~15 s
- ☐ Replayed events preserve the original timestamp (`offlinePerformedAt`)
- ☐ Cached identifier map enables offline RFID lookup
- ☐ Online detection uses `/api/health` poll, not just `navigator.onLine` (APK-safe)

**Where:** `/m` (tablet), `/filters` (desktop).

## 10. Notifications

- ☐ Inbox lists notifications with unread count badge
- ☐ Mark single read/unread + bulk + bulk delete
- ☐ Notification rules: event-types list, CRUD, toggle, test-send
- ☐ Email channel: config + OAuth2 flow for M365/Google + test-send + logs
- ☐ SMS channel: config + test-send
- ☐ Templates: CRUD

**Where:** `/notifications`, `/config/notification-rules`, `/config/notification-settings`.

## 11. Reports

- ☐ Template CRUD + toggle + versions + duplicate
- ☐ Generate with template + date range
- ☐ List + detail + PDF download + preview
- ☐ Sign with reauth (21 CFR e-sig)
- ☐ Reject with reason
- ☐ PDFs respect the Report Settings (header/footer/records-per-page/compact)

**Where:** `/report-templates`, `/reports`, `/reports/generate`.

## 12. Dashboards

- ☐ Dashboard CRUD + layout edit
- ☐ Widget CRUD + `GET /widget-types` catalog
- ☐ Dashboard assignment to users / groups
- ☐ Data adapter endpoint serves widget data

**Where:** `/` (default dashboard) and dashboard admin pages.

## 13. Admin requests + block-change + approvals

- ☐ Admin request types: create user, unlock, reset password, modify user
- ☐ Requester Employee ID required
- ☐ Approvers see pending count + list
- ☐ Approval actually **executes** the requested action server-side
- ☐ Audit trail has both request-creation and execution rows; UUIDs hidden in audit display
- ☐ Block-change request: mandatory remarks, single-use consumption, desktop + mobile popup
- ☐ `/approvals` inbox aggregates block-change + PM approvals

**Where:** `/admin-requests`, `/approvals`.

## 14. Multi-tenant + super-admin

- ☐ Organization CRUD + stats
- ☐ Per-org detail: users, entities, templates, user-entity assignments, visible-entities
- ☐ Super-admin data management console edits/deletes rows across 8 tables

**Where:** `/tenant`, `/config/filter-data-management`.

## 15. Theming

- ☐ 10 preset themes (Ocean, Sapphire, Emerald, Amethyst, Sunset, Slate, Ruby, Forest, Midnight, Coral)
- ☐ Theme change updates CSS variables on `:root` without reload
- ☐ All pages light theme; no per-page color divergence
- ☐ Branding: logo + company name update in header + login + reports

**Where:** `/config/branding`.

## 16. System health + deployment check

- ☐ `/api/system-health` returns aggregate + per-service
- ☐ `/api/deployment-check` passes after a fresh deploy (used in CI)
- ☐ `/system-health` page in UI shows a green board

**Where:** `/system-health`.
