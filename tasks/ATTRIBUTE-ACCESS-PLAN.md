# Per-role instrument attribute access — plan (2026-08-19)

Operator request: stop giving attributes an ad-hoc Edit/Delete per row; govern them
with ONE per-role configuration offering all-editable / all-view / selected-editable,
carrying a per-role re-authentication switch, and demand mandatory remarks whenever a
value changes.

## Decisions taken (operator, 2026-08-19)

- **Editable = change, add and remove.** One rule. A view-only role gets no Edit, no
  Delete and no Add. In SELECTED mode only the chosen keys carry Edit/Delete; adding a
  NEW key stays allowed, because a new key cannot overwrite a protected one.
- **Remarks are required to CHANGE an existing value and to DELETE.** Not to fill a
  blank prompt for the first time — that is registration, and demanding a reason on
  every key of a new instrument trains people to type "x".
- **An unconfigured role behaves exactly as today**: editable iff it already holds
  `INSTRUMENT_UPDATE`, read-only otherwise. Nothing changes for anyone until a rule is
  set. SUPER_ADMIN bypasses, as everywhere else in this app.

## Shape

`role_configs.attribute_access` JSONB, nullable (NULL = inherit = today's behaviour),
mirroring the `instrument_scope` precedent — same table, same tab pattern, same
audited PUT-per-role endpoints.

```jsonc
{
  "mode": "ALL_EDIT" | "ALL_VIEW" | "SELECTED",
  "keys": ["High Temperature Limit", "..."],  // SELECTED only; case-insensitive match
  "requireReauth": false                       // password prompt on every write
}
```

## Steps

1. `packages/shared/src/types/attribute-access.ts` — the mode vocabulary, parsing, and
   the ONE decision function both sides call. Tests.
2. Prisma column + hand-authored migration; apply to `compliance_core_db` AND
   `compliance_core_db_test` (they migrate separately).
3. `apps/api/src/modules/instruments/attribute-access.ts` — resolve for a request's
   role, cache-free. Tests.
4. Enforce on POST / PUT / DELETE attribute routes: access check, mandatory `reason`
   on change + delete (bounded, `signature_meaning` is VARCHAR(255)), conditional
   `enforceReauthAlways`.
5. `GET /api/instruments/attribute-access/me` so the panel can render the right
   affordances without re-deriving the rule.
6. Roles endpoints: read all + PUT one role, audited like instrument-scope.
7. Web: attributes panel — per-key affordances, remarks dialog, reauth plumbed.
8. Web: Config → Roles & Access → **Attribute Access** tab.
9. Docs + counts.

## Traps to respect

- `audit_trail.signature_meaning` is VARCHAR(255) and `auditLog` does not truncate —
  bound the remark in the body schema AND clamp the sentence.
- A new module/route must be registered in `app.ts` AND `e2e/test-helper.ts`.
- `prisma migrate diff` here emits three destructive statements; hand-author the SQL.
- Writing a NULL to a JSONB column needs `Prisma.DbNull`, never `JsonNull`.
- The gate is enforced SERVER-side; the panel's rendering is a convenience, not the
  control.
