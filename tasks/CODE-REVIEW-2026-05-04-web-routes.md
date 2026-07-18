# Code Review — Web Routes — 2026-05-04

Adversarial review of `apps/web/src/routes/` (~85 pages, 197 tsx files) and `apps/web/src/main.tsx` against the Phase 5 architecture rules: granular permissions (90 privileges, 106 perms), reauth gates (87 actions), decision-tape contract, remarks-mandatory rule, dynamic attributeSchema, tablet/web unification, light-theme-only, and `connectionInfo` error mapping.

Method: targeted grep battery (dark theme, empty handlers, TODO/FIXME, `reauth.execute()` call sites, `connectionInfo`, `attributeSchema`, hard-coded stage names, `isSuperAdmin`/`perms.includes`) cross-referenced against `packages/shared/src/types/reauth-actions.ts`. Then sampled the highest-risk files.

---

## Summary (5 lines)
- **CRITICAL — missing reauth on regulated mutations:** `approvals/index.tsx:34` (block-change approve/reject), `mobile/mobile-wrapper.tsx:262` (same on tablet), `mobile/mobile-wrapper.tsx:207-244` (RFID assign/unassign), `config/equipment-groups.tsx:130-164,114-121` (CREATE/UPDATE/DELETE_EQUIPMENT_GROUP), `rule-chains/editor.tsx:501-518,524-530` (UPDATE_RULE_CHAIN on toggle + rename), and `config/action-reauth.tsx:255` (the reauth-config save itself bypasses reauth — privilege-escalation risk) all call mutating APIs with no `reauth.execute()` despite the action keys existing in `packages/shared/src/types/reauth-actions.ts`.
- **CRITICAL — Backend serves /terminate and /bypass but no FE caller exists** (`apps/api/src/modules/filter-operations/routes.ts:307,458`): operators cannot record cleaning-cycle deviations through the UI. `TERMINATE_CLEANING_CYCLE` and `BYPASS_FILTER_STAGE` reauth actions are dead at the FE layer — this is missing UI, not stale config.
- **HIGH — Sensitive-config writes lack reauth coverage entirely** (no action defined at all): `config/access-matrix.tsx:91`, `config/ldap.tsx:71`, `config/template-kinds.tsx:81/107/132/142`, `config/notification-rules/index.tsx:208/210/222/...`, `config/dashboard-cards.tsx:71`, `config/cleaning-profile-assignment.tsx:148`, `config/filter-cleaning-reasons.tsx:28`, `config/notification-settings/email-settings.tsx:197,668`, `config/ahu-filter-set-config.tsx:41`, `audit/index.tsx:101,116`, plus `checklist-form/index.tsx:143-184` (no `SUBMIT_CHECKLIST_WITH_SIGNATURE` wrap; also missing the entire signature-capture flow).
- **MEDIUM — `/admin-requests` guard uses `USER_CREATE`** (`main.tsx:243`) conflating approver vs creator authority; one light-theme miss in the mobile debug overlay (`mobile-operations.tsx:1415`); `RequireRole` semantics confirmed OR (`some()` at `require-role.tsx:40`) so multi-perm guards in main.tsx are correctly permissive.
- **DECISION-TAPE INTACT** — hardcoded `WASH_IN`/`DRY_IN` references in `filter-operations.tsx:895/971/1048` and `mobile-operations.tsx:997` are UI input-gating only (`if (stage.key === 'WASH_IN' && blockId)` — show block-picker), not next-stage decisions. `mobile-wrapper.tsx:13-20` `STAGES` const has `needsBlock: true` flags — same input-gating pattern. No client-side pipeline reconstruction observed.

---

## Critical

### Reauth-bypass regressions (action defined; call site missing the wrap)
These are pure code-change fixes — no product/vocab decisions needed. The action keys are already in `packages/shared/src/types/reauth-actions.ts`.

