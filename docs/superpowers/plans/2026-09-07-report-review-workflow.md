# Report Review Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every PDF download becomes a review request; an approver signs it from a new Reports page; the requester and approver then download the approved document carrying both electronic signatures.

**Architecture:** The browser renders the report exactly as today but, instead of saving it, captures a complete snapshot of every drawing call and posts it with the request. A new `report-reviews` API module stores the snapshot as the record, scopes every read to the parties, enforces one PENDING → APPROVED | REJECTED transition, and audits each step. The Reports page replays the snapshot through the one shared renderer as a watermarked DRAFT or, once approved, with the two signature lines.

**Tech Stack:** Fastify 5 + Prisma 6 + PostgreSQL (api), React 19 + SWR + jsPDF/autotable (web), vitest everywhere. Windows dev box — see the Global Constraints.

**Spec:** `docs/superpowers/specs/2026-09-07-report-review-workflow-design.md`

## Global Constraints

- Run every vitest file INDIVIDUALLY with `--pool=forks --poolOptions.forks.singleFork=true` and judge by EXIT CODE; the whole `apps/web` suite manufactures failures (root `CLAUDE.md`, memory).
- `npx tsc --noEmit -p tsconfig.json` in `apps/web` AND `apps/api` after every task — vitest does not typecheck.
- Run `npm run build -w @digilog/shared` after any `packages/shared` change; the web app consumes the built `dist`.
- Source files are CRLF; edit with the Edit tool or a CRLF-aware script, never a bash heredoc with backslashes.
- Migrations are HAND-AUTHORED and applied to BOTH `compliance_core_db` and `compliance_core_db_test` (`DATABASE_URL=… npx prisma migrate deploy --schema apps/api/prisma/schema.prisma`, run from `apps/api`). Never paste `prisma migrate diff` output — it emits `DROP TABLE "instrument_telemetry_history"`.
- `prisma generate` needs the API's three `tsx watch` processes stopped and a DETACHED restart (memory `windows-tooling-gotchas`). Leave Vite alone.
- A new API module is registered in `apps/api/src/app.ts` AND `apps/api/src/e2e/test-helper.ts` in the same commit.
- Every count quoted in a doc is re-derived by the command beside it in root `CLAUDE.md`. Counts that move here: models 35 → 36, enums 12 → 13, modules 24 → 25, permissions 42 → 44, reauth actions 48 → 50 (categories 8), audit actions 98 → 102, templates 92 → 96 (categories 7), sidebar items 13 → 14, routes 51 → 52, tree groups 12 → 13, nodes 53 → 55, feature privileges 41 → 43.
- Commit after each task; push to `data-layer` only. Commit trailer:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_016qBNUfkk2N7codNnf4rsrh`.
- Nothing is seen on screen by the implementer: the operator holds the browser session. Render sample PDFs to the scratchpad and Read them back instead.

---

## File map

| File | Responsibility |
|---|---|
| `packages/shared/src/types/permissions.ts` | +`REPORT_REVIEW_READ`, `REPORT_REVIEW_APPROVE` |
| `packages/shared/src/types/reauth-actions.ts` | +`APPROVE_REPORT`, `REJECT_REPORT` (category Reports) |
| `packages/shared/src/types/audit-actions.ts`, `audit-templates.ts` | +4 actions / templates |
| `packages/shared/src/types/permission-tree.ts` | group `reports` (nodes `reports.view`, `reports.approve`), order list |
| `packages/shared/src/types/__snapshots__/legacy-maps-snapshot.ts` | appended entries |
| `packages/shared/src/types/sidebar-items.ts` | +`reports` |
| `apps/api/prisma/schema.prisma` + `migrations/20260907120000_report_reviews/` | enum + model |
| `apps/api/src/modules/report-reviews/service.ts` | pure rules (party scope, decision), DB access, audit, notifications |
| `apps/api/src/modules/report-reviews/routes.ts` | the six routes |
| `apps/api/src/e2e/report-reviews.e2e.test.ts` | HTTP-level coverage |
| `apps/web/src/lib/pdf-report.ts` | snapshot v2: records notes, images, titles, page breaks; `renderSnapshotToPdf` with `draft` / `signatures` |
| `apps/web/src/lib/report-review.ts` | client for the six routes + `openDraft` / `downloadApproved` |
| `apps/web/src/components/report-download-dialog.tsx` | +Send to (user or role) |
| `apps/web/src/components/assignee-picker.tsx` | the user-or-role control, lifted from `SendForReviewButton` (which is deleted) |
| `apps/web/src/routes/instruments/trend.tsx`, `trend-report.ts`, `routes/data-report/generate-report-card.tsx`, `routes/alarms/index.tsx`, `routes/audit/index.tsx` | download → request |
| `apps/web/src/routes/reports/index.tsx` (+ `decision-dialog.tsx`) | the Reports page |
| `apps/web/src/main.tsx`, `components/layout/sidebar.tsx` | route + nav item |
| Docs: root `CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/index.md`, `packages/shared/CLAUDE.md`, `apps/web/CLAUDE.md`, `apps/api/CLAUDE.md`, `CHANGELOG.md`, `tasks/todo.md` | counts + narrative |

---

### Task 1: Shared registries — permissions, re-auth actions, audit actions, permission tree

**Files:**
- Modify: `packages/shared/src/types/permissions.ts`
- Modify: `packages/shared/src/types/reauth-actions.ts:116`
- Modify: `packages/shared/src/types/audit-actions.ts:140`, `audit-templates.ts:196`
- Modify: `packages/shared/src/types/permission-tree.ts` (after the `data-report` group; `CONFIGURABLE_PRIVILEGE_ORDER`)
- Modify: `packages/shared/src/types/__snapshots__/legacy-maps-snapshot.ts` (append)
- Test: `packages/shared/src/types/permission-tree.test.ts`, `legacy-maps-derived.test.ts`

**Interfaces:**
- Produces: `PERMISSIONS.REPORT_REVIEW_READ`, `PERMISSIONS.REPORT_REVIEW_APPROVE`; reauth actions `APPROVE_REPORT`, `REJECT_REPORT`; audit actions `REPORT_REVIEW_REQUESTED`, `REPORT_REVIEW_APPROVED`, `REPORT_REVIEW_REJECTED`, `REPORT_DOWNLOADED`; tree nodes `reports.view`, `reports.approve`.

- [ ] **Step 1: Write the failing tests** — append to `permission-tree.test.ts`:

```ts
describe('reports group (2026-09-07)', () => {
  const group = PERMISSION_TREE.find((g) => g.sidebarId === 'reports');
  it('has a View node gated on REPORT_REVIEW_READ and an Approve node gated on REPORT_REVIEW_APPROVE with the APPROVE_REPORT re-auth', () => {
    expect(group).toBeTruthy();
    expect(group!.nodes.map((n) => n.id)).toEqual(['reports.view', 'reports.approve']);
    expect(resolveNodeGate('reports.view')).toEqual([PERMISSIONS.REPORT_REVIEW_READ]);
    expect(resolveNodeGate('reports.approve')).toEqual([PERMISSIONS.REPORT_REVIEW_APPROVE]);
    expect(group!.nodes[1].reauthAction).toBe('APPROVE_REPORT');
    expect(group!.visibilityPrivilegeIds).toEqual(['reports.view', 'reports.approve']);
  });
});
```
In `legacy-maps-derived.test.ts` change the pinned counts: configurable nodes 41 → 43, `FEATURE_PRIVILEGES` 43, `FEATURE_TO_PERMISSION_MAP` 43, `SIDEBAR_PRIVILEGE_MAP` 13 (with a comment: 2026-09-07 report review, 13th group `reports`, 2 nodes). Append to the three snapshot literals: `{ id: 'reports.view', label: 'View Reports', category: 'Reports', icon: 'file-text' }`, `{ id: 'reports.approve', label: 'Approve / Reject Reports', category: 'Reports', icon: 'check' }`; `'reports.view': ['REPORT_REVIEW_READ']`, `'reports.approve': ['REPORT_REVIEW_APPROVE', 'REPORT_REVIEW_READ']`; section `{ sidebarId: 'reports', label: 'Reports', icon: '📑', description: 'Report requests awaiting approval, and approved reports to download', privilegeIds: ['reports.view', 'reports.approve'] }`.

- [ ] **Step 2: Run to verify RED** — `cd packages/shared && npx vitest run src/types/permission-tree.test.ts src/types/legacy-maps-derived.test.ts --pool=forks --poolOptions.forks.singleFork=true` → the new describe and the three count cases fail.

- [ ] **Step 3: Implement**
  - `permissions.ts`: under a `// Reports (2026-09-07)` comment add `REPORT_REVIEW_READ: 'REPORT_REVIEW_READ', REPORT_REVIEW_APPROVE: 'REPORT_REVIEW_APPROVE',`.
  - `reauth-actions.ts` after `DOWNLOAD_REPORT`: `APPROVE_REPORT: { label: 'Approve a Report Request', category: 'Reports' }, REJECT_REPORT: { label: 'Reject a Report Request', category: 'Reports' },`.
  - `audit-actions.ts` after `REPORT_GENERATED`: the four actions. `audit-templates.ts` after `REPORT_GENERATED`, same category `'Data & Approvals'`, placeholders `['actor', 'targetType']` ONLY (generic — no `audit-helpers.ts` substitution needed): templates `'{targetType} report requested for approval by {actor}'`, `'{targetType} report approved by {actor}'`, `'{targetType} report rejected by {actor}'`, `'{targetType} report downloaded by {actor}'`. `targetType` will carry the report's `reportType`, as `REPORT_GENERATED` does.
  - `permission-tree.ts`: append the group after `data-report`:
