# Phase 9 — Security Review

**This is a code-grounded review, not a speculative OWASP checklist.** Every
control below was read in source; every gap is one I could point at. In a
21 CFR Part 11 document, an unverified vulnerability claim is worse than no
claim, so nothing here is inferred.

---

## 1. Controls verified present

| Control | Implementation | Verdict |
|---|---|---|
| Password hashing | **bcrypt** (`lib/password.ts`) — `hash`/`compare`, configured rounds | ✅ Appropriate |
| JWT | **jose**, HS256, **algorithm pinned** on verify | ✅ Good — `alg:none` and confusion blocked |
| JWT secret | `getSecret()` warns and uses an ephemeral random secret if unset/short | ✅ Fails safe (sessions break rather than being forgeable) |
| Authorisation | `requirePermission` / `requireAnyPermission` preHandlers | ✅ Centralised |
| Step-up auth | `enforceReauth` in 19 module route files, 10s cache | ✅ §11.200 satisfied |
| XSS (input) | `sanitize-html` with `allowedTags: []`, `disallowedTagsMode: 'recursiveEscape'` | ✅ Strips tags, entities, `javascript:`/`data:` URIs, event handlers |
| XSS (output) | React escapes by default; responses are schema-serialised | ✅ |
| SQL injection | Prisma parameterised queries throughout | ✅ |
| CSP | `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'` | ⚠ see §2.1 |
| HSTS | `max-age=31536000`, `includeSubDomains`, `preload` | ✅ |
| Permissions-Policy | `camera=() microphone=() geolocation=() payment=()` | ✅ |
| CORS | Explicit allow-list; **production boot fails without `ALLOWED_ORIGINS`** | ✅ Fails closed |
| Rate limiting | Global 5000/min + tight per-route auth limits (10/min login, 3/15min forgot-password) | ✅ Correct two-tier shape |
| Upload validation | MIME allow-list **+ magic-byte verification**, 5 MB cap, 1 file, server-generated filename | ✅ Strong |
| Secret masking | `lib/mask-secrets.ts` on config reads | ✅ |
| Account lockout | `maxFailedAttempts` + configurable lockout type/duration | ✅ |
| Password policy | 10 configurable rules incl. history-based reuse prevention | ✅ |
| Session control | Single active session; single-tab; idle timeout; sweep job | ✅ |
| User enumeration | Login errors unified across "no such user" and "wrong password" | ✅ |
| Audit integrity | Hash chain + DB trigger + keyed HMAC | ✅ see [audit-chain.md](../05-database/audit-chain.md) |
| Seed safety | Seed **throws** without `INITIAL_ADMIN_PASSWORD` | ✅ No default credential can ship |

**Upload handling deserves specific credit.** It checks the declared MIME type
against an allow-list *and* verifies the file's **magic bytes**, then writes
under a server-generated filename into a fixed directory. That defeats the
common "rename `shell.php` to `.jpg`" and path-traversal attacks. Many systems
check only the extension.

## 2. Findings

### 2.1 `script-src 'unsafe-inline'` — MEDIUM
```ts
scriptSrc: ["'self'", "'unsafe-inline'"],   // Swagger UI requires unsafe-inline
```
The CSP's main benefit against XSS is neutralised for the whole origin so that
**Swagger UI** can run. The comment is honest about why.

**Impact is bounded** — input is HTML-stripped and React escapes output, so
there is no known injection path today. But CSP is defence-in-depth, and this
removes the depth.

**Recommendation:** serve `/docs` on a separate route with its own relaxed CSP
(or disable Swagger UI in production entirely, since this is an on-prem product
that does not need a live API explorer at a customer site) and tighten the
application origin to `script-src 'self'`.

### 2.2 Audit hard-delete exists — ACCEPTED RISK, documented
`DELETE /api/audit/:id` can permanently destroy audit records and **break the
hash chain irreversibly**.

This is **not a defect** — it was explicitly requested by an operator, and the
implementation is about as careful as such a feature can be: `AUDIT_DELETE`
granted to no role by default, re-auth plus a mandatory reason, trigger disabled
for one transaction only under an ACCESS EXCLUSIVE lock, and a meta-audit row
written *before* destruction. Chain breakage is deliberately left loud.

**Recommendation:** keep it unassigned. If a site enables it, that decision
should be recorded in their validation documentation, because it materially
changes their §11.10(e) posture.

### 2.3 `AUDIT_CHAIN_KEY` is optional — MEDIUM (deployment)
When unset, the writer falls back to unkeyed V2 checksums. A DB-level actor can
then recompute a fully self-consistent forged chain — precisely the threat V3
exists to stop. The code documents this clearly.

**Recommendation:** make the key **mandatory in production** (fail boot without
it, exactly as CORS already does), and document key custody, backup, and
rotation in the install guide. Rotation invalidates verification of existing v3
rows, so it must be a deliberate, recorded event.

### 2.4 Tail-truncation is undetectable by the chain alone — KNOWN, mitigated
Deleting the newest row (or the whole tail) leaves no successor to reveal the
gap. `verifyChain` returns the highest `chain_position` seen so an operator can
compare it against an out-of-band record.