### C1. `apps/web/src/routes/approvals/index.tsx:34-46` — block-change approve/reject skips reauth
`handleProcess` calls `apiClient.post('/api/block-change-requests/${id}/${action}')` directly. `REAUTH_ACTIONS.APPROVE_BLOCK_CHANGE` and `REJECT_BLOCK_CHANGE` exist (`reauth-actions.ts:104-105`). Identical to M1 (admin-requests, fixed 2026-05-04) but untouched. Block changes are deviation events under 21 CFR Part 11 — must be challengeable.
**Fix:** wrap mutation in `reauth.execute(action === 'approve' ? 'APPROVE_BLOCK_CHANGE' : 'REJECT_BLOCK_CHANGE', ...)` mirroring `admin-requests/index.tsx:55-91`. Use `apiClient.postWithReauth` when password supplied.

### C2. `apps/web/src/routes/mobile/mobile-wrapper.tsx:262-274` — mobile block-change approve/reject skips reauth
Identical bug to C1 on the tablet path. The "tablet must NOT have a separate implementation" rule (CLAUDE.md) is technically violated: web `approvals/index.tsx` and mobile `mobile-wrapper.tsx` have two parallel handler implementations that drifted. Whatever fix lands for C1 must land here — or, better, both call sites delegate to one shared hook.
**Fix:** mirror C1's reauth wrap; long-term, extract a `useBlockChangeApproval()` hook used by both.

### C3. `apps/web/src/routes/mobile/mobile-wrapper.tsx:207-244` — RFID assign/unassign skip identifier reauth
`assignRfid` posts to `/api/assets/identifiers` and `unassignRfid` deletes — both correspond to `CREATE_ASSET_IDENTIFIER` / `DELETE_ASSET_IDENTIFIER` (`reauth-actions.ts:47-48`). The web equivalent (`assets/hooks/use-asset-mutations.ts:300,326`) does wrap them; the mobile path drifted.
**Fix:** wrap both in `reauth.execute('CREATE_ASSET_IDENTIFIER' | 'DELETE_ASSET_IDENTIFIER', …)` matching the web hook signature.

### C4. `apps/web/src/routes/config/equipment-groups.tsx:130-164,114-121` — handleSave + handleDelete skip CREATE/UPDATE/DELETE_EQUIPMENT_GROUP
All three reauth actions exist (`reauth-actions.ts:99-101`). `apiClient.post/put('/api/equipment-groups', payload)` and `apiClient.delete(...)` go through unwrapped. The M8 soft-lock dialog (lines 95-112) was added to flag in-use edits but the underlying mutation is still unprotected.
**Fix:** wrap save in `reauth.execute(isNew ? 'CREATE_EQUIPMENT_GROUP' : 'UPDATE_EQUIPMENT_GROUP', …)`; wrap delete in `reauth.execute('DELETE_EQUIPMENT_GROUP', …)`.

### C5. `apps/web/src/routes/rule-chains/editor.tsx:501-518,524-530` — handleToggleActive + handleNameSave skip UPDATE_RULE_CHAIN
Both PUT `/api/rule-chains/${chainId}` directly. `handleSave` (the visual-editor save at line 489) correctly wraps in `reauth.execute('UPDATE_RULE_CHAIN', …)`; the inline name edit and active-toggle do not. Same backing endpoint, same audit consequence.
**Fix:** wrap both PUTs in `reauth.execute('UPDATE_RULE_CHAIN', …)`.

### C6. `apps/web/src/routes/config/action-reauth.tsx:255` — reauth-config save itself bypasses reauth (privilege escalation)
The page that controls which actions need re-auth is editable via a plain `api.put('/api/config/action-reauth', currentConfig)` with no challenge. Trivial privilege escalation: an admin disables reauth on `DELETE_USER`, then deletes users without challenge.
**Fix:** wrap in `reauth.execute('UPDATE_ROLE_CONFIG', …)` (closest existing action) OR introduce a dedicated `UPDATE_REAUTH_CONFIG`. Lower confidence on key choice — verify against the backend handler at `apps/api/src/modules/config/...` to confirm which action it actually expects.

