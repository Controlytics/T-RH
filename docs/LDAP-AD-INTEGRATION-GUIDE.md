# Active Directory Integration — Requirements, Setup & Operating Guide

**Audience:** the implementation team, and (Part 1) the client's IT team.
**Applies to:** compliance-core with the 2026-08-08 directory-authentication changes.
**Supersedes:** `old/docs-superseded/LDAP_INTEGRATION_GUIDE.md` (generic LDAP reference; still useful for OpenLDAP/FreeIPA specifics and troubleshooting).

---

## The one thing to say first

**You will never receive your employees' passwords, and the application never stores them.**

When someone signs in, the application forwards the password they just typed
straight to your Active Directory server and asks "is this correct?". AD answers
yes or no. Nothing is kept. This is the standard, and the only safe, way to do
directory authentication — a vendor who asks you to export passwords is doing
something wrong.

The same applies to employee IDs: you do not send us a list. Each employee's ID
arrives automatically the first time they log in, read from their AD record.

---

# Part 1 — What we need from the client

Send this section to the client's IT/AD administrator. Everything below is
information their AD administrator can produce in a few minutes.

## 1.1 The checklist

| # | What we need | Example | Where they find it |
|---|---|---|---|
| 1 | **Directory server address** | `ldaps://dc01.clientcorp.local:636` | AD admin knows; must be reachable from the application server |
| 2 | **Service account DN** | `CN=svc-compliance,OU=Service Accounts,DC=clientcorp,DC=local` | See §1.3 |
| 3 | **Service account password** | — | Sent separately, never by email in plain text |
| 4 | **Search Base DN** | `OU=Employees,DC=clientcorp,DC=local` | The branch containing employee accounts |
| 5 | **Parent group DN** | `CN=Compliance-Users,OU=Groups,DC=clientcorp,DC=local` | The group they described |
| 6 | **One DN per role group** | `CN=Compliance-Admin,OU=Groups,…` (×5) | See §1.4 |
| 7 | **Which attribute holds the employee ID** | `sAMAccountName` or `employeeID` | See §1.5 |
| 8 | **The AD server's CA certificate** | `clientcorp-root-ca.cer` | Required for `ldaps://` |
| 9 | **Firewall opened** | TCP 636 from app server → domain controller | Their network team |

## 1.2 What a "group link" actually is

The client said they would "create a group and give the link". There is no URL.
What we need is the group's **distinguishedName (DN)** — a text string that looks
like:

```
CN=Compliance-Users,OU=Groups,DC=clientcorp,DC=local
```

**How their admin gets it:**

1. Open **Active Directory Users and Computers** (`dsa.msc`).
2. Menu **View → Advanced Features** (this is off by default and the tab is hidden without it).
3. Find the group → right-click → **Properties** → **Attribute Editor** tab.
4. Scroll to `distinguishedName` → double-click → **Copy**.

Or, in PowerShell on any domain-joined machine:

```powershell
Get-ADGroup -Filter "Name -like 'Compliance-*'" | Select-Object Name, DistinguishedName
```

That single command produces every DN we need in item 6. Ask them to paste its
output.

## 1.3 The service account

We need one **read-only** account so the application can look users up before
authenticating them. It does **not** need to be a Domain Admin — a plain user
account with default read permissions is enough and is what we recommend.

```powershell
New-ADUser -Name "svc-compliance" `
           -SamAccountName "svc-compliance" `
           -Path "OU=Service Accounts,DC=clientcorp,DC=local" `
           -AccountPassword (Read-Host -AsSecureString "Password") `
           -PasswordNeverExpires $true `
           -Enabled $true
```

`-PasswordNeverExpires` matters: if this password expires, **every employee's
login stops working at once**, because the application can no longer look anyone
up. If their policy forbids non-expiring service passwords, they must tell us the
rotation date so we can update the configuration before it lapses.

## 1.4 The group structure

The client described: one parent group, containing role groups, containing
employees. That works. We need it laid out explicitly:

```
CN=Compliance-Users,OU=Groups,DC=clientcorp,DC=local     ← parent
├── CN=Compliance-Admin,OU=Groups,…
├── CN=Compliance-Supervisor,OU=Groups,…
├── CN=Compliance-QA,OU=Groups,…
├── CN=Compliance-Maintenance,OU=Groups,…
└── CN=Compliance-Operator,OU=Groups,…
```

Employees go into **exactly one** role group.

Two rules to give them:

- **One role group per person.** If someone lands in two, the application applies
  the higher-privilege role, which may not be what was intended. Ask them to
  keep the groups mutually exclusive.
- **Tell us the naming before they build it.** Renaming a group later breaks
  every mapping until we update the configuration.

## 1.5 Which attribute is the employee ID?

This decides what people actually type into the login box. Ask them to run:

```powershell
Get-ADUser -Identity <one-sample-employee> -Properties * |
  Select-Object sAMAccountName, employeeID, employeeNumber, userPrincipalName, mail
