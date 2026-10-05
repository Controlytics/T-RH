# Application Recreation Dossier — compliance-core

> **Snapshot notice (added 2026-10-05).** Verified 2026-07-25 at `cbcb913`; superseded by root `CLAUDE.md` System Stats for every count; re-derive before quoting.

**Generated:** 2026-07-25 · **Branch:** `master` · **Commit at analysis:** `cbcb913`

This folder is a reverse-engineering dossier of **compliance-core**: what the
system actually is, phase by phase, at a level of detail sufficient to rebuild
it from scratch without reading the original source.

---

## 1. Read this first — two things that change the whole task

### 1.1 This is NOT DigiLog. Roughly half the requested subject matter does not exist here.

The recreation brief enumerates Android, RFID, barcode, printing, offline-first
operation, IndexedDB, background sync, and a message queue. **None of those are
present in compliance-core.** This repository is a fork of DigiLog whose entire
cleanroom/filter domain was deliberately removed in the "Phase 0 domain strip"
(commit `a92ca5d`), leaving a generic 21 CFR Part 11 administration core.

Verified absences (commands and receipts in
[`08-mobile/README.md`](08-mobile/README.md) and
[`02-inventory/absent-subsystems.md`](02-inventory/absent-subsystems.md)):

| Brief asks for | Status in compliance-core |
|---|---|
| Android application | **Absent** — `apps/` contains only `api` and `web` |
| RFID / barcode scanning | **Absent** — no SDK, no plugin, no dependency |
| Printing / printer integration | **Absent** — PDF *generation* exists (jsPDF); no printer path |
| Offline-first / IndexedDB / sync engine | **Absent** — no sync engine, no offline queue, no IndexedDB |
| Capacitor / native plugins | **Absent** — not a dependency |
| Message queue (Redis/Kafka/RabbitMQ) | **Absent** — job queue is graphile-worker on Postgres |
| Stored procedures / views | **Absent** — 1 trigger + 1 function, 0 views (see Phase 5) |

Per the brief's own rule — *"Never assume functionality"* — these are documented
as **absent with evidence** rather than invented. Each phase folder marks
inapplicable sections `N/A (absent)` and links to the receipt.

### 1.2 Every existing document in this repo has stale counts. This dossier supersedes them.

`CLAUDE.md`, `PROJECT_ARCHITECTURE.md`, `packages/shared/CLAUDE.md`, and the
other root docs still describe the **pre-strip** system (102 permissions,
61 models, 33 API modules, 77 routes). Those numbers have been wrong since the
Phase 0 strip.

**Every figure in this dossier was produced by a command run against the live
code and database on 2026-07-25.** No number was copied from an existing
document. Where a count is stated, the command that produced it is shown.

Headline corrections:

| Metric | Stale docs claim | **Actual (verified)** |
|---|---|---|
| Prisma models | 61 | **23** |
| Prisma enums | 23 | **6** |
| API modules | 33 | **18** |
| API paths (OpenAPI) | "200+ endpoints" | **139 paths** |
| Frontend routes | 77 | **38** |
| Permission constants | 102 | **30** |
| Reauth actions | 92 | **39** |
| Feature privileges | 83 | **26** |
| Sidebar groups | 27 items | **8 groups / 9 sidebar items** |
| Config definitions | 36 | **21** |

---

## 2. Scope of this deliverable — delivered vs. not

The brief spans 14 phases. Phases 1–11 are *analysis and design of code that
exists*, and are delivered here in full. Phases 12–14 are not, and the reason is
substantive rather than effort-based:

