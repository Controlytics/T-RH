# Phase 1 — Complete System Understanding

*All statements below are derived from the source tree, the live OpenAPI dump, and
the live database on 2026-07-25. See the root README §4 for method.*

---

## 1. What this system is

**compliance-core** is a single-tenant, on-premises **21 CFR Part 11 compliant
administration platform**. It is not a domain application — it is the regulated
*substrate* that a domain application would be built on top of.

Its reason to exist is the FDA rule set for electronic records and electronic
signatures. Concretely, it provides the six capabilities that Part 11 demands of
any system holding regulated electronic records:

| 21 CFR §11 requirement | Implemented as |
|---|---|
| §11.10(e) — secure, computer-generated, time-stamped audit trail | Hash-chained `audit_trail` with a DB-level delete-blocking trigger |
| §11.10(d) — limiting system access to authorised individuals | JWT auth + 6-role RBAC + a 30-permission gate catalogue |
| §11.10(g) — authority checks | `requirePermission` / `requireAnyPermission` route decorators |
| §11.200 — signature components, re-authentication | 39 re-auth actions, password re-entry before sensitive operations |
| §11.300 — password/ID controls | Configurable password policy, expiry, history, lockout, single-session |
| §11.10(c) — record protection and retrieval | Backup/restore, export (PDF/Excel), immutable audit retrieval |

Everything else in the system — users, roles, notifications, dashboards, help,
configuration — exists to support or be governed by those six.

## 2. What was deliberately removed (and why it matters to a rebuild)

