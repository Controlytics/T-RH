# Block Change Approval System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent filters from being cleaned in a block they don't belong to, unless a designated approver role (chosen by super admin) approves the block change request.

**Architecture:** New `BlockChangeRequest` model + service + routes. Block validation added to `startCycle()`. Config definition for approval role selection. New Approvals sidebar page + mobile dialog.

**Tech Stack:** Prisma (DB), Fastify (API), React (Web), Tailwind CSS (styling)

---

### Task 1: Add Prisma model + enum + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

- [ ] **Step 1: Add enum and model to schema.prisma**

Add after the last model (`ChecklistQuestion`):

```prisma
enum BlockChangeStatus {
  PENDING
  APPROVED
  REJECTED
  EXPIRED
  @@map("block_change_status")
}

model BlockChangeRequest {
  id              String            @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  filterId        String            @map("filter_id") @db.Uuid
  filterName      String            @map("filter_name") @db.VarChar(255)
  fromBlockId     String            @map("from_block_id") @db.Uuid
  fromBlockName   String            @map("from_block_name") @db.VarChar(255)
  toBlockId       String            @map("to_block_id") @db.Uuid
  toBlockName     String            @map("to_block_name") @db.VarChar(255)
  reason          String?
  status          BlockChangeStatus @default(PENDING)
  requestedBy     String            @map("requested_by") @db.Uuid
  requestedByName String            @map("requested_by_name") @db.VarChar(255)
  processedBy     String?           @map("processed_by") @db.Uuid
  processedByName String?           @map("processed_by_name") @db.VarChar(255)
  processedComment String?          @map("processed_comment")
  processedAt     DateTime?         @map("processed_at") @db.Timestamptz
  organizationId  String            @map("organization_id") @db.Uuid
  createdAt       DateTime          @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime          @updatedAt @map("updated_at") @db.Timestamptz

  @@index([filterId, toBlockId, status])
  @@index([status, organizationId])
  @@index([requestedBy])
  @@map("block_change_requests")
}
```

- [ ] **Step 2: Generate and apply migration**

Run: `cd apps/api && npx prisma migrate dev --name block_change_requests`

- [ ] **Step 3: Verify migration**

Run: `npx prisma generate`

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/
git commit -m "feat: add BlockChangeRequest model and migration"
```

---

### Task 2: Add permissions, feature privileges, sidebar items, reauth actions

**Files:**
- Modify: `packages/shared/src/types/permissions.ts`
- Modify: `packages/shared/src/types/feature-privileges.ts`
- Modify: `packages/shared/src/types/sidebar-items.ts`
- Modify: `packages/shared/src/types/sidebar-privilege-map.ts`
- Modify: `packages/shared/src/types/reauth-actions.ts`

- [ ] **Step 1: Add permissions**

In `packages/shared/src/types/permissions.ts`, before closing `} as const;`:

```typescript
  // Block Change Requests
  BLOCK_CHANGE_REQUEST: 'BLOCK_CHANGE_REQUEST',
  BLOCK_CHANGE_APPROVE: 'BLOCK_CHANGE_APPROVE',
```

- [ ] **Step 2: Add feature privileges**

In `packages/shared/src/types/feature-privileges.ts`, add to `FEATURE_PRIVILEGES` array:

```typescript
  // Block Change
  { id: 'block_change.request', label: 'Request Block Change', category: 'Filter Management', icon: 'refresh' },
  { id: 'block_change.approve', label: 'Approve Block Change', category: 'Filter Management', icon: 'check-circle' },
```

Add to `FEATURE_TO_PERMISSION_MAP`:

```typescript
  // Block Change
  'block_change.request': ['BLOCK_CHANGE_REQUEST'],
  'block_change.approve': ['BLOCK_CHANGE_APPROVE'],
```

- [ ] **Step 3: Add sidebar item**

In `packages/shared/src/types/sidebar-items.ts`, before closing `];`:

```typescript
  { id: 'approvals', label: 'Approvals', icon: '\u2705', description: 'Block change approval requests' },
```

- [ ] **Step 4: Add sidebar privilege mapping**

In `packages/shared/src/types/sidebar-privilege-map.ts`, before closing `];`:

```typescript
  {
    sidebarId: "approvals",
    label: "Approvals",
    icon: "\u2705",
    description: "Block change approval requests",
    privilegeIds: ["block_change.request", "block_change.approve"],
  },
