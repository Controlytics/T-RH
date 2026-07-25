# The Audit Chain — 21 CFR §11.10(e)

This is the compliance heart of the product. If a rebuild gets nothing else
exactly right, it must get this right.

**Regulatory obligation.** §11.10(e) requires *"secure, computer-generated,
time-stamped audit trails to independently record the date and time of operator
entries and actions that create, modify, or delete electronic records… Record
changes shall not obscure previously recorded information."*

---

## 1. Structure

`audit_trail` — 23 columns. The chain-relevant ones:

| Column | Type | Role |
|---|---|---|
| `checksum` | `varchar(64)` NOT NULL | Hash over this row's fields + `previous_checksum` |
| `previous_checksum` | `varchar(64)` | The prior row's `checksum` — the chain link |
| `chain_position` | `bigint` NOT NULL | `BIGSERIAL`, monotonic ordering |
| `checksum_version` | `smallint` | NULL/1/2 = unkeyed SHA-256 · 3 = keyed HMAC |

Content columns: `timestamp`, `user_id`, `user_name`, `user_role`, `action`,
`target_type`, `target_id`, `before_value` (jsonb), `after_value` (jsonb),
`reason`, `ip_address`, `user_agent`, `session_id`, `signature_meaning`.

Redaction columns: `redacted_at`, `redacted_by`, `redaction_reason`.

```
row N-1 ──checksum: A──┐
                       │
row N   ── previous_checksum: A
           checksum: B ──┐
                         │
row N+1 ── previous_checksum: B
           checksum: C
```

Mutating row N changes its checksum, so row N+1's `previous_checksum` no longer
matches — **and every subsequent row fails too**. Tampering propagates forward
and cannot be locally repaired without recomputing the entire tail.

## 2. Three independent defence layers

### Layer 1 — Application
The writer only ever appends. There is no update path and no delete path in the
audit service.

### Layer 2 — Database trigger
```sql
CREATE TRIGGER audit_trail_no_delete BEFORE DELETE ON audit_trail
FOR EACH ROW EXECUTE FUNCTION block_audit_trail_delete();
```
```sql
BEGIN
  RAISE EXCEPTION 'audit_trail rows are immutable. Use the admin delete endpoint
                   which temporarily disables this trigger under audit.';
END;
```
This matters because it defends against actors who bypass the application
entirely — a DBA at a `psql` prompt.

### Layer 3 — Cryptographic (V3 keyed HMAC)
Layers 1–2 are insufficient on their own, and the code says why:

> *"The checksum and previous_checksum live in the same audit_trail table they
> protect, so a DB-level actor (the exact threat the immutability triggers +
> chain defend against — triggers can be disabled) can recompute a fully
> self-consistent forged chain that passes verify-chain."*

**V3** mixes in `AUDIT_CHAIN_KEY`, held in the API service's environment —
**outside the database**. An actor with full DB write access but no key cannot
forge a passing checksum.

## 3. Checksum versioning

The versioning philosophy is: **never rewrite immutable history.**

| Version | Formula | When written |
|---|---|---|
| NULL / 1 / 2 | Unkeyed SHA-256 | Legacy rows, or when `AUDIT_CHAIN_KEY` is unset |
| 3 | Keyed HMAC-SHA256 | New rows when `AUDIT_CHAIN_KEY` is set |

Verifier rules — subtle and load-bearing:

- **v3 rows REQUIRE the key and an HMAC match.** The verifier does **not** accept
  the unkeyed formula for them. Otherwise an attacker could *downgrade* a row to
  unkeyed and still pass.
- A downgrade attempt still breaks the **forward** link (the next v3 row's
  `previous_checksum` stops matching), and re-linking the whole forward chain
  requires the key — so the attack surfaces on a chain walk either way.
- Legacy rows keep verifying via the unkeyed fallback, so historical data stays
  valid across the cutover.

**Operational consequence:** `AUDIT_CHAIN_KEY` must be backed up separately from
the database, and rotating it invalidates verification of existing v3 rows. A
rebuild must document key custody as part of the install procedure.

