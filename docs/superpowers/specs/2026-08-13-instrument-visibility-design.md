# Role and user instrument visibility — design (Project D)

**Date:** 2026-08-13
**Branch:** `data-injection`
**Depends on:** Project A (Functional Locations), complete.

## Goal

Some roles see every instrument; others see only the functional locations they are
granted. Within one role, individual users can be granted a different set — the
operator's requirement: *"in same role different users need to see different
instruments"*.

## This supersedes an earlier design

Visibility was first designed against the free-text `block`/`area` columns. That is
abandoned: functional locations are real rows with stable ids, so a rename cannot
silently change who sees what and a typo cannot create a scope that matches nothing.
The free-text approach was already visibly fragile in the live data (`CWH` beside
`Block C`), which is why A was built first.

## Storage

`instrument_scope` — a nullable JSONB column on **both** `role_configs` and
`user_configs`. Those two tables already mirror each other (same three JSON columns,
one keyed on `role`, one on `userId`) and `config.service.getMyConfig` already
implements "user config wins, else role config", so this follows an existing
mechanism rather than inventing a second one.

```ts
type InstrumentScope = null | string[];   // functional-location ids
```

## Resolution order

1. `SUPER_ADMIN` → unrestricted. Consistent with every other gate in this app.
2. The user's `instrument_scope` is **not NULL** → use it.
3. Else the role's `instrument_scope` is **not NULL** → use it.
4. Else unrestricted.

**NULL vs `[]` is load-bearing, and this is a deliberate deviation from
`getMyConfig`.** That function decides whether the user config wins by testing
`sidebarItems.length > 0`. Scope has three meaningful states where sidebar items have
two:

| Value | Means |
|---|---|
| `NULL` | inherit — role, then unrestricted |
| `[]` | **see nothing** — a real, sayable instruction |
| `[ids]` | see these locations |

With a `length > 0` test, `[]` would fall through to the role scope and "this user
sees no instruments" would become a grant. That is the wrong failure direction for
access control, so resolution tests for NULL, not for emptiness.

## Override replaces, it does not intersect

A user's scope stands in place of the role's. This is what "same role, different
users, different instruments" requires, and it matches the existing precedent.

**Consequence, stated rather than discovered:** an override can **widen** as well as
narrow, so a user in a tightly-scoped role can be granted more than their role. Every
override is therefore a privilege decision — reauth-gated, audited, and the UI shows
the role default beside the override so nobody widens by accident.

I raised intersect-instead as the safer alternative when this was first designed and
the operator did not choose between them. Replace is implemented because it is the
only option that satisfies the stated requirement; switching to intersect later is a
one-line change in the resolver, and the resolver is the only place that decides.

## Expansion and unassigned instruments

A granted **Block** includes its **Areas** — resolved through
`functional-locations/tree.ts:resolveLocationIds()`, the same helper the dashboard
uses. Granting `CWH` and then wondering why `Module-E` is invisible would be the
obvious bug, and there is one implementation of that rule.

**Instruments with no functional location are invisible to scoped roles.** This was
the operator's explicit choice, and it is the safe reading: an instrument nobody has
placed is in nobody's grant. Today that is **15 of 20 instruments**, so the
Instruments page shows a count — "15 instruments are in no functional location and
are hidden from scoped roles" — because a silent gap reads as a broken dashboard.

Unrestricted roles (`NULL` scope) still see everything, so nothing disappears on
deploy: every existing role and user has a NULL scope until someone sets one.

## Enforcement — server-side, on the query

`resolveVisibilityWhere(req)` returns a Prisma fragment or `undefined`, applied to:

| Endpoint | Behaviour when out of scope |
|---|---|
| `GET /api/instruments` | filtered; `total` reflects the filtered count |
| `GET /api/instruments/:id` | **404**, not 403 |
| `GET /api/instruments/:id/telemetry` | 404 |
| `GET /api/instruments/telemetry-overview` | filtered |
| `GET /api/instruments/:id/attributes` | 404 |
| `PUT` / `DELETE /api/instruments/:id` | 404 |
| `GET /api/functional-locations` | tree filtered to granted locations |

**404 rather than 403**, because a 403 confirms the instrument exists — which is the
fact being withheld.

**Writes are included.** If a role cannot see an instrument it must not be able to
edit or delete it; otherwise the feature is decoration for anyone holding
`INSTRUMENT_UPDATE`.

**Deliberately NOT scoped:** `/api/functional-locations/linkable-instruments` and the
gateway child pickers. Those are administrative surfaces already gated on
`FUNCTIONAL_LOCATION_UPDATE` / `INSTRUMENT_UPDATE` — the authority to organise the
estate is different from the authority to view a subset of it, and scoping them would
make it impossible to assign an instrument into a location you cannot yet see.

## UI

Config → Roles & Access gains an **Instrument Scope** tab (fifth, beside Roles /
Permissions / Sidebar / Reauth):

- **Per role:** `All instruments` or `Only selected locations`, with the
  functional-location tree as checkboxes. Checking a Block grants its Areas, stated
  on screen.
- **Per user:** a user picker showing `Inherits role (CWH)` until an override is set,
  then the override with the role default named beside it.

Saving is `ROLE_MANAGE` + reauth + audited, like the other role-config edits.

## Testing

The resolver is pure and carries the risk, so it is tested directly:

- SUPER_ADMIN → unrestricted regardless of stored scope
- user scope `[]` → **sees nothing**, and specifically does NOT fall through to the role
- user scope NULL → inherits the role
- both NULL → unrestricted
- user scope present → replaces the role's, including when it is wider
- a granted Block expands to its Areas
- an unknown id in a scope contributes nothing rather than widening
- unassigned instruments excluded whenever a scope is active, included when not

## Out of scope

- Intersect semantics (a one-line resolver change if ever wanted).
- Scoping the administrative pickers, per above.
- Per-user overrides of anything other than instrument visibility.
- Project C (alarms).
