# compliance-core — Current-State Analysis & Gap Report

_Generated 2026-07-18. Every count below was verified against live code (`grep`/`ls`), not copied from docs._

> **Status: awaiting decisions.** Target-architecture diagrams and the migration plan are deliberately **not** in this document yet — they depend on the domain-strip decision (see “Blocking Decisions”). Producing ~20 target diagrams before that answer would waste effort on the wrong branch.

---

## 1. What this repo actually is

This is the **DigiLog / 21cfrlogbook** codebase, forked into `compliance-core`. Branch `master`, one commit: _“Initial fork of DigiLog (domain intact) — restore point before domain strip.”_ No git remote yet.

**The important finding: this is already ~85% of the enterprise 21 CFR Part 11 admin platform the brief describes.** The brief is not a green-field build — it is a spec that the existing platform already satisfies for most modules. The real work is (a) deciding whether to strip the cleanroom domain, and (b) filling a small, well-defined set of gaps.

### Verified stack (differs from the brief)

The brief says _“React, TypeScript, Material UI, Redux/Context.”_ **The actual stack is not that:**

| Layer | Brief assumed | **Reality (verified)** |
|---|---|---|
| Frontend | React + **Material UI** + **Redux** | React **19** + Vite 6 + **Tailwind v4** + custom UI components + **SWR** (server cache) + react-hook-form + zod |
| Backend | “reuse existing” | **Fastify 5** + Prisma 6 + **PostgreSQL 18** + jose (JWT) + bcrypt + ldapts + nodemailer + graphile-worker queue |
| Icons/Export | — | lucide-react, jspdf/jspdf-autotable, exceljs |
| Repo | — | Turborepo monorepo (`apps/{api,web,android}`, `rfid_scan_app`, `packages/{shared,queue}`) |

**Recommendation: keep the existing stack.** Migrating to Material UI + Redux would be a destructive, multi-month rewrite of ~77 routes with **zero** compliance benefit. The current stack is modern and production-grade.

### Verified system size

| Metric | Count | Source |
|---|---|---|
| API modules | **33** | `ls apps/api/src/modules/` |
| Prisma models / enums | **61 / 23** | `schema.prisma` |
| Permission constants | **102** | `permissions.ts` |
| Reauth (e-sig) actions | **92** | `reauth-actions.ts` |
| Config definitions | **36** | `config/defs/*.def.ts` |
| Frontend routes | **77** | `main.tsx` |

---

## 2. Compliance posture (already strong)

- **Tamper-evident audit trail** — `audit_trail` with `previous_checksum` + `chain_position BIGSERIAL` hash chain; DB immutability trigger (`audit_trail_no_delete`); `GET /api/audit/verify-chain`; chain-preserving **redact** path. (21 CFR §11.10(e), ALCOA+.)
- **Electronic signatures** — reauthentication with **meaning/reason** on 92 defined actions (§11.50/§11.200). _Note: these are password-meaning e-signatures, not PKI/crypto digital signatures — which §11 does not require._
- **Password policy** — length/complexity/expiry/history/lockout/idle-timeout, config-driven; expiry sweep worker.
- **RBAC** — `PERMISSION_TREE` single source of truth; sidebar + button + (partial) field gating; SUPER_ADMIN bypass; `useCan()` hook.
- **Sessions** — session-sweep worker, forced change on first login, LDAP.

---

## 3. Gap analysis — brief vs. reality

Legend: ✅ exists · 🟡 partial · ❌ gap (new work)

| Brief module | Status | Evidence / notes |
|---|---|---|
| **1. User Management** | 🟡 | `users`, `user-groups`, `roles` modules; password history/expiry, failed logins, session history, force-change, LDAP import all present. **Gaps:** MFA, profile image, clone-user/copy-permissions, bulk import/export/bulk-disable. |
| **2. Role & Access** | ✅ | `PERMISSION_TREE`, 102 perms, sidebar/button gating, `access-matrix` config, reauth. **Gap:** role hierarchy / permission inheritance (currently flat). |
| **3. Admin Requests** | ✅ | `admin-requests` module + reauth + audit + notifications. |
| **4. Audit Trail** | ✅ | Hash chain, old/new value, IP, reason, e-sig, redact, filter/export. **Minor gap:** richer browser/OS parsing. |
| **5. Audit Reports** | 🟡 | Ad-hoc audit export (PDF/Excel/CSV) exists. **Gap:** canned Daily/Monthly/Yearly scheduled report generation. |
| **6. Dashboard** | ✅ | `dashboards` module + `home` module guide. **Gap:** role-wise widget configuration depth. |
| **7. Notifications** | 🟡 | In-app + **email** + **SMS** channels, `notification-rules`, templates, retry, escalation, delivery logs. **Gap:** Teams / Slack / **webhook** / push channels. |
| **8. Config (A–P)** | ✅ | **36 config defs** cover General, Password, Backup, Date/Time, User-ID, Access, Branding, Notification rules/channels, System Health, Debug Traces, Version History, Export, Session, Login-Security. **Gaps within:** CAPTCHA (login-security def exists, no captcha engine), LDAP sync/role-mapping depth, backup **encryption + cloud** target, i18n. |

### Cross-cutting NEW work (additive — safe under either branch)

| Item | Effort | 21 CFR relevance |
|---|---|---|
| ❌ **MFA / TOTP** (authenticator app) | M | Strengthens §11.10(d) access control |
| ❌ **CAPTCHA** on login (configurable) | S | Brute-force defense |
| ❌ **Multi-language / i18n** (login + UI) | L | Usability (not §11) |
| ❌ **Teams / Slack / webhook / push** channels | M | Notification completeness |
| ❌ **Scheduled canned audit reports** (daily/monthly/yearly PDF) | M | §11 record availability |
| 🟡 **Role hierarchy / inheritance** | M | Admin usability |
| 🟡 **Backup encryption + cloud target** | M | Record protection §11.10(c) |
| ⚪ **PKI/digital signatures** (optional) | L | _Not required by §11; current e-sig is compliant_ |

---

## 4. The domain layer (the strip question)

These modules/models are **DigiLog cleanroom domain**, not generic compliance-platform:

- **API modules (~15):** `filter-operations`, `cleaning-profiles`, `checklist-profiles`, `equipment-groups`, `pm-schedules`, `replacement-schedule`, `hierarchy`, `assets`, `block-change-requests`, `stage-approvals`, `report-reviews`, `guest`, `sync` (offline), plus filter-specific parts of `dashboards`.
- **~40 Prisma models** (FilterProfile, EquipmentGroup, cleaning cycles, PM schedules, RFID identifiers, …).
- **Whole sub-apps:** `apps/android` (Capacitor APK), `rfid_scan_app` (Kotlin RFID), offline IndexedDB engine.

The **generic core** to keep: `auth`, `users`, `user-groups`, `roles`, `admin-requests`, `audit`, `notifications`, `notification-rules`, `notification-delivery`, `config`, `dashboards`, `backup`, `ldap`, `system-health`, `debug-traces`, `super-admin`, `uploads`, `help`.

**Whether to strip this domain is decision #1 below — it determines the entire target architecture and migration plan.**
