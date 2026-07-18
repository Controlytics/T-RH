# compliance-core — Domain Strip Manifest

_From read-only dependency discovery, 2026-07-18. Restore tag: `pre-domain-strip` @ ac0fcab._

**Build-breakers (must cut FIRST, do NOT delete the importing core file):**
1. `apps/api/src/modules/super-admin/routes.ts:6` — imports `computeChecksum` from `../filter-operations/helpers.js`; also hosts ~15 `/data/<domain>` Filter-Data-Management routes (prisma.filterEvent/cleaningCycle/assetInstance/assetIdentifier/filterDetails). Inline checksum + delete domain data routes.
2. `apps/api/src/modules/audit/routes.ts:9` — imports `entryLabel` from `../replacement-schedule/workflow.js`. Inline/drop.
3. `apps/web/src/components/layout/app-layout.tsx` — top-level imports of `use-rfid-guard`, `use-offline-config`, `triggerSync/startSyncPolling` (`@/lib/sync-since`), invoked at mount. Decouple.

**Prisma FK bridges (core→domain) to sever:**
- `TemplateAssignment.template → AssetTemplate` + `User.templateAssignments` back-relation → DROP model + back-relation.
- `EntityAssignment.entity → AssetInstance` + `User.entityAssignments` back-relation → DROP model + back-relation.

**Bulk removals:**
- **API modules (domain):** filter-operations, cleaning-profiles, checklist-profiles, equipment-groups, filter-profiles, pm-schedules, replacement-schedule, hierarchy, assets, block-change-requests, stage-approvals, report-reviews, guest, sync, deployment-check.
- **app.ts:** remove domain imports (L14-60 region) + register lines (L346-378 region) + `pmOverdueCheckTask` + `pm_overdue_check` taskList entry.
- **Prisma models (~34 domain):** TemplateKind, Block, Area, Ahu, Filter, AssetTemplate(+Version), AssetInstance, FilterDetails, AssetRelationship, AssetIdentifier, PmSchedule(+Entry), QualityNotification, PmExecution, ReplacementSchedule(+Entry), ReplacementExecution, Deviation, FilterCleaningProfile, FilterPipelineStage/Connection, FilterProfile(+ApplicableTemplate,+Version), CleaningCycle, FilterEvent, EquipmentGroup(+Version,+Instrument), ChecklistProfile(+Question,+Version), BlockChangeRequest, ReportReview, CleaningStageApproval. **+ TemplateAssignment, EntityAssignment** (bridges).
- **Prisma enums (domain, ~17):** PmScheduleStatus, PmEntryApprovalStatus, CleaningProfileStatus, PmExecutionStatus, FilterSetLabel, PipelineFlowMode, PipelineNodeType, CleaningCycleStatus, FilterEventType, BlockRestriction, ReplacementEntryStatus, DeviationStatus, ChecklistQuestionType, BlockChangeStatus, ReportReviewStatus, CleaningStageApprovalStatus, RelationshipType. **Prune domain values** from NotificationType.
- **packages/shared:** ~71 domain permissions, ~52 domain reauth actions, domain PERMISSION_TREE groups + folded `report_reviews.*` under audit, domain SIDEBAR_ITEMS, `schemas/assets.ts`. Trim CONFIGURABLE_PRIVILEGE_ORDER + frozen snapshots.
- **Config defs (16 domain):** ahu-completion-process, ahu-filter-set-config, block-change-approval, filter-cleaning-reasons, filter-field-options, guest-cleaning-requests, pm-schedule-approval, pm-schedule-settings, qnn-notifications, replacement-schedule-approval, replacement-schedule-filters, stage-interlock, offline-cache, report-labels, report-page-titles, report-signatories. + config-discovery.ts imports + config/index.tsx cards + static-routes files.
- **Frontend routes/ (domain):** approvals, checklist-admin, cleaning-cycles, deviations, filter-management, hierarchy-preview, mobile, my-tasks, pm-schedules, report-reviews, stage-approvals + domain pages in config/. ~37 main.tsx route elements. sidebar.tsx allNavItems (17 items + REPORTS_GROUP + /api/pm-schedules/qnn poll).
- **Frontend lib/hooks (domain):** offline-*, sync-*, connectivity, hard-cutoff, action-tape/, rfid-bridge, filter-*, ahu-block-map, cleaning-cycle-report, stage-approval, lib/filter-ops/, report-review/report-labels/report-types, use-offline*/use-rfid*/use-hierarchy/use-pm-*/use-replacement-*/use-report-*. **KEEP shared:** pdf-report.ts, excel-export.ts (used by core audit export).
- **Queue:** remove pm_overdue_check task; clean stale INGESTION/ingestionMessageSchema/exportJobSchema/maintenanceJobSchema artifacts.
- **Seed:** filter-field-options block, Phase-2 field-ids (FLD_FILTER/CYCLE/CP/CL/EQ/FP_*), domain help articles; trim default-roles.ts domain perm arrays.

**Core kept (22 models):** TemplateAssignment/EntityAssignment DROPPED; Dashboard(+Widget,+Assignment), Role, User, PasswordHistory, Session, SystemConfig, FieldIdConfig, PasswordResetRequest, AdminRequest, AuditTrail, Notification, UserConfig, RoleConfig, HelpArticle(+Version), NotificationLog, NotificationTemplate, UserGroup(+Member), NotificationRule(+Recipient).

**Order:** (1) cut 3 build-breaker couplings + 2 FK bridges → (2) super-admin console surgery → (3) drop app.ts domain registration → (4) delete domain modules/frontend/config-defs/lib/hooks → (5) trim shared (perms/reauth/tree/sidebar/schemas) → (6) trim seed/default-roles → (7) prisma migrate → (8) verify (tsc api+web, shared build, API boot, /health, login, audit verify-chain, web build).
