# DRY_IN State Persistence & Offline Support

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DRY_IN countdown panel and temperature dropdown persist across navigation and work fully offline.

**Architecture:** After SET_DURATION succeeds (online or queued offline), update the IndexedDB `filter-state-{id}` cache with `dryerStartedAt` and `dryerDurationMinutes`. Store selected-but-unsubmitted temperature in a separate `dryer-temp-{id}` cache key. Both web and mobile pages read from cache on mount, so the panel appears immediately without re-scanning.

**Tech Stack:** React, IndexedDB (offline-store.ts), SWR, useOffline hook

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `apps/web/src/routes/filter-management/filter-operations.tsx` | Modify | Update cache after SET_DURATION; persist/restore temp selection in DryingFilterRow |
| `apps/web/src/routes/mobile/mobile-operations.tsx` | Modify | Update cache after SET_DURATION; persist/restore temp selection in DryingFilterCard |

Two files, four changes total. No new files needed.

---

### Task 1: Web — Cache dryer fields after SET_DURATION

**Files:**
- Modify: `apps/web/src/routes/filter-management/filter-operations.tsx:903-956` (handleDryerDurationSubmit)

**What:** After `executeOrQueue` succeeds in `handleDryerDurationSubmit`, update the `filter-state-{filterId}` cache with dryer timing so the DryingFiltersPanel shows the countdown immediately — whether online or offline.

- [ ] **Step 1: Add cache update after batch SET_DURATION success**

In `handleDryerDurationSubmit`, after the batch loop (line ~929, after `refreshFilters()`), add cache updates for each filter in the batch:

```typescript
// After: refreshFilters();
// Add: update cached state with dryer timing for each filter
const dryerStartedAt = new Date().toISOString();
for (const item of batch) {
  try {
    const cached = await getCache<any>(`filter-state-${item.filterId}`) ?? {};
    cache(`filter-state-${item.filterId}`, {
      ...cached,
      currentState: 'DRY_IN',
      currentCycle: {
        ...(cached.currentCycle ?? {}),
        dryerDurationMinutes: minutes,
        dryerStartedAt,
      },
    });
  } catch { /* ignore cache errors */ }
}
```

- [ ] **Step 2: Add cache update after single-filter SET_DURATION success**

In the single-filter path (line ~947, after `refreshFilters()`), add the same cache update:

```typescript
// After: refreshFilters();
// Add: update cached state with dryer timing
try {
  const cached = await getCache<any>(`filter-state-${dryerDialog.filterId}`) ?? {};
  cache(`filter-state-${dryerDialog.filterId}`, {
    ...cached,
    currentState: 'DRY_IN',
    currentCycle: {
      ...(cached.currentCycle ?? {}),
      dryerDurationMinutes: minutes,
      dryerStartedAt: new Date().toISOString(),
    },
  });
} catch { /* ignore cache errors */ }
```

- [ ] **Step 3: Verify — navigate away and back**

1. Start dev server: `cd apps/web && npx vite`
2. Go to filter operations, DRY_IN stage
3. Scan/select a filter, submit 5-minute duration
4. Navigate to another page (e.g., dashboard)
5. Navigate back to DRY_IN stage
6. **Expected:** Countdown panel appears with timer, not "waiting for dryer start..."

- [ ] **Step 4: Verify — offline mode**

1. Submit a duration while online
2. Go offline (disconnect network)
3. Navigate away and back to DRY_IN
4. **Expected:** Countdown panel still shows from cache
5. Also test: go offline FIRST, then submit duration (queued), stay on DRY_IN
6. **Expected:** Countdown panel appears immediately after submission

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/filter-management/filter-operations.tsx
git commit -m "fix: cache dryer timing after SET_DURATION for web operations"
```

---

### Task 2: Web — Persist temperature dropdown selection across navigation

**Files:**
- Modify: `apps/web/src/routes/filter-management/filter-operations.tsx:1519-1679` (DryingFilterRow)

**What:** Save the selected temperature to IndexedDB cache when the user picks a value from the dropdown. Restore it on component mount. Clear it after successful submit.

- [ ] **Step 1: Add cache import and restore on mount**

DryingFilterRow currently does NOT have access to `cache`/`getCache` from useOffline (it's a child component). It uses a dynamic import for offline fallback (line 1588). We'll use the same pattern — direct import from offline-store.

At the top of DryingFilterRow (after the existing useState declarations around line 1536), add:

```typescript
// Restore previously selected temperature from cache (survives navigation)
useEffect(() => {
  import('@/lib/offline-store').then(({ getCachedData }) => {
    getCachedData<number>(`dryer-temp-${filterId}`).then(saved => {
      if (saved !== null && saved !== undefined) setTemp(saved);
    });
  }).catch(() => {});
}, [filterId]);
```

- [ ] **Step 2: Save temp to cache on dropdown change**

Replace the `onChange` handler on the temperature `<select>` (line ~1656):

From:
```typescript
onChange={(e) => setTemp(e.target.value ? Number(e.target.value) : '')}
```

To:
```typescript
onChange={(e) => {
  const val = e.target.value ? Number(e.target.value) : '';
  setTemp(val);
  // Persist selection so it survives navigation
  if (val !== '') {
    import('@/lib/offline-store').then(({ cacheData }) => {
      cacheData(`dryer-temp-${filterId}`, val, 24 * 60 * 60 * 1000);
    }).catch(() => {});
  }
}}
```

- [ ] **Step 3: Clear cached temp after successful submit**

In the `handleSubmit` function (line ~1613, after `setToast`), add:

```typescript
// Clear persisted temp selection
import('@/lib/offline-store').then(({ cacheData }) => {
  cacheData(`dryer-temp-${filterId}`, null, 0);
}).catch(() => {});
```

- [ ] **Step 4: Verify — temp persists across navigation**

1. Go to DRY_IN stage with a filter drying (half-time reached)
2. Select a temperature from the dropdown (but do NOT submit)
3. Navigate to dashboard
4. Navigate back to DRY_IN
5. **Expected:** The previously selected temperature is still shown in the dropdown

- [ ] **Step 5: Verify — temp clears after submit**

1. Select a temperature and submit it
2. **Expected:** Filter moves to DRY_OUT, cached temp is cleared

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/filter-management/filter-operations.tsx
git commit -m "fix: persist DRY_IN temperature selection across navigation"
```