```ts
  // ---- Reports (2026-09-07) ----
  // Every PDF download is a REQUEST; an approver signs it here. See
  // docs/superpowers/specs/2026-09-07-report-review-workflow-design.md.
  {
    sidebarId: 'reports', label: 'Reports', icon: '📑',
    description: 'Report requests awaiting approval, and approved reports to download',
    visibilityPrivilegeIds: ['reports.view', 'reports.approve'],
    nodes: [
      { id: 'reports.view', label: 'View Reports', sidebarId: 'reports', page: 'Reports', action: 'View',
        icon: 'file-text', category: 'Reports', permissions: ['REPORT_REVIEW_READ'], enforce: 'a',
        gate: ['REPORT_REVIEW_READ'], configurable: true },
      { id: 'reports.approve', label: 'Approve / Reject Reports', sidebarId: 'reports', page: 'Reports', action: 'Approve',
        icon: 'check', category: 'Reports', permissions: ['REPORT_REVIEW_APPROVE', 'REPORT_REVIEW_READ'], enforce: 'a',
        gate: ['REPORT_REVIEW_APPROVE'], reauthAction: 'APPROVE_REPORT', configurable: true },
    ],
  },
```
  and append `'reports.view', 'reports.approve',` to `CONFIGURABLE_PRIVILEGE_ORDER`.

- [ ] **Step 4: Run to verify GREEN** — the two files, then the whole shared suite (`npx vitest run --pool=forks --poolOptions.forks.singleFork=true` in `packages/shared`), then `npx tsc --noEmit -p tsconfig.json`, then `npm run build -w @digilog/shared` from the repo root.

