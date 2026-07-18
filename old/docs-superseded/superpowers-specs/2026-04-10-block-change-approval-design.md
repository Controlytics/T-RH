# Block Change Approval System — Design Spec

## Problem
Filters belong to a specific block (via parent hierarchy: Filter → AHU → Block). When a user tries to clean a filter in a different block than its home block, the system should block the operation and require approval from a designated role.

## Flow

```
User scans filter in Block B → Filter belongs to Block A (mismatch)
  → API returns BLOCK_CHANGE_REQUIRED
  → UI shows "Request Block Change" dialog
  → User submits request (filterId, fromBlock, toBlock, reason)
  → Request stored as PENDING in block_change_requests table
  → Notification shown to approval role users
  
Approver opens Approvals page → sees pending requests
  → Approves or Rejects with optional comment
  → Status updated to APPROVED / REJECTED
  
User retries cleaning:
  → If APPROVED request exists for this filter+toBlock → allowed
  → If REJECTED or no request → blocked again
```

## Data Model

### New Prisma Model: BlockChangeRequest
```prisma
model BlockChangeRequest {
  id              String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  filterId        String   @map("filter_id") @db.Uuid
  filterName      String   @map("filter_name") @db.VarChar(255)
  fromBlockId     String   @map("from_block_id") @db.Uuid
  fromBlockName   String   @map("from_block_name") @db.VarChar(255)
  toBlockId       String   @map("to_block_id") @db.Uuid
  toBlockName     String   @map("to_block_name") @db.VarChar(255)
  reason          String?
  status          BlockChangeStatus @default(PENDING)
  requestedBy     String   @map("requested_by") @db.Uuid
  requestedByName String   @map("requested_by_name") @db.VarChar(255)
  processedBy     String?  @map("processed_by") @db.Uuid
  processedByName String?  @map("processed_by_name") @db.VarChar(255)
  processedComment String? @map("processed_comment")
  processedAt     DateTime? @map("processed_at") @db.Timestamptz
  organizationId  String   @map("organization_id") @db.Uuid
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz

  @@index([filterId, toBlockId, status])
  @@index([status, organizationId])
  @@map("block_change_requests")
}

enum BlockChangeStatus {
  PENDING
  APPROVED
  REJECTED
  EXPIRED
  @@map("block_change_status")
}
```

## API Endpoints

### Block Change Requests
```
POST   /api/block-change-requests              — Submit request (BLOCK_CHANGE_REQUEST permission)
GET    /api/block-change-requests              — List requests (filterable by status, for approvers: all org; for others: own only)
GET    /api/block-change-requests/pending-count — Count pending (for badge on Approvals sidebar)
POST   /api/block-change-requests/:id/approve  — Approve (BLOCK_CHANGE_APPROVE permission)
POST   /api/block-change-requests/:id/reject   — Reject (BLOCK_CHANGE_APPROVE permission)
```

### Modified Endpoints
- `POST /api/filters/:id/start-cycle` — add block validation check
- `POST /api/filters/:id/advance` — add block validation check (on first advance only)

## Block Validation Logic

In `filter-operations.service.ts`, before starting a cycle or first advance:

```typescript
async validateBlockChange(filterId: string, cleaningAreaId: string, ctx: RequestContext) {
  // 1. Walk up filter's parent chain to find its home block
  const homeBlockId = await this.getFilterHomeBlock(filterId);
  
  // 2. If same block or no block assigned, allow
  if (!homeBlockId || homeBlockId === cleaningAreaId) return;
  
  // 3. Check for approved block change request
  const approved = await prisma.blockChangeRequest.findFirst({
    where: {
      filterId,
      toBlockId: cleaningAreaId,
      status: 'APPROVED',
    },
  });
  
  if (!approved) {
    throw new AppError(409, 'BLOCK_CHANGE_REQUIRED', 
      'Filter belongs to a different block. Submit a block change request.',
      { filterId, homeBlockId, requestedBlockId: cleaningAreaId }
    );
  }
}
```

## Configuration

New system config key: `block-change-approval`
```json
{
  "approvalRole": "ADMIN",      // Role that can approve (configurable)
  "requireReason": true,         // Require reason for request
  "autoExpireHours": 24          // Approved requests expire after N hours
}
```

Added to config registry as a new config definition.

## Permissions

New permissions added to PERMISSIONS constant:
- `BLOCK_CHANGE_REQUEST` — can submit block change requests
- `BLOCK_CHANGE_APPROVE` — can approve/reject requests

## Feature Privileges

New entries in FEATURE_PRIVILEGES:
- `block_change.request` → maps to `['BLOCK_CHANGE_REQUEST']`
- `block_change.approve` → maps to `['BLOCK_CHANGE_APPROVE']`

## Sidebar

New sidebar item:
- ID: `approvals`
- Label: "Approvals"
- Icon: checkmark-in-circle
- Privilege IDs: `['block_change.request', 'block_change.approve']`

## Re-authentication

New reauth actions:
- `APPROVE_BLOCK_CHANGE` — approving a request
- `REJECT_BLOCK_CHANGE` — rejecting a request

## Frontend Pages

### Approvals Page (`/approvals`)
- Two views based on role:
  - **Approver view**: Table of pending requests with Approve/Reject buttons
  - **Requestor view**: Table of own requests with status badges
- Filters: status (Pending/Approved/Rejected/All)
- Columns: Filter, From Block, To Block, Reason, Status, Requested By, Date, Actions

### Mobile Operations Change
- When API returns `BLOCK_CHANGE_REQUIRED`:
  - Show dialog: "This filter belongs to [Block A]. You're in [Block B]. Request block change?"
  - Reason input field
  - Submit creates the request
  - Show "(Pending approval)" status

## Files to Create/Modify

### New Files
1. `apps/api/prisma/migrations/XXXX_block_change_requests/migration.sql`
2. `apps/api/src/modules/block-change-requests/routes.ts`
3. `apps/api/src/modules/block-change-requests/block-change.service.ts`
4. `apps/api/src/modules/config/defs/block-change-approval.def.ts`
5. `apps/web/src/routes/approvals/index.tsx`

### Modified Files
6. `apps/api/prisma/schema.prisma` — add model + enum
7. `apps/api/src/modules/filter-operations/filter-operations.service.ts` — add block validation
8. `apps/api/src/app.ts` — register new routes
9. `packages/shared/src/types/permissions.ts` — add new permissions
10. `packages/shared/src/types/feature-privileges.ts` — add new features + mappings
11. `packages/shared/src/types/sidebar-items.ts` — add Approvals
12. `packages/shared/src/types/sidebar-privilege-map.ts` — add mapping
13. `packages/shared/src/types/reauth-actions.ts` — add actions
14. `apps/web/src/main.tsx` — add Approvals route
15. `apps/web/src/routes/mobile/mobile-operations.tsx` — handle BLOCK_CHANGE_REQUIRED error