```

Then decide:

| If the employee ID is in… | We configure Username Attribute as | They log in with |
|---|---|---|
| `sAMAccountName` (the usual case) | `sAMAccountName` | `EMP1234` |
| `employeeID` / `employeeNumber` | `employeeID` | `EMP1234` |
| Email / UPN | `userPrincipalName` | `ravi@clientcorp.local` |

⚠️ If they choose `employeeID`, confirm it is **populated for every employee and
unique**. It is a free-text field in AD and is very often blank or duplicated.
Anyone with it blank cannot log in at all. `sAMAccountName` is guaranteed unique
and always populated, which is why it is the default.

## 1.6 The email to send them

> Hello,
>
> To connect your Active Directory to the compliance application, we need the
> following. **Please do not send us any employee passwords** — the application
> checks each person's password directly against your AD at sign-in and never
> stores or receives it.
>
> 1. The LDAPS address of a domain controller (e.g. `ldaps://dc01.yourdomain.local:636`)
> 2. A **read-only** service account: its full distinguishedName, and its password sent separately
> 3. The Search Base DN of the branch holding employee accounts
> 4. The **distinguishedName** of each role group you have created (Admin, Supervisor, Operator, QA, Maintenance) — the output of `Get-ADGroup -Filter "Name -like 'Compliance-*'" | Select Name, DistinguishedName` is exactly what we need
> 5. Which AD attribute holds your employee ID — the output of `Get-ADUser -Identity <a sample user> -Properties * | Select sAMAccountName, employeeID, userPrincipalName`
> 6. Your domain's root CA certificate (`.cer`)
> 7. Firewall access from our application server to your domain controller on TCP 636
>
> Employees do not need to be pre-registered. Each person appears in the
> application automatically the first time they sign in, with the role matching
> their AD group. To remove someone's access, remove them from the AD group.

---

# Part 2 — How we configure it

## 2.1 Prerequisites in the application

**Create the roles first.** Their role names must exist under
**Configuration → Roles & Access** before you map any group to them. The built-in
roles are `SUPER_ADMIN`, `ADMIN`, `SUPERVISOR`, `MAINTENANCE`, `OPERATOR`,
`VIEWER` — **`QA` does not exist and must be created**, with the permissions the
client's QA function requires.

If you map to a role that does not exist, the application now falls back to the
default role and writes the mismatch into the audit trail rather than creating a
user with a dangling role. That is a safety net, not a substitute for creating
the role.

## 2.2 Filling in Configuration → LDAP / Active Directory

| Field | Value |
|---|---|
| Enable LDAP Authentication | ON (leave OFF until Test Connection passes) |
| Server URL | `ldaps://dc01.clientcorp.local:636` |
| Bind DN | `CN=svc-compliance,OU=Service Accounts,DC=clientcorp,DC=local` |
| Bind Password | the service account password |
| Verify TLS Certificate | **ON** — see §2.6 |
| Connection Timeout | `5000` |
| Search Base DN | `OU=Employees,DC=clientcorp,DC=local` |
| Search Filter | see below |
| Username Attribute | `sAMAccountName` (or whatever §1.5 determined) |
| Group Attribute | `memberOf` |
| Full Name / Email / Department | `displayName` / `mail` / `department` |
| Sync attributes on every login | ON |

### The Search Filter — the most important field on the page

```
(&(sAMAccountName={{username}})(memberOf:1.2.840.113556.1.4.1941:=CN=Compliance-Users,OU=Groups,DC=clientcorp,DC=local))
```

Two things to understand:

- **`memberOf:1.2.840.113556.1.4.1941:=`** is AD's `LDAP_MATCHING_RULE_IN_CHAIN`.
  It follows nested groups. With the client's structure — employees in role
  groups, role groups inside the parent — a plain `memberOf=CN=Compliance-Users…`
  **matches nobody**, because no employee is a direct member of the parent. Using
  the matching rule is what makes their layout work.
