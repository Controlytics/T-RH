# Phase 3 — Business Analysis

Feature-by-feature analysis: purpose, workflow, rules, edge cases. Only features
that **exist** are documented; absent subsystems are listed in
[`../02-inventory/absent-subsystems.md`](../02-inventory/absent-subsystems.md).

---

## Feature map

| # | Feature | Regulatory driver | Module(s) |
|---|---|---|---|
| 1 | Authentication & session | §11.10(d), §11.300 | `auth` |
| 2 | Re-authentication (e-signature) | §11.200 | `lib/reauth-check.ts` + 19 modules |
| 3 | Audit trail | §11.10(e) | `audit` |
| 4 | User lifecycle | §11.10(d) | `users` |
| 5 | Roles & access control | §11.10(g) | `roles`, `config` |
| 6 | Admin requests (self-service) | §11.10(d) | `admin-requests` |
| 7 | Configuration management | §11.10(a) | `config` (21 surfaces) |
| 8 | Notifications | operational | `notifications`, `notification-*` |
| 9 | Dashboards | operational | `dashboards` |
| 10 | Backup & restore | §11.10(c) | `backup` |
| 11 | Reporting & export | §11.10(b) | `lib/pdf-report.ts`, `excel-export` |
| 12 | Help system | operational | `help` |
| 13 | System health & debug | operational | `system-health`, `debug-traces` |
| 14 | LDAP integration | optional | `ldap` |

---

## 1. Authentication & session

**Purpose.** Establish and maintain authorised access (§11.10(d)) with the
identification controls §11.300 requires.

**Workflow.**
```
POST /api/auth/login {username, password}
  ├─ user not found OR password wrong → unified error (no user enumeration)
  ├─ status DISABLED / LOCKED / EXPIRED → rejected with that reason
  ├─ existing active session → 409 CONFLICT with session details
  │     └─ client re-POSTs with {force:true} → old session terminated
  ├─ forcePasswordChange → JWT issued, client routed to /change-password
  │     (refresh is BLOCKED for fpc users — 403 FORCE_PASSWORD_CHANGE)
  └─ success → JWT + session row + AUDIT: LOGIN_SUCCESS
```

**Business rules.**
- **Single active session per user.** A second login must explicitly terminate
  the first. This is a shared-workstation control, and it is why the 409 branch
  exists rather than silently allowing concurrent sessions.
- **Token in `sessionStorage`, not `localStorage`** — deliberate: a shared
  workstation must not leak a token across browser sessions.
- **Single-tab enforcement** per user via `use-single-tab` (BroadcastChannel +
  localStorage heartbeat).
- **30-minute JWT refresh cycle**, plus one refresh ~5s after mount.
- **Idle timeout** with a warning dialog; `session_sweep` job expires stale rows.
- **Session auth cache is 30s** — and `logout` must invalidate it. (A real bug
  was fixed upstream where it did not, leaving a logged-out session valid for up
  to 30s.) A rebuild must not reintroduce this.

**Configurable** (`session` def): `sessionDurationHours`, `autoLogoutEnabled`,
`idleTimeoutMinutes`.

**Edge cases.** Network error ≠ 401: `use-auth` distinguishes them so a
connectivity blip does not log the user out. Cached user + token present keeps
the app authenticated; only a real 401 clears it.

## 2. Re-authentication (electronic signature)

**Purpose.** §11.200 requires that a signing action be executed by the person
whose signature it is — so sensitive operations demand password re-entry.

**Workflow.** Client calls the operation → server `enforceReauth(action)` →
if no valid recent re-auth, responds `401 REAUTH_REQUIRED` → client opens
`ReauthDialog` → user re-enters password → operation retried with the credential.

**Rules.**
- **39 reauth actions** across categories; which actions require re-auth is
  **admin-configurable** via the `action-reauth` config surface.
- **10-second in-memory cache** (`lib/reauth-check.ts`) so a multi-step operation
  does not prompt repeatedly.
- Enforced in **19 of 18 modules' route files** (`grep -rl enforceReauth`).
- Approval/decision flows additionally require **remarks** — a reason string is
  part of the record.

**Rebuild note.** The dialog suppresses password autofill and manages focus on
close; both are deliberate (autofilled signatures would defeat the control).

## 3. Audit trail

**Purpose.** §11.10(e) — a secure, computer-generated, time-stamped audit trail
that independently records operator entries and actions, and does not obscure
previously recorded information.

**Workflow.** Every auditable action calls `writeAudit()` inside the operation's
transaction, appending a row whose checksum covers its own fields **and** the
previous row's checksum.

**Recorded per row:** timestamp, user id/name/role, action, target type/id,
before value, after value, reason, IP, user agent, session id, checksum,
checksum version, previous checksum, chain position, signature meaning.

