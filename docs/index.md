# compliance-core Documentation

> **⚠ Most of this file was inherited from upstream DigiLog.** This fork is a
> 21 CFR Part 11 administration platform (users, roles, hash-chained audit
> trail, e-signature re-auth, notifications, instrument monitoring). The
> Digital Filter Management System, RFID/Android tablet operations, and the
> "Phase 3/4/5" narrative below describe upstream DigiLog or an earlier,
> pre-strip state of this repo — **none of it exists here now**. See root
> `CLAUDE.md` and `docs/recreation/` (the verified inventory) before trusting
> any claim on this page. Fixed 2026-08-24; the historical section further
> down was left as archived record, not current state.

## Platform stats (re-derive before trusting — see root `CLAUDE.md` "Live-count verification")
- **25** API modules, **37** Prisma models, **13** enums (re-derived 2026-10-01)
- **34** config definitions with auto-discovery (33 → 34 on 2026-10-01 with `sensor-offsets`), **23** config pages (re-derived `ls` 2026-10-01 — 22 → 23 with `report-settings.tsx`; 32 → 33 with `report-downloads`, no page; pages 23 → 22 on 2026-09-22 when `floorplans.tsx` became the `layout-designer/` folder. Earlier, re-derived 2026-09-16; 31 → 32 that day with `attribute-labels`, which adds no page — its column lives on Instrument Attributes; 30 → 31 on 2026-09-07 with `report-approvers`)
- **44** permissions, **50** reauth actions, **14** sidebar items (re-derive — these drift; see command block below)
- **106** audit actions, **100** audit templates, **53** `<Route`s (52 → 53 with `/config/report-settings`), **6** worker tasks (re-derived 2026-10-01 — this line read 103 / 97 / 53 / 15 sidebar items / 36 models and was already stale)
- **10** color themes, multi-channel notifications
- Single PostgreSQL database (`compliance_core_db`); Postgres-backed **graphile-worker** job queue (no Redis, no TimescaleDB). **MQTT IS live** — `mqtt@5` is in `apps/api/package.json` and `/api/ingest/v1` is registered in `app.ts`; the "no MQTT" this line carried until 2026-08-27 repeated a tear-out that was later reversed (see root `CLAUDE.md`).

Counts above re-derived 2026-08-27 with the command block below.

## Where to start

For a top-down view, prefer the docs at the repo root (verify any count against live code first):
- [`PROJECT_SUMMARY.md`](../PROJECT_SUMMARY.md) — overview
- [`PROJECT_ARCHITECTURE.md`](../PROJECT_ARCHITECTURE.md) — system architecture
- [`API_REFERENCE.md`](../API_REFERENCE.md) — API reference
- [`BACKEND_GUIDE.md`](../BACKEND_GUIDE.md) — backend dev guide
- [`FRONTEND_GUIDE.md`](../FRONTEND_GUIDE.md) — frontend dev guide
- [`CHANGELOG.md`](../CHANGELOG.md) — chronological history
- [`docs/recreation/`](recreation/) — the verified inventory of what actually exists in this fork

## Getting Started
- [What is DigiLog?](getting-started/what-is-digilog.md) *(stale — see banner on that page)*
- [System Requirements](getting-started/system-requirements.md) *(stale — see banner on that page)*
- [Hello World](getting-started/hello-world.md)

## User Guide
- [Entities & Hierarchy](user-guide/entities/entities-and-hierarchy.md) *(stale)*
- [Asset Templates](user-guide/templates/asset-templates.md) *(stale)*
- [Checklists](user-guide/checklists/checklists.md) *(stale)*

> The IoT-ingestion subsystems (Device Connectivity, MQTT, Telemetry, Rule Engine,
> Alarms, UNS, Data Export) and the filter/AHU/asset/cleaning domain do not exist
> in this fork. See root `CLAUDE.md` "Filter domain — REMOVED".

## Administration
*(pages below carry a stale-content banner — read that before the body)*
- [User Management](administration/users/user-management.md)
- [Roles & Permissions](administration/roles/roles-and-permissions.md)
- [System Configuration](administration/configuration/system-configuration.md)
- [Audit Trail](administration/audit/audit-trail.md)
- [Email Integration](administration/notifications/email-integration.md)
- [SMS Integration](administration/notifications/sms-integration.md)
- [Security](administration/security/security.md)

## Deployment
- [Deployment Methods Overview](deployment-methods/README.md)
- [Method A — Native Windows](deployment-methods/method-a-native-windows.md)
- [Method B — Docker Compose](deployment-methods/method-b-docker-compose.md)
- [Method D — Hybrid](deployment-methods/method-d-hybrid.md)
- [Method E — IIS](deployment-methods/method-e-iis.md)
- [Comparison](deployment-methods/comparison.md)

## Compliance
- [21 CFR Part 11](compliance/21-cfr-part-11.md) *(stale — see banner on that page)*

---

## Historical: Digital Filter Management System (upstream DigiLog / pre-strip)

**Everything below this line describes software removed from this fork on
2026-08-20 (vocabulary) / 2026-07-18 (modules), or that never existed here
(RFID/Android). Kept only as an archive pointer — do not treat as current.**

Upstream DigiLog included a filter/AHU cleaning-cycle domain: Cleaning
Profiles (pipeline editor), Filter Profiles, Filter Operations (start/advance/
bypass/terminate cycles), PM Schedules, Checklist Profiles, and Equipment
Groups, plus a Phase 3 RFID/Android tablet + offline-sync layer. None of the
`/api/filters/*`, `/api/cleaning-profiles`, `/api/pm-schedules`,
`/api/equipment-groups` endpoints exist in this fork's `apps/api/src/app.ts`.

Restore points if this history is ever needed: tags `pre-domain-strip` and
`pre-filter-domain-strip` (see root `CLAUDE.md`).