## 4. Verification — what it catches, and what it does not

`GET /api/audit/verify-chain` → `lib/audit-verify.ts` walks rows in
`chain_position` order.

**Detected:**
- In-place mutation (row's checksum no longer matches its field values)
- Insertion between rows (`previous_checksum` mismatch)
- Deletion of a middle row (successor's link breaks)
- Forward propagation — every row after a tampered row also fails

**NOT detected by the chain alone — documented honestly in the source:**
- **Deletion of the latest row** — no successor exists to reveal the gap.
- **Truncation of the entire tail** — same reason.

**Mitigation:** `verifyChain` returns the **highest `chain_position` seen**, which
an operator compares against an out-of-band record (e.g. a daily snapshot of the
last known maximum). This turns tail-truncation into a detectable discrepancy.

> A rebuild must reproduce this limitation *and its documentation*. Silently
> implying the chain detects everything would be worse than the current honest
> statement. The out-of-band position check should ideally be automated.

Pre-chain rows (`previous_checksum IS NULL`) predate the chain migration and are
verified by per-row checksum only.

## 5. Redaction — the supported removal path

`POST /api/audit/:id/redact` (permission `AUDIT_REDACT`, SUPER_ADMIN in practice)

Blanks sensitive values **in place** while recording `redacted_at`,
`redacted_by`, and `redaction_reason`. The row, its position, and its chain
links survive.

This is the correct answer to "personal data must be removed": the *record of
the action* is preserved (as §11 requires) while the *sensitive content* is
removed (as privacy law may require).

## 6. Hard delete — present, disabled by default, and loud

`DELETE /api/audit/:id` and `POST /api/audit/bulk-delete` exist because an
operator explicitly required them. They are deliberately hard to reach:

- Require the `AUDIT_DELETE` permission, **granted to no role by default**.
- Require re-authentication **and** a `reason`.
- Each disables the `audit_trail_no_delete` trigger for **its own transaction
  only** (`ALTER TABLE … DISABLE/ENABLE TRIGGER` takes an ACCESS EXCLUSIVE lock,
  which closes the window where another session could delete unaudited).
- Write a **meta-audit row** (`AUDIT_RECORD_DELETED` /
  `AUDIT_RECORDS_BULK_DELETED`) recording who, what, and why **before** the
  target row is destroyed.

> **⚠ Physical deletion permanently breaks the chain.** `verify-chain` will
> report the downstream chain invalid, forever. The verifier was deliberately
> **not** taught to tolerate deletions — so the breakage stays loud.

**This is the single most important design decision in the system**, and it is
the right one: a compliance system must not make destroying evidence quiet.
Redaction remains the recommended path.

## 7. Retained registry entries for removed subsystems

`audit-actions.ts` and `audit-templates.ts` still carry entries for subsystems
that were torn out upstream (UNS, retention, device credentials, rule chains,
alarms). Nothing emits them any more.

**They are retained deliberately.** Historic audit rows referencing those actions
must still render correctly for an inspector years later. Deleting the registry
entries would leave old rows displaying raw action codes.

**A rebuild must carry these forward.** They look like dead code to a linter and
are not.

## 8. Rebuild checklist

1. Append-only writer; **no** update or delete path in the audit service.
2. DB-level BEFORE DELETE trigger that raises.
3. Keyed HMAC (v3) with the key held outside the database; version column for
   forward migration without rewriting history.
4. Verifier that **requires** the key for v3 rows (reject the unkeyed fallback).
5. Verifier returns max `chain_position` for out-of-band tail checks — and
   ideally automate that comparison.
6. Redaction as the supported removal path; chain-preserving.
7. Hard delete, if present: off by default, re-auth + reason, meta-audit first,
   trigger disabled per-transaction only, and **chain breakage left loud**.
8. Audit write happens in the **same transaction** as the audited action.
9. No foreign keys from `audit_trail` — denormalise actor fields as strings.
10. Retain audit-action/template registry entries for removed subsystems.
11. Isolate test writes to a throwaway database.