- **Without the `memberOf` clause at all**, the filter is
  `(sAMAccountName={{username}})` and *every employee in the entire directory* can
  sign in and be auto-created. Never ship that.

### Access Restriction (the belt to the filter's braces)

Add each role group under **Access Restriction → Add Group**:

```
Compliance-Admin
Compliance-Supervisor
Compliance-QA
Compliance-Maintenance
Compliance-Operator
```

> ⚠️ **List the role sub-groups, never the parent.** This check reads `memberOf`,
> which reports only *direct* membership — it does not follow nesting. Entering
> `CN=Compliance-Users` (the parent) here matches nobody and refuses every login,
> while looking entirely reasonable on screen. Nesting is the search filter's job,
> via the matching rule above. This is the easiest mistake to make here, because
> the parent DN is the one the customer hands you.

The application checks this list in code after the password is verified. It exists
because until now, restricting access depended entirely on an administrator
remembering to type the `memberOf` clause correctly — one omission and the whole
directory was admitted with no warning anywhere. Full DN or bare group name both
work. Leaving the list empty imposes no restriction and the page warns you.

### Group-to-Role Mapping

Order does NOT matter (since 2026-10-12): when a person's groups match several
rows, the **highest-privilege role wins** (the role's hierarchy level; the list
order only breaks a tie between roles at the same level). A mapping to a role that
does not exist or is inactive never wins over one that does.

| LDAP Group | Role |
|---|---|
| `Compliance-Admin` | ADMIN |
| `Compliance-Supervisor` | SUPERVISOR |
| `Compliance-QA` | QA |
| `Compliance-Maintenance` | MAINTENANCE |
| `Compliance-Operator` | OPERATOR |

Set **Default Role** to your least-privileged role (`VIEWER`). It applies when
someone passes the access restriction but matches no role group — a
misconfiguration, so the safe landing spot is minimal privilege, not OPERATOR.

Mapping a group to `SUPER_ADMIN` is silently ignored. That account stays local so
it still works when the directory is unreachable.

## 2.3 TLS certificate

Install the client's root CA on the application server:

```powershell
Import-Certificate -FilePath .\clientcorp-root-ca.cer `
                   -CertStoreLocation Cert:\LocalMachine\Root
```

Verify the chain before enabling LDAP:

```powershell
$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(".\clientcorp-root-ca.cer")
$c.Subject; $c.NotAfter
```

Note `NotAfter` — when that CA expires, LDAPS stops working and every login fails.

## 2.4 Rehearse it before you touch the customer's directory

The repository ships an Active Directory stand-in that speaks the real LDAP
protocol, so you can walk the whole configuration end to end without a domain:

```bash
cd apps/api && npx tsx src/test-support/fake-ad-server.ts
```

It prints every value you need to paste into the configuration page, and serves
seven employees across the same five-role layout described in Part 1 — including
one who is in the directory but in no Compliance group, for step 6 below. Point
**Server URL** at `ldap://127.0.0.1:1389` and work through §2.2 exactly as you
would on site. `npx vitest run src/e2e/ldap-directory.e2e.test.ts` drives the same
server through 28 automated checks.

Two things the stand-in does NOT cover, so verify them on the real directory:
TLS (it listens on plain `ldap://`, so certificate trust and
`tlsRejectUnauthorized` are untested), and AD's own lockout, expiry and
disabled-account behaviour.

## 2.5 Test sequence

1. **Test Connection** — proves the service account binds. Failure here is
   network, credentials, or TLS; nothing else can work until it passes.
2. Turn **Enable** ON and **Save Configuration** (requires re-authentication).
3. Have one employee from **each** of the five role groups log in.
4. **Configuration → Users** — confirm five new users appear, each carrying the
   blue **AD** badge and the correct role.
5. Have the Supervisor and QA users each perform one **approval or signature**.
   This exercises the re-authentication path, which is separate from login and
   used to be broken for directory users (§3.1).
6. Have someone who is in the directory but in **no** Compliance group attempt to
   log in. They must be refused. If they get in, the search filter or access
   restriction is wrong — stop and fix it before go-live.
7. **Audit Trail** — confirm a `USER_CREATED` row per new employee showing
   `authSource: ldap`, the AD groups matched, and the role granted.

## 2.6 Do not turn off "Verify TLS Certificate"