**Rules.**
- **Append-only.** Enforced at three layers — application, the
  `audit_trail_no_delete` DB trigger, and the cryptographic chain.
- **Redaction is the supported removal path** (`POST /api/audit/:id/redact`):
  blanks values in place, records `redacted_at` / `redacted_by` /
  `redaction_reason`, and **preserves the chain**.
- **Hard delete exists but is off by default** (`AUDIT_DELETE` permission,
  granted to no role). It disables the trigger for one transaction, writes a
  meta-audit row recording who/what/why *before* destroying the target, then
  re-enables. **It permanently breaks the chain** — and verification was
  deliberately *not* taught to tolerate this, so the breakage stays loud.
- **Verification** — `GET /api/audit/verify-chain` walks the chain.
- **Registry entries for removed subsystems are retained** so historic rows
  still render correctly for an inspector, even though nothing emits them now.
  This is a compliance requirement, not dead code.

Full mechanics: [`../05-database/audit-chain.md`](../05-database/audit-chain.md).

## 4. User lifecycle

**States** (`UserStatus`): `ENABLED`, `DISABLED`, `LOCKED`, `EXPIRED`.

**Workflow.** Create → (forced password change on first login) → active →
{disable / lock via failed attempts / expire via password age} → unlock/reset →
active. Deletion is reserved for SUPER_ADMIN and is a re-auth action.

**Password policy** (all configurable, `password-policy` def): `minLength`,
`maxLength`, `requireUppercase`, `requireLowercase`, `requireNumbers`,
`requireSpecialChars`, `preventReuseCount`, `maxFailedAttempts`,
`passwordExpiryDays`, `expiryNotificationDays`.

**Rules.**
- Password history is retained (`PasswordHistory` model) to enforce
  `preventReuseCount`.
- `maxFailedAttempts` drives lockout; lockout type/duration configured in
  `login-security` (`lockoutType`, `lockoutDurationMinutes`).
- Expiry is evaluated by the `password_expiry_check` background job, which also
  emits advance-warning notifications (`expiryNotificationDays`).
- **User ID format is configurable** (`user-id` def: `format`, `length`,
  `autoGenerate`) — sites have their own employee-ID conventions.
- The seed **throws** if `INITIAL_ADMIN_PASSWORD` is unset — no hardcoded
  default credential is permitted to reach an install.

## 5. Roles & access control

Six seeded roles with a hierarchy level (verified from the live `roles` table):

| Role | Level | Permissions |
|---|---|---|
| SUPER_ADMIN | 6 | 29 |
| ADMIN | 5 | 26 |
| SUPERVISOR | 4 | 4 |
| MAINTENANCE | 3 | 3 |
| OPERATOR | 2 | 3 |
| VIEWER | 1 | 3 |

Custom roles can be created. Full analysis:
[`../04-roles-permissions/README.md`](../04-roles-permissions/README.md).

## 6. Admin requests (self-service)

**Purpose.** Let an unauthenticated or limited user request an administrative
action without granting them the permission — preserving least privilege while
staying operationally practical.

**Model.** `AdminRequest` — `requestType` ∈ {`CREATE_USER`, `MODIFY_USER`,
`UNLOCK`, `FORGOT_PASSWORD`}; `status` ∈ {`PENDING`, `APPROVED`, `REJECTED`}.

**Workflow.**
```
Requester (public /contact-admin) → AdminRequest {PENDING, requestData, remarks}
   → notification to approvers
   → approver opens /admin-requests
      ├─ APPROVE → adminRemarks required → side effect executed → AUDIT
      └─ REJECT  → adminRemarks required → no side effect       → AUDIT
```

**Rules.**
- Two distinct permissions — `ADMIN_REQUEST_APPROVE` and
  `ADMIN_REQUEST_REJECT`. There is deliberately **no view-only level**: the page
  is visible to anyone holding either. (A single combined `..._REVIEW`
  permission was removed upstream precisely because it gated both the page and
  the actions, so it could never be revoked while the menu was enabled.)
- `adminRemarks` is mandatory on both outcomes — the record must carry a reason.
- `manualEntry` flags rows inserted through the data-management console rather
  than the public flow, so an inspector can distinguish them.
- `requestData` is type-specific JSONB — the shape depends on `requestType`.

## 7. Configuration management

**21 configuration surfaces**, auto-discovered at boot. Each definition declares
its own `moduleKey`, `permissions`, `requiredRole`, `requiresReauth`,
`reauthAction`, and either a custom page or the dynamic renderer.

**Rules.**
- Reads generally require `CONFIG_READ` (27 route usages); writes
  `CONFIG_UPDATE` (31 usages).
