# DigiLog Reports Module — Claude Code Task Plan

**Date:** 2026-04-04
**Priority:** Phase 4 Feature
**Estimated Complexity:** High (comparable to Phase 2 Filter Management)

---

## Pre-Implementation Checklist

Before starting, read these files to understand existing patterns:

```
# Architecture patterns
apps/api/src/app.ts                           # Module registration pattern
apps/api/src/modules/cleaning-profiles/        # Versioned entity pattern (follow this for templates)
apps/api/src/modules/filter-operations/        # State machine + transaction pattern (follow for signatures)
apps/api/src/modules/config/definitions/       # Config auto-discovery pattern
apps/api/src/plugins/                          # Auth, RBAC, audit-logger plugins
apps/api/src/lib/org-scope.ts                  # Org scoping utility

# Frontend patterns
apps/web/src/routes/filter-management/         # Complex page with dialogs (follow for template designer)
apps/web/src/routes/cleaning-cycles/           # List + detail pattern
apps/web/src/hooks/use-auth.ts                 # Auth + re-auth flow
apps/web/src/hooks/use-reauth.ts               # Re-auth for sensitive actions (use for signing)
apps/web/src/components/ui/                    # UI component conventions

# Shared
packages/shared/src/permissions.ts             # Permission constants
apps/api/prisma/schema.prisma                  # Existing models
```

---

## Implementation Order (18 Tasks)

### Phase A: Foundation (Tasks 1–5)

- [ ] **Task 1: Prisma Schema — Add Report Models**
  - Add to `schema.prisma`: ReportTemplate, ReportTemplateVersion, ReportInstance, ReportSignature
  - Add enums: ReportTemplateStatus, ReportStatus
  - Add relations to User and Organization models
  - Run `npx prisma migrate dev --name add-reports-module`
  - Verify migration succeeds and models are generated
  - **Pattern:** Follow AssetTemplate + AssetTemplateVersion for versioning pattern

- [ ] **Task 2: Permissions & Config**
  - Add 9 permissions to `packages/shared/src/permissions.ts` (REPORT_TEMPLATE_READ/CREATE/UPDATE/DELETE, REPORT_GENERATE/VIEW/SIGN/DELETE/EXPORT)
  - Add permissions to seed file in default role assignments
  - Create config definition `apps/api/src/modules/config/definitions/report-settings.def.ts`
  - Add sidebar config entry for Reports section
  - Verify permissions appear in `GET /api/roles/permissions/all`

- [ ] **Task 3: Report Templates — Backend CRUD**
  - Create module `apps/api/src/modules/report-templates/`
  - Files: routes.ts, handlers.ts, service.ts, schemas.ts, types.ts
  - Implement: list (with org scope, status filter, pagination), get by ID (include latest version config), create (version 1), update (create new version, bump currentVersion), delete, toggle-status (ACTIVE/ARCHIVED/DRAFT), list versions
  - All routes use `requirePermission()` decorator
  - All mutations create audit trail entries
  - Zod validation for the full template config JSON
  - **Pattern:** Follow cleaning-profiles module exactly for versioning + toggle-status

- [ ] **Task 4: Report Templates — Frontend List + CRUD**
  - Create `apps/web/src/routes/report-templates/index.tsx` — list page
  - Table with columns: Name, Status (badge), Version, Created By, Updated At, Actions
  - Status badges: ACTIVE (green), ARCHIVED (gray), DRAFT (yellow)
  - Actions: Edit, Duplicate, Toggle Status, Delete (with confirmation dialog)
  - "+ New Template" button
  - SWR data fetching, pagination from config
  - **Pattern:** Follow cleaning-profile-list page layout and conventions

- [ ] **Task 5: Install Backend Dependencies**
  - `cd apps/api && npm install puppeteer chartjs-node-canvas chart.js handlebars dayjs`
  - On EC2: install Chromium dependencies for Puppeteer (see BACKEND_IMPL.md §8)
  - Verify Puppeteer can launch headless browser in dev and prod environments
  - Create `apps/api/src/modules/reports/renderers/pdf-renderer.ts` with basic test
  - Verify chart rendering works with `chartjs-node-canvas`

### Phase B: Template Designer (Tasks 6–9)

- [ ] **Task 6: Template Designer — Layout Shell**
  - Create `apps/web/src/routes/report-templates/[id]/edit.tsx`
  - Three-panel layout: palette (left), section list (center), editor (right)
  - Top bar: template name input, page settings button, save button, preview button
  - Load template config from API on mount; save via PUT on save button
  - `@dnd-kit` for section drag-and-drop reordering
  - **Install:** `cd apps/web && npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`