---

### Task 3: Mobile — Cache dryer fields after SET_DURATION

**Files:**
- Modify: `apps/web/src/routes/mobile/mobile-operations.tsx:640-660` (handleDryerDurationSubmit)

**What:** Same as Task 1 but for the mobile operations page. After SET_DURATION succeeds or queues, update the `filter-state-{filterId}` cache.

- [ ] **Step 1: Add cache update after mobile SET_DURATION**

In `handleDryerDurationSubmit` (line ~651, after `setSuccess`), add:

```typescript
// Update cached state with dryer timing (for offline + navigation persistence)
try {
  const cached = await getCache<any>(`filter-state-${dryerDialog.filterId}`) ?? {};
  cache(`filter-state-${dryerDialog.filterId}`, {
    ...cached,
    currentState: 'DRY_IN',
    currentCycle: {
      ...(cached.currentCycle ?? {}),
      dryerDurationMinutes: minutes,
      dryerStartedAt: new Date().toISOString(),
    },
  });
} catch { /* ignore cache errors */ }
```

- [ ] **Step 2: Verify — mobile offline DRY_IN**

1. Open mobile operations view
2. Go offline
3. Scan filter, advance to DRY_IN, submit 5-minute duration (queued)
4. **Expected:** DryingFilterCard shows countdown immediately
5. Navigate to home, back to DRY_IN stage
6. **Expected:** Countdown still shows

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/mobile/mobile-operations.tsx
git commit -m "fix: cache dryer timing after SET_DURATION for mobile operations"
```

---

### Task 4: Mobile — Persist temperature dropdown selection across navigation

**Files:**
- Modify: `apps/web/src/routes/mobile/mobile-operations.tsx:1584-1730` (DryingFilterCard)

**What:** Same as Task 2 but for mobile. Persist selected temp to cache, restore on mount, clear on submit.

- [ ] **Step 1: Add restore on mount**

In DryingFilterCard, after the existing `useState` declarations (line ~1594), add:

```typescript
// Restore previously selected temperature from cache
useEffect(() => {
  getCache<number>(`dryer-temp-${filterId}`).then(saved => {
    if (saved !== null && saved !== undefined) setTemp(saved);
  }).catch(() => {});
}, [filterId]);
```

Note: DryingFilterCard already receives `getCache` as a prop, so no dynamic import needed.

- [ ] **Step 2: Save temp on dropdown change**

In the temperature `<select>` (line ~1709):

From:
```typescript
onChange={e => setTemp(e.target.value ? Number(e.target.value) : '')}
```

To:
```typescript
onChange={e => {
  const val = e.target.value ? Number(e.target.value) : '';
  setTemp(val);
  if (val !== '') {
    import('@/lib/offline-store').then(({ cacheData }) => {
      cacheData(`dryer-temp-${filterId}`, val, 24 * 60 * 60 * 1000);
    }).catch(() => {});
  }
}}
```

- [ ] **Step 3: Clear cached temp after successful submit**

In `handleTempSubmit` (line ~1680, after `onSuccess`), add:

```typescript
// Clear persisted temp selection
import('@/lib/offline-store').then(({ cacheData }) => {
  cacheData(`dryer-temp-${filterId}`, null, 0);
}).catch(() => {});
```

- [ ] **Step 4: Verify — mobile temp persistence**

1. Open mobile DRY_IN with a drying filter (half-time reached)
2. Select temperature, do NOT submit
3. Navigate to mobile home
4. Return to DRY_IN
5. **Expected:** Selected temperature still shown

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/mobile/mobile-operations.tsx
git commit -m "fix: persist DRY_IN temperature selection across navigation (mobile)"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Cache dryer timing after SET_DURATION (web) | filter-operations.tsx |
| 2 | Persist temp dropdown selection (web) | filter-operations.tsx |
| 3 | Cache dryer timing after SET_DURATION (mobile) | mobile-operations.tsx |
| 4 | Persist temp dropdown selection (mobile) | mobile-operations.tsx |
