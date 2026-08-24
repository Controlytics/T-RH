# future/ — Onboarding Pack

> **⚠ STALE, and the "trust this pack" claim below is now backwards.** This
> pack is a snapshot from **2026-04-29** — before multi-tenancy was removed
> (2026-04-30), before the IoT/rule-chain/MQTT/TimescaleDB tear-outs
> (2026-05..2026-06), before the filter/AHU/RFID domain was stripped
> (2026-07-18 modules, 2026-08-20 vocabulary), and it describes an Android/
> RFID tablet app that root `CLAUDE.md` and `docs/recreation/08-mobile/`
> confirm never shipped in this fork. It is now the **older, wrong** document
> relative to root `CLAUDE.md` and `docs/recreation/` (the verified
> inventory) — treat it as an archived design pack for the pre-strip product,
> not onboarding material for `compliance-core` today.

Single source of truth for anyone joining the project — developers, QA, testers, or business stakeholders. Written by inspecting the actual code in this repository (not by relying on older design documents). If something here contradicts an older `.md` file, trust this pack.

## What's inside

| Folder | For | Read first |
|---|---|---|
| `overview/` | Everyone | `CODEBASE_SUMMARY.md` |
| `frontend/` | React / UI devs | `frontend/README.md` |
| `backend/` | Fastify / API devs | `backend/README.md` |
| `testing/` | SDETs, automation | `testing/README.md` |
| `qa/` | Manual QA, product | `qa/README.md` |

## Reading order

1. **`overview/CODEBASE_SUMMARY.md`** — what the product is, monorepo layout, tech stack with version pins, where to start a dev server.
2. **`overview/CURRENT_STATUS.md`** — what's done as of 2026-04-29, what's in flight, KNOWN GOTCHAS.
3. **`overview/API_LIST.md`** — every HTTP endpoint, grouped by module, with prefix and verb.
4. Role-specific folders.

## Live root docs (kept at repo root on purpose)

These are still accurate and authoritative; existing tooling links into them:

- `CLAUDE.md` — project rules for AI contributors
- `AGENTS.md` — agent-mode rules
- `README.md` — quick-start
- `CHANGELOG.md` — version history (up to `[2.5.0]` 2026-04-25)
- `API_REFERENCE.md`, `BACKEND_GUIDE.md`, `FRONTEND_GUIDE.md`, `OFFLINE_SYNC_ARCHITECTURE.md`, `PROJECT_ARCHITECTURE.md`, `PROJECT_SUMMARY.md`
- `docs/archive/PHASE_5_RECENT_WORK.md` — archived; post-Phase-4 work (Apr 15–29: reports, offline hardening, RFID SDK plugin, Filter Data Mgmt console, decision-tape proposal) for the now-removed filter/RFID/reports domain
- `DEPLOY-WINDOWS.md`, `LOCAL_SETUP_WINDOWS.md`
- `PROJECT_HANDOVER/APPLICATION_FLOW.md` — handover doc with 14 Mermaid diagrams

The pack under `future/` complements those — it's written one abstraction level higher (where to look, not how every detail works).

## Superseded / historical material

`old/` retains the audit-trail material:

- `old/docs-superseded/superpowers-{plans,specs}/` — completed feature design specs (block-change, PM tasks, reports, DRY_IN) referenced from `docs/archive/PHASE_5_RECENT_WORK.md § 10`
- `old/docs-superseded/{ARCHITECTURE.md, bloat.md, offline-sync-design.md}` — historical reference
- `old/{apks, db-backups, playwright-artifacts, reports-specs, screenshots}/` — point-in-time binary artifacts

> **Note:** The DigiLog deployment is now **local-Windows-only**. EC2 / Linux / PM2 references in older docs no longer apply (EC2 removed in commit `251be95`).
