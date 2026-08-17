# Phase 11 — Rebuild Plan

This is the handoff point. Phases 1–10 established *what the system is*; this
phase specifies *what to build and in what order*.

> **Read first:** the brief asks for a rebuild with "100% feature parity" plus
> "Clean Architecture, DDD, CQRS, Docker, Kubernetes, HA, DR". Those are not the
> same goal, and some of them actively conflict with this product's deployment
> reality. §1 resolves that conflict before any design follows from it.

---

## 1. Constraints that must survive the rebuild

### 1.1 It ships to an on-premises Windows machine, offline

There is no cloud, no container runtime, and often no internet at a validated
pharmaceutical site. Deployment today is PowerShell scripts and a Postgres
instance. This is **why** the system has no Redis, no message broker, and no
separate cache — every additional service is another component a site engineer
must install, secure, and *validate*.

**Therefore:** Docker/Kubernetes/HA are legitimate **optional** targets for a
hosted variant, but they must not become required. A rebuild that can only be
deployed as a container fleet is a worse product for this market, not a better
one. Keep a single-node, no-broker installation path as the primary one.

### 1.2 Regulated software has a validation cost per change

Every architectural change at a validated site triggers re-qualification.
"Cleaner architecture" is only worth it where it reduces defect risk in
compliance-critical paths. Gratuitous restructuring of working code is a cost,
not a benefit.

**Therefore:** prioritise the audit chain, the permission model, and the
authorisation path. Leave working peripheral code alone.

### 1.3 CQRS is not indicated

The brief lists "CQRS where beneficial". Assessed honestly: this system has 139
endpoints, a shallow 23-model schema with 8 foreign keys, and no read/write
asymmetry that a separate read model would solve. Introducing CQRS here would
add eventual-consistency semantics to an audit trail that must be
transactionally consistent.

**Recommendation: do not adopt CQRS.** The one place with genuine read/write
asymmetry is `audit_trail` (write-once, read-heavy) — and that is better served
by partitioning and checkpointing (§4.2) than by a second model.

## 2. Target architecture

Keep the stack. React 19 + Fastify 5 + Prisma + PostgreSQL is well matched to
the constraints, and the team knows it. Change the **internal structure**, not
the technology.

```
┌─────────────────────────────────────────────────────────────┐
│ apps/web            React 19 · Vite · SWR · Tailwind        │
│   routes/  components/  hooks/  lib/                        │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTPS + JWT
┌───────────────────────────▼─────────────────────────────────┐
│ apps/api                                                    │
│                                                             │
│  ┌── interface ────────────────────────────────────────┐    │
│  │ routes · schemas · preHandlers (authz, reauth)      │    │
│  └────────────────────┬────────────────────────────────┘    │
│  ┌── application ─────▼────────────────────────────────┐    │
│  │ use-cases · orchestration · transaction boundaries  │    │
│  └────────────────────┬────────────────────────────────┘    │
│  ┌── domain ──────────▼────────────────────────────────┐    │
│  │ entities · policies · invariants                    │    │
│  │  ⟵ AuditChain, PermissionTree, PasswordPolicy live  │    │
│  │     HERE, not scattered across routes               │    │
│  └────────────────────┬────────────────────────────────┘    │
│  ┌── infrastructure ──▼────────────────────────────────┐    │
│  │ Prisma repositories · queue · mail · LDAP · files    │   │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                            │
              PostgreSQL (app data + graphile-worker)
```

**The single most valuable structural change:** today, compliance rules are
enforced by *convention* — a developer must remember to call `writeAudit()` and
`enforceReauth()`. In the target, they are enforced by *construction*: an
application-layer command handler that cannot commit without producing an audit
entry.

### 2.1 Make the compliance guarantee structural

```ts
// Today: audit is a call the developer must remember.
await prisma.$transaction(async (tx) => {
  await tx.user.update(...);
  await writeAudit(tx, { action: 'USER_UPDATED', ... });  // ← easy to forget
});

// Target: the handler cannot commit without one.
class UpdateUserHandler extends AuditedCommand<UpdateUser> {
  readonly action = 'USER_UPDATED';
  readonly reauth = 'UPDATE_USER';
  async execute(cmd, tx): Promise<AuditRecord> { ... }   // ← return type forces it
}
```

