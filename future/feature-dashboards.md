# Configurable Widget Dashboards — Future Scope

**Status:** Backend complete, no frontend consumer. Parked 2026-04-30 during the Phase 5 adversarial review.

## What ships today

- 4 Prisma models: `Dashboard`, `DashboardWidget`, `DashboardAssignment`, plus widget-data backing tables
- 13 routes under `/api/dashboards` (CRUD, widget management, layout save, USER/ROLE/ORGANIZATION assignment, widget data fetcher, widget catalog)
- Permission-gated reads: SUPER_ADMIN sees all; ADMIN sees all in their org; everyone else sees only what their `DashboardAssignment` row grants
- Module file: `apps/api/src/modules/dashboards/routes.ts` (registered in `app.ts:280` under prefix `/api/dashboards`)

## What's missing

- Frontend page at `/dashboards`. The current landing route `/` is a hardcoded "system overview" page (welcome banner, 3 quick-stat tiles, 3 quick-action cards, filter analytics charts) that reads standalone endpoints — it ignores the `Dashboard` / `DashboardWidget` tables.
- A widget designer (drag-drop canvas, widget catalog, layout persistence)
- A widget renderer that calls `GET /api/dashboards/:id/data/:widgetId` and turns the response into the widget UI (chart, gauge, count, table, etc.)

## When to do this

- Customer asks for per-role / per-user customizable home pages
- Multi-tenant deployments where each org wants its own KPIs

## How to start

1. Audit the widget-data endpoint (`apps/api/src/modules/dashboards/routes.ts:408`) to see which widget shapes the backend already supports
2. Spike a `/dashboards` route in `apps/web/src/main.tsx` that lists assigned dashboards
3. Build a `<DashboardCanvas>` with `react-grid-layout` (or similar) backed by `PUT /:id/layout`
4. Per widget type, build a `<Widget*>` component that consumes the matching data shape
5. Replace the hardcoded `/` landing page with a redirect to the user's default dashboard once UI is live

## Related code

- `apps/api/src/modules/dashboards/routes.ts` — 13 routes
- `apps/api/prisma/schema.prisma` — search for `model Dashboard`, `model DashboardWidget`, `model DashboardAssignment`
- `apps/web/src/routes/index.tsx` — the current hardcoded landing page that this would replace