- [ ] **Step 5: Commit** — `git add packages/shared && git commit -m "feat(shared): report review permissions, re-auth actions, audit actions and tree group"`.

---

### Task 2: Data model and migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (enum after `AlarmSource`; model after `AlarmWebhookDelivery`)
- Create: `apps/api/prisma/migrations/20260907120000_report_reviews/migration.sql`

**Interfaces:**
- Produces: `prisma.reportReview` with the columns below; `ReportReviewStatus` enum.

- [ ] **Step 1: Schema**

```prisma
enum ReportReviewStatus {
  PENDING
  APPROVED
  REJECTED

  @@map("report_review_status")
}

/// A report REQUEST: the frozen document (data_snapshot) plus who asked,
/// who was asked, and who decided. One transition only: PENDING -> APPROVED | REJECTED.
/// Never deleted — a §11 record. Design: docs/superpowers/specs/2026-09-07-report-review-workflow-design.md
model ReportReview {
  id              String             @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  reportType      String             @map("report_type") @db.VarChar(100)
  title           String             @db.VarChar(500)
  subtitle        String?            @db.VarChar(1000)
  requestMeta     Json               @map("request_meta") @db.JsonB
  dataSnapshot    Json               @map("data_snapshot") @db.JsonB
  status          ReportReviewStatus @default(PENDING)

  requestedBy     String             @map("requested_by") @db.Uuid
  requestedByName String             @map("requested_by_name") @db.VarChar(255)
  requestedAt     DateTime           @default(now()) @map("requested_at") @db.Timestamptz
  requestRemarks  String             @map("request_remarks") @db.Text

  assigneeUserId  String?            @map("assignee_user_id") @db.Uuid
  assigneeRole    String?            @map("assignee_role") @db.VarChar(50)

  decidedBy       String?            @map("decided_by") @db.Uuid
  decidedByName   String?            @map("decided_by_name") @db.VarChar(255)
  decidedAt       DateTime?          @map("decided_at") @db.Timestamptz
  decisionRemarks String?            @map("decision_remarks") @db.Text

  createdAt       DateTime           @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime           @updatedAt @map("updated_at") @db.Timestamptz

  @@index([status, assigneeUserId])
  @@index([status, assigneeRole])
  @@index([requestedBy, createdAt])
  @@map("report_reviews")
}
```

