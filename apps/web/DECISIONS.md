# Frontend Architecture Decisions

## 1. Custom UI Components (not full Shadcn CLI install)
**Decision:** Built lean custom UI components (Button, Input, Card, Table, Dialog, Badge, Select, DropdownMenu) following Shadcn/ui patterns.
**Rationale:** Shadcn CLI requires project initialization and pulls in many dependencies (Radix UI, etc.). For Phase 1, the UI needs are well-defined: forms, tables, cards, dialogs. Custom components using Tailwind CSS give us full control, smaller bundle, and zero external UI deps. Components follow Shadcn patterns (variant props, cn() utility, forwardRef) so migration to full Shadcn is straightforward later.

## 2. SWR for Data Fetching (not React Query)
**Decision:** SWR for server state management.
**Rationale:** Per the Phase 1 tech stack doc. SWR is simpler, smaller, and sufficient for Phase 1. Its `useSWR` hook with a global fetcher config provides automatic caching, deduplication, and revalidation. React Query's extra features (mutations, infinite queries, devtools) aren't needed yet.

## 3. Vite Proxy for API (not CORS in dev)
**Decision:** Vite dev server proxies `/api` to the backend at `localhost:3000`.
**Rationale:** Avoids CORS issues in development entirely. The frontend makes requests to the same origin (e.g., `fetch('/api/users')`), and Vite transparently proxies to the backend. In production, a reverse proxy (nginx) would handle this.

## 4. sessionStorage for JWT (not localStorage or httpOnly cookies)
**Decision:** Store JWT access token in `sessionStorage`.
**Rationale:** sessionStorage is cleared when the browser tab closes, providing better security for shared workstations common in regulated environments. In 21 CFR Part 11 contexts, users should not remain authenticated after closing the browser. Combined with single-tab enforcement, this ensures each session is properly scoped. HttpOnly cookies would require CSRF protection and complicate the API client.

## 5. Password Field Security via secureField Prop
**Decision:** Custom `secureField` prop on `<Input>` that disables copy/paste/cut/drag/context-menu.
**Rationale:** 21 CFR Part 11 requires that password fields prevent clipboard operations. Rather than wrapping every password input, a single prop handles all security restrictions. Applied on login, create user, change password, and re-auth forms.

## 6. Role-Based Sidebar Navigation
**Decision:** Sidebar nav items are filtered client-side based on `user.role` and server-side sidebar config.
**Rationale:** Each nav item has an optional `defaultRoles` array — if present, only those roles see the item by default. If the user has a custom sidebar config (from `/api/config/my-config`), that takes precedence. Server still enforces permissions on every API call, so this is a UX convenience, not a security boundary.

## 7. Flat Route Structure (not nested feature folders)
**Decision:** Routes are organized as `routes/[feature]/[page].tsx` with a flat router in `main.tsx`.
**Rationale:** With ~20 pages, a flat router in main.tsx is easy to understand. All routes are visible in one place. Nested routing/code-splitting can be added when the app grows.

## 8. React Hook Form + Zod (shared schemas)
**Decision:** Forms use React Hook Form with `@hookform/resolvers/zod` and import schemas from `@digilog/shared`.
**Rationale:** Same Zod schemas validate on both client and server. No duplication. React Hook Form minimizes re-renders and provides built-in dirty/touched/error tracking. The resolver bridges Zod validation into RHF's error system automatically.

## 9. Dynamic Role Data from API (not hardcoded constants)
**Decision:** Pages that display roles (Role Privileges, Action Re-auth, User Create/Edit dropdowns) fetch from `/api/roles/active` instead of importing the hardcoded `ROLES` constant.
**Rationale:** Custom roles created by SUPER_ADMIN must appear in all role-related UI without code changes. Hardcoded role maps (labels, colors, icons) have fallback values for custom roles. The SWR call uses `revalidateOnMount: true` and `dedupingInterval: 0` to ensure freshness.

## 10. SWR Global Cache Invalidation with Filter Functions
**Decision:** When roles/assets are created/updated/deleted, use `useSWRConfig().mutate(key => key.startsWith('/api/...'))` instead of invalidating specific keys.
**Rationale:** Multiple SWR hooks consume data under different keys (e.g., `/api/roles`, `/api/roles/active`, `/api/assets/templates`, `/api/assets/instances/tree`). A filter-based global mutate ensures ALL related caches are invalidated in one call, preventing stale data across the app.