- [ ] **Task 7: Template Designer — Section Editors**
  - Implement section-editor.tsx with forms for each section type:
    - **Text:** Rich text content with variable tag insertion
    - **Table:** Data source selector, column editor (key, header, width, format, align, text transform, conditional rules), table settings (maxRowsPerPage, wrapText, borders, striped, font, fontSize, emptyValue)
    - **Chart:** Chart type selector, data series config, axis config, legend/grid toggles
    - **Key-Value:** Entries list with label, value (variable tag), format
    - **Signature:** Signer roles, labels, required flags, meaning text
    - **Page Break:** No config needed (just drag-and-drop placeholder)
  - Implement variable-tag-picker.tsx — browsable tag categories with click-to-insert
  - Implement conditional-rule-form.tsx — condition/value/style builder
  - Implement table-column-editor.tsx — full column config with conditional rules

- [ ] **Task 8: Template Designer — Header/Footer Editor**
  - Implement header-footer-editor.tsx
  - Element types: image (logo from branding config), text (with variable tags), spacer
  - Position: left, center, right
  - Style: fontSize, fontWeight, color
  - Height configuration
  - Toggle enabled/disabled

- [ ] **Task 9: Template Designer — Entity Slots**
  - Implement entity-slot-editor.tsx
  - Add/remove named slots with: name, label, type (asset_instance | equipment_group | uns_path)
  - Optional filters: templateFilter (for asset instances), pathPrefix (for UNS)
  - Slot names used as `$slotName` in variable tags
  - Validate that all `$slot` references in tags have matching slot definitions on save

### Phase C: Report Generation Engine (Tasks 10–13)