- [ ] **Step 2: Migration** (hand-authored; header comment in the repo's style noting the stripped `DROP TABLE "instrument_telemetry_history"`):

```sql
CREATE TYPE "report_review_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "report_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "report_type" VARCHAR(100) NOT NULL,
  "title" VARCHAR(500) NOT NULL,
  "subtitle" VARCHAR(1000),
  "request_meta" JSONB NOT NULL,
  "data_snapshot" JSONB NOT NULL,
  "status" "report_review_status" NOT NULL DEFAULT 'PENDING',
  "requested_by" UUID NOT NULL,
  "requested_by_name" VARCHAR(255) NOT NULL,
  "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "request_remarks" TEXT NOT NULL,
  "assignee_user_id" UUID,
  "assignee_role" VARCHAR(50),
  "decided_by" UUID,
  "decided_by_name" VARCHAR(255),
  "decided_at" TIMESTAMPTZ,
  "decision_remarks" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "report_reviews_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "report_reviews_status_assignee_user_id_idx" ON "report_reviews"("status", "assignee_user_id");
CREATE INDEX "report_reviews_status_assignee_role_idx" ON "report_reviews"("status", "assignee_role");
CREATE INDEX "report_reviews_requested_by_created_at_idx" ON "report_reviews"("requested_by", "created_at");
```

- [ ] **Step 3: Apply to both databases** (from `apps/api`, `DATABASE_URL` explicit for each), then stop the three API processes, `npx prisma generate --schema prisma/schema.prisma`, restart detached, confirm `curl -sk --ssl-revoke-best-effort https://localhost:3001/api/health` → 200. Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-migrations.ps1` (drift guard PASS). `grep -cE "^model "` → 36, `"^enum "` → 13.

- [ ] **Step 4: Commit** — `feat(db): report_reviews table and ReportReviewStatus enum`.

---

### Task 3: API service — pure rules first

**Files:**
- Create: `apps/api/src/modules/report-reviews/service.ts`
- Test: `apps/api/src/modules/report-reviews/__tests__/service.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ReviewParties { requestedBy: string; assigneeUserId: string | null; assigneeRole: string | null; decidedBy: string | null }
export function isParty(ctx: { userSub: string; userRole: string }, row: ReviewParties): boolean
export function isAssignee(ctx: { userSub: string; userRole: string }, row: ReviewParties): boolean
export function requireOneAssignee(userId?: string, role?: string): { assigneeUserId: string | null; assigneeRole: string | null }  // throws AppError 400 ASSIGNEE_REQUIRED / ASSIGNEE_AMBIGUOUS
export const reportReviewService: {
  submit(ctx: RequestContext, input: SubmitInput): Promise<ReviewSummary>;
  list(ctx: RequestContext, list: 'queue'|'mine'|'approved', page: number, pageSize: number): Promise<{ data: ReviewSummary[]; total: number }>;
  getForParty(ctx: RequestContext, id: string): Promise<ReviewFull | null>;   // null = not found OR not a party
  decide(ctx: RequestContext, id: string, decision: 'APPROVED'|'REJECTED', remarks: string): Promise<ReviewSummary>; // throws 404 / 403 NOT_ASSIGNEE / 403 SELF_APPROVAL / 409 ALREADY_DECIDED
  logDownload(ctx: RequestContext, id: string): Promise<void>;                // throws 404 / 409 NOT_APPROVED
}
```

- [ ] **Step 1: Failing unit tests** (pure functions; no DB):

```ts
import { describe, it, expect } from 'vitest';
import { isParty, isAssignee, requireOneAssignee } from '../service.js';
const row = { requestedBy: 'u-req', assigneeUserId: 'u-appr', assigneeRole: null, decidedBy: null };
describe('isParty', () => {
  it('admits requester, assignee user, a holder of the assignee role, the decider, and SUPER_ADMIN', () => {
    expect(isParty({ userSub: 'u-req', userRole: 'OPERATOR' }, row)).toBe(true);
    expect(isParty({ userSub: 'u-appr', userRole: 'OPERATOR' }, row)).toBe(true);
    expect(isParty({ userSub: 'x', userRole: 'QA' }, { ...row, assigneeUserId: null, assigneeRole: 'QA' })).toBe(true);
    expect(isParty({ userSub: 'u-dec', userRole: 'OPERATOR' }, { ...row, decidedBy: 'u-dec' })).toBe(true);
    expect(isParty({ userSub: 'x', userRole: 'SUPER_ADMIN' }, row)).toBe(true);
    expect(isParty({ userSub: 'x', userRole: 'OPERATOR' }, row)).toBe(false);
  });
});
describe('isAssignee', () => {
  it('is the user, or a holder of the role, or SUPER_ADMIN — never the requester by virtue of requesting', () => {
    expect(isAssignee({ userSub: 'u-appr', userRole: 'OPERATOR' }, row)).toBe(true);
    expect(isAssignee({ userSub: 'u-req', userRole: 'OPERATOR' }, row)).toBe(false);
    expect(isAssignee({ userSub: 'x', userRole: 'QA' }, { ...row, assigneeUserId: null, assigneeRole: 'QA' })).toBe(true);
    expect(isAssignee({ userSub: 'x', userRole: 'SUPER_ADMIN' }, row)).toBe(true);
  });
});
describe('requireOneAssignee', () => {
  it('needs exactly one of user or role', () => {
    expect(requireOneAssignee('u1', undefined)).toEqual({ assigneeUserId: 'u1', assigneeRole: null });
    expect(requireOneAssignee(undefined, 'QA')).toEqual({ assigneeUserId: null, assigneeRole: 'QA' });
    expect(() => requireOneAssignee(undefined, undefined)).toThrow(/ASSIGNEE_REQUIRED|user or a role/);
    expect(() => requireOneAssignee('u1', 'QA')).toThrow(/ASSIGNEE_AMBIGUOUS|not both/);
  });
});
```

- [ ] **Step 2: RED** — `cd apps/api && npx vitest run src/modules/report-reviews/__tests__/service.test.ts --pool=forks --poolOptions.forks.singleFork=true` → module not found.

- [ ] **Step 3: Implement `service.ts`** — the pure functions above plus the service object. Key bodies:

```ts
const SUMMARY_SELECT = { id: true, reportType: true, title: true, subtitle: true, requestMeta: true, status: true,
  requestedBy: true, requestedByName: true, requestedAt: true, requestRemarks: true,
  assigneeUserId: true, assigneeRole: true, decidedBy: true, decidedByName: true, decidedAt: true, decisionRemarks: true, createdAt: true } as const;

async submit(ctx, input) {
  const assignee = requireOneAssignee(input.assigneeUserId, input.assigneeRole);
  if (assignee.assigneeUserId) {
    const u = await prisma.user.findFirst({ where: { id: assignee.assigneeUserId, status: 'ENABLED' }, select: { id: true } });
    if (!u) throw new AppError(400, 'ASSIGNEE_NOT_FOUND', 'That user does not exist or is not active.');
    if (u.id === ctx.userSub) throw new AppError(400, 'SELF_ASSIGNMENT', 'A report cannot be sent to yourself for approval.');
  } else {
    const r = await prisma.role.findFirst({ where: { name: assignee.assigneeRole!, isActive: true }, select: { name: true } });
    if (!r) throw new AppError(400, 'ASSIGNEE_NOT_FOUND', 'That role does not exist or is not active.');
  }
  const row = await prisma.reportReview.create({ data: { reportType: input.reportType.slice(0, 100), title: input.title.slice(0, 500),
    subtitle: input.subtitle?.slice(0, 1000) ?? null, requestMeta: input.requestMeta as Prisma.InputJsonValue,
    dataSnapshot: input.dataSnapshot as Prisma.InputJsonValue, requestedBy: ctx.userSub, requestedByName: ctx.userId,
    requestRemarks: input.remarks, ...assignee }, select: SUMMARY_SELECT });
  await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'REPORT_REVIEW_REQUESTED', targetType: row.reportType, targetId: row.id,
    afterValue: { title: row.title, requestMeta: row.requestMeta, assignee, remarks: input.remarks },
    reason: input.remarks,
    signatureMeaning: clampSignature(`${ctx.userId} requested approval of the ${row.reportType} report "${row.title}" from ${assignee.assigneeUserId ? 'user ' + assignee.assigneeUserId : 'role ' + assignee.assigneeRole}`),
    ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId });
  await notify(row, 'REPORT_REVIEW_REQUESTED', 'Report awaiting your approval', `"${row.title}" was sent to you for approval by ${ctx.userId}.`, ctx.userId, 'assignee');
  return row;
}
```
  `decide()` uses `prisma.reportReview.findUnique` → 404 `NOT_FOUND` if missing or `!isParty`; `if (row.requestedBy === ctx.userSub) throw new AppError(403, 'SELF_APPROVAL', 'You cannot decide on your own request.')` (BEFORE the SUPER_ADMIN assignee bypass — separation of duties applies to everyone); `if (!isAssignee(ctx, row)) throw new AppError(403, 'NOT_ASSIGNEE', …)`; then `const { count } = await prisma.reportReview.updateMany({ where: { id, status: 'PENDING' }, data: { status: decision, decidedBy: ctx.userSub, decidedByName: ctx.userId, decidedAt: new Date(), decisionRemarks: remarks } }); if (count === 0) throw new AppError(409, 'ALREADY_DECIDED', 'This request has already been decided.');` then re-read, audit (`REPORT_REVIEW_APPROVED` / `REJECTED`, `reason: remarks`), notify the requester (`forUserId: row.requestedByName`). `logDownload()`: 404 unless found and party; 409 `NOT_APPROVED` unless APPROVED; audit `REPORT_DOWNLOADED` with `afterValue: { signatures: [{ label: 'Requested By', name: row.requestedByName, at: row.requestedAt }, { label: 'Approved By', name: row.decidedByName, at: row.decidedAt }] }`. `list()`: `queue` → `{ status: 'PENDING', OR: [{ assigneeUserId: ctx.userSub }, { assigneeRole: ctx.userRole }] }` (SUPER_ADMIN: `{ status: 'PENDING' }`); `mine` → `{ requestedBy: ctx.userSub }`; `approved` → `{ status: 'APPROVED', OR: [{ requestedBy }, { decidedBy }, { assigneeUserId }, { assigneeRole }] }` (SUPER_ADMIN: `{ status: 'APPROVED' }`); `findMany` + `count` in a `$transaction`, `orderBy: { createdAt: 'desc' }`, `skip/take`. `clampSignature` is imported from `../alarms/validation.js` (it exists; 255-char clamp).
  Notifications: copy `notifyAssignee` / `notifySubmitter` from the removed module (`git show pre-domain-strip:apps/api/src/modules/report-reviews/service.ts`), best-effort with a `console.error`, `createNotification({ type, title, message, forUserId | forRole, metadata: { reportReviewId, reportType }, createdBy })`.

- [ ] **Step 4: GREEN** — same command; `npx tsc --noEmit -p tsconfig.json`.
- [ ] **Step 5: Commit** — `feat(api): report-reviews service — party scoping, single decision, audit and notifications`.

---

### Task 4: API routes, registration, e2e

**Files:**
- Create: `apps/api/src/modules/report-reviews/routes.ts`
- Modify: `apps/api/src/app.ts` (import + `await app.register(reportReviewRoutes, { prefix: '/api/report-reviews' })` beside `alarmWebhookRoutes`), `apps/api/src/e2e/test-helper.ts` (same)
- Test: `apps/api/src/e2e/report-reviews.e2e.test.ts`

**Interfaces:**
- Produces the six routes of the spec, response bodies `{ data: ReviewSummary[], total }` for the list and the summary/full object otherwise. `ReviewFull = ReviewSummary & { dataSnapshot: unknown }`.

- [ ] **Step 1: Failing e2e** — shape after `alarm-webhooks.test.ts`: `buildApp()`, `loginAs(app)` for SUPER_ADMIN plus two created users (`requester`, role `OPERATOR` with `['REPORT_REVIEW_READ','INSTRUMENT_READ']`; `approver`, role `QA_APPROVER` with `['REPORT_REVIEW_READ','REPORT_REVIEW_APPROVE']`) created directly with `prisma.role.create` / `prisma.user.create` (hash via `hashPassword`) and `invalidateRolePermsCache()`; reauth header `x-reauth-password`. A minimal snapshot fixture: `{ version: 2, reportType: 'Instrument Time Series', title: 'T', config: {}, sections: [{ kind: 'table', head: ['A'], body: [['1']] }] }`. Cases, each asserted over `app.inject` status AND body:
  1. submit to user → 201, `status: 'PENDING'`, `assigneeUserId`; an `audit_trail` row `REPORT_REVIEW_REQUESTED` with `target_id` = the id; a `notifications` row `REPORT_REVIEW_REQUESTED` for the approver's username.
  2. submit to role → 201; notification `for_role` = the role.
  3. submit with neither / both assignees → 400; blank remarks → 400; wrong reauth password → 401; to yourself → 400 `SELF_ASSIGNMENT`.
  4. `GET /?list=queue` as approver lists it; as requester does not; as SUPER_ADMIN lists it.
  5. `GET /?list=mine` as requester lists it; as approver does not.
  6. `GET /:id` as a third user with `REPORT_REVIEW_READ` → 404; as approver → 200 with `dataSnapshot`.
  7. approve as requester → 403 `SELF_APPROVAL`; as third user → 403 `NOT_ASSIGNEE` (or 404 — pick 404 to match `getForParty`; the test asserts 404); as approver without password → 401; with password + remarks → 200 `status: 'APPROVED'`, `decidedByName`; audit `REPORT_REVIEW_APPROVED`; notification to requester.
  8. approve again → 409 `ALREADY_DECIDED`; reject an approved one → 409.
  9. reject flow on a second request → `REJECTED` + audit `REPORT_REVIEW_REJECTED`.
  10. `GET /?list=approved` as requester and approver lists the approved one; a third user gets `total: 0`.
  11. `POST /:id/download-log` as requester → 200 and audit `REPORT_DOWNLOADED`; as third user → 404; on the rejected one → 409.
  12. `DELETE /:id` → 404 (no such route).
  `afterAll`: delete the created rows (`report_reviews`, `notifications` for those users, the two users and roles). Audit rows are NEVER deleted (immutability trigger).

- [ ] **Step 2: RED** — `npx vitest run src/e2e/report-reviews.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true` → 404s.

- [ ] **Step 3: Implement `routes.ts`** — Fastify plugin, `preHandler: [app.requirePermission('REPORT_REVIEW_READ')]` on all, `REPORT_REVIEW_APPROVE` on approve/reject. Body schemas with `required`, `remarks` `{ type: 'string', minLength: 1, maxLength: 500 }` and a server-side `trim()` check (the `report-export-log` precedent), `dataSnapshot: { type: 'object' }`, `requestMeta: { type: 'object', additionalProperties: true }`, `bodyLimit: 8 * 1024 * 1024` on `POST /`. Re-auth: `const { ok } = await enforceReauth('DOWNLOAD_REPORT', req, reply); if (!ok) return;` on submit; `'APPROVE_REPORT'` / `'REJECT_REPORT'` on the decisions. `sanitizeStrings(body, ['remarks'])` — remarks exempt like every free-text reason. Response schemas DECLARE every field (Fastify strips undeclared ones — the repo's recurring trap); `requestMeta` and `dataSnapshot` as `{ type: 'object', additionalProperties: true }`. Errors through `AppError` → the app's error handler maps `status`/`code`.

- [ ] **Step 4: Register** in `app.ts` and `test-helper.ts`; GREEN; `tsc`; also re-run `src/e2e/audit-export-log.test.ts` (unchanged route, sanity).
- [ ] **Step 5: Commit** — `feat(api): /api/report-reviews — submit, list, get, approve, reject, download-log`.

---

### Task 5: Snapshot v2 — the renderer records everything it draws, and replays it

**Files:**
- Modify: `apps/web/src/lib/pdf-report.ts` (`ReportSnapshot`, `SnapshotSection`, `createReport` recording, `renderSnapshotToPdf`)
- Modify: `apps/web/src/routes/instruments/trend-report.ts` (use `report.addNote` / `report.addImage`; delete the local `addNote` / the direct `doc.addImage`)
- Test: `apps/web/src/lib/__tests__/pdf-report-snapshot.test.ts`; existing `trend-report-chart.test.ts` must stay green.

**Interfaces:**
- Produces:
```ts
export type SnapshotSection =
  | { kind: 'table'; title?: string; head: string[]; body: TableCell[][]; columnStyles?: Record<number, any>; bold?: boolean[][] }
  | { kind: 'pairs'; title?: string; pairs: [string, string][]; columns?: number }
  | { kind: 'title'; text: string }
  | { kind: 'note'; text: string; color: 'red' | 'muted' | 'text' }
  | { kind: 'image'; dataUrl: string; widthMm: number; heightMm: number }
  | { kind: 'page-break' };
