# Data Injection Layer — Phase 1 (Foundation) — Design Spec

- **Date:** 2026-08-01
- **Branch:** `final-user-management`
- **Status:** Approved for planning (awaiting spec review)
- **Author:** Claude (with user)
- **Related:** `docs/recreation/` dossier (the only accurate inventory of this system);
  sibling repo `C:\Users\hello\21cfrlogbook-DigitalFMS` tag `pre-ingestion-removal`
  (the deleted upstream ingestion layer, used as reference only)

---

## 1. Problem

The user requires a production-grade **Industrial IoT Data Injection Layer** on top of
compliance-core: a centralised communication engine for devices, gateways, PLCs, sensors,
controllers and external systems, spanning 19 protocols, ~20 sub-modules, a rule engine and
a SCADA-style UI.

Two facts shape the whole approach.

**1.1 The subsystem being requested was deliberately deleted upstream.** compliance-core is a
fork of DigiLog. DigiLog removed its entire ingestion layer across 2026-06-11..17 (Phase 7):
the `data-ingestion`, `uns`, `connectivity` and `queries` modules, the `transport/` MQTT
layer, 6 TimescaleDB hypertables, the `digilog_tsdb` database, and the `mqtt`/`aedes`
dependencies. compliance-core was then forked *after* that removal, so **its own git history
contains no ingestion code at all** — 16 commits, earliest `ac0fcab`.

The upstream implementation *is* still reachable, but in a **separate repository with no
shared history** (`21cfrlogbook-DigitalFMS`, 1194 commits, tag `pre-ingestion-removal`).
Code therefore moves by **copy-and-adapt, never cherry-pick**, and everything there is
written against a schema that no longer exists here (`Organization`, `AssetInstance`,
TimescaleDB hypertables).

What is genuinely reusable is narrow and worth naming: `message-normalizer`,
`entity-resolver`, `dlq-manager`, `connectivity-tracker`, the 5-file `uns` module, and
`mosquitto-acl-generator`. That is the UNS topic model and the gateway→device fan-out — the
hardest design work, already solved once by this team. **The other 18 protocols and the
entire SCADA UI are greenfield.**

**1.2 The full brief is ~9 independent subsystems, not one feature.** Attempting it as a
single unit would produce scaffolding rather than working software. It is decomposed in §3;
this spec covers **P1 only**.

---

## 2. Constraints and conflicts with the existing architecture

Recorded so that later phases do not re-litigate them, and so the deviations from the
original brief are explicit rather than silent.

| Brief requirement | Reality in compliance-core | Resolution |
|---|---|---|
| Multi-tenant support | Deliberately single-tenant. `Organization` + `org-admin`/`tenant-admin` removed 2026-04-30; JWT `scope` always stamps `GLOBAL` | **Out of scope.** Re-adding multi-tenancy is its own programme touching every table and query |
| Dark/Light theme | Light-theme-only by explicit product decision; 10 accent presets ("Midnight" is an accent palette, not a dark mode) | **Build light-only.** Dark mode is a separate cross-cutting project |
| Time-series optimisation | TimescaleDB dropped (`DROP DATABASE digilog_tsdb`); plain PostgreSQL 18 | **Native declarative partitioning** (decision D3) |
| Horizontal scale / HA | 30 s session cache and 10 s reauth cache are **in-process**; two API instances would disagree about logout — a correctness bug in a compliance path | **Single-instance only.** Externalising those caches is a prerequisite, tracked as rebuild-plan H3 |
| Kafka / AMQP / Azure IoT / AWS IoT | No pub/sub layer exists; the in-process bus was removed as dead code. Each adds a service a regulated site must install, secure and **validate** | Deferred to P9, each behind its own adapter and its own site-level validation decision |
| OPC-DA | COM/DCOM Windows legacy; no viable Node.js implementation | **Not deliverable in-process.** Requires a separate .NET/C++ bridge or a commercial gateway. Flagged as out of scope until that is funded |
| "Without introducing regressions" | **No CI exists, and 23 tests already fail** | Minimum CI + route-parity test folded into P1 (§9) |

---

## 3. Programme decomposition

Each slice gets its own spec → plan → implementation cycle.

| Slice | Contents |
|---|---|
| **P1** | Instruments, Gateways, Communication Profiles, hierarchy, UNS topic derivation, RBAC, audit wiring, wizard + tree UI, **minimum CI** ← *this spec* |
| P2 | `IProtocolAdapter` + MQTT adapter, connection manager, payload parser, gateway fan-out |
| P3 | Telemetry storage (partitioned), latest/history, charts, export |
| P4 | Message Explorer, Logs, Health Monitoring |
| P5 | Alarms + Events |
| P6 | Rule Engine |
| P7 | Data Mapping Engine (JSONPath / XPath / Modbus registers / OPC nodes) |
| P8 | Commands / RPC (audited + re-auth) |
| P9 | Remaining protocol adapters, one increment each |