### 2.2 Make `gate` and `permissions` unmixable

The historical `ASSET_*` privilege leak happened because a grant set was used as
an authorisation check. Types should make that impossible:

```ts
type Gate  = Brand<Permission[], 'Gate'>;
type Grant = Brand<Permission[], 'Grant'>;
function authorize(user: User, gate: Gate): boolean;   // Grant does not compile
```

## 3. Module boundaries

| Bounded context | Owns | Notes |
|---|---|---|
| **Compliance** | audit chain, verification, redaction, re-auth | The core. No other context may write `audit_trail` directly. |
| **Identity** | users, roles, sessions, password policy, LDAP | |
| **Access control** | permission tree, gates, grants, sidebar visibility | Shared kernel — published, versioned |
| **Administration** | config surfaces, admin requests, help | |
| **Operations** | notifications, jobs, backup, health | |
| **Presentation** | dashboards, reports, export | |

**Rule:** Compliance is a *supplier* to every other context and depends on none.

## 4. Prioritised work breakdown

### Phase A — Foundations (blocking; do first)
| # | Task | Why |
|---|---|---|
| A1 | Establish measured baselines: bundle, query plans, latency, coverage | Cannot prove improvement otherwise ([Phase 10 §6](../10-performance/README.md)) |
| A2 | Clear the 23 pre-existing test failures | Start from green ([testing-baseline](../10-performance/testing-baseline.md)) |
| A3 | Add CI: typecheck, tests, `npm audit`, bundle budget | No CI exists today |
| A4 | Add **frontend↔backend route-parity test** | Five dead callers shipped undetected |
| A5 | Add contract tests: every reauth action enforced; every `enforce:'a'` gate in a real guard | Prevents security theatre |

### Phase B — Compliance core (highest value)
| # | Task | Why |
|---|---|---|
| B1 | Extract audit chain into a domain module; no direct writes elsewhere | Single enforcement point |
| B2 | `AuditedCommand` base — cannot commit without an audit record | Structural, not conventional |
| B3 | Make `AUDIT_CHAIN_KEY` **mandatory in production**; document custody/rotation | [Security §2.3](../09-security/README.md) |
| B4 | Checkpointed + range chain verification | O(n) walk grows forever |
| B5 | Automate the out-of-band `chain_position` tail check | [Security §2.4](../09-security/README.md) |
| B6 | Partition `audit_trail` by time; define archival | Top scaling risk |
| B7 | Full tamper-detection test matrix | The test that proves the regulation is met |

### Phase C — Access control
| # | Task | Why |
|---|---|---|
| C1 | Branded `Gate` / `Grant` types | Makes the historical leak impossible |
| C2 | Keep tree as source of truth + frozen drift test | Already correct — preserve |
| C3 | Resolve every `enforce:'b'` node — add the narrow gate | Turn intent into enforcement |
| C4 | Resolve every `enforce:'c'` node — enforce or delete | No cosmetic controls |
| C5 | Authorisation matrix test: role × endpoint | Systematic, not spot-checked |

### Phase D — Security hardening
| # | Task |
|---|---|
| D1 | Remove `unsafe-inline`; isolate or disable Swagger in production |
| D2 | Remove dead `capacitor://localhost` CORS entry |
| D3 | Security telemetry: failed-login spikes, chain-verify failures, 403 bursts |
| D4 | Dependency CVE gate in CI |

### Phase E — Performance
| # | Task |
|---|---|
| E1 | Dynamic-import ExcelJS + jsPDF/html2canvas at click (~1.1 MB off initial load) |
| E2 | Bundle-size budget enforced in CI |
| E3 | Query-plan regression tests on `audit_trail` |
| E4 | Evaluate SSE to replace the busiest polls |