export interface ReportSnapshot { version: 2; reportType: string; title: string; subtitle?: string; orientation?: 'portrait'|'landscape';
  config: { legend?: ReportConfig['legend']; typography?: ReportConfig['typography']; showAppName?: boolean }; sections: SnapshotSection[] }
export interface ReportDoc { …existing…; addNote: (text: string, color?: 'red'|'muted'|'text') => void; addImage: (dataUrl: string, widthMm: number, heightMm: number) => void }
export async function renderSnapshotToPdf(snapshot: ReportSnapshot, opts: { formatDateTime: (d: string) => string; signatures?: { label: string; value: string }[]; draft?: boolean }): Promise<ReportDoc>  // returns the doc; caller saves or opens
export function normaliseSnapshot(v: unknown): ReportSnapshot  // throws on anything but version 2
```
  `createReport` gains `draft?: boolean` in `ReportConfig`: when true, after `addFooters()` every page gets `DRAFT — NOT APPROVED` at 48pt, light grey (`[200,200,200]`), rotated 35°, centred (`doc.text(text, pw/2, ph/2, { align: 'center', angle: 35 })`), and NO signature lines (`sigLines = []`).
  Signature lines when `signatures` is set are printed one per line as `${label}: ${value}` (unchanged), so the caller formats `value` as `<name> (<user id>) — <date-time>`.

- [ ] **Step 1: Failing tests** (`pdf-report-snapshot.test.ts`, mocking `@/lib/api-client` like `pdf-report-span.test.ts`):
  - builds a report with a title, a table with a span and a bold cell, a note, a 1×1 PNG data URL image, a page break, a pairs block; `getSnapshot()` has the six kinds in order with `version: 2` and the config (legend, typography, showAppName);
  - `renderSnapshotToPdf(snapshot, { formatDateTime })` produces the same `getNumberOfPages()`, the same `lastAutoTable` body cell texts and `fontStyle`, and calls `addImage` once with the same data URL (spy `jspdf.default.API.addImage`);
  - `draft: true` → text `DRAFT` appears on every page (pdf text extraction per page via `doc.internal.pages`, the `history-widget` test's technique) and no `Requested By`; `signatures: [{label:'Requested By', value:'x'}]` without draft → `Requested By: x` present and no `DRAFT`;
  - `normaliseSnapshot({ version: 1 })` throws; a version-2 object round-trips.

- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** Record in `addSectionTitle` (`{kind:'title'}` — but `addTable` today consumes `pendingTitle` into the table section; keep that: a title followed by a table stays on the table, a title followed by anything else is recorded as its own `title` section), `addNote`, `addImage`, `newPage` (`{kind:'page-break'}`), `addTable` (`kind:'table'`, with `bold`), `addKeyValue` (`kind:'pairs'`). `getSnapshot()` returns `{ version: 2, reportType: config.reportKey ?? '', title, subtitle, orientation, config: { legend, typography, showAppName }, sections }`. `renderSnapshotToPdf` = `createReport({ ...snapshot.config, title, subtitle, orientation, reportKey: snapshot.reportType, formatDateTime, signatures, draft })` then a `switch (s.kind)` replay. Move `addNote` into `ReportDoc` (same body; colours by name from `COLORS`) and add `addImage` (the `addChart` body: `checkPageBreak(h + 4); doc.addImage(...); y += h + 6`). `trend-report.ts` calls `report.addNote(text, 'red' | 'muted')` and `report.addImage(section.image.dataUrl, w, h)`.
- [ ] **Step 4: GREEN**; re-run `trend-report-chart.test.ts`, `pdf-report-span.test.ts`, `pdf-report-header.test.ts`, `trend-downloads.test.tsx`; `tsc`.
- [ ] **Step 5: Commit** — `feat(web): report snapshot v2 records notes, images and page breaks; DRAFT watermark and signature replay`.

---

### Task 6: Client library and the dialog's Send-to picker

**Files:**
- Rewrite: `apps/web/src/lib/report-review.ts`
- Create: `apps/web/src/components/assignee-picker.tsx` (lifted from `SendForReviewButton`'s role/user segment + selects)
- Delete: `apps/web/src/components/SendForReviewButton.tsx` and its mount in `routes/audit/index.tsx:428` (the import too)
- Modify: `apps/web/src/components/report-download-dialog.tsx`
- Test: `apps/web/src/components/__tests__/report-download-dialog.test.tsx` (extend), `apps/web/src/lib/__tests__/report-review.test.ts` (new)

**Interfaces:**
- Produces:
```ts
// report-review.ts
export type Assignee = { userId: string } | { role: string };
export interface ReviewSummary { id; reportType; title; subtitle?; requestMeta: { period?: { from; to; label }; intervalMs?: number|null; instrumentCodes?: string[]; search?: string };
  status: 'PENDING'|'APPROVED'|'REJECTED'; requestedBy; requestedByName; requestedAt; requestRemarks; assigneeUserId; assigneeRole; decidedBy; decidedByName; decidedAt; decisionRemarks; createdAt }