---

## 4. Decisions taken (with rationale)

| # | Decision | Rationale |
|---|---|---|
| **D1** | **Configuration is audited; telemetry is not.** Instrument/Gateway/Profile/Topic/Rule changes write hash-chained audit rows in-transaction. Telemetry and client-reported attribute *values*, raw message logs and heartbeats do not. **Commands are audited and require re-auth.** | Telemetry is process data, not a §11 electronic record — it is not an operator entry creating, modifying or deleting a regulated record. Auditing it would put millions of rows/day into a table whose `verify-chain` is already an O(n) full walk, making verification unusable within weeks. A command that writes to a PLC *is* an operator action with physical effect, so it stays on the audited path. **This boundary must be stated in the site's validation documentation.** |
| **D2** | Design P1 first, with minimum CI folded in | The schema is the highest-leverage artefact; nothing downstream can be correct until the UNS model and gateway→device resolution are settled |
| **D3** | Telemetry store = **native PostgreSQL declarative partitioning**, not TimescaleDB | No new service for a regulated site to install, secure and validate; works offline on-prem; Postgres 18 partitioning is sufficient. Retention becomes a partition drop |
| **D4** | Hierarchy = **`hierarchy_nodes` table with an `ltree` materialised path** | `ltree` is **already installed** in this database (a leftover the dossier flagged for removal — it now earns its place). Resolves a full ancestor chain in **one** query, fixing the upstream N+1; supports gaps natively; GiST-indexed subtree rollups; a new level is a data change, not a migration |
| **D5** | Topics are **derived on read; only overrides are stored** | Renaming a hierarchy node re-derives every descendant's topics with no backfill. Storing 13 rows × 10,000 instruments = 130,000 rows of almost entirely derivable data, with drift risk if a backfill half-fails |

---

## 5. Architecture

### 5.1 Module layout

Follows the existing convention (`apps/api/src/modules/<name>/{routes,service,schema}.ts`).
Four new API modules (**18 → 22**):

```
apps/api/src/modules/
  hierarchy/                 nodes CRUD + tree + move/reparent
  gateways/                  gateway CRUD
  instruments/               instrument CRUD + wizard support + topic resolution
  communication-profiles/    reusable protocol profiles
```

Topic resolution lives **inside** `instruments/` as `topic-resolver.ts` rather than being its
own module — it is a pure function over an instrument plus its hierarchy path, with no
independent lifecycle.

The `Protocol` registry is a lookup table served by `communication-profiles/`, following the
`TemplateKind` precedent (admin-editable data, not an enum).

### 5.2 Schema — 7 new models (23 → 30), 2 new enums (6 → 8)

```prisma
enum HierarchyLevel { COMPANY SITE PLANT BUILDING BLOCK AREA LINE }

enum TopicCategory {
  TELEMETRY ATTRIBUTES ALARM COMMAND RPC HEARTBEAT EVENT
  STATUS CONFIG RESPONSE SETTINGS PUBLISH SUBSCRIBE
}

model HierarchyNode {
  id        String  @id @default(uuid())
  parentId  String?
  level     HierarchyLevel
  name      String
  slug      String                          // sanitised, used in the UNS path
  path      Unsupported("ltree")            // materialised; GiST index
  sortOrder Int     @default(0)
  isActive  Boolean @default(true)
  @@unique([parentId, slug])                // no duplicate siblings
}

model Protocol {                            // lookup, admin-editable
  key          String  @id                  // 'mqtt', 'modbus-tcp', ...
  name         String
  isEnabled    Boolean @default(false)
  capabilities Json                          // {publish, subscribe, poll, write}
}

model CommunicationProfile {
  id          String  @id @default(uuid())
  name        String  @unique
  protocolKey String
  config      Json                           // protocol-specific; secrets masked on read
  isActive    Boolean @default(true)
}

model Gateway {
  id                     String  @id @default(uuid())
  name                   String
  code                   String  @unique
  slug                   String                 // sanitised; used in the UNS path
  gatewayType            String
  externalId             String                 // the identity used on the wire
  hierarchyNodeId        String
  communicationProfileId String
  isActive               Boolean @default(true)
  @@unique([hierarchyNodeId, slug])
}

model Instrument {
  id                     String  @id @default(uuid())
  name                   String
  code                   String  @unique
  slug                   String                 // sanitised; used in the UNS path
  instrumentType         String
  manufacturer           String?
  model                  String?
  serialNumber           String?
  hierarchyNodeId        String
  gatewayId              String?                // NULL = communicates independently
  deviceKey              String?                // how a gateway payload addresses this child
  communicationProfileId String?                // NULL ⇒ inherit the gateway's profile
  isActive               Boolean @default(true)
  @@unique([gatewayId, deviceKey])
  @@unique([hierarchyNodeId, slug])
}
```

