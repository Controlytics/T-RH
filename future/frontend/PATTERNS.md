# Frontend Patterns

Conventions every page in this codebase follows. Use this to pattern-match when adding new features — consistency matters more than cleverness here.

## 1. Route definition

Every authenticated route looks like this:

```tsx
<Route
  path="/my-thing"
  element={
    <RequireRole permissions={[PERMISSIONS.MY_THING_READ]}>
      <Suspense fallback={<LazyFallback />}>
        <MyThingPage />
      </Suspense>
    </RequireRole>
  }
/>
```

- Always use `PERMISSIONS.*` constants from `@digilog/shared`, never string literals.
- Lazy-load via `React.lazy()` for anything other than the dashboard and cheap config pages.
- `SUPER_ADMIN` is allowed by `RequireRole` automatically — you don't need to include it explicitly.

## 2. Fetching data

```tsx
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';

const { data, error, isLoading, mutate } = useSWR(
  '/api/my-things',
  (url) => apiClient.get(url)
);
```

- SWR is the default. No TanStack Query, no Redux.
- Errors thrown by `apiClient` carry `.status` — handle 403 quietly (the UI is already gated by permissions).

## 3. Forms

```tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { mySchema } from '@digilog/shared';

const form = useForm({ resolver: zodResolver(mySchema) });
```

- Reuse Zod schemas from `packages/shared/src/schemas/` — never duplicate a schema in both apps.
- If a form triggers a reauth-required action, wrap the submit in `useReauth()`:

```tsx
const { withReauth } = useReauth();
const onSubmit = withReauth('ACTION_KEY', async (values) => {
  await apiClient.put('/api/things/1', values);
});
```

## 4. Offline-safe mutations

```tsx
const { executeOrQueue, online } = useOffline();

await executeOrQueue({
  type: 'advance',
  filterId: filter.id,
  filterName: filter.name,
  payload: { reason: 'Scheduled' },
  onlineFn: () => apiClient.post(`/api/filters/${filter.id}/advance`, { reason: 'Scheduled' }),
});
```

- Mutations that participate in the offline pipeline must go through `executeOrQueue`.
- Pure reads do **not** need offline handling — SWR's stale-while-revalidate is enough because the cache lives in `offline-store` via `cacheData` helpers.

## 5. Dynamic attribute forms

Creation dialogs (e.g., filter create) must render their fields from the template's `attributeSchema`:

```ts
template.attributeSchema.forEach(({ fieldName, dataType, required, dropdownOptions }) => { /* render */ });
```

- Honor `required` and `dataType` at submit time.
- Dropdowns must use `dropdownOptions` from the schema.

## 6. Error display

Use `<ErrorPopup>` from `components/ui/error-popup.tsx` for terminal errors (e.g., failed create, conflict). Avoid inline red banners — the project standardized on popups.

## 7. Themes and colors

- Do not hardcode colors. Use Tailwind + the theme CSS variables (`var(--theme-primary)` et al.) where a dynamic color is needed.
- All pages share the same active theme. **No per-page color palettes.**
- All pages are **light-themed** — no dark-theme classes anywhere.
- Safe defaults: `bg-white` cards, `bg-slate-50` sections, `border-slate-200`, gradient dialog headers are OK.

## 8. Reauth + approvals

- Decisions that modify business data and are reauth-required must fetch `/api/config/action-reauth/my-actions` via SWR and check inclusion before prompting.
- Approval / rejection UIs require **mandatory remarks** (user feedback rule). Filter cleaning stages are the documented exception where remarks stay optional.

## 9. RFID-enabled inputs

```tsx
<Input data-rfid="true" onRfidScan={(tag) => { /* handle */ }} />
```

- Without `data-rfid="true"`, `useRfidGuard()` will swallow the keyboard burst.
- Scan dialogs debounce at 300 ms and dedup identical tags.

## 10. Permission + feature-privilege mapping

When adding a **feature toggle** (a granular privilege like "Download PM Template"):

1. Add the permission constant to `packages/shared/src/types/permissions.ts`.
2. Add the feature privilege to `packages/shared/src/types/feature-privileges.ts`.
3. Update `FEATURE_TO_PERMISSION_MAP` with **both** the frontend visibility permission and the backend route permission.
4. Rebuild shared: `npm run build -w @digilog/shared`.
5. Update the consuming frontend component's visibility check.
6. Update the backend route's `preHandler` permission check.
7. Update the sidebar if the feature creates a new nav entry (both sidebar files — don't auto-sync).
8. Update the reauth list if the action is reauth-protected.
9. Update the seed and the auth plugin public-path list if needed.
10. Re-verify by curl'ing the endpoint (user rule: "compile clean doesn't mean it works").

This is the **12-touchpoint rule** mentioned in memory. Skipping any step causes hard-to-debug UI vs. API mismatches.

## 11. Tablet parity

**Do not fork** pages into separate tablet and web versions. Use the same page component for both. The tablet wrapper (`mobile-wrapper.tsx`) should compose the existing page with a tablet chrome, not replace it. Separate implementations always drift. This is a hard rule — the history of this repo has multiple painful merges caused by ignoring it.

## 12. Sidebar visibility

`SIDEBAR_ITEMS` from `@digilog/shared` defines the nav tree. `SIDEBAR_PRIVILEGE_MAP` maps each item to the permissions that gate its visibility. The sidebar component filters by those privileges at render — do not add ad-hoc hide/show logic inside `sidebar.tsx`.