export interface ReviewFull extends ReviewSummary { dataSnapshot: ReportSnapshot }
export async function submitReportForReview(input: { snapshot: ReportSnapshot; reportType: string; title: string; subtitle?: string; requestMeta: ReviewSummary['requestMeta']; remarks: string; assignee: Assignee; password?: string }): Promise<ReviewSummary>   // apiClient.postWithReauth('/api/report-reviews', body, password ?? '')
export async function listReviews(list: 'queue'|'mine'|'approved', page: number, pageSize: number): Promise<{ data: ReviewSummary[]; total: number }>
export async function fetchReview(id: string): Promise<ReviewFull>
export async function decideReview(id: string, decision: 'approve'|'reject', remarks: string, password: string): Promise<ReviewSummary>
export function reviewSignatures(r: ReviewSummary, formatDateTime: (d: string) => string): { label: string; value: string }[]  // [{ 'Requested By', `${name} (${name}) — ${fmt(requestedAt)}` }, { 'Approved By', … }] — name IS the user id here (username)
export async function openDraft(id: string, formatDateTime): Promise<void>   // fetch → renderSnapshotToPdf({draft:true}) → window.open(doc.output('bloburl'))
export async function downloadApproved(id: string, formatDateTime): Promise<void>  // fetch → if status!=='APPROVED' throw → apiClient.post(`/api/report-reviews/${id}/download-log`, {}) BEFORE render → renderSnapshotToPdf({signatures}) → doc.save(`${slug(title)}-approved.pdf`)
// report-download-dialog.tsx
export interface ReportDownloadRequest { period; remarks; password?; intervalMs?; assignee: Assignee }
```
  The dialog: an `<AssigneePicker value onChange>` block under Remarks labelled **Send to**; `canSubmit` also requires an assignee (error text `Choose who approves this report.`); the confirm button reads **Request approval**; the header line reads `Request approval — ${reportName}`. `AssigneePicker` fetches `/api/roles/active` (minus `SUPER_ADMIN`) and `/api/users?${ALL_RECORDS_PARAM}&status=ENABLED` exactly as the old button did, `seg`/`seg-btn` segment + a `Select`.

- [ ] **Step 1: Failing tests** — dialog: confirm disabled until an assignee is chosen; confirm payload carries `{ assignee: { userId } }`; the button text. Library: `submitReportForReview` posts the body shape (mock `apiClient.postWithReauth`); `downloadApproved` calls `download-log` BEFORE `save` (event order array, the `history-widget` technique) and refuses a PENDING row without calling either; `reviewSignatures` formats both lines and omits Approved By when undecided.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN** (+ `alarms-page.test.tsx`, `trend-downloads.test.tsx` still green — they will now need an assignee in their dialog flow: update their `download()` helper to pick a user in the picker; the users mock returns `[{ id: 'u-appr', username: 'qa1', fullName: 'QA One' }]`). `tsc`.
- [ ] **Step 5: Commit** — `feat(web): report-review client, Send-to picker on the download dialog, SendForReviewButton removed`.

---

### Task 7: Every download becomes a request

**Files:**
- Modify: `apps/web/src/routes/instruments/trend.tsx` (`runDownload`: the three `report.save` sites), `apps/web/src/routes/data-report/generate-report-card.tsx`, `apps/web/src/routes/alarms/index.tsx`, `apps/web/src/routes/audit/index.tsx` (PDF branch only; Excel keeps `logExport`)
- Test: `trend-downloads.test.tsx`, `generate-report-card.test.tsx`, `alarms-page.test.tsx`, `routes/audit/__tests__/…` (whichever covers exportPdf; add one if none)

**Interfaces:**
- Consumes `submitReportForReview` from Task 6. Each site replaces `await logReportExport({...}); report.save(name)` with:
```ts
await submitReportForReview({
  snapshot: report.getSnapshot(), reportType: 'Instrument Time Series', title: report.getSnapshot().title,
  requestMeta: { period: reportPeriod, intervalMs: reportInterval, instrumentCodes: [instrument.code] },
  remarks: req.remarks, assignee: req.assignee, password,
});
toast.success('Sent for approval', `The request is with ${assigneeLabel(req.assignee)} — see Reports.`);
```
  (`assigneeLabel` in `report-review.ts`: `'user <id>'` / `'role <name>'`). `reportType` strings are the existing audit ones: `Instrument Trend — Temperature` / `— Humidity`, `Instrument Time Series`, `Instrument Alarms`, `Alarms`, `Audit Trail`. `logReportExport` is no longer imported by any PDF path; `lib/report-export-log.ts` stays for the Audit Excel export.

- [ ] **Step 1: Failing tests** — in each file: after confirming the dialog (with an assignee), `submitReportForReview` mock was called once with the right `reportType` and a `snapshot.version === 2`, and `jspdf save` was NOT called (`saved` stays empty); the existing "writes the audit record BEFORE saving" cases become "posts the request and saves nothing".
- [ ] **Step 2: RED. Step 3: Implement. Step 4: GREEN** for the four files + `tsc` + `vite build`.
- [ ] **Step 5: Commit** — `feat(web): every PDF download raises a review request instead of saving`.

---

### Task 8: The Reports page, route, sidebar item

**Files:**
- Create: `apps/web/src/routes/reports/index.tsx`, `apps/web/src/routes/reports/decision-dialog.tsx`
- Modify: `apps/web/src/main.tsx` (lazy import + `<Route path="/reports" element={<RequireRole permissions={[PERMISSIONS.REPORT_REVIEW_READ]}>…`), `apps/web/src/components/layout/sidebar.tsx` (`{ id: 'reports', label: 'Reports', href: '/reports', icon: <svg …document-check…/> }`), `packages/shared/src/types/sidebar-items.ts` (`{ id: 'reports', label: 'Reports', icon: '\u{1F4D1}', description: 'Report requests awaiting approval, and approved reports to download' }`) — rebuild shared.
- Test: `apps/web/src/routes/reports/__tests__/reports-page.test.tsx`; `sidebar-parity`, `route-guard-coverage`, `sidebar-visibility` stay green.

**Interfaces:**
- Consumes Task 6's client. Page: `PageHeader` "Reports"; three tabs (`queue` → *For my approval*, `mine` → *My requests*, `approved` → *Approved*) backed by `useSWR(['/api/report-reviews', list, page, pageSize])` → `listReviews`; table columns Report (title + reportType), Period (`requestMeta.period.label` or from–to via `useDatetimeFormat`), Requested by / at, Send to (`user <id>` / `role <name>`), Status pill (PENDING amber, APPROVED green, REJECTED red — colour + word), Decided by / at, Actions: *View draft* (every row; `openDraft`), *Approve* / *Reject* (row is PENDING AND `useCan('reports.approve')` AND the current user is the assignee by id or role — `useAuth().user`), *Download* (APPROVED). `DecisionDialog`: remarks (required) + `SignaturePasswordInput`, calls `decideReview`, then `mutate()`; a failed list request renders `The reports could not be loaded.`, never "No reports". Canonical `<Pagination>` at `usePaginationDefaults().defaultLimit`.

- [ ] **Step 1: Failing page test** (mounted for real, `swr` and `@/lib/report-review` mocked): renders the three tabs and the rows; the Approve button appears only on a PENDING row assigned to the current user (fixture user `qa1`, role `QA`); approving posts remarks + password and revalidates; Download appears only on APPROVED; the error state; exactly one `<h1>`.
- [ ] **Step 2: RED. Step 3: Implement. Step 4: GREEN** + parity/guard/visibility tests + `tsc` + `vite build`.
- [ ] **Step 5: Commit** — `feat(web): Reports page — approve, reject, view draft, download approved`.

---

### Task 9: Samples, docs, counts

- [ ] **Step 1:** Render a DRAFT and an APPROVED sample of a Data Report to the scratchpad through `renderSnapshotToPdf` (temporary test under `src/__scratch__/`, deleted after) and Read them back: watermark on every page of the draft, two signature lines on the approved one, tables identical.
- [ ] **Step 2:** Docs — root `CLAUDE.md` (System Stats lines for every count above, plus a Report Review bullet in the notes section and the new endpoints in the Key API Endpoints block), `AGENTS.md`, `README.md`, `docs/index.md`, `packages/shared/CLAUDE.md`, `apps/web/CLAUDE.md` (a "Report review workflow" section; the Data Report / trend sections' "download" wording now says "request"), `apps/api/CLAUDE.md` (module list), `CHANGELOG.md` (one entry with the operator's words, the decisions, the counts, the receipts), `tasks/todo.md`. Stale-stat sweep with the OLD numbers across the active doc set.
- [ ] **Step 3:** Memory: a `project` note that the review workflow is back and how the snapshot is the record.
- [ ] **Step 4: Commit and push** — `docs: report review workflow counts and narrative`; `git push origin data-layer`.

---

## Self-review

- Spec coverage: every section maps — record-is-snapshot (T5), data model (T2), six routes (T3/T4), permissions/reauth/audit/notifications (T1/T3), dialog + triggers (T6/T7), Reports page + sidebar (T8), signatures + DRAFT (T5/T6), counts/docs (T9), tests and mutation checks (each task; mutation checks named in the spec run in T4 — remove the `status: 'PENDING'` guard and the self-approval check — and T6 — skip `download-log` before save — and T5 — drop `draft` from the watermark).
- Placeholders: none; every code step names its file and shape.
- Types: `ReviewSummary` / `ReviewFull` / `Assignee` / `ReportDownloadRequest.assignee` / `SnapshotSection` kinds are used with the same names in T5–T8.