| Phase | Status |
|---|---|
| 1 — Complete project understanding | **Delivered** — [`01-understanding/`](01-understanding/) |
| 2 — Project inventory | **Delivered** — [`02-inventory/`](02-inventory/) |
| 3 — Business analysis | **Delivered** — [`03-business-analysis/`](03-business-analysis/) |
| 4 — User role analysis | **Delivered** — [`04-roles-permissions/`](04-roles-permissions/) |
| 5 — Database reverse engineering | **Delivered** — [`05-database/`](05-database/) |
| 6 — API analysis | **Delivered** — [`06-api/`](06-api/) |
| 7 — UI analysis | **Delivered** — [`07-ui/`](07-ui/) |
| 8 — Mobile application | **Delivered as an absence finding** — [`08-mobile/`](08-mobile/) |
| 9 — Security | **Delivered** — [`09-security/`](09-security/) |
| 10 — Performance | **Delivered** — [`10-performance/`](10-performance/) |
| 11 — Rebuild plan | **Delivered** — [`11-rebuild-plan/`](11-rebuild-plan/) |
| 12 — Implementation (rebuild the app) | **Not delivered** |
| 13 — Full test suite generation | **Not delivered** |
| 14 — Fourteen manuals | **Not delivered** |

**Why 12–14 are not included.** Phase 12 is a from-scratch reimplementation of a
139-endpoint, 23-model, 38-route regulated system with 100% feature parity —
a multi-month engineering programme, not a document. Phase 13 asks for twelve
categories of test suite over that not-yet-existing system. Phase 14 asks for
fourteen manuals describing it. Emitting scaffolding for these would produce
code and documentation describing software that does not exist, which the
brief's own rules forbid ("never assume functionality", "every implementation
decision must be traceable to the original application").

Phase 11 is therefore the correct handoff point: it contains the target
architecture, module boundaries, migration sequencing, and a work-breakdown that
Phase 12 would execute against. **Phases 1–11 are what makes Phase 12 possible;
they are the deliverable that was actually achievable with integrity.**

Existing test coverage of the *current* system is documented in
[`10-performance/testing-baseline.md`](10-performance/testing-baseline.md) —
including the pre-existing failures, so the real baseline is not overstated.

---

## 3. How to navigate

```
docs/recreation/
├── README.md                     ← you are here: scope, ground truth, corrections
├── 01-understanding/             system purpose, bounded context, request lifecycle
├── 02-inventory/                 stack, structure, modules, absent subsystems
├── 03-business-analysis/         feature-by-feature: rules, flows, edge cases
├── 04-roles-permissions/         6 roles × 30 permissions × 26 privileges × 39 reauth
├── 05-database/                  23 models, ER model, the hash chain, migrations
├── 06-api/                       139 paths, conventions, authz matrix
├── 07-ui/                        38 routes, component system, states, theming
├── 08-mobile/                    absence finding + evidence
├── 09-security/                  code-grounded review (not a speculative checklist)
├── 10-performance/               measured characteristics + testing baseline
└── 11-rebuild-plan/              target architecture + work breakdown
```

**Suggested reading order for a rebuild team:** README → 01 → 02 → 05 → 04 → 06
→ 03 → 09 → 11. (Database and roles before API, because in this system the
permission tree and the audit chain constrain almost every endpoint's shape.)

---

## 4. Verification method

Every count in this dossier is reproducible. The environment used:

```bash
# API running on 3001 against the isolated compliance_core_db
cd apps/api && npx tsx watch src/app.ts       # PORT=3001 from apps/api/.env
cd apps/web && WEB_PORT=5176 API_PROXY_TARGET=https://localhost:3001 npx vite --host
```

Primary sources, in order of authority:

1. **Live OpenAPI dump** — `curl -sk https://localhost:3001/docs/json` — the
   authoritative endpoint list (139 paths). Used for Phase 6 instead of reading
   route source, because it reflects what is actually registered at runtime.
2. **Live database** — `psql -d compliance_core_db` — used for triggers,
   functions, sequences, indexes, and role rows. Used for Phase 5.
3. **`PERMISSION_TREE`** (`packages/shared/src/types/permission-tree.ts`) — the
   single source of truth for permissions, gates, and sidebar visibility; the
   feature-privilege and sidebar maps are *derived* from it. Used for Phase 4.
4. **Source tree** — for structure, business rules, and control flow.

Existing repository documentation was deliberately **not** used as a source.

---

## 5. Status note

This folder is **purely additive** — it adds documentation only and changes no
application code. Note that the working tree also carries a separate,
unrelated set of ~25 modified files from the preceding "fix leftover 404 calls"
task, which is pending review; this dossier does not touch any of them.