With it off, an `ldaps://` connection accepts **any** certificate. Anyone able to
position themselves on the network path can present a self-signed certificate and
collect the service-account password plus every employee password in clear text.
If the connection fails with a certificate error, fix the CA trust (§2.3) — do not
disable the check.

---

# Part 3 — What changed in the application

Five defects made directory authentication unusable or unsafe in practice. All
are fixed; they are recorded here because each one shapes how the feature now
behaves.

## 3.1 Re-authentication could never succeed — CRITICAL

Every electronic signature (21 CFR §11.200) asks the user to re-enter their
password. That check compared the password against the placeholder text stored
for directory users, which can never match. **An AD-authenticated Supervisor or QA
could log in but could not approve, sign, bypass, terminate, or save any
reauth-gated configuration — every e-signature surface in the product.** Three
attempts also locked their account.

Both re-authentication paths now re-bind to the directory.
`lib/ldap-identity.ts` is the single helper they share, so they cannot drift apart
again.

## 3.2 Password expiry locked out every AD user after 90 days

The expiry clock ran on directory accounts, whose password this application never
changes. At `passwordExpiryDays` after provisioning (default 90) every AD user was
flagged "must change password" — and the change-password screen cannot serve them.
Directory users are now exempt at login, on every request, and in the nightly
notification sweep. Credential ageing is the directory's job.

## 3.3 "Reset Password" silently detached the account from AD

An admin clicking Reset Password on a directory user wrote a local password over
the placeholder. From that moment the employee's AD password no longer worked
and — much worse — **disabling them in AD no longer revoked their access here**,
because the credential had quietly become local. The action is now refused with an
explanation, in the UI and in the API. The same guard covers self-service change,
forgot-password, and approval of pending reset requests.

## 3.4 A mapped role that did not exist created a permission-less ghost

`users.role` has no foreign key. A mapping naming a role the application does not
have — a typo, or `QA` before anyone created it — produced a user who logged in
successfully to a completely empty application, with no error anywhere. Mappings
are now validated against the Roles table; a mismatch falls back to the default
role and records both names in the audit trail.

## 3.5 The config page silently disabled TLS verification

The page's own defaults said "off" while the backend said "on". An admin who
opened the page and saved before the stored config finished loading wrote "off" —
re-introducing §2.6's exposure through the UI. The defaults now match.

Also added: the **Access Restriction** list (§2.2), because group restriction
previously depended entirely on one hand-typed filter clause.

---

# Part 4 — Which settings apply to AD employees?

## 4.1 Configuration → General & Password Settings

| Setting | Applies to AD users? | Why |
|---|---|---|
| Minimum / Maximum Length | ❌ No | AD validates the password; this application never sees it |
| Require Uppercase / Lowercase / Numbers / Special | ❌ No | Same — enforce these in AD Group Policy instead |
| Prevent Reuse Count | ❌ No | Password history lives in AD |
| Password Expiry (days) | ❌ No | **Was a lockout bug** (§3.2). AD's own maximum password age governs |
| Password Expiry Notification (days) | ❌ No | AD/Windows notifies them |
| **Max Failed Attempts** | ❌ **Delegated** | See §4.2 |
| Session timeout / duration | ✅ **Yes** | This application owns its own sessions regardless of who authenticated |
| Re-authentication requirements | ✅ **Yes** | Still enforced — now correctly, against the directory (§3.1) |

**All password rules stay in effect for local accounts** — SUPER_ADMIN, and any
user you create manually. It is a per-account distinction, not a global switch.

## 4.2 Account lockout

Failed logins by directory users **do not** increment this application's lockout
counter; AD's own lockout policy governs. Counting in both places produces double
lockout — the application locks at 5 attempts while AD still considers the account
healthy, stranding an employee who holds valid credentials until an admin
intervenes here.

Failures are still **audited** in full. Only the counter is delegated, never the
record.

Legacy locked rows can still exist. Unlocking a directory user now clears the lock
**without** issuing a temporary password, and the dialog says so.

## 4.3 Configuration → User ID Format

**Exempt for AD users, deliberately.** Their employee ID is whatever the directory
says it is; this application has no standing to dictate another organisation's
naming convention, and enforcing a format would refuse real employees with no
self-service fix. The format still governs users you create locally.

## 4.4 Quick reference — what is managed where