### C7. Backend serves /terminate and /bypass but no FE caller exists — operators cannot record cleaning-cycle deviations
`apps/api/src/modules/filter-operations/routes.ts:307` (`POST /:id/bypass`) and `:458` (`POST /:id/terminate-cycle`) are live; matching reauth actions `BYPASS_FILTER_STAGE` and `TERMINATE_CLEANING_CYCLE` are defined (`reauth-actions.ts:71-72`). `grep '/terminate|/bypass|TERMINATE_CLEANING_CYCLE|BYPASS_FILTER_STAGE' apps/web/src/routes/` returns ZERO matches. Either:
1. The terminate/bypass UI affordances were removed from `filter-operations.tsx`/`mobile-operations.tsx` in a recent refactor, OR
2. They were never added.
Under 21 CFR Part 11 § 11.10(k) operators must be able to record deviations as part of normal operations. Without UI, the only way to terminate a stuck cycle is direct DB intervention.
**Fix:** restore (or add) terminate-cycle and bypass-stage controls to the operations pages; gate via the existing reauth actions.

---

## High

### Reauth coverage gaps (no action defined; product decision needed before code change)
These surfaces are unprotected by reauth, but the right fix is **not** to wrap with an arbitrary key — it's to decide whether the operation deserves reauth, name an action key, then wrap. Each H-item below proposes a likely answer; product/compliance should confirm.

