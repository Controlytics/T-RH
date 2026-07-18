# RBAC Redesign — Runtime Verification Checklist (Phases 2 / 3 / 5C)

Run these against your **local** API (`https://localhost:3000`, self-signed → `-k`). They confirm the
gating works against *real roles*, which I couldn't do (no low-privilege credentials). Bash/git-bash syntax.

## How to read results
- **`403`** = permission **denied** (the gate rejected the request). ✅ for the *negative* (unauthorized) cases.
- **`2xx`** OR **`401 REAUTH_REQUIRED`** = request **passed the permission gate** (401 just means it then wanted a password re-entry). ✅ for the *positive* (authorized) cases. A `401 REAUTH_REQUIRED` still proves the gate let you through.
- **`200` on a GET you expected to be blocked** = ❌ gap not closed — tell me.

## Setup — get 3 tokens
You need a token for **SUPER_ADMIN**, an **ADMIN**, and a **low-privilege** role (OPERATOR or VIEWER).
Your DB has these (e.g. `superadmin`, ADMIN `EMP-001`, OPERATOR `OPP48EPF`) — use passwords you know.

```bash
login() { curl -sk -X POST https://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$1\",\"password\":\"$2\"}" | sed -E 's/.*"token":"([^"]+)".*/\1/'; }

SA=$(login   superadmin 'YOUR_SA_PASSWORD')
ADMIN=$(login EMP-001    'YOUR_ADMIN_PASSWORD')     # any ADMIN-role user
OP=$(login    OPP48EPF   'YOUR_OPERATOR_PASSWORD')  # any OPERATOR-role user

# sanity: each should print a long JWT, not empty
echo "SA=${SA:0:12}…  ADMIN=${ADMIN:0:12}…  OP=${OP:0:12}…"

# helper: print just the HTTP status
code() { curl -sk -o /dev/null -w "%{http_code}\n" "$@"; }
H() { echo "-H"; echo "Authorization: Bearer $1"; }   # not used directly; see calls below
```

> **Safety:** the *negative* (403) checks are non-destructive — the request is rejected at the gate
> before any DB write. The *positive* checks on DELETE/PATCH endpoints **would mutate data** — only run
> those against a throwaway/test record, or just trust the 403 negatives (they prove the gate).

---

## Phase 2 — closed security gaps

**S4 — Report Reviews GETs require a report perm** (OPERATOR has none → 403; SA → 200):
```bash
code -H "Authorization: Bearer $OP" https://localhost:3000/api/report-reviews/queue      # expect 403
code -H "Authorization: Bearer $SA" https://localhost:3000/api/report-reviews/queue      # expect 200
```

**S2-help — Help GETs require CONFIG_READ** (OPERATOR lacks it → 403; ADMIN has it → 200):
```bash
code -H "Authorization: Bearer $OP"    https://localhost:3000/api/help                   # expect 403
code -H "Authorization: Bearer $ADMIN" https://localhost:3000/api/help                   # expect 200
```

**S1 — config access-matrix default-DENY** (no clean curl — verify in browser):
- Log in as **ADMIN** → open `/config` → you still see the 4 general cards (Password, Date/Time, Backup, User ID). ✅ (preserved)
- (Optional) a brand-new unconfigured config module would NOT appear for ADMIN until granted — the fail-open is closed.

---

## Phase 3 — FE/BE mismatch fixes (negatives are the safe, meaningful checks)

**M3 — user delete is SUPER_ADMIN-only** (ADMIN now blocked at the API). Use any real user id `UID`:
```bash
UID=<some-user-id>
code -X DELETE -H "Authorization: Bearer $ADMIN" https://localhost:3000/api/users/$UID  # expect 403 (was allowed pre-Phase-3)
# positive (SA) would actually delete — skip, or use a throwaway user.
```

**M4 — PM schedule delete is SUPER_ADMIN-only** (ADMIN blocked):
```bash
PMID=<some-pm-schedule-id>
code -X DELETE -H "Authorization: Bearer $ADMIN" https://localhost:3000/api/pm-schedules/$PMID  # expect 403
```

**M2 — retire/replace require FILTER_RETIRE/REPLACE** (OPERATOR has FILTER_OPERATE but not these → 403).
This is a POST with a body; a 403 fires before the body matters:
```bash
FID=<some-filter-id>
code -X POST -H "Authorization: Bearer $OP" -H "Content-Type: application/json" \
  -d '{"remarks":"verify"}' https://localhost:3000/api/filters/$FID/retire               # expect 403
# ADMIN (has FILTER_RETIRE) → expect 401 REAUTH_REQUIRED or 200, NOT 403 (don't run unless you want a real retire)
```

**M1 — filter status update requires FILTER_STATUS_UPDATE** (a MAINTENANCE user with ASSET_UPDATE but not
FILTER_STATUS_UPDATE → 403). If you have a MAINTENANCE-role token `MAINT`:
```bash
code -X PATCH -H "Authorization: Bearer $MAINT" -H "Content-Type: application/json" \
  -d '{}' https://localhost:3000/api/assets/instances/$FID/lifecycle-state               # expect 403
```

**M6 — role/reauth config requires ROLE_MANAGE.** No seed role has CONFIG_UPDATE-without-ROLE_MANAGE, so
this is only exploitable by a custom role. To test: create a custom role with `CONFIG_UPDATE` but NOT
`ROLE_MANAGE`, log in as a user with it, then:
```bash
code -X PUT -H "Authorization: Bearer $CUSTOM" -H "Content-Type: application/json" \
  -d '{}' https://localhost:3000/api/config/action-reauth                                 # expect 403
```
(Skip if you don't want to create a test role — it was a theoretical hole, now closed.)

---

## Phase 5C — button gating (frontend → verify visually per role)

The backend gates are covered by Phases 2/3 above; 5C makes the *buttons* match. Log in to the web app
(`http://localhost:5175`) as each role and confirm:

| Page | As OPERATOR / low-priv | As ADMIN | As SUPER_ADMIN |
|---|---|---|---|
| **Users** | no Create / Edit / Delete / Reset-Requests buttons | Edit/Enable/Disable/Unlock + Create; **no Delete** (SA-only) | all incl. Delete |
| **Stage Approvals** | **no** Approve/Reject (was wrongly shown before) | Approve/Reject if STAGE_APPROVAL_DECIDE | all |
| **Report Reviews** | page Access-Denied / no Review-Approve | Review/Approve if perm | all |
| **Filters** | view only (no add/edit/delete/retire) | create/edit/delete/retire/replace | all |
| **Cleaning Profiles / Checklists** | no create/edit/delete; **toggle only if FCP_UPDATE/\*_EDIT** (theater-fixed) | per perms | all |
| **PM Schedules** | no New/Upload/Edit; **Delete only for SUPER_ADMIN** | New/Upload/Edit; Approve/Reject only if the workflow approver/reviewer role | all |

Key 5C corrections to spot-check: **Users "Create" now hidden** from non-USER_CREATE roles; **Stage
Approvals / Report Reviews approve buttons hidden** from view-only users; **toggle buttons** on Cleaning
Profiles/Checklists hidden from `CP_TOGGLE`/`CHECKLIST_TOGGLE`-only holders (theater fix).

---

## If anything is wrong
A `200` where you expected `403` (Phase 2/3), or a button visible where the table says it shouldn't be
(5C) = a gap. Note the page/endpoint + the role and tell me — it's a quick fix.