**Profile resolution rule.** `Instrument.communicationProfileId` is nullable and
`Gateway.communicationProfileId` is not. An instrument behind a gateway normally inherits the
gateway's profile; setting its own overrides that. An **independent** instrument
(`gatewayId IS NULL`) **must** carry its own profile — enforced in the service layer and by a
CHECK constraint in the migration, since Prisma cannot express the conditional requirement:

```sql
CHECK (gateway_id IS NOT NULL OR communication_profile_id IS NOT NULL)
```

```prisma

model InstrumentSetting {
  instrumentId String @unique
  values       Json                             // Zod-validated shape
}

model InstrumentTopic {                          // OVERRIDES ONLY — never the default 13
  id           String @id @default(uuid())
  instrumentId String
  category     TopicCategory
  customTopic  String?
  qos          Int     @default(1)
  retain       Boolean @default(false)
  enabled      Boolean @default(true)
  @@unique([instrumentId, category])
}
```

**`deviceKey` is the load-bearing field.** It is the identifier a gateway's payload uses to
address one child device, and it is what P2's fan-out resolves against. Defining it in P1 is
precisely what makes P2 buildable without reopening the schema. `@@unique([gatewayId,
deviceKey])` guarantees a payload can never resolve ambiguously.

`InstrumentSetting.values` is a Zod-validated JSON blob rather than ~16 typed columns,
matching the existing `SystemConfig` pattern. Trade-off accepted: no per-setting SQL
filtering. Settings are read per-instrument, never queried across instruments.

### 5.3 Topic derivation

```
resolveTopic(instrument, category):
    override ← instrumentTopic(instrument, category)
    if override?.customTopic → return it
    return join(
        unsSettings.prefix,                      // e.g. 'controlyt'
        hierarchyNode.path,                      // ltree path, dots → separator
        gateway?.slug,                           // omitted when gatewayId IS NULL
        instrument.slug,
        category.toLowerCase()
    )
```

Reuses the upstream `sanitizeName()` (lowercase, spaces→hyphens, strip specials, collapse and
trim hyphens) and its **gap-handling**: a level absent from the hierarchy is *omitted*, never
emitted as a blank segment.

Prefix, separator, letter case and the include-gateway toggle become a new config surface,
`uns-settings` — the application's **22nd**. Adding it follows the 12-touchpoint rule in
`docs/CONTRIBUTING.md` (the def, the discovery import, the config index card, and either a
page or the dynamic renderer).

### 5.4 Data flow (P1)

```
Wizard / API request
   → Zod validation (packages/shared)
   → requirePermission preHandler          §11.10(g)
   → enforceReauth (create/update/delete)  §11.200
   → sanitize.ts (HTML-strip all text)
   → service → repository → Prisma / raw SQL (ltree)
   → writeAudit() in the SAME transaction  §11.10(e)
   → schema-serialised response
```

No deviation from the existing request lifecycle. That is deliberate: the compliance
guarantee lives in the ordering, and P1 introduces no new path around it.

---

## 6. RBAC

A new `data-injection` sidebar group in `PERMISSION_TREE`
(`packages/shared/src/types/permission-tree.ts`), which remains the single source of truth —
`FEATURE_PRIVILEGES`, `FEATURE_TO_PERMISSION_MAP` and `SIDEBAR_PRIVILEGE_MAP` stay derived.

16 nodes: `view` / `create` / `edit` / `delete` × {`hierarchy`, `gateways`, `instruments`,
`comm_profiles`}.

| Axis | Before | After |
|---|---|---|
| Permission constants | 30 | **46** |
| Re-auth actions | 39 | **51** (create/update/delete × 4) |
| Sidebar groups | 8 | **9** |
| Sidebar items | 9 | **10** |

Each node's `gate` is the single discriminating permission; `permissions` is the
grant-expansion set including read dependencies. **They must not be conflated** — OR-ing over
`permissions` as an authorisation check is exactly the historical `ASSET_*` privilege leak.
All new nodes are tagged `enforce: 'a'` (a real backend gate) — no cosmetic toggles are
introduced.

The frozen-snapshot drift test (`legacy-maps-derived.test.ts` +
`__snapshots__/legacy-maps-snapshot.ts`) must be regenerated in the same commit.

---

## 7. Audit

Every mutation writes a hash-chained row inside the operation's transaction, with before/after
values via the existing `lib/audit-diff.ts`.

New audit action constants and templates (`lib/audit-actions.ts`, `lib/audit-templates.ts`):
`HIERARCHY_NODE_*`, `GATEWAY_*`, `INSTRUMENT_*`, `COMMUNICATION_PROFILE_*`,
`INSTRUMENT_TOPIC_OVERRIDE_*` — created / updated / deleted for each.