### H1. `apps/web/src/routes/config/access-matrix.tsx:91` — privilege-matrix save has no reauth action
`apiClient.put('/api/config/access-matrix', draft)` writes role→privilege bindings without challenge. This is the access-control source-of-truth. Closest existing action: `UPDATE_ROLE_CONFIG` (`reauth-actions.ts:27`).
**Decision needed:** treat as `UPDATE_ROLE_CONFIG` reuse, or define `UPDATE_ACCESS_MATRIX` as a distinct audit key (so role-config edits and matrix edits don't overlap in the audit trail — same reasoning as M1/M2 audits this month).

### H2. `apps/web/src/routes/config/ldap.tsx:71` — LDAP config save has no reauth action
`api.put('/api/ldap/config', config)` writes the directory-server bind credentials. Sensitivity: changing LDAP base-DN can redirect every login to an attacker-controlled directory. No `UPDATE_LDAP` action.
**Decision needed:** add `UPDATE_LDAP_CONFIG` (preferred for audit clarity) OR reuse `UPDATE_LOGIN_SECURITY` (`reauth-actions.ts:22`).

### H3. `apps/web/src/routes/config/template-kinds.tsx:81,107,132,142` — template-kinds CRUD has no reauth action
PUT/POST/DELETE/toggle all unwrapped. Template kinds are the controlled vocabulary that drives Filter / Block / AHU / etc. classification — adding/renaming a kind has cascade effects on every entity using it.
**Decision needed:** add `CREATE_TEMPLATE_KIND` / `UPDATE_TEMPLATE_KIND` / `DELETE_TEMPLATE_KIND` (preferred) OR reuse the existing `*_ASSET_TEMPLATE` actions (`reauth-actions.ts:39-41`).

### H4. `apps/web/src/routes/audit/index.tsx:101,116` — audit deletion has no reauth action
`deleteSingleAudit` and `bulkDeleteAudit` strip rows from the immutable audit table with no challenge. SUPER_ADMIN-gated by row visibility (`isSuperAdmin` checks at lines 233/265/298), but role-bypass to reauth narrows the blast radius, doesn't eliminate it.
**Decision needed:** under 21 CFR Part 11 § 11.10(e), audit-trail records must be "secure" — discuss whether deletion should be allowed at all. If yes, add `DELETE_AUDIT_RECORD` / `BULK_DELETE_AUDIT_RECORDS`. If no, remove the UI.

### H5. `apps/web/src/routes/config/notification-rules/index.tsx:208,210,222,227,527,536,548,556,666,668,680,810` — twelve mutations have no reauth coverage
Notification rules + user groups + members + templates + log delete. No `*_NOTIFICATION_*` actions defined.
**Decision needed:** introduce `CREATE_NOTIFICATION_RULE` / `UPDATE_NOTIFICATION_RULE` / `DELETE_NOTIFICATION_RULE` (and template/user-group equivalents). Routine-config style, low audit pressure — could be batched into one `UPDATE_NOTIFICATION_CONFIG` umbrella key for simplicity if granular trail isn't required.

### H6. `apps/web/src/routes/checklist-form/index.tsx:143-184` — submit lacks BOTH reauth wrap AND signature-capture flow
The action key `SUBMIT_CHECKLIST_WITH_SIGNATURE` (`reauth-actions.ts:56`) implies a signature flow. The page does NOT read `template.signatureConfig` anywhere — no signer-name input, no meaning-of-signature input, no signature image capture before submit. Compare to `alarms/index.tsx:222-250` which DOES enforce `signerFullName` + `meaning` before sending. So:
1. **If signing is required for this entity's template:** the page is missing the signature UI entirely. Add the signer-name + meaning fields, wrap submit in `reauth.execute('SUBMIT_CHECKLIST_WITH_SIGNATURE', …)`.
2. **If signing is optional:** the page should branch — collect signature when `template.signatureConfig?.required`, wrap reauth conditionally.
3. **If signing is never required for this surface:** the action key is misnamed; rename to `SUBMIT_CHECKLIST` or delete and use no reauth.
**Decision needed first** before writing the fix.

### H7. `config/dashboard-cards.tsx:71`, `config/cleaning-profile-assignment.tsx:148`, `config/filter-cleaning-reasons.tsx:28`, `config/notification-settings/email-settings.tsx:197,668`, `config/ahu-filter-set-config.tsx:41` — five more config writes with no reauth coverage
Same product decision as H1-H5 in miniature. Likely batchable into one or two umbrella keys (`UPDATE_DASHBOARD_CONFIG`, `UPDATE_FILTER_OPS_CONFIG`).

### H8. `pm-schedules/detail.tsx:17` — startPm posts `/api/pm-executions` with no reauth
No `START_PM_EXECUTION` action exists. Starting a PM run is a recorded operator action — currently treated as routine work, mirroring filter-stage advancement (also unchallenged).
**Decision needed:** consistent with cleaning advancement (no reauth) or different (PM = scheduled compliance event, deserves challenge)?

---

## Medium

### M1. `apps/web/src/routes/approvals/index.tsx:37` — comment field not trimmed before send
`handleProcess` sends `comment: processComment || undefined`. If user types whitespace-only the request goes through with leading/trailing whitespace (or, for a single space, with `' '` rather than undefined). Compare to `pm-schedules/index.tsx:210` which calls `.trim()` before send and to admin-requests `:58` which trims+validates non-empty.
**Fix:** `comment: processComment.trim() || undefined`. The disabled-state check at `:193` already validates `.trim()` so this is just send-side hygiene.

### M2. `apps/web/src/routes/main.tsx:243` — `/admin-requests` guard uses `USER_CREATE`
Approving an admin request is not the same operation as creating a user (the M1 audit fix even made this point — see `reauth-actions.ts:13-18`). A reset-password approver doesn't need user-creation rights. Consider adding `ADMIN_REQUEST_APPROVE` permission and gating the route on it.

### M3. `apps/web/src/routes/mobile/mobile-operations.tsx:1415` — `bg-slate-900/95` violates light-theme-only
Floating debug log overlay. Light-theme rule says "no dark theme classes anywhere." Two other matches (`rule-chains/editor/dialogs/AddNodeDialog.tsx:86`, `AddConnectionDialog.tsx:68`) use `bg-slate-900/60` as dialog backdrop scrims — conventional, acceptable. `mobile-operations.tsx:1415` is different: foreground UI with `text-emerald-300` against near-black. Either gate to a debug-only affordance or recolor to `bg-slate-50 / text-slate-700`. `assets/components/tabs/connectivity-tab.tsx:329` (`bg-slate-900` for code-block preview) is also acceptable per convention.

---

## Low

### L1. `apps/web/src/routes/filter-management/retirement-list.tsx`, `replacement-list.tsx`, `filter-traceability.tsx`, `filter-status.tsx`, `filter-scan.tsx`, `cleaning-cycles/history.tsx`, `cleaning-cycles/timeline.tsx` — pure viewers
No reauth-relevant findings. Retire mutation is correctly wrapped at `filter-list.tsx:594`.

### L2. `apps/web/src/routes/notifications/index.tsx` — read-state mutations bypass reauth (intentional)
Mark-read / mark-unread / bulk-delete / single-delete (`apiClient.put` / `apiClient.post` / `apiClient.delete` at lines 137-201). No `*_NOTIFICATION_*` reauth actions defined; treating notification-state changes as routine UI affordances is reasonable — flag only.

### L3. `apps/web/src/routes/filter-management/cleaning-profile-editor.tsx:229` — dead `setSaving(false)` after fire-and-forget reauth.execute
`reauth.execute(...)` returns void; the inner `finally { setSaving(false) }` at line 227 already covers cleanup. Line 229 is reachable but inert. Hygiene only.

### L4. `apps/web/src/routes/main.tsx:177` — dashboard-cards uses `roles=['SUPER_ADMIN', 'ADMIN']` instead of perms
Inconsistent with neighbouring config routes that use `permissions=[CONFIG_READ]`. Hardcoded roles can't be re-assigned via Role Privileges. Migrate to a privilege when one is defined.

### L5. `apps/web/src/routes/main.tsx:167,172-174,176,178-182,206,209` — `roles=['SUPER_ADMIN']` proliferates
10 routes are hardcoded to SUPER_ADMIN-only with no privilege fallback. Each represents a privilege the access-matrix UI cannot grant. Document explicitly which are intentionally locked (branding, access-matrix, action-reauth themselves) vs which should become assignable (help, retention, notification-rules, alarm-columns, audit-templates, pagination, dashboard-cards, email-settings, sms-settings).

### L6. `apps/web/src/routes/checklist-form/index.tsx:295` — hardcoded colors instead of theme vars
Should use `var(--theme-gradient-from)` / `var(--theme-gradient-to)` to honour the 10 color themes (`packages/shared` Phase 4). Same in `apps/web/src/routes/rule-chains/index.tsx:445,495` and other rule-chains dialogs.

### L7. `apps/web/src/routes/main.tsx:213,218-220,186,223,244` — multi-perm route guards confirmed permissive
Verified `RequireRole` at `apps/web/src/components/require-role.tsx:40` uses `permissions.some(p => user.permissions!.includes(p))` — OR semantics. So `/notifications` (`NOTIFICATION_VIEW`/`NOTIFICATION_MANAGE`) and similar multi-perm routes correctly admit users with any one permission. Document the OR convention in the JSX guards if unclear.

---

## Design challenges (not bugs but worth raising)

### D1. Tablet/web duplicated approval handler — extract a shared hook
C1 and C2 are the same bug because `approvals/index.tsx` and `mobile/mobile-wrapper.tsx` carry parallel implementations of the same business logic. The CLAUDE.md rule "tablet must NOT have a separate implementation" was created to prevent exactly this drift. The mobile-wrapper renders `MobileOperationsPage` for cleaning ops (good — unified), but inlines its own copy of approvals UI. Recommend extracting `useBlockChangeApproval()` + a shared `<ApprovalRow>` component.

### D2. Reauth-action coverage matrix is implicit and decays
Of the 87 declared reauth actions, this review found at least 2 dead at the FE layer (C7: `TERMINATE_CLEANING_CYCLE` + `BYPASS_FILTER_STAGE`) and at least 25 mutation sites lacking reauth wraps (C1-C7 + H1-H8). The 12-touchpoint rule (CLAUDE.md "Config sync rule") doesn't catch reauth drift because there's no test that asserts every defined action has at least one call site. Recommend a build-time test:
```ts
test('every REAUTH_ACTION has a call site', () => {
  for (const action of Object.keys(REAUTH_ACTIONS)) {
    const hits = grep(`reauth.execute('${action}'`, 'apps/web/src/routes/');
    expect(hits.length, `${action} has no call site`).toBeGreaterThan(0);
  }
});
```
Symmetric test: every `apiClient.post/put/delete` (excluding GET helpers) should be inside a `reauth.execute` lexically — or explicitly exempted via a `// reauth: not-required (...reason)` comment that the linter scans for.

### D3. Inconsistent guard styles in `main.tsx`
Mix of `roles=['SUPER_ADMIN']` (10×), `permissions=[CONFIG_READ]` (mixed across CONFIG_READ / CONFIG_UPDATE / specific privileges), and OR-perms (5+ routes). Standardise on one model: privileges-only + a "SUPER_ADMIN bypass" baked into `RequireRole`. Roles in the guard should be the exception, not the norm — and each one should have a justifying comment.

### D4. `connectionInfo` handling is consistent but verbose
Filter-operations.tsx alone has 5 near-identical `if (e?.code === 'BLOCK_CHANGE_REQUIRED' && e?.connectionInfo) { setBlockChangeDialog({…}) }` blocks (lines 409, 702, 866, 933, 1030, 1090). Mobile-operations has 4 more. Extract a `handleBlockChangeError(err, fallbackFilterId, fallbackFilterName)` helper. Bonus: easier to extend when other error-with-connectionInfo flows are added.

### D5. Dynamic attributeSchema rendering only covers Create/Edit dialogs
`filter-list.tsx` reads `attributeSchema` for CSV bulk-upload columns (line 769-774), the create dialog (`CreateFilterDialog.tsx`), and the edit dialog. The `entity-detail-panel.tsx:89` and `attributes-tab.tsx:12` render attributes for assets generally. Verify that `add-entity-wizard.tsx:178-217` step 3 shows ALL `dropdownOptions` (it does, line 88-90 for select rendering). This area is in good shape.

---

## Out-of-scope (noticed but did not review)

- 23 sub-component files under `apps/web/src/routes/assets/components/`, `audit/components/`, `config/branding-components/`, `config/roles-components/`, `report-templates/components/`, `rule-chains/editor/dialogs/`, `filter-management/components/`, `filter-management/filter-list/dialogs/`, `checklist-form/components/`, `mobile/` — covered only by their consuming page reads.
- `apps/web/src/components/` (layout, ErrorBoundary, ToastProvider, ReauthDialog) — out of scope per the brief; `RequireRole` was inspected for L7 (semantics confirmed OR).
- `apps/web/src/lib/` — connectivity, sync-engine, api-client, themes — out of scope.
- `apps/web/src/hooks/use-reauth.ts` — out of scope, but the surface (`reauth.execute(action, fn, opts)`) is consistent everywhere it IS called, which is good.
- Backend `apps/api/src/modules/*` route guards — cannot verify FE-vs-BE permission alignment for `FEATURE_TO_PERMISSION_MAP` from inside FE only.

---

## Notes
- All file paths are absolute paths inside the worktree at `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification\`.
- Reauth-action ground truth: `packages/shared/src/types/reauth-actions.ts` — 87 actions across 16 categories, verified against the worktree branch `feature/phase5-verification` (descended from RFID).
- `reauth.execute()` call-site inventory: 86 occurrences across 30 files in `apps/web/src/routes/` — most concentrated in `filter-list.tsx` (12), `assets/hooks/use-asset-mutations.ts` (10), `pm-schedules/index.tsx` (3), `report-templates/index.tsx` (4).