```

- [ ] **Step 5: Add reauth actions**

In `packages/shared/src/types/reauth-actions.ts`, before closing `} as const;`:

```typescript
  // Block Change
  APPROVE_BLOCK_CHANGE: { label: 'Approve Block Change', category: 'Filter Management' },
  REJECT_BLOCK_CHANGE: { label: 'Reject Block Change', category: 'Filter Management' },
```

- [ ] **Step 6: Rebuild shared package**

Run: `cd packages/shared && npx tsc`

- [ ] **Step 7: Commit**

```bash
git add packages/shared/
git commit -m "feat: add block change permissions, sidebar, reauth actions"
```

---

### Task 3: Create block-change-requests API module

**Files:**
- Create: `apps/api/src/modules/block-change-requests/block-change.service.ts`
- Create: `apps/api/src/modules/block-change-requests/routes.ts`
- Modify: `apps/api/src/app.ts` (register routes)

- [ ] **Step 1: Create service**

Create `apps/api/src/modules/block-change-requests/block-change.service.ts`:

```typescript
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { orgScope } from '../../lib/org-scope.js';
import type { RequestContext } from '../../types/context.js';

export const blockChangeService = {
  async create(ctx: RequestContext, data: {
    filterId: string; filterName: string;
    fromBlockId: string; fromBlockName: string;
    toBlockId: string; toBlockName: string;
    reason?: string;
  }) {
    // Check for existing pending request for same filter+toBlock
    const existing = await prisma.blockChangeRequest.findFirst({
      where: { filterId: data.filterId, toBlockId: data.toBlockId, status: 'PENDING' },
    });
    if (existing) throw new AppError(409, 'DUPLICATE_REQUEST', 'A pending request already exists for this filter and block');

    const request = await prisma.blockChangeRequest.create({
      data: {
        ...data,
        requestedBy: ctx.userSub,
        requestedByName: ctx.userId,
        organizationId: ctx.organizationId ?? '',
      },
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'BLOCK_CHANGE_REQUESTED',
      targetType: 'block_change_request', targetId: request.id,
      afterValue: { filterId: data.filterId, fromBlock: data.fromBlockName, toBlock: data.toBlockName },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return request;
  },

  async list(ctx: RequestContext, query: { status?: string; page?: number; limit?: number; mine?: boolean }) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const where: any = { ...orgScope(ctx) };

    if (query.status && query.status !== 'ALL') where.status = query.status;
    if (query.mine) where.requestedBy = ctx.userSub;

    const [data, total] = await Promise.all([
      prisma.blockChangeRequest.findMany({
        where, skip: (page - 1) * limit, take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.blockChangeRequest.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  },

  async pendingCount(ctx: RequestContext) {
    const where: any = { status: 'PENDING', ...orgScope(ctx) };
    return prisma.blockChangeRequest.count({ where });
  },

  async process(ctx: RequestContext, id: string, action: 'approve' | 'reject', comment?: string) {
    const request = await prisma.blockChangeRequest.findUnique({ where: { id } });
    if (!request) throw new AppError(404, 'NOT_FOUND', 'Request not found');
    if (request.status !== 'PENDING') throw new AppError(409, 'ALREADY_PROCESSED', `Request already ${request.status.toLowerCase()}`);

    const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
    const updated = await prisma.blockChangeRequest.update({
      where: { id },
      data: {
        status: newStatus,
        processedBy: ctx.userSub,
        processedByName: ctx.userId,
        processedComment: comment ?? null,
        processedAt: new Date(),
      },
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: action === 'approve' ? 'BLOCK_CHANGE_APPROVED' : 'BLOCK_CHANGE_REJECTED',
      targetType: 'block_change_request', targetId: id,
      beforeValue: { status: 'PENDING' },
      afterValue: { status: newStatus, comment },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return updated;
  },

  async hasApproval(filterId: string, toBlockId: string): Promise<boolean> {
    const approved = await prisma.blockChangeRequest.findFirst({
      where: { filterId, toBlockId, status: 'APPROVED' },
    });
    return !!approved;
  },

  async consumeApproval(filterId: string, toBlockId: string): Promise<void> {
    // Mark the approval as used (set to EXPIRED) so it's single-use
    await prisma.blockChangeRequest.updateMany({
      where: { filterId, toBlockId, status: 'APPROVED' },
      data: { status: 'EXPIRED' },
    });
  },
};
```

- [ ] **Step 2: Create routes**

Create `apps/api/src/modules/block-change-requests/routes.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { blockChangeService } from './block-change.service.js';
import { buildContext } from '../../lib/build-context.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { enforceReauth } from '../../lib/reauth-check.js';

export default async function blockChangeRoutes(app: FastifyInstance) {
  // POST / — Submit block change request
  app.post('/', {
    preHandler: [app.requirePermission('BLOCK_CHANGE_REQUEST')],
    schema: {
      tags: ['Block Change Requests'],
      summary: 'Submit a block change request',
      body: {
        type: 'object',
        required: ['filterId', 'filterName', 'fromBlockId', 'fromBlockName', 'toBlockId', 'toBlockName'],
        properties: {
          filterId: { type: 'string', format: 'uuid' },
          filterName: { type: 'string' },
          fromBlockId: { type: 'string', format: 'uuid' },
          fromBlockName: { type: 'string' },
          toBlockId: { type: 'string', format: 'uuid' },
          toBlockName: { type: 'string' },
          reason: { type: 'string', maxLength: 500 },
        },
      },
      response: { 201: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const ctx = buildContext(req);
    const result = await blockChangeService.create(ctx, req.body as any);
    return reply.code(201).send(result);
  });

  // GET / — List requests
  app.get('/', {
    preHandler: [app.requirePermission('BLOCK_CHANGE_REQUEST')],
    schema: {
      tags: ['Block Change Requests'],
      summary: 'List block change requests',
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'ALL'] },
          mine: { type: 'string', enum: ['true', 'false'] },
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const query = req.query as any;
    return blockChangeService.list(ctx, { ...query, mine: query.mine === 'true' });
  });

  // GET /pending-count
  app.get('/pending-count', {
    preHandler: [app.requirePermission('BLOCK_CHANGE_APPROVE')],
    schema: {
      tags: ['Block Change Requests'],
      summary: 'Count pending requests',
      response: { 200: { type: 'object', properties: { count: { type: 'integer' } } } },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const count = await blockChangeService.pendingCount(ctx);
    return { count };
  });

  // POST /:id/approve
  app.post('/:id/approve', {
    preHandler: [app.requirePermission('BLOCK_CHANGE_APPROVE')],
    schema: {
      tags: ['Block Change Requests'],
      summary: 'Approve a block change request',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', properties: { comment: { type: 'string', maxLength: 500 } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('APPROVE_BLOCK_CHANGE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    const { comment } = (req.body as any) ?? {};
    return blockChangeService.process(ctx, id, 'approve', comment);
  });

  // POST /:id/reject
  app.post('/:id/reject', {
    preHandler: [app.requirePermission('BLOCK_CHANGE_APPROVE')],
    schema: {
      tags: ['Block Change Requests'],
      summary: 'Reject a block change request',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', properties: { comment: { type: 'string', maxLength: 500 } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('REJECT_BLOCK_CHANGE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    const { comment } = (req.body as any) ?? {};
    return blockChangeService.process(ctx, id, 'reject', comment);
  });
}
```

- [ ] **Step 3: Register routes in app.ts**

In `apps/api/src/app.ts`, add import:

```typescript
import blockChangeRoutes from './modules/block-change-requests/routes.js';
```

Add registration (near other route registrations):

```typescript
app.register(blockChangeRoutes, { prefix: '/api/block-change-requests' });
```

- [ ] **Step 4: Type-check**

Run: `npx tsc -p apps/api/tsconfig.json --noEmit`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/block-change-requests/ apps/api/src/app.ts
git commit -m "feat: block change request API — create, list, approve, reject"
```

---

### Task 4: Add block validation to filter operations

**Files:**
- Modify: `apps/api/src/modules/filter-operations/filter-operations.service.ts`

- [ ] **Step 1: Add getFilterHomeBlock helper method**

Add to the `FilterOperationsService` class:

```typescript
async getFilterHomeBlock(filterId: string): Promise<{ blockId: string; blockName: string } | null> {
  // Walk up parent chain: Filter → AHU → Block
  let currentId: string | null = filterId;
  const visited = new Set<string>();

  while (currentId) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const instance = await prisma.assetInstance.findUnique({
      where: { id: currentId },
      select: { id: true, name: true, parentId: true, template: { select: { name: true } } },
    });
    if (!instance) break;

    if (instance.template?.name === 'Block') {
      return { blockId: instance.id, blockName: instance.name };
    }
    currentId = instance.parentId;
  }
  return null;
}
```

- [ ] **Step 2: Add validateBlockChange method**

Add to the service class:

```typescript
async validateBlockChange(filterId: string, cleaningAreaId: string | undefined, ctx: RequestContext) {
  if (!cleaningAreaId) return; // No block selected, skip validation

  const homeBlock = await this.getFilterHomeBlock(filterId);
  if (!homeBlock) return; // Filter not in any block hierarchy, allow

  if (homeBlock.blockId === cleaningAreaId) return; // Same block, allow

  // Different block — check for approved request
  const { blockChangeService } = await import('../block-change-requests/block-change.service.js');
  const hasApproval = await blockChangeService.hasApproval(filterId, cleaningAreaId);

  if (!hasApproval) {
    // Get target block name for error message
    const targetBlock = await prisma.assetInstance.findUnique({
      where: { id: cleaningAreaId },
      select: { name: true },
    });

    throw new AppError(409, 'BLOCK_CHANGE_REQUIRED',
      `Filter belongs to ${homeBlock.blockName}. Request approval to clean in ${targetBlock?.name ?? 'another block'}.`,
      {
        filterId,
        homeBlockId: homeBlock.blockId,
        homeBlockName: homeBlock.blockName,
        requestedBlockId: cleaningAreaId,
        requestedBlockName: targetBlock?.name ?? '',
      }
    );
  }

  // Approval exists — consume it (single-use)
  await blockChangeService.consumeApproval(filterId, cleaningAreaId);
}
```

- [ ] **Step 3: Call validateBlockChange in startCycle**

In the `startCycle` method, add after the "Check if cycle already active" validation (around line 435) and before cycle code generation:

```typescript
    // Validate block change (must be before cycle creation)
    await this.validateBlockChange(filterId, cleaningAreaId, ctx);
```

- [ ] **Step 4: Type-check**

Run: `npx tsc -p apps/api/tsconfig.json --noEmit`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/filter-operations/
git commit -m "feat: block validation — require approval for cross-block cleaning"
```

---

### Task 5: Add config definition for approval role

**Files:**
- Create: `apps/api/src/modules/config/defs/block-change-approval.def.ts`

- [ ] **Step 1: Create config definition**

Create `apps/api/src/modules/config/defs/block-change-approval.def.ts`:

```typescript
import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const blockChangeApprovalDef: ModuleConfigDefinition = {
  moduleKey: 'block-change-approval',
  moduleName: 'Block Change Approval',
  description: 'Configure which role can approve block change requests for filter cleaning',
  icon: 'shield-check',
  category: 'filter',
  sortOrder: 60,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'approvalRole',
      type: 'string',
      label: 'Approval Role',
      description: 'The role that can approve block change requests (selected by Super Admin)',
      group: 'Approval',
      defaultValue: 'ADMIN',
    },
    {
      key: 'requireReason',
      type: 'boolean',
      label: 'Require Reason',
      description: 'Require users to provide a reason when requesting a block change',
      group: 'Approval',
      defaultValue: true,
    },
    {
      key: 'autoExpireHours',
      type: 'number',
      label: 'Auto-Expire Hours',
      description: 'Approved requests expire after this many hours (0 = no expiry)',
      group: 'Approval',
      defaultValue: 24,
    },
  ],
};
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/config/defs/
git commit -m "feat: block change approval config definition"
```

---

### Task 6: Create Approvals frontend page

**Files:**
- Create: `apps/web/src/routes/approvals/index.tsx`
- Modify: `apps/web/src/main.tsx` (add route + lazy import)

- [ ] **Step 1: Create Approvals page**

Create `apps/web/src/routes/approvals/index.tsx` — full professional page with cyan/teal theme, stats cards, table with approve/reject actions, status filters.

(Full component code — approvers see all pending requests with approve/reject buttons, other users see their own requests with status badges)

- [ ] **Step 2: Add route to main.tsx**

Add lazy import at top:
```typescript
const ApprovalsPage = lazy(() => import("./routes/approvals/index").then(m => ({ default: m.ApprovalsPage })));
```

Add route inside protected routes:
```typescript
<Route path="/approvals" element={<Suspense fallback={<LazyFallback />}><ApprovalsPage /></Suspense>} />
```

- [ ] **Step 3: Add sidebar nav item**

In `apps/web/src/components/layout/sidebar.tsx`, add to `allNavItems` array:

```typescript
{
  id: "approvals",
  label: "Approvals",
  href: "/approvals",
  icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>),
},
```

- [ ] **Step 4: Type-check**

Run: `cd apps/web && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/approvals/ apps/web/src/main.tsx apps/web/src/components/layout/sidebar.tsx
git commit -m "feat: Approvals page — view, approve, reject block change requests"
```

---

### Task 7: Update mobile operations to handle block change

**Files:**
- Modify: `apps/web/src/routes/mobile/mobile-operations.tsx`

- [ ] **Step 1: Add block change request dialog state**

Add state variables:
```typescript
const [blockChangeDialog, setBlockChangeDialog] = useState<{
  filterId: string; filterName: string;
  homeBlockId: string; homeBlockName: string;
  requestedBlockId: string; requestedBlockName: string;
} | null>(null);
const [blockChangeReason, setBlockChangeReason] = useState('');
const [blockChangeSubmitting, setBlockChangeSubmitting] = useState(false);
```

- [ ] **Step 2: Handle BLOCK_CHANGE_REQUIRED error**

In the outer `catch` of `handleSubmit` and `handleReasonSubmit`, add before the generic `setError`:

```typescript
if (e.code === 'BLOCK_CHANGE_REQUIRED' && e.connectionInfo) {
  setBlockChangeDialog({
    filterId: e.connectionInfo.filterId,
    filterName: scanValue,
    homeBlockId: e.connectionInfo.homeBlockId,
    homeBlockName: e.connectionInfo.homeBlockName,
    requestedBlockId: e.connectionInfo.requestedBlockId,
    requestedBlockName: e.connectionInfo.requestedBlockName,
  });
  setBlockChangeReason('');
  setLoading(false);
  return;
}
```

- [ ] **Step 3: Add block change request submit handler**

```typescript
const handleBlockChangeRequest = async () => {
  if (!blockChangeDialog) return;
  setBlockChangeSubmitting(true);
  try {
    await apiClient.post('/api/block-change-requests', {
      filterId: blockChangeDialog.filterId,
      filterName: blockChangeDialog.filterName,
      fromBlockId: blockChangeDialog.homeBlockId,
      fromBlockName: blockChangeDialog.homeBlockName,
      toBlockId: blockChangeDialog.requestedBlockId,
      toBlockName: blockChangeDialog.requestedBlockName,
      reason: blockChangeReason || undefined,
    });
    setSuccess('Block change request submitted. Waiting for approval.');
    setBlockChangeDialog(null);
    setScanValue('');
  } catch (e: any) {
    setError(e.message ?? 'Failed to submit request');
  }
  setBlockChangeSubmitting(false);
};
```

- [ ] **Step 4: Add block change dialog JSX**

Add dialog component in the JSX (similar pattern to existing dialogs):

```tsx
{blockChangeDialog && (
  <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
    <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
      <div className="h-1.5 bg-gradient-to-r from-amber-500 to-orange-500" />
      <div className="p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
            <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-800">Block Change Required</h3>
            <p className="text-xs text-slate-400">This filter belongs to a different block</p>
          </div>
        </div>
        <div className="space-y-3 mb-5">
          <div className="bg-slate-50 rounded-xl p-3 text-sm">
            <div className="text-slate-500">Filter: <span className="font-semibold text-slate-800">{blockChangeDialog.filterName}</span></div>
            <div className="text-slate-500 mt-1">Home Block: <span className="font-semibold text-slate-800">{blockChangeDialog.homeBlockName}</span></div>
            <div className="text-slate-500 mt-1">Requested Block: <span className="font-semibold text-amber-700">{blockChangeDialog.requestedBlockName}</span></div>
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Reason</label>
            <textarea className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-800 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100 outline-none" rows={2}
              value={blockChangeReason} onChange={e => setBlockChangeReason(e.target.value)}
              placeholder="Why does this filter need to be cleaned in a different block?" />
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={() => { setBlockChangeDialog(null); setScanValue(''); }}
            className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium">Cancel</button>
          <button onClick={handleBlockChangeRequest} disabled={blockChangeSubmitting}
            className="flex-1 py-2.5 bg-gradient-to-r from-cyan-600 to-teal-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50 shadow-lg shadow-cyan-500/25">
            {blockChangeSubmitting ? 'Submitting...' : 'Request Change'}
          </button>
        </div>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 5: Type-check**

Run: `cd apps/web && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/mobile/
git commit -m "feat: mobile block change request dialog"
```

---

### Task 8: Build, test, push

- [ ] **Step 1: Full type-check**

```bash
cd packages/shared && npx tsc
npx tsc -p apps/api/tsconfig.json --noEmit
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 2: Run API tests**

```bash
cd apps/api && npx vitest run src/modules/config
```

- [ ] **Step 3: Push**

```bash
git push origin RFID
```