- Sensitive surfaces additionally demand re-auth via their declared
  `reauthAction`.
- Secrets are masked on read (`lib/mask-secrets.ts`) — SMTP passwords and
  similar never round-trip to the client in clear.
- Config changes are audited with before/after values.

## 8. Notifications

**Models:** `Notification` (per-user inbox), `NotificationTemplate`,
`NotificationLog`, `NotificationRule`, `NotificationRuleRecipient`.

**Channels** (`NotificationChannel`) and delivery states
(`NotificationDeliveryStatus`) are enums; delivery is asynchronous through the
`notification` graphile-worker task, and every attempt is logged.

**Rules.**
- Rules bind a `NotificationEventType` to recipients (users, roles, or groups).
- `NotificationEventType` **still contains upstream domain values**
  (`DEVICE_ONLINE`, `DEVICE_OFFLINE`, `DEVICE_INACTIVITY`,
  `CHECKLIST_SUBMITTED/APPROVED/REJECTED`) that nothing emits in
  compliance-core. Live values are `USER_LOGIN`, `USER_CREATED`, `USER_LOCKED`,
  `SYSTEM_ERROR`. **A rebuild should model only the live four** and treat the
  rest as removed — but must retain the ability to *render* historic values.
- `NOTIFICATION_DELETE` is a real grantable permission (not SUPER_ADMIN-only).
- `NOTIFICATION_VIEW` / `NOTIFICATION_MANAGE` are enforced by **no route** —
  notification endpoints are user-scoped/auth-only. They are visibility toggles.
  A rebuild should either enforce them or drop them; today they are cosmetic.

## 9. Dashboards

`Dashboard`, `DashboardWidget`, `DashboardAssignment`. Four permissions
(`DASHBOARD_VIEW/CREATE/MANAGE/ASSIGN`). Dashboard **card visibility is
per-role**, configured on Appearance → Dashboard Cards and stored under the
`dashboard-cards` config key; the backend validates submitted keys against a
`VALID_CARD_KEYS` allow-list that must stay in sync with the frontend list.
Current cards: `total_users`, `audit_trail`, `notifications`, `quick_actions`.

## 10. Backup & restore

Three permissions: `BACKUP_MANAGE`, `BACKUP_EXPORT`, `BACKUP_RESTORE`. Backup
covers all tables dynamically. `scripts/backup-db.ps1` +
`register-backup-task.ps1` provide scheduled OS-level backups.

**Rule.** Restore includes `password_hash`, so a restore is a genuine
point-in-time recovery rather than one that silently locks everyone out.

## 11. Reporting & export

**On-screen report chrome** (`components/report-page-wrapper.tsx`) is shared by
report pages; **PDF** is client-side (jsPDF + autotable) via `lib/pdf-report.ts`;
**Excel** via ExcelJS.

**Rules.**
- Export limits are configurable (`export-limit` def: max records + message).
- Export formats are configurable (`export-options` def).
- Report identity (company + application name) comes from `report-page-titles`,
  falling back to Branding.
- Audit export requires `AUDIT_EXPORT`.
- **Report labels and signatories are no longer configurable** — those config
  defs were dropped in the Phase 0 strip, so the resolvers now return built-in
  defaults. A rebuild should either restore the config surfaces or remove the
  indirection; the current half-state is a strip artefact.

## 12. Help system

`HelpArticle` + `HelpArticleVersion` — versioned in-app documentation, seeded
with 33 articles. Keyed by article `key` for deep-linking from feature pages.

## 13. System health & debug traces

- **System health** — one endpoint surfacing server/system metrics, plus
  `/health` for liveness (returns even unauthenticated, so TLS/uptime can be
  probed).
- **Debug traces** — reads from `audit_trail`, rendering each audited action as
  a single-stage SUCCESS trace. **Known limitation:** only successes are
  represented; there are no error codes or durations, because the original
  pipeline-trace hypertable was dropped. Gated by `READ_DEBUG_TRACE` /
  `MANAGE_DEBUG_TRACE`.

## 14. LDAP

Three endpoints for optional directory integration. Not required for operation;
local accounts are the default.

---

## Cross-cutting rules a rebuild must preserve

1. **Every state-changing action writes an audit row, in the same transaction.**
2. **Approval/decision flows require remarks.** No silent approvals.
3. **Sensitive actions require re-authentication**, and which ones is
   configurable rather than hardcoded.
4. **Secrets are masked on read** and never echoed back to a client.
5. **All text input is HTML-stripped** before persistence.
6. **Configuration is data, not code** — sites change policy without a redeploy.
7. **SUPER_ADMIN bypasses frontend permission checks** but is still audited.
8. **Grant set ≠ gate.** Never authorise by OR-ing a node's `permissions`.