## 11. Paginated API Response Unwrapping
**Decision:** SWR types must match the API response shape. Paginated endpoints return `{ data: [], total, page, limit, totalPages }`, not raw arrays.
**Rationale:** The API wraps paginated results in a standard envelope. The frontend must type SWR calls as `useSWR<{ data: T[] }>('/api/...')` and extract `res?.data`. Using `useSWR<T[]>` directly causes runtime crashes (`o.filter is not a function`) because the response object has no `.filter` method.

## 12. Entity Explorer Split Panel Layout
**Decision:** The Entity Explorer uses a fixed-width tree panel (320px) on the left with a detail panel on the right, plus a toggle for list view.
**Rationale:** Entity hierarchies need visual tree navigation for CONTAINS relationships, but flat list view is essential for search/filter operations across all entities. The split panel gives both options. Detail panel uses 5 tabs (Overview, Attributes, Relationships, Identifiers, Audit) to organize the rich entity data without overwhelming the user.

## 13. Multi-Step Add Entity Wizard
**Decision:** Creating an entity is a 4-step wizard: Select Template -> Basic Info -> Fill Attributes -> Review & Create.
**Rationale:** Entity creation requires multiple decisions (which template, parent, attribute values). A single long form would be overwhelming. The wizard breaks it into digestible steps. Step 3 dynamically renders type-aware inputs (number inputs for INTEGER/FLOAT with constraints, date pickers for DATE/DATETIME, dropdowns for DROPDOWN type, toggles for BOOLEAN) based on the selected template's attribute schema.

## 14. Sidebar Active State: Exact Match for Parent Routes
**Decision:** The `/assets` sidebar item uses exact pathname match (`location.pathname === '/assets'`) instead of `startsWith('/assets')`.
**Rationale:** Without exact matching, navigating to `/assets/templates` would highlight both "Entities" and "Entity Templates" in the sidebar, since both paths start with `/assets`. Exact match for the parent route ensures only the correct item is highlighted.

## 15. Reauth Execute Must Be Awaited
**Decision:** All `reauth.execute()` calls must use `await` (i.e., `await reauth.execute('ACTION', callback, opts)`).
**Rationale:** Without `await`, the code after `reauth.execute` runs immediately, which can cause race conditions where state is saved (e.g., closing a dialog, clearing form data) before the reauth dialog is shown or the callback completes. This was a key bug fix that applies to all entity mutation flows (create, edit, delete, link, status change).

## 16. API Client Methods for Mutations
**Decision:** Frontend uses `apiClient.post()`, `apiClient.put()`, and `apiClient.delete()` for mutations instead of SWR's mutation helpers.
**Rationale:** SWR is designed for data fetching, not mutations. Using the API client directly for POST/PUT/DELETE gives explicit control over request bodies, error handling, and reauth password headers. SWR's `mutate()` is only used for cache invalidation after successful mutations.

## 17. Template Selector Shows All Templates (no isActive filter)
**Decision:** The Add Entity wizard's template selector fetches `/api/assets/templates?limit=100` without filtering by `isActive`.
**Rationale:** Users should be able to create entities from any template regardless of its active/inactive status. The `isActive` flag on templates controls whether the template itself can be edited or is retired, not whether entities can be created from it. Filtering by `isActive=true` would hide templates that still have valid schemas for entity creation.

## 18. Dynamic Tree Diagram with Inline Actions
**Decision:** The Relationships tab diagram tree has hover-action buttons (create child, attach existing, remove from tree) directly on each node, rather than a separate context menu.
**Rationale:** Direct action buttons reduce click count and make the tree interactive without modal overhead. Three distinct actions (green=create new, blue=attach existing, red=remove) use color coding for quick identification. The buttons only appear on hover to keep the tree clean. The "remove" action deletes the CONTAINS relationship (not the entity), with a confirm dialog.

