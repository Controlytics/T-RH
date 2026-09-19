# Phase 10 — Performance Analysis

**Measured where measurable; explicitly unmeasured where not.** No performance
claim below is estimated.

---

## 1. Frontend bundle — measured

`npx vite build`, 2026-07-25. Built in 11.71s. **22 JS chunks, ~2.97 MB raw.**

| Chunk | Raw | Gzip | Note |
|---|---|---|---|
| `exceljs.min` | **940 kB** | 271 kB | ⚠ over the 800 kB warning threshold |
| `index-Bc9vahBU` | 778 kB | 188 kB | main app chunk |
| `index-B4uMqGmN` | 489 kB | 156 kB | |
| `html2canvas.esm` | 202 kB | 48 kB | pulled in by jsPDF |
| `index.es` | 160 kB | 54 kB | |
| `vendor` | 51 kB | 18 kB | react, react-dom, react-router |
| `purify.es` | 29 kB | 11 kB | |
| …15 more route chunks | 6–37 kB each | | lazy-loaded pages |

PWA precache: **31 entries, 3.29 MB**.

### Findings

1. **ExcelJS (940 kB) is the single largest chunk** and Vite warns about it. It
   is needed only when a user clicks "Export as Excel". **It should be
   dynamically imported at the click**, not bundled into the initial graph.
2. **html2canvas (202 kB) arrives via jsPDF** and is only needed for PDF export.
   Same treatment.
3. Together these two are **~1.14 MB raw / ~319 kB gzip of export machinery**
   shipped to every user on every load, including users who lack export
   permissions entirely.
4. Route-level code splitting is otherwise working well — the 15 small chunks
   are lazy-loaded pages, which is the right shape.
5. `manualChunks` currently splits only `vendor` and `swr`. Extending it to
   isolate the export libraries behind dynamic imports is the highest-value
   frontend performance change available.

**Estimated win:** deferring both export libraries would cut roughly a third of
the initial JS payload for the common case.

## 2. Frontend runtime patterns — reviewed

**Good:**
- SWR with `dedupingInterval` (typically 2000 ms) coalesces duplicate fetches.
- Conditional fetching — passing `null` as the SWR key when the user lacks the
  permission avoids both the request and a console 403.
- `lazy()` + `<Suspense>` on heavy routes.
- `useMemo` on derived lists (role filtering, breakdowns).
- Refresh intervals are scoped per key, and SWR only polls while the component
  is mounted and the tab is visible.

**Concerns:**
- **Polling is used fairly freely** — e.g. dashboard cards every 30 s (the Module
  Guide's 30 s role-matrix poll went with that page on 2026-09-19). On a page left open all
  shift this is a steady request stream. With no pub/sub layer there is no
  push alternative today; a rebuild might consider SSE for a few surfaces.
- **A dead 20 s poll survived for months.** `/api/filters/dashboard-stats` was
  polled every 20 s and 404'd every time, invisibly, until it was found by a
  route diff on 2026-07-25. **A rebuild should fail loudly on a 404 from a
  polling key**, or assert frontend↔backend route parity in CI.
- No virtualisation on long tables — pagination is used instead. Acceptable at
  current page sizes; the configurable `export-limit` is what protects the
  export path.

## 3. Database performance — reviewed

**`audit_trail` is the performance-critical table.** It grows monotonically
(rows can never be pruned by deletion) and carries the heaviest read load.

Its **7 secondary indexes** are well-matched to its query patterns, notably the
deliberate pairing of a single-column `user_id` index with a composite
`(user_id, timestamp DESC)` — the composite serves "this user's recent activity"
without a sort. `admin_requests` similarly indexes exactly its three list
filters.

**Concerns:**
1. **No archival or partitioning strategy.** `audit_trail` grows forever. At
   232 rows on a fresh install this is invisible; at millions of rows on a
   multi-year production install, `timestamp DESC` scans and the full chain walk
   in `verify-chain` will both degrade. **This is the top scaling risk.**
2. **`verify-chain` walks the entire table.** It is O(n) with no checkpointing,
   so verification cost rises linearly forever. A rebuild should support
   verifying a *range* and maintaining periodic signed checkpoints.
3. Write amplification is inherent: every audited action performs an extra
   insert in the same transaction. This is correct and non-negotiable — it is
   the compliance guarantee — but it must be accounted for in capacity planning.

**Not measured:** no query plans (`EXPLAIN ANALYZE`) were captured, no load test
was run, and there is no production dataset to profile. Any statement about
actual latency would be invention.

## 4. Backend — reviewed

- **Fastify** with schema-based serialisation is a fast baseline; response
  schemas double as an output allow-list.
- **30 s session auth cache** avoids a user+permission lookup per request. Its
  invalidation on logout is load-bearing — a bug where it was missed left
  logged-out sessions valid for up to 30 s.
- **10 s re-auth cache** prevents repeated password prompts in multi-step flows.
- **graphile-worker** keeps jobs in Postgres — one less service, at the cost of
  queue load landing on the same database as application queries. At this scale
  that is the right trade; at high job volume it would become contention.
- **Rate limiting is two-tier** (loose global, tight per-auth-route), which is
  the correct shape — see [`../06-api/README.md`](../06-api/README.md) §6.

**Not measured:** no APM, no request-latency histogram, no throughput benchmark.

## 5. Known scaling limits

| Limit | Impact | Mitigation |
|---|---|---|
| `audit_trail` unbounded growth | Query + verification degradation over years | Partition by time; checkpointed verification |
| `verify-chain` is O(n) full walk | Verification time grows without bound | Range verification + periodic signed checkpoints |
| Export libraries in initial bundle | ~1.1 MB shipped to every user | Dynamic import at click |
| Polling with no push channel | Steady request stream on long-lived pages | SSE for a few high-value surfaces |
| Job queue shares the app database | Contention at high job volume | Acceptable now; revisit if volume grows |
| Single-node deployment | No horizontal scale, no HA | See [`../11-rebuild-plan/`](../11-rebuild-plan/) |

## 6. What was deliberately not measured

Stated so coverage is not overread:

- Lighthouse / Core Web Vitals — not run
- `EXPLAIN ANALYZE` on any query — not captured
- Load or soak testing — not performed
- Memory / CPU profiling under load — not performed
- Time-to-interactive on target hardware — not measured

A rebuild should establish these as **baselines before** refactoring, so
improvements are demonstrable rather than asserted.

---

See [`testing-baseline.md`](testing-baseline.md) for the current test suite
state, including its pre-existing failures.