**Recommendation:** automate that comparison — persist the daily max position to
write-once storage outside the database and alert on regression. Today it relies
on an operator remembering to check.

### 2.5 Cosmetic permissions presented as controls — LOW
`NOTIFICATION_VIEW` and `NOTIFICATION_MANAGE` are enforced by no route. They are
honestly tagged `enforce: 'c'` in the tree, which is good practice — but an
administrator toggling them in the UI may reasonably believe they are
restricting access.

**Recommendation:** enforce or remove. If kept, label them as visibility-only in
the admin UI itself, not just in the source.

### 2.6 Dead CORS origin — LOW
`capacitor://localhost` remains in the allow-list with no Capacitor client.
Unused allow-list entries are latent attack surface. **Remove.**

### 2.7 Swagger exposed at runtime — LOW
`/docs` and `/docs/json` are served by the running API. On an on-prem install
this publishes a complete API map to anyone who can reach the port.

**Recommendation:** gate behind an env flag, default off in production.

## 3. OWASP Top 10 (2021) — assessed against actual code

| # | Risk | Assessment |
|---|---|---|
| A01 Broken access control | **Mitigated.** Centralised preHandlers; permission tree as single source of truth; `gate` vs grant-set separation is explicit. **The historical `ASSET_*` over-grant was exactly this risk** and was fixed by separating the sets — a rebuild must keep them structurally distinct. |
| A02 Cryptographic failures | **Mostly mitigated.** bcrypt, HS256 pinned, HMAC audit chain, TLS. Gap: `AUDIT_CHAIN_KEY` optional (§2.3). |
| A03 Injection | **Mitigated.** Prisma parameterisation; `sanitize-html` on all text input; React output escaping. No raw SQL string building found outside the trigger-toggle in audit delete, which uses fixed identifiers. |
| A04 Insecure design | **Strong.** Append-only audit, defence in depth on immutability, fail-closed CORS, no default credential. |
| A05 Security misconfiguration | **Gaps.** `unsafe-inline` CSP (§2.1), Swagger in production (§2.7), dead CORS entry (§2.6). |
| A06 Vulnerable components | **Not assessed** — no `npm audit` run in this analysis. A rebuild must add dependency scanning to CI. |
| A07 Identification/auth failures | **Mitigated.** Lockout, password policy + history, single session, idle timeout, unified login errors, per-route auth rate limits, forced first-login change. |
| A08 Software/data integrity | **Strong** for records (hash chain). **Not assessed** for supply chain — no lockfile-integrity or signed-build process in repo. |
| A09 Logging & monitoring failures | **Strong on audit, weak on security telemetry.** The §11 audit trail is excellent, but there is no alerting on failed-login spikes, chain-verification failure, or permission-denied bursts. |
| A10 SSRF | **Low surface.** No user-supplied URL fetching found. LDAP and SMTP hosts come from admin config, not user input — but they *are* admin-controlled outbound targets, so treat config write access accordingly. |

## 4. Not assessed (out of scope for a static review)

Stated explicitly so the coverage is not overread:

- Dependency CVE scan (`npm audit`) — **not run**
- Penetration testing / dynamic scanning — **not performed**
- TLS cipher-suite configuration of the host — **not inspected**
- Windows host hardening, service account privileges, file ACLs
- Physical and procedural controls (§11.10(i)–(k) training and accountability)
- LDAP bind security in a real directory

## 5. Prioritised recommendations

| Priority | Action |
|---|---|
| **High** | Make `AUDIT_CHAIN_KEY` mandatory in production; document custody/rotation (§2.3) |
| **High** | Automate the out-of-band `chain_position` check for tail truncation (§2.4) |
| **Medium** | Remove `unsafe-inline` from the app origin; isolate or disable Swagger (§2.1, §2.7) |
| **Medium** | Add dependency scanning + `npm audit` gate to CI (A06) |
| **Medium** | Add security telemetry: failed-login spikes, chain-verify failures, 403 bursts (A09) |
| **Low** | Enforce or remove the cosmetic notification permissions (§2.5) |
| **Low** | Remove the dead `capacitor://localhost` CORS entry (§2.6) |
| **Ongoing** | Keep `AUDIT_DELETE` unassigned; require site-level justification if enabled (§2.2) |

## 6. What a rebuild must not lose

The security posture here is genuinely good, and several decisions are subtler
than they look. Do not "simplify" any of these:

1. **`gate` vs `permissions` separation** — the difference between an
   authorisation check and a grant set. Model them as distinct types.
2. **Three-layer audit immutability** — application, database trigger, and
   cryptographic key held outside the database.
3. **Verifier refuses the unkeyed fallback for v3 rows** — otherwise downgrade
   attacks pass.
4. **Fail-closed configuration** — no `ALLOWED_ORIGINS` in production, no boot;
   no `INITIAL_ADMIN_PASSWORD`, no seed.
5. **Magic-byte upload verification**, not extension checking.
6. **Unified login errors** — no user enumeration.
7. **Two-tier rate limiting** — loose global, tight on credentials.
8. **Token in `sessionStorage`** — a shared-workstation decision, not an oversight.
9. **Test isolation to a throwaway database** — so tests cannot write immutable
   rows into regulated audit history.