This repo is a fork of **DigiLog**, an IoT/cleanroom filter-management platform.
Commit `a92ca5d` ("Phase 0: strip cleanroom domain → generic 21 CFR Part 11
admin core") removed the entire domain.

A rebuild team must understand this, because the surviving code carries the
*shape* of the removed domain in places:

- **Generic-sounding names with domain history.** `report-page-titles`,
  `export-surfaces`, `report-labels` were built to serve filter reports; they
  now serve the audit trail only.
- **Extension points with one implementation.** The report-export machinery
  (`lib/pdf-report.ts`, `lib/report-types.ts`, `lib/export-surfaces.ts`) is a
  registry designed for many report types; exactly one (`audit-trail`) survives.
- **Dead branches were still being called until 2026-07-25.** Five frontend
  callers were still hitting deleted endpoints and 404ing at runtime; these were
  removed in the task immediately preceding this dossier. A rebuild should not
  reproduce them. See [`../02-inventory/absent-subsystems.md`](../02-inventory/absent-subsystems.md).

**Rebuild implication:** treat the surviving generic abstractions as *deliberate
seams for a future domain*, not as over-engineering to be flattened. That is the
single most important architectural intent to preserve.

## 3. Bounded context

```
┌─────────────────────────────────────────────────────────────────┐
│                     compliance-core                             │
│                                                                 │
│  IDENTITY & ACCESS          COMPLIANCE RECORD                   │
│  ├─ Users, roles, groups    ├─ Audit trail (hash-chained)       │
│  ├─ Sessions (single-tab)   ├─ Re-authentication (e-sig)        │
│  ├─ Password policy         ├─ Redaction (chain-preserving)     │
│  └─ LDAP (optional)         └─ Verification (chain walk)        │
│                                                                 │
│  ADMINISTRATION             OPERATIONS                          │
│  ├─ 21 config surfaces      ├─ Notifications (4 channels)       │
│  ├─ Role & access matrix    ├─ Background jobs (3 tasks)        │
│  ├─ Branding & themes       ├─ Backup / restore                 │
│  ├─ Admin requests          ├─ System health                    │
│  └─ Help articles           └─ Debug traces                     │
└─────────────────────────────────────────────────────────────────┘
              │                              │
              ▼                              ▼
        PostgreSQL 18                  graphile-worker
     (application + queue)            (same Postgres DB)
```

**Single tenant, single site, single company.** Multi-tenancy was removed
upstream; JWT `scope` always stamps `GLOBAL`. There is no organisation entity.

## 4. Technology stack (verified)

| Layer | Choice | Notes |
|---|---|---|
| Backend | **Fastify 5** + TypeScript (ESM) | `apps/api`, port 3001 (this checkout) |
| ORM | **Prisma 6** | 23 models, migration-driven |
| Database | **PostgreSQL 18** | single DB; also hosts the job queue |
| Job queue | **graphile-worker** | Postgres-backed; 3 tasks. No Redis. |
| Frontend | **React 19** + **Vite 6** | `apps/web`, port 5176 (this checkout) |
| Data fetching | **SWR** | no Redux, no React Query |
| Styling | **Tailwind CSS v4** | no component library; hand-rolled primitives |
| Forms | react-hook-form + Zod (via `@hookform/resolvers`) | |
| Export | jsPDF + jspdf-autotable (client), ExcelJS (server) | |
| Shared | `packages/shared` | Zod schemas + the permission tree |
| Monorepo | npm workspaces + Turborepo | |

Deliberate *non*-choices worth preserving: no Redis, no MUI/Redux, no ORM-level
soft deletes, no GraphQL. The queue and pub/sub were consolidated onto Postgres
upstream specifically to reduce operational surface for on-prem Windows installs.

## 5. Request lifecycle (the path every call takes)

Understanding this one sequence explains most of the backend:

```
1. HTTPS request → Fastify
2. @fastify/helmet          → security headers, HSTS
3. @fastify/cors            → origin allow-list
4. @fastify/rate-limit      → 5000 req/min global
5. authPlugin               → verifies JWT, loads user + permissions onto request
                              (30s session auth cache; invalidated on logout)
6. rbacPlugin               → provides requirePermission / requireAnyPermission
                              / requireSuperAdmin decorators
7. Route preHandler         → the authority check (§11.10(g))
8. enforceReauth (19 modules) → for sensitive actions, re-verifies the user's
                              password within a 10s window (§11.200)
9. Zod / Fastify schema     → request validation
10. sanitize.ts             → strips HTML from all text input (XSS defence)
11. Handler → service → Prisma → PostgreSQL
12. writeAudit()            → appends a hash-chained audit row inside the
                              same transaction where the action is auditable
13. Response (Fastify schema-serialised)
```

Steps 5–8 and 12 are the compliance-critical ones. A rebuild that changes their
order or makes step 12 asynchronous would break the regulatory guarantee.

## 6. The two invariants a rebuild must not break

### 6.1 The audit chain is append-only and tamper-evident

Each `audit_trail` row stores a `checksum` over its own fields plus the
`previous_checksum` of the row before it, ordered by a `chain_position BIGSERIAL`.
Any modification or deletion breaks every downstream link, and
`GET /api/audit/verify-chain` walks the chain to detect it.

Three layers defend it:
- **Application:** the writer only ever appends.
- **Database:** the `audit_trail_no_delete` BEFORE DELETE trigger raises on any
  row deletion.
- **Cryptographic:** with `AUDIT_CHAIN_KEY` set, checksums are HMAC-SHA256 (v3)
  with the key held *outside* the database — so an actor with DB write access
  but no key cannot forge a self-consistent chain.

The correct way to remove information is **redaction**
(`POST /api/audit/:id/redact`), which blanks values in place and records who,
when, and why — preserving the chain. Full detail: [`../05-database/audit-chain.md`](../05-database/audit-chain.md).

### 6.2 The permission tree is the single source of truth

`packages/shared/src/types/permission-tree.ts` is a Sidebar → Page → Action
catalogue. `FEATURE_PRIVILEGES`, `FEATURE_TO_PERMISSION_MAP`, and
`SIDEBAR_PRIVILEGE_MAP` are all **derived** from it, and a frozen-snapshot test
locks the derivation against drift.

Critically, each node distinguishes two different permission sets:
- **`gate`** — the *discriminating* permission the backend actually checks.
- **`permissions`** — the *grant-expansion* set handed out when an admin enables
  the toggle (includes read dependencies).

**Never OR over `permissions` as an authorisation check** — it includes read
dependencies and would over-grant. `useCan()` gates on `gate` only. This
distinction is subtle, load-bearing, and easy to get wrong in a rebuild.
Full detail: [`../04-roles-permissions/README.md`](../04-roles-permissions/README.md).

## 7. Deployment shape

On-premises **Windows**, single machine. No cloud, no containers, no CI/CD
pipeline in-repo. `scripts/` holds PowerShell installers
(`install.ps1`, `provision-db.ps1`, `register-services.ps1`, `backup-db.ps1`,
`verify-migrations.ps1`). TLS uses mkcert-issued certs under `certs/`.

This constrains the rebuild: the target must remain installable offline on a
Windows Server by an operator with no container runtime. That is why the queue
is in Postgres and why there is no Redis.
