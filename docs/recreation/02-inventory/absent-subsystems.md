# Absent Subsystems — Evidence

The recreation brief enumerates a number of subsystems. This page records, with
receipts, which of them **do not exist** in compliance-core, so that a rebuild
does not attempt to reproduce them and no downstream document invents them.

All commands run 2026-07-25 at commit `cbcb913`.

---

## Summary

| Subsystem in brief | Present? | Evidence |
|---|---|---|
| Android application | **No** | §1 |
| RFID scanning / SDK | **No** | §2 |
| Barcode scanning | **No** | §2 |
| Printing / printer integration | **No** (PDF generation only) | §3 |
| Offline features / offline-first | **No** | §4 |
| IndexedDB / offline queue | **No** | §4 |
| Synchronisation engine | **No** | §4 |
| Background sync | **No** | §4 |
| Capacitor / native plugins | **No** | §5 |
| Message queue (Redis/Kafka/RabbitMQ) | **No** (Postgres-backed queue) | §6 |
| Stored procedures | **No** (1 trigger function) | §7 |
| Database views | **No** | §7 |
| Localization / i18n | **No** | §8 |
| Dark mode | **No** (10 light themes) | §8 |
| Docker / Kubernetes / CI-CD | **No** | §9 |

---

## 1. No Android application

```bash
$ ls apps/
api  web
```

Only two applications exist. The upstream DigiLog repository had `apps/android`
(a Capacitor wrapper) and `rfid_scan_app/` (a native Kotlin UHF reader app);
neither was carried into this fork.

There is no `capacitor.config.ts`, no `android/` directory, no Gradle build, and
no `.apk` artefact anywhere in the tree.

**Phase 8 of the brief is therefore not applicable.** See
[`../08-mobile/README.md`](../08-mobile/README.md).

## 2. No RFID or barcode

```bash
$ grep -rli "rfid" apps/web/src apps/api/src
apps/web/src/lib/api-client.ts
apps/web/src/lib/export-surfaces.ts
apps/web/src/lib/report-labels.ts
apps/web/src/lib/report-types.ts
apps/web/src/routes/audit/audit-helpers.ts
apps/api/src/lib/config-discovery.ts
apps/api/src/lib/swagger.ts
apps/api/src/e2e/entities.test.ts
apps/api/src/e2e/super-admin-unretire.test.ts
```

Every hit is a **vestigial string or comment** in a surviving generic file — for
example a leftover `'rfid-track-record'` report key in the report registry, or a
comment in `api-client.ts` describing historical behaviour. There is:

- no RFID SDK or `.jar`,
- no keyboard-wedge guard,
- no scanner input handling,
- no `assets/identifiers` endpoints (the OpenAPI dump has none),
- no barcode library in any `package.json`.

## 3. No printing

`apps/web/package.json` dependencies include `jspdf` and `jspdf-autotable`, and
the API uses `exceljs`. These **generate downloadable files**; they do not drive
a printer.

```bash
$ grep -rli "printer" apps/web/src apps/api/src
(no matches)
```

There is no print-server integration, no ESC/POS, no label printer path. The
only "print" vocabulary in the codebase is the report footer's *"Printed By"*
signature label in `lib/pdf-report.ts`.

## 4. No offline support, sync engine, or IndexedDB

```bash
$ grep -rli "indexeddb" apps/web/src apps/api/src
(no matches)

$ ls apps/web/src/lib/
api-base.ts  api-client.ts  cn.ts  datetime-input.ts  excel-export.ts
export-surfaces.ts  format-by-least-count.ts  password-utils.ts  pdf-report.ts
report-export-log.ts  report-labels.ts  report-review.ts  report-types.ts
resolve-bulk-targets.ts  server-contact.ts  swr-config.ts  theme-styles.ts
themes.ts  timing-constants.ts  url-utils.ts
```

No `sync-engine.ts`, no `offline-queue.ts`, no tombstone or idempotency-key
machinery. The upstream offline-replay subsystem was removed in commit
`cbcb913`; its last stranded caller (`POST /api/auth/offline-grant` in
`hooks/use-auth.ts`, which 404'd on **every login**) was removed on 2026-07-25.

`lib/server-contact.ts` survives — it records a last-server-contact timestamp —
but it is a remnant of the offline design, not a working offline capability.

**The application requires a live server connection.**

## 5. No Capacitor

```bash
$ python -c "import json;print(json.load(open('apps/web/package.json'))['dependencies'].keys())"
@digilog/shared @hookform/resolvers clsx exceljs jspdf jspdf-autotable
lucide-react react react-dom react-hook-form react-router-dom swr tailwind-merge
```

No `@capacitor/*` package. The nine files matching "capacitor" contain only
comments describing historical WebView behaviour (e.g. TLS notes in
`lib/api-base.ts`) and a `capacitor://localhost` entry left in the CORS
allow-list in `app.ts` — dead configuration, harmless but worth removing in a
rebuild.

A PWA manifest **is** configured via `vite-plugin-pwa` in `vite.config.ts`, so
the web app is installable — but it is not an offline application.

## 6. No message queue

Job scheduling uses **graphile-worker**, which stores jobs in the same
PostgreSQL database. There is no Redis, RabbitMQ, Kafka, or SQS.

`ioredis` was removed upstream; the in-process EventEmitter bus that briefly
replaced it was itself removed as dead code. **There is no pub/sub layer.**

This is a deliberate operational choice: the product installs on a single
on-premises Windows machine, and every additional service is an additional thing
for a site engineer to install, secure, and validate.

## 7. No stored procedures or views

```sql
-- views
select count(*) from information_schema.views where table_schema='public';  -- 0

-- non-internal triggers
audit_trail :: audit_trail_no_delete

-- custom functions (excluding pgcrypto)
block_audit_trail_delete

-- sequences
audit_trail_chain_position_seq
```

Exactly **one** trigger, **one** custom function, **zero** views. Both existing
objects serve the audit chain. Everything else in `pg_proc` belongs to the
`pgcrypto` extension.

Business logic lives in the application tier, not the database — with the single
deliberate exception of delete-blocking, which must be enforced *below* the
application to be meaningful.

## 8. No localization, no dark mode

- **i18n:** no `i18next`, no locale files, no translation catalogue. All UI
  strings are inline English. Some labels are admin-configurable (field IDs,
  report page titles) but that is configuration, not localization.
- **Dark mode:** the app is **light-theme only** by explicit design decision.
  `lib/themes.ts` provides **10 colour presets** (Ocean, Sapphire, Emerald,
  Amethyst, Sunset, Slate, Ruby, Forest, Midnight, Coral) applied via CSS custom
  properties. "Midnight" is a dark *accent palette*, not a dark UI mode.

## 9. No containers or CI/CD

No `Dockerfile`, no `docker-compose.yml`, no `k8s/`, no `.github/workflows/`,
no `Jenkinsfile`. Deployment is PowerShell scripts onto a Windows host
(see [`README.md`](README.md) §9).

The brief's Phase 11 asks for a "Docker / Kubernetes ready / cloud ready" target
architecture. That is a legitimate *forward* goal and is addressed in
[`../11-rebuild-plan/`](../11-rebuild-plan/) — but it must be understood as a
**new requirement**, not a description of the current system.