- [ ] **Task 10: Variable Resolver**
  - Create `apps/api/src/modules/reports/variable-resolver.ts`
  - Tag parser: extract `{{...}}` patterns, parse source/path/modifier
  - Entity slot resolution: `$slotName` → concrete entity ID from generation input
  - Create data source modules in `data-sources/`:
    - `attribute-source.ts` — query AssetInstance attributes by entity ID
    - `identifier-source.ts` — query AssetIdentifier by entity ID and type
    - `telemetry-source.ts` — query TimescaleDB: latest, aggregations (avg/min/max/sum/count over window), range series
    - `uns-source.ts` — resolve UNS paths with wildcard via UnsMapping table
    - `timestamp-source.ts` — time.now, time.range.start/end
    - `meta-source.ts` — report name, user name, org name from context
    - `calc-source.ts` — simple arithmetic expressions on resolved values
  - Batch queries by source type for efficiency (don't query one-by-one)
  - Return Map<string, ResolvedTag> with error handling for failed resolutions
  - **Critical:** Validate entity access within org scope — no cross-org data leaks

- [ ] **Task 11: HTML + Table + Chart Renderers**
  - Create Handlebars templates in `apps/api/src/modules/reports/templates/`:
    - `report-base.hbs` — full HTML page with header, footer, sections loop, print CSS
    - `section-table.hbs` — table partial with conditional formatting
    - `section-chart.hbs` — chart image embed
    - `section-text.hbs` — text with resolved variables
    - `section-kv.hbs` — key-value grid
    - `section-signature.hbs` — signature block (empty for DRAFT, filled for SIGNED)
    - `styles.css` — print stylesheet with page breaks, table pagination, fonts
  - Create `table-renderer.ts`:
    - Conditional rule evaluation (gt/lt/between/eq/contains/empty)
    - Value formatting (decimal places, datetime pattern, unit)
    - Text transform (uppercase/lowercase/capitalize)
    - Text wrapping CSS
    - Auto-pagination by maxRowsPerPage
    - Cross-column reference in conditions (valueRef: "column:threshold")
  - Create `chart-renderer.ts`:
    - chartjs-node-canvas rendering to base64 PNG
    - Support: line, bar, pie, scatter, area chart types
    - Time-series X axis, numeric Y axis
  - Create `html-renderer.ts`:
    - Orchestrate Handlebars compilation with all partials
    - Inject resolved variables, chart images, formatted tables
    - Apply header/footer on each page (CSS position: fixed + @page rules)

- [ ] **Task 12: PDF Generation Service**
  - Create `apps/api/src/modules/reports/service.ts`
  - generateReport() orchestration:
    1. Load template + latest active version
    2. Validate entity slots match template requirements
    3. Resolve all variable tags via VariableResolver
    4. Render charts via ChartRenderer
    5. Build HTML via HtmlRenderer
    6. Convert to PDF via PdfRenderer (Puppeteer)
    7. Store PDF to filesystem (configurable path from report-settings config)
    8. Create ReportInstance record with metadata
    9. Create audit trail entry
  - Handle errors gracefully — if a tag fails to resolve, render "ERROR: [tag]" in red
  - Add DRAFT watermark for unsigned reports
  - Queue-based generation for large reports (BullMQ)
  - **Pattern:** Follow filter-operations/service.ts for transaction-guarded state changes

- [ ] **Task 13: Report API Endpoints**
  - Create `apps/api/src/modules/reports/` — routes.ts, handlers.ts, schemas.ts
  - Endpoints:
    - `POST /api/reports/generate` — start generation (sync for small, async for large)
    - `GET /api/reports` — list with org scope, status filter, template filter, date filter, pagination
    - `GET /api/reports/:id` — get instance with signatures
    - `GET /api/reports/:id/pdf` — stream PDF file (Content-Type: application/pdf)
    - `GET /api/reports/:id/preview` — return rendered HTML for iframe preview
    - `DELETE /api/reports/:id` — delete instance + PDF file
    - `POST /api/reports/bulk-delete` — bulk delete
  - Register module in app.ts

### Phase D: Digital Signatures (Tasks 14–15)

- [ ] **Task 14: Signature Service**
  - Create `apps/api/src/modules/reports/signature-service.ts`
  - `POST /api/reports/:id/sign` — re-authenticate user (verify password), create ReportSignature record
  - `POST /api/reports/:id/reject` — reject report with reason, update status to REJECTED
  - Signature state machine:
    - DRAFT → PENDING_SIGNATURE (on generation if signatureConfig.required)
    - PENDING_SIGNATURE → SIGNED (when all required signers have signed)
    - PENDING_SIGNATURE → REJECTED (if any signer rejects)
    - Check signature expiry (expiresAt from config)
  - On all-signed: re-render PDF with filled signature blocks, remove DRAFT watermark
  - Create ElectronicSignature record (existing model) for 21 CFR Part 11 compliance
  - Audit trail for sign/reject actions
  - **Pattern:** Follow use-reauth.ts flow — password sent in X-Reauth-Password header

- [ ] **Task 15: Signature Frontend**
  - Create `apps/web/src/routes/reports/[id]/sign.tsx`
  - Show report preview (iframe) + signature panel
  - Signature dialog: re-authentication (password input), meaning display, sign/reject buttons
  - Use existing `use-reauth` hook for password verification
  - Show signature progress: which signers have signed, which are pending
  - After signing, redirect to report detail with updated status

### Phase E: Frontend Report Pages (Tasks 16–17)

- [ ] **Task 16: Report Generation Wizard**
  - Create `apps/web/src/routes/reports/generate.tsx`
  - 3-step wizard:
    1. Select template (card grid of ACTIVE templates)
    2. Fill entity slots (entity selector components per slot type)
    3. Select time range (date range picker) + generate button
  - Entity slot fillers:
    - `asset_instance` → searchable dropdown of asset instances (filtered by templateFilter if provided)
    - `equipment_group` → dropdown of equipment groups
    - `uns_path` → path browser with prefix filter
  - Loading state during generation
  - Navigate to report detail on success

- [ ] **Task 17: Report List + Detail Pages**
  - Create `apps/web/src/routes/reports/index.tsx` — list page
    - Table: Name, Template, Status (badge), Generated By, Generated At, Signed At, Actions
    - Filters: status, template, date range
    - Actions: View, Download PDF, Delete
  - Create `apps/web/src/routes/reports/[id]/index.tsx` — detail page
    - PDF viewer (iframe pointing to preview endpoint)
    - Metadata panel (template, version, time range, entity slots)
    - Signatures panel (signer role, name, timestamp, meaning)
    - Action buttons: Sign (if pending), Download PDF, Delete
  - Report status badges: DRAFT (yellow), PENDING_SIGNATURE (orange), SIGNED (green), REJECTED (red), EXPIRED (gray)

### Phase F: Polish & Integration (Task 18)

- [ ] **Task 18: Integration Testing + Polish**
  - End-to-end test: create template → generate report → sign → download PDF
  - Verify:
    - Variable tags resolve correctly for all data source types
    - Tables respect maxRowsPerPage, conditional formatting, decimal places, text transform
    - Charts render correctly in PDF
    - Digital signatures follow re-auth flow
    - Audit trail entries created for all mutations
    - Org scoping prevents cross-org access
    - PDF watermark appears for DRAFT, removed for SIGNED
    - Header/footer render on every page
  - Error handling: invalid tags show clear errors, missing entities handled gracefully
  - Performance: test with 50-page report, 10K telemetry rows in table
  - Add help articles for report templates and report generation

---

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| PDF Engine | Puppeteer (HTML → PDF) | Maximum flexibility for complex layouts, charts, conditional formatting; works with CSS print stylesheets |
| Chart Rendering | chartjs-node-canvas | Server-side Chart.js rendering; same library as frontend recharts data format |
| Template Engine | Handlebars | Simple, logic-less, partials support; good for HTML generation |
| Template Designer | Custom (no ReactFlow) | Report layout is linear (sections stacked), not a graph; drag-and-drop reorder with @dnd-kit is simpler |
| Storage | Local filesystem (dev), configurable path | Start simple; can migrate to S3 later via config |
| Async Generation | BullMQ queue | Consistent with existing queue infrastructure; prevents long HTTP timeouts for big reports |
| Variable Tag Syntax | `{{source.path[modifier]}}` | Familiar Handlebars-like syntax; clear source/path separation; modifiers for aggregation |

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Puppeteer memory on EC2 | Set `--disable-dev-shm-usage` flag; limit concurrent generations via BullMQ |
| Slow telemetry queries for large ranges | Use TimescaleDB continuous aggregates; limit maxTelemetryRowsPerTable in config |
| Cross-org data leak in variables | All data source queries include `orgId` filter; validate entity ownership before resolution |
| Template config schema evolution | Versioned templates — old versions preserved; migration utilities if schema changes |
| PDF generation timeouts | BullMQ with configurable timeout; return job ID for async polling |

---

## Files to Create (Summary)

### Backend (~25 files)
```
apps/api/src/modules/report-templates/routes.ts
apps/api/src/modules/report-templates/handlers.ts
apps/api/src/modules/report-templates/service.ts
apps/api/src/modules/report-templates/schemas.ts
apps/api/src/modules/report-templates/types.ts
apps/api/src/modules/reports/routes.ts
apps/api/src/modules/reports/handlers.ts
apps/api/src/modules/reports/service.ts
apps/api/src/modules/reports/schemas.ts
apps/api/src/modules/reports/types.ts
apps/api/src/modules/reports/variable-resolver.ts
apps/api/src/modules/reports/signature-service.ts
apps/api/src/modules/reports/report-queue.ts
apps/api/src/modules/reports/data-sources/attribute-source.ts
apps/api/src/modules/reports/data-sources/identifier-source.ts
apps/api/src/modules/reports/data-sources/telemetry-source.ts
apps/api/src/modules/reports/data-sources/uns-source.ts
apps/api/src/modules/reports/data-sources/timestamp-source.ts
apps/api/src/modules/reports/data-sources/meta-source.ts
apps/api/src/modules/reports/data-sources/calc-source.ts
apps/api/src/modules/reports/renderers/html-renderer.ts
apps/api/src/modules/reports/renderers/pdf-renderer.ts
apps/api/src/modules/reports/renderers/chart-renderer.ts
apps/api/src/modules/reports/renderers/table-renderer.ts
apps/api/src/modules/reports/templates/report-base.hbs
apps/api/src/modules/reports/templates/section-*.hbs (5 partials)
apps/api/src/modules/reports/templates/styles.css
apps/api/src/modules/config/definitions/report-settings.def.ts
```

### Frontend (~20 files)
```
apps/web/src/routes/report-templates/index.tsx
apps/web/src/routes/report-templates/[id]/edit.tsx
apps/web/src/routes/report-templates/components/template-designer.tsx
apps/web/src/routes/report-templates/components/section-palette.tsx
apps/web/src/routes/report-templates/components/section-editor.tsx
apps/web/src/routes/report-templates/components/header-footer-editor.tsx
apps/web/src/routes/report-templates/components/variable-tag-picker.tsx
apps/web/src/routes/report-templates/components/table-column-editor.tsx
apps/web/src/routes/report-templates/components/chart-config-editor.tsx
apps/web/src/routes/report-templates/components/entity-slot-editor.tsx
apps/web/src/routes/report-templates/components/signature-config.tsx
apps/web/src/routes/report-templates/components/conditional-rule-form.tsx
apps/web/src/routes/reports/index.tsx
apps/web/src/routes/reports/generate.tsx
apps/web/src/routes/reports/[id]/index.tsx
apps/web/src/routes/reports/[id]/sign.tsx
apps/web/src/routes/reports/components/report-list-table.tsx
apps/web/src/routes/reports/components/generation-wizard.tsx
apps/web/src/routes/reports/components/entity-slot-filler.tsx
apps/web/src/routes/reports/components/report-status-badge.tsx
apps/web/src/routes/reports/components/signature-dialog.tsx
```

### Schema & Config (~3 files)
```
apps/api/prisma/schema.prisma (modify — add 4 models, 2 enums)
packages/shared/src/permissions.ts (modify — add 9 permissions)
apps/api/prisma/seed.ts (modify — add permissions to roles)
```