| Concern | Managed in |
|---|---|
| Password, complexity, expiry, history | **Active Directory** |
| Account lockout for AD users | **Active Directory** |
| Who may sign in at all | **Both** — AD group membership + Access Restriction here |
| Role and permissions | **Both** — AD group decides the role, this application defines what the role can do |
| Session timeout, re-authentication | **This application** |
| Audit trail, electronic signatures | **This application** |
| Employee ID format | **Active Directory** |

---

# Part 5 — Day-to-day operation

## 5.1 Common tasks

| Task | Where | Notes |
|---|---|---|
| Add an employee | AD | Add to the right role group. They appear here on first login |
| Change someone's role | AD | Move them between role groups; applied at their **next login** |
| Remove access | AD | Remove from the group **and** disable the AD account |
| Reset a password | AD | Never here — the application refuses |
| Change what a role can do | **This application** | Configuration → Roles & Access |

## 5.2 Removal is not immediate — know this before go-live

Removing someone from an AD group takes effect at their **next login**. There is
no background sync. Someone with a live session keeps their current role until the
session ends.

To revoke access immediately: **disable the account in AD** (which fails their
next bind), and **disable the user here** (Configuration → Users → Disable), which
terminates their active sessions at once. Add both steps to the client's leaver
process.

Removed users are **not deleted** from this application. Their row stays for audit
integrity — 21 CFR Part 11 requires historic records to remain attributable — and
they simply can no longer authenticate.

## 5.3 Troubleshooting

| Symptom | Likely cause |
|---|---|
| Test Connection fails, "connection refused" | Firewall / port 636 not open, or wrong hostname |
| Test Connection fails, certificate error | Root CA not installed on the app server (§2.3) |
| Test Connection fails, "invalid credentials" | Service account DN or password wrong, or its password expired |
| One user can't log in, others can | Not in a required group; or their `sAMAccountName` differs from what they typed |
| **Nobody** can log in, suddenly | Service account password expired — the most common cause of a total outage |
| User logs in with no menus / empty application | Their mapped role does not exist or has no permissions — check the audit trail for `mappedRoleNotFound` |
| Everyone gets the default role | Group DNs in the mappings don't match reality; check nesting and §2.2 |
| Users from outside the intended group can log in | Search filter missing its `memberOf` clause, and Access Restriction empty |
| User can log in but cannot approve/sign | If this recurs after 2026-08-08, it is a regression of §3.1 — check `lib/ldap-identity.ts` |
| **Nobody** can log in, and the log says "not a member of any required group" | Access Restriction lists the PARENT group. Replace it with the role sub-groups — see §2.2 |
| Test Connection passes but every login fails with a TLS error | Fixed 2026-08-08: `ldap://` used to force a TLS handshake. If seen on an older build, use `ldaps://` or upgrade |

## 5.4 Emergency access

The `superadmin` account is **always local** and never goes through the directory.
If AD becomes unreachable, sign in as `superadmin` and turn **Enable LDAP
Authentication** off to fall back to local accounts. Directory users cannot sign
in while it is off — they have no local password — so this is a break-glass step,
not a workaround.

---

## Reference — files involved

| Concern | File |
|---|---|
| Directory identity + credential routing | `apps/api/src/lib/ldap-identity.ts` |
| Bind, search, group matching, provisioning | `apps/api/src/modules/ldap/ldap.service.ts` |
| Config endpoints | `apps/api/src/modules/ldap/routes.ts` |
| Login | `apps/api/src/modules/auth/auth.service.ts` |
| Re-authentication (inline-password path) | `apps/api/src/lib/reauth-check.ts` |
| Per-request expiry enforcement | `apps/api/src/plugins/auth.ts` |
| Admin password operations | `apps/api/src/modules/users/user.service.ts` |
| Configuration page | `apps/web/src/routes/config/ldap.tsx` |
| Local AD stand-in (dev only) | `apps/api/src/test-support/fake-ad-server.ts` |
| End-to-end tests over a real LDAP socket | `apps/api/src/e2e/ldap-directory.e2e.test.ts` |
| Unit tests | `apps/api/src/lib/__tests__/ldap-identity.test.ts`, `apps/api/src/modules/{ldap,auth}/__tests__/` |

Generic LDAP background (OpenLDAP, FreeIPA, ldapsearch recipes, deeper
troubleshooting) remains in `old/docs-superseded/LDAP_INTEGRATION_GUIDE.md`.
