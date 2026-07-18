# Unused-Tables + Hard-Delete Audit (2026-05-25)

Operator asked: "remove the data which deleted in application that data should be delete from the dbs also" + "tables which are not linked or using in application remove those also".

This is a **scoping document**, not an action plan. Direct table-drops and hard-deletes have 21 CFR Part 11 compliance implications. Decide before acting.

## 1. Soft-delete patterns currently in the codebase

These tables/columns implement **soft delete** (row stays, status flips) because the audit chain references them by ID forever:

| Table | Soft-delete signal | Why hard-delete is dangerous |
|---|---|---|
| `users` | `status = 'DISABLED'` (column `UserStatus`) | `audit_trail.user_id` and `cleaning_cycles.created_by` reference username + UUID. Hard-deleting orphans every audit row that mentions them — auditor can't trace "who did this". **21 CFR §11.10(e)** retention violation. |
| `roles` | row stays; `is_active=false` not yet wired | Role names live in `audit_trail.user_role`. Same concern. |
| `cleaning_cycles` | `status = 'TERMINATED'` (not deleted) | Every cycle has `filter_events` children with the cycle's full history. Cycle FK is RESTRICT, can't delete with children. **Compliance: §11.10(b) preserve full record**. |
| `filter_cleaning_profiles` | `status = 'ARCHIVED'` | Old cycles' `profile_id` FK references archived profiles. Hard-delete → cycle history loses pipeline context for audit replay. |
| `filter_profiles` | `is_active = false` (or row deleted — see your current empty table) | Same — historical cycles may FK into archived FilterProfiles. |
| `checklist_profiles` | versioning via `ChecklistProfileVersion` sidecar | Cycles pin `checklistVersionPins` to specific versions; hard-delete a profile and the historical checklist questions become unrecoverable. |
| `equipment_groups` | `is_active = false` + version pin in `EquipmentGroupVersion` | Same versioning concern — cycle's reading validation reads pinned version. |
| `system_config` | row stays; new value overwrites old | Audit trail `CONFIG_CHANGED` event captures `beforeValue`/`afterValue`. Dropping rows breaks history-restore capability. |

**Conclusion**: Hard-delete is **NOT safe** for any of the above unless you accept losing the audit chain. The compliant pattern is what's already in place.

## 2. Hard-delete cases that ARE safe

These tables don't have audit-chain references and can be safely hard-deleted when the corresponding UI delete fires:

| Table | When UI delete should hard-delete |
|---|---|
| `notifications` | When user clicks "Clear all" — the notification has served its purpose. Already hard-deleted today. |
| `password_reset_requests` | After resolution (approved/rejected). Currently soft-state via `status` column; could prune > 90 days. |
| `block_change_requests` | Same — after resolution + N days. Currently stays forever. |
| `password_history` | Beyond `preventReuseCount` × small buffer — older hashes have no business value. |
| `sessions` (`is_active=false`) | Currently kept forever; could prune > 30 days. |
| Untracked `.cdp-*.cjs` dev scripts in repo root | Already in working tree as test scripts; could `.gitignore` or delete. |

**These are safe candidates for a periodic cleanup job (e.g., daily cron drops `notifications` > 90 days, `sessions` > 30 days, etc.).**

## 3. Tables likely never queried from app code

Audit method: `grep -rE "prisma\.<modelName>\." apps/ packages/` — if 0 non-test matches, candidate for drop.

Status of each table needs to be verified by running the audit; not done in this document. Likely candidates based on rule-chain + alarm tear-out today (2026-05-17 commit cd5e018 / earlier):

| Suspect table | Why suspect |
|---|---|
| Any leftover `_alarms` / `_rule_chain*` tables | The 2026-05-17 tear-out dropped 5 Prisma models but Postgres tables may have lingered if a migration was missed. **Verify with `\dt _alarm*` `\dt _rule*`**. |
| `template_kinds` lookup table | Added in Step 1; if admin never used it, only seed entries exist. Still referenced by `asset_templates.template_kind`, so don't drop. |
| Audit-related tables for non-existent actions | The `audit_actions` constants list 100+ actions; many may never fire in this deployment. Tables are still needed (the constants gate what CAN be written). |

**Recommendation**: run the grep audit before dropping anything. A drop is irreversible; a rename or comment-out is safer for ambiguous tables.

## 4. The 21 CFR Part 11 trade-off, stated plainly

The codebase's compliance posture rests on three things:

1. **Hash-chained `audit_trail`** — every row references the previous row's checksum. Deleting any row breaks every subsequent row's hash.
2. **Immutable `filter_events`** — never modified, never deleted. Per-cycle history is permanent.
3. **Soft-delete + versioning** — historical data stays referenceable.

If you accept dropping #3 (hard-delete), you weaken inspector reach to:
- "Who deleted this filter?" → no longer answerable
- "What was the cleaning profile when this cycle ran?" → no longer answerable if profile was hard-deleted
- "What user changed this config 3 months ago?" → no longer answerable if user was hard-deleted

If your facility's inspection posture doesn't require this depth, hard-delete is fine. If it does, keep soft-delete.

## 5. Recommended next actions

1. **Decide on inspection posture** (full §11.10 vs reduced). Without this, the right answer changes.
2. **For ANY hard-delete**: add a `tasks/HARD-DELETE-PROPOSAL.md` listing each entity type + the audit chain rows it would orphan. Get sign-off.
3. **For unused-table drop**: run the grep audit; only drop tables with 0 non-test references AND no FK reference from another live table.
4. **Quick wins ready today** (no compliance impact):
   - Periodic prune of `sessions` rows where `is_active = false AND expires_at < NOW() - INTERVAL '30 days'`
   - Periodic prune of `password_history` beyond `preventReuseCount` rows per user
   - Periodic prune of `block_change_requests` resolved > 90 days
   - Move all `.cdp-*.cjs` and `.cs*.json` files into `tasks/dev-scripts/` and `.gitignore` them

These four are safe, scoped, and shippable. The bigger restructure is a multi-day project.

---

Written 2026-05-25 in response to operator request, after the orphan re-parent + CWHH dedup work in commits `204316e` and onward.