**Secrets.** `CommunicationProfile.config` holds broker passwords, client certificates and
API keys. It is routed through the existing `lib/mask-secrets.ts` on every read, so values
never round-trip to a client, and the *masked* form is what appears in audit `before`/`after`
diffs. Writing a secret into an audit row would make it permanently unredactable-in-practice,
since the row is immutable.

---

## 8. User interface

New sidebar group **Data Injection**, gated by `isSidebarItemVisible()`:

| Route | Contents |
|---|---|
| `/data-injection` | Dashboard — counts only in P1 |
| `/data-injection/hierarchy` | Tree view; create / rename / move nodes |
| `/data-injection/gateways` | List + detail; child-instrument roster |
| `/data-injection/instruments` | List + **3-step create wizard** |
| `/data-injection/profiles` | Communication profile list + editor |

Wizard steps follow the brief: (1) Basic details + location, (2) Communication /
protocol + profile, (3) Gateway configuration — `Gateway Enabled? Yes/No`, revealing gateway
selection and `deviceKey` when Yes.

Built with the existing hand-rolled Tailwind primitives in `components/ui/`, SWR for reads,
react-hook-form + Zod for the wizard, `useCan('<node-id>')` for button gating, and toasts for
success/error. Routes are `lazy()`-loaded and wrapped in `<RequireRole>`.

Frontend routes **38 → 43**.

**Deviation:** light theme only, per §2.

---

## 9. Testing and CI

**CI (new — none exists today).** A workflow running: typecheck, `vitest run` across all
three workspaces, `npm audit`. The 23 pre-existing failures are **explicitly baselined as
known-failing** in the first commit, with an allow-list that shrinks over time. Starting CI
red without a baseline trains everyone to ignore it.

**Contract tests** (these are what make "no regressions" verifiable rather than asserted):

- **Frontend↔backend route parity** — every `/api` string literal in `apps/web/src` resolves
  to a path in the live OpenAPI document. This gap has *already* shipped bugs: a dead
  `/api/filters/dashboard-stats` poll 404'd every 20 s for months, unnoticed.
- Every newly declared re-auth action is referenced by ≥1 route (prevents security theatre —
  three such phantom actions existed upstream).
- Every `enforce: 'a'` node's `gate` appears in a real route guard.
- Regenerated frozen permission-map snapshot.

**Unit tests:** topic derivation (defaults, overrides, hierarchy gaps, sanitisation edge
cases, gateway present/absent); `ltree` path maintenance on rename and on reparent (the
subtree's descendant paths must all update); `deviceKey` uniqueness within a gateway.

**Integration/e2e:** create instrument → 13 topics derive correctly → audit row written with
correct before/after → secret masked in the response and in the audit diff.

---

## 10. Migration

Hand-authored per the standing rule — `prisma db push` and `prisma migrate dev`
auto-generation are **forbidden** against any populated database, because they can silently
drop audit data.

1. Edit `schema.prisma`.
2. `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel
   prisma/schema.prisma --script` → review.
3. Hand-author into `prisma/migrations/<UTC>_data_injection_p1/migration.sql`, adding the
   `ltree` column, its GiST index and the partitioning groundwork that Prisma cannot express.
4. `npm run db:verify-migrations` — the drift guard **must PASS** before commit.

`ltree` and `pgcrypto` are already present, so `prisma/sql/extensions.sql` is unchanged.

---

## 11. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Prisma cannot read `ltree` columns.** It maps to `Unsupported("ltree")`, so path reads and writes need raw SQL | Contained in `hierarchy/hierarchy.repository.ts` — roughly six hand-written queries (insert, move-subtree, ancestors, descendants, rename, delete-cascade). Every one gets a unit test |
| R2 | Reparenting a node must rewrite every descendant path | Single `UPDATE … SET path = new_prefix \|\| subpath(path, nlevel(old_prefix))` under one transaction; tested explicitly |
| R3 | 23 pre-existing failures make a green CI impossible on day one | Baseline allow-list (§9), shrinking over time |
| R4 | Schema grows 23 → 30 models; docs already wholesale stale | Update `docs/recreation/` (the accurate inventory) — **not** the root docs, which describe a different product |
| R5 | Adding an ingestion path to a validated system triggers re-qualification | D1's audit boundary is stated explicitly so the validation impact is assessable up front, not discovered at inspection |

---

## 12. Out of scope for P1

Any protocol connection or broker; telemetry storage or ingest; alarms; events; rule engine;
message explorer; data mapping; command execution; health monitoring; multi-tenancy;
horizontal scale; dark mode; OPC-DA.

P1 is complete when **an Instrument and a Gateway can be created, their UNS topics
auto-generate correctly, and the configuration change lands in the audit chain** — with no
broker in existence.