## 19. Attach Existing Entity Dialog (Search + Select)
**Decision:** Attaching an existing entity to the tree uses a modal dialog with search input, radio-button entity list, and preview, rather than drag-and-drop.
**Rationale:** Drag-and-drop is difficult to implement in a nested tree and has poor accessibility. The search dialog allows finding entities by name across the entire system, shows template badge for context, and provides a clear preview before committing. Creates a CONTAINS relationship behind the scenes.

## 20. All 12 Relationship Types in UI Selectors
**Decision:** The Link Entities dialog shows all 12 relationship types freely available with no restrictions.
**Rationale:** Any entity can link to any other entity with any relationship type (CONTAINS, CONTAINED_IN, CONNECTED_TO, FEEDS, FED_BY, DEPENDS_ON, DEPENDED_ON_BY, BACKS_UP, BACKED_UP_BY, MONITORS, MONITORED_BY, CUSTOM). All types are shown as radio buttons for selection.

## 21. Toast Notification System via React Context
**Decision:** Global toast notifications use React Context (`ToastProvider` + `useToast` hook) rather than a third-party library (react-hot-toast, sonner, etc.).
**Rationale:** The app already uses a custom component library without external UI dependencies. A lightweight custom toast system (~150 lines total) keeps the bundle small and gives full control over styling (matching the Tailwind design system). The Context pattern allows any component to trigger toasts without prop drilling. Auto-dismiss (5s) with manual close keeps the UI clean.

## 22. Entity Template View Dialog (Read-Only)
**Decision:** Entity template details are shown in a read-only dialog (triggered by an eye icon) rather than navigating to a separate page or using the edit dialog in read-only mode.
**Rationale:** A dedicated view dialog provides quick inspection without the risk of accidental edits. The dialog shows all template sections (attributes, telemetry, identifiers, alarm rules) in a compact format. An "Edit Template" button allows seamless transition to the edit dialog when changes are needed. This keeps the template table's action column clean with three distinct icons: view (eye), edit (pencil), delete (trash).

## 23. Connection Status Cards with Progress Bars
**Decision:** The entity Overview tab shows 4 connection status cards (Connections Allowed/Used, Parent Connections Allowed/Used) with visual progress bars.
**Rationale:** Connection limits are template-level settings that users need to monitor per entity. Progress bars provide an instant visual indicator of capacity (green when under limit, red when at limit). Showing both total connections and parent connections separately reflects the dual limit system (maxConnections vs maxParentConnections). Cards are read-only since limits are set at the template level.

## 24. React Flow for Rule Chain Visual Editor
> **⚠️ SUPERSEDED — rule-chain removed 2026-05-17; `reactflow` uninstalled.** The cleaning-profile pipeline editor (which had reused React Flow) now uses a **custom canvas**. Retained as a historical decision-record.

**Decision:** Use React Flow library for the rule chain visual editor canvas (77 node types across 8 categories) rather than building a custom canvas solution.
**Rationale:** React Flow provides production-ready node-based graph editing with drag-and-drop, zooming, panning, edge routing, and selection out of the box. Building a custom canvas would take weeks and wouldn't match the quality. React Flow integrates naturally with React state management. The node palette sidebar uses a simple drag-to-canvas pattern. Edge selection uses red highlight with animation for visibility. Also reused for the cleaning profile pipeline editor.

## 25. Component Extraction Pattern (Entity Explorer refactoring)
**Decision:** Extract the Entity Explorer from a 2,081-line monolith into: 6 dialog components (`components/dialogs/`), 6 tab components (`components/tabs/`), and 2 custom hooks (`hooks/`). Main file reduced to 386 lines.
**Rationale:** Large monolithic components are hard to maintain, test, and review. The extraction follows a clear separation: dialogs handle modal CRUD operations, tabs handle detail panel content, hooks encapsulate mutation logic and tree filtering. Each extracted component is self-contained with its own props interface. The pattern can be applied to other large pages (templates.tsx at ~1,410 lines).

## 26. Role-Based Alarm Column Visibility
> **⚠️ SUPERSEDED — alarm subsystem + `/config/alarm-columns` page removed 2026-05-17.** Retained as a historical decision-record.