### Phase F — Debt removal
| # | Task |
|---|---|
| F1 | Delete `SendForReviewButton` + `lib/report-review.ts` (backend removed) |
| F2 | Restore report label/signatory config surfaces, or remove the indirection |
| F3 | Trim `NotificationEventType` to the 4 live values (keep rendering historic) |
| F4 | Remove the `ltree` extension if genuinely unused |
| F5 | Remove the mobile-era `localStorage` server-URL override in `api-base.ts` |
| F6 | Delete `API_PORT` from `.env` — dead; `app.ts` reads `PORT` |

### Phase G — UI
| # | Task |
|---|---|
| G1 | Component render tests for every page + permission-gating assertions |
| G2 | Automated axe pass per route; skip-link; WCAG AA contrast audit across all 10 themes |
| G3 | Converge remaining inline permission checks onto `useCan` |

### Phase H — Deployment (optional target)
| # | Task |
|---|---|
| H1 | Keep the single-node Windows installer as the **primary** path |
| H2 | Add an optional container image for hosted deployments |
| H3 | Only if H2 is adopted: externalise session/reauth caches (currently in-process, so multi-instance would break them) |

> **H3 is the hidden blocker for horizontal scale.** The 30 s session cache and
> 10 s re-auth cache are in-process. Two API instances would disagree about
> logout and re-auth state — a correctness bug in a compliance path, not just a
> cache miss. Do not add a second instance before solving this.

## 5. Explicitly not recommended

| Brief item | Recommendation | Reason |
|---|---|---|
| CQRS | **Skip** | No read/write asymmetry that justifies eventual consistency next to an audit trail |
| Message queue | **Skip** | graphile-worker on Postgres fits the deployment constraint |
| Mobile app | **Skip unless separately justified** | No surviving field workflow; offline + regulated records is a compliance design problem, not a caching one ([Phase 8](../08-mobile/README.md)) |
| Kubernetes as default | **Skip as default** | Conflicts with offline on-prem installs; keep optional |
| Component-library migration | **Skip** | Would change every screen; brief says preserve UX |
| Dark mode | **Skip unless requested** | Explicit product decision to be light-only |

## 6. Feature-parity checklist

A rebuild is complete when all of the following hold. Each links to its
specification.

- [ ] 34 models, 13 enums — or a justified, documented deviation ([Phase 5](../05-database/README.md)). *(Was 23/6 when this checklist was written, then 34/11 after the floorplan/functional-location/alarm work, and 34/13 as of the 2026-08-17 instrument-limit alarm work (`AlarmSource`, `AlarmLimitKind`). Re-derive with the greps in Phase 5 rather than trusting this line.)*
- [ ] 139 API paths reachable with equivalent semantics ([endpoints](../06-api/endpoints.md))
- [ ] 38 frontend routes ([Phase 7](../07-ui/README.md))
- [ ] 30 permissions · 26 configurable privileges · 8 groups · 9 sidebar items ([Phase 4](../04-roles-permissions/README.md))
- [ ] 39 re-auth actions, all enforced by ≥1 route
- [ ] 21 config surfaces, auto-discovered
- [ ] 6 seeded roles with the same hierarchy levels
- [ ] 3 background job tasks
- [ ] 10 colour themes via CSS custom properties
- [ ] Audit chain: append-only, trigger-protected, keyed HMAC, verifiable, redactable ([audit-chain](../05-database/audit-chain.md))
- [ ] All 8 cross-cutting business rules ([Phase 3 §Cross-cutting](../03-business-analysis/README.md))
- [ ] All 9 "must not lose" security properties ([Phase 9 §6](../09-security/README.md))

## 7. Sequencing summary

```
A (foundations) ──▶ B (compliance core) ──▶ C (access control)
                            │                      │
                            └──────┬───────────────┘
                                   ▼
                    D (security) · E (perf) · F (debt) · G (UI)
                                   ▼
                            H (deployment, optional)
```

**A blocks everything** — without baselines and CI there is no way to show the
rebuild is better rather than merely different. **B before C** because the audit
chain is the product's reason to exist and every other guarantee is layered on
it.
