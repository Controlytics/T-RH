# Testing Baseline

*Measured 2026-07-25. Reported honestly — including the failures — so the real
baseline is not overstated.*

---

## 1. Current state

| Suite | Files | Passed | **Failed** | Skipped | Total |
|---|---|---|---|---|---|
| `packages/shared` | 17 | 266 | **3** | 0 | 269 |
| `apps/web` | 24 | 278 | **6** | 0 | 284 |
| `apps/api` | 58 | 676 | **14** | 8 | 698 |
| **Total** | **99** | **1220** | **23** | 8 | **1251** |

```bash
cd packages/shared && npx vitest run
cd apps/web      && npx vitest run
cd apps/api      && npm test          # single-fork — see §4
```

## 2. The 23 failures are all pre-existing

Every one was verified to fail identically on a clean `git stash` of HEAD. They
are **test debt left by the Phase 0 domain strip**, not product defects:

- **`apps/web` (6)** — three `url-utils` tests reference route files deleted in
  the strip (`filter-management/filter-list.tsx`,
  `filter-management/replacement-schedule.tsx`, `pm-schedules/index.tsx`); two
  `use-can` tests assert gates for removed nodes (`FCP_UPDATE`, `CP_PAGE_EDIT`);
  one route-guard coverage test asserts a route count from before the strip.
- **`packages/shared` (3)** — an audit-template placeholder test for a removed
  domain template, plus two `permission-tree` gate tests for removed nodes
  (`cleaning_profiles.toggle`, `checklists.submit`).
- **`apps/api` (14)** — not individually triaged in this analysis; they were
  confirmed identical before and after the preceding change set.

> **Do not treat "23 failures" as the acceptance bar for a rebuild.** They are a
> cleanup backlog. A rebuild starts from zero and should stay at zero.

## 3. Coverage shape

**Well covered:**
- `packages/shared` — the permission tree, its derived maps, and a **frozen
  snapshot test** that locks derivation against drift. This is the strongest
  test asset in the repo and a rebuild should reproduce the pattern.
- `apps/api/src/lib` — unit tests for `audit`, `hash-chain`, `jwt`, `password`,
  `reauth-check`, `errors`, `build-context`, `audit-diff`, `user-id-validator`.
  The compliance-critical libraries are tested.
- `apps/api/src/e2e` — end-to-end suites covering auth, config, entities,
  super-admin flows.

**Gaps:**
- **No React component rendering tests.** `test-setup.ts` registers
  `@testing-library/jest-dom` matchers, but every current web suite is
  pure-logic. There is no test that a page renders, a dialog opens, or a
  permission actually hides a button.
- **No automated accessibility test.**
- **No frontend↔backend route-parity test.** This gap is *proven* by history: a
  dead `/api/filters/dashboard-stats` poll ran every 20 s, 404ing invisibly,
  until a manual route diff found it on 2026-07-25. Five such dead callers
  existed. **A rebuild must assert route parity in CI.**
- **No load, performance, or security regression tests.**
- **No dependency CVE gate.**

## 4. Test infrastructure — two decisions worth preserving

### 4.1 Single-fork execution is required
```bash
npx vitest run --pool=forks --poolOptions.forks.singleFork=true   # = npm test
```
Multiple worker forks produce flaky failures that are **not** real bugs: suites
share an `admin` test user, and one file calling `POST /api/auth/logout`
invalidates the session another file is mid-request against. `fileParallelism:
false` alone is insufficient — it only serialises *within* a worker.

**Better long-term fix** (already the documented convention for new files):
each test file provisions its **own** uniquely-named user in `beforeAll`. Once
every file does this, parallelism can be restored. A rebuild should adopt the
per-file fixture from the start.

### 4.2 Tests run against a separate database
`vitest.env.ts` rewrites `DATABASE_URL` onto `digilog_test_db` before Prisma
connects.

**This is a compliance control, not a convenience.** Previously the suite wrote
**permanent, immutable, hash-chained rows into the real `audit_trail`** —
including orphaned records that then appeared in the live Audit Trail UI. Those
rows cannot be deleted without breaking the chain.

**A rebuild must never let a test suite write to a database holding regulated
records.**

## 5. What a rebuild's test strategy should add

| Layer | Requirement |
|---|---|
| Unit | Keep lib-level coverage of audit, hash-chain, jwt, password, reauth |
| Contract | **Frontend↔backend route parity** asserted in CI |
| Contract | Every declared re-auth action referenced by ≥1 route |
| Contract | Every `enforce: 'a'` node's `gate` appears in a real route guard |
| Snapshot | Keep the frozen permission-map drift test |
| Component | Render tests for every page; permission-gating assertions |
| Integration | Audit chain: write → verify → tamper → verify fails |
| Integration | Redaction preserves the chain; hard delete breaks it *loudly* |
| E2E | Login, session conflict, forced password change, idle timeout |
| Security | Authorisation matrix test: each role × each endpoint |
| A11y | Automated axe pass on every route |
| Performance | Bundle-size budget; query-plan regression on `audit_trail` |
| Supply chain | `npm audit` / CVE gate |

The **audit chain tamper-detection test** is the single most important one:
it is the test that proves the product does what the regulation requires.