**Decision:** Alarm dashboard columns are configurable per role via the `/config/alarm-columns` page. Each role can have different visible columns from the 11 available (severity, alarmType, entity, highLimit, lowLimit, generatedValue, clearedValue, status, generatedAt, clearedAt, actions).
**Rationale:** Different roles need different alarm information. Operators may only need severity and status, while maintenance engineers need threshold details. Column definitions are centralized in `@digilog/shared` (ALARM_COLUMN_DEFINITIONS), and the frontend fetches the current user's visible columns via SWR. This avoids hardcoding column visibility and supports custom roles.

## 27. Permission Constants for Route Guards (not string literals)
**Decision:** All frontend route permission checks use `PERMISSIONS.*` constants imported from `@digilog/shared`, never string literals like `'ASSET_CREATE'`.
**Rationale:** String literals are error-prone (typos compile but fail at runtime) and make permission renames risky. Constants provide compile-time checking and IDE autocomplete. If a permission is renamed in the shared package, all references break at build time, ensuring nothing is missed.

## 28. Debug Trace Page for Pipeline Visibility
**Decision:** Added a `/debug` page showing pipeline debug traces with stage-by-stage execution details.
**Rationale:** Data ingestion pipelines are opaque — when telemetry doesn't appear, users need to see where in the 10-stage pipeline the data was dropped. The debug trace page shows each message's journey through the pipeline with timestamps, stage results, and error details. This is a development/operations tool, not user-facing, so it requires the `READ_DEBUG_TRACE` permission.

## 29. Dynamic Config Pages (2026-03-12)
**Decision:** Auto-generate config UI from registry manifest for modules without custom pages.
**Rationale:** Reduces boilerplate — each new config module gets a functional UI without writing a custom page component.
**Trade-offs:** Less control over layout for dynamic pages, but custom pages can still be used when needed (hasCustomPage: true).

## 30. Field ID Grouping by Module (2026-03-12)
**Decision:** Restructured Field ID Names page to group fields by module with color-coded tabs.
**Rationale:** With expansion from 6 to 78 fields across multiple modules, a flat list was unusable. Module grouping with search and filter makes management practical.

## Phase 2 Decisions

- ~~**Pipeline editor reuses ReactFlow**~~: *(superseded 2026-05-17 — `reactflow` was uninstalled with the rule-chain tear-out; the cleaning-profile pipeline editor now uses a custom canvas)*
- **Pipeline as graph, not linear list**: Chose directed graph (stages + connections) over linear array to support future branching, parallel paths, and conditional flows
- **Checklist as pipeline node, not stage property**: Checklists are first-class CHECKLIST nodes in the graph, not attached to stages. This allows placing checklists between any stages, or multiple checklists in sequence
- **Versioning via create-new + archive-old**: Updating a cleaning profile creates a new version and archives the old one, preserving historical data for completed cycles
- **Events as immutable log**: filter_events table is append-only with SHA-256 checksums for 21 CFR Part 11 compliance
- **Auto-complete on last stage**: Cycle auto-completes when the last STAGE node leads to END, eliminating a separate "end cycle" step
- **Server-side checklist enforcement**: advance() checks for pending checklists and blocks if not completed, preventing API-level bypass
- **Unified light theme**: ALL pages use bg-white, text-slate-800, bg-slate-50 sections, border-slate-200 — no dark theme anywhere
- **Filter operations merged into single page**: Filter status view consolidated into filter operations for streamlined UX
- **AHU dashboard by equipment group**: Filters grouped by AHU/equipment for operational overview rather than flat list
- **Retirement/replacement as separate workflows**: Distinct pages for retirement (with reason) and replacement (linking old to new filter) for audit trail clarity
- **Bulk upload with CSV validation**: Frontend validates CSV format before upload, server validates data integrity

---

## Phase 3 Update (2026-04-07)

**RFID & Offline Operations:**
- RFID Scanner Android app (`rfid_scan_app/`) for KC-series UHF readers
- RFID keyboard guard prevents UKB tag input leaking into random fields
- Offline cleaning operations via IndexedDB queue + sync engine
- Cached identifier→filter map for offline RFID lookup
- "Data Synced" indicator in mobile header
- One identifier per entity (backend-enforced)
- Responsive layout with collapsible sidebar
- Error popups replace inline banners
- User creation auto-assigns org for admins
- `/api/roles/active` public endpoint for contact-admin page

See `CHANGELOG.md` for full details.
