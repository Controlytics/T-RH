# Instrument Token Reveal + Attributes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let an operator view and set an instrument's access token, show the credential three ways in the connection panel so a device config form can be filled without guessing, and record free-form attributes per instrument.

**Architecture:** Tokens gain a second stored form — AES-256-GCM ciphertext alongside the existing SHA-256 hash. The hash keeps doing authentication (fast, prefix-indexed, unchanged); the ciphertext exists only to answer "show me the token", behind a permission, a re-auth and an audit row. Attributes are a child table rather than a JSONB blob so each change is individually attributable.

**Tech Stack:** Fastify 5, Prisma 6, PostgreSQL 18, node:crypto, React 19 + SWR, vitest.

## Global Constraints

- **This reverses a documented security decision** (spec `2026-08-04-instruments-inbound-ingestion-design.md` D5: "token stored hashed, shown once — a retrievable credential is a standing liability"). The operator has decided so explicitly. **Record the reversal and its compensating controls where D5 is stated**; do not delete D5's reasoning.
- **The hash remains the ONLY thing authentication consults.** Never authenticate by decrypting. If the two forms ever disagree, the hash wins and the ciphertext is what is wrong.
- **Fail closed on reveal, open on ingest.** If `INSTRUMENT_TOKEN_KEY` is absent or wrong, revealing must return a clear error — never a partial or garbage value — while token authentication and ingest continue working exactly as today.
- **Migrations are hand-authored.** `prisma migrate dev` auto-generation and `prisma db push` are FORBIDDEN. Apply the SQL FIRST, then `npx prisma migrate resolve --applied <name>`, to **both** `compliance_core_db` and `compliance_core_db_test`. `psql` needs `PGPASSWORD=digilog123 -h localhost -U digilog -d <db> -v ON_ERROR_STOP=1`. Drift guard must PASS: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-migrations.ps1`.
- **`stop-app.bat` before `prisma generate`** — a running node process holds the query-engine DLL (EPERM).
- Run the API suite single-fork: `cd apps/api && npm test`. Baseline **14 pre-existing failures in 5 files** (`auth-profile-reauth`, `entities`, `replacement-audit-enrichment`, `super-admin-unretire`, `block-change-approval-current`). Web baseline **5** (`use-can`, `url-utils`).
- **vitest never typechecks** — `npx tsc -p apps/api/tsconfig.json --noEmit` and the web equivalent must both be clean.
- Do not disturb the gateway lock ordering (`apps/api/DECISIONS.md` §4a).

---

### Task 1: Token encryption, reveal, and set

**Files:**
- Create: `apps/api/src/modules/instruments/token-crypto.ts`, its test
- Modify: `apps/api/prisma/schema.prisma`, new migration, `token.ts`, `routes.ts`, `packages/shared/src/schemas/instruments.ts`, `packages/shared/src/types/{permissions,reauth-actions,audit-actions,audit-templates}.ts`, `apps/api/.env.example`
- Test: `apps/api/src/e2e/instrument-token.test.ts`

**Produces:**
```ts
// token-crypto.ts — pure except for reading the key from env
export function encryptToken(plain: string): string | null;   // null when no key configured
export function decryptToken(blob: string): string;           // throws on wrong key / tampering
export function tokenKeyConfigured(): boolean;
```
```
GET /api/instruments/:id/token    -> { token }        INSTRUMENT_UPDATE + reauth REVEAL_INSTRUMENT_TOKEN
PUT /api/instruments/:id/token    -> { tokenPrefix }  INSTRUMENT_UPDATE + reauth SET_INSTRUMENT_TOKEN
```

- [ ] **Step 1: Write `token-crypto.test.ts` first**

Cover: round-trip; ciphertext differs across two encryptions of the same plaintext (random IV); **decrypting with a different key throws rather than returning garbage**; a tampered ciphertext throws (that is what GCM's auth tag is for); `encryptToken` returns `null` and `tokenKeyConfigured()` is false when the env var is unset; a key of the wrong length is rejected at first use with a clear message, not silently truncated.

- [ ] **Step 2: Run it, confirm module-not-found. Then implement**

AES-256-GCM. Key from `INSTRUMENT_TOKEN_KEY` — 32 bytes, base64 or hex. Store `iv:authTag:ciphertext` in one column, all base64. A header comment must state: what this protects (a stolen database backup alone yields no usable tokens), what it does NOT protect (a host with both the database and `.env`), and that authentication never decrypts.

- [ ] **Step 3: Schema + migration**

`InstrumentCredential` gains `tokenEncrypted String? @map("token_encrypted")`. Nullable on purpose — every credential issued before this migration has no ciphertext and **must remain unviewable**, not break. Hand-author `<UTC>_instrument_token_encrypted/migration.sql`, apply to both databases, drift guard PASS.

- [ ] **Step 4: Wire issuance**

Everywhere a token is minted — `createWithCredential`, bulk create, `regenerate-token` — store the ciphertext alongside the hash when a key is configured. When no key is configured, store `null` and carry on: issuance must not depend on the key.

- [ ] **Step 5: `GET /:id/token`**

`app.requirePermission('INSTRUMENT_UPDATE')` + `enforceReauth('REVEAL_INSTRUMENT_TOKEN', …)`. Writes an `INSTRUMENT_TOKEN_VIEWED` audit row **inside the transaction**, naming who and when — the compensating control that makes a retrievable credential acceptable. Distinct, non-guessy errors: `TOKEN_NOT_RECOVERABLE` (issued before this feature — tell the operator to regenerate), `TOKEN_KEY_MISSING`, `TOKEN_DECRYPT_FAILED` (wrong key or tampering — this one is a real alarm, log it).

- [ ] **Step 6: `PUT /:id/token`**

Body `{ token }`. Validate in shared Zod: 32–128 chars, `[A-Za-z0-9._-]` only (it must survive an `Authorization` header, an MQTT username and a JSON line unescaped). **Reject a token already in use by another instrument** — a collision would make authentication ambiguous, and the prefix index would resolve it arbitrarily. Revoke-and-insert exactly as `regenerate-token` does, call `invalidateIngestAuthCache(id)`, audit `INSTRUMENT_TOKEN_SET` (never log the value itself).

- [ ] **Step 7: Shared package**

New reauth actions `REVEAL_INSTRUMENT_TOKEN` and `SET_INSTRUMENT_TOKEN` under the existing `Instruments` category; new audit actions `INSTRUMENT_TOKEN_VIEWED` / `INSTRUMENT_TOKEN_SET` plus templates. No new permissions — both reuse `INSTRUMENT_UPDATE`. `npm run build -w @digilog/shared`.

- [ ] **Step 8: e2e**

Reveal returns the same token creation returned; a legacy credential (ciphertext nulled directly in the DB) returns `TOKEN_NOT_RECOVERABLE`, not a 500; setting a custom token makes the OLD token 401 at ingest and the new one 200; a duplicate token is refused; reveal writes exactly one audit row; **an OPERATOR without `INSTRUMENT_UPDATE` gets 403** (`admin` is SUPER_ADMIN and bypasses every permission check, so without this test a misspelt permission string passes everything).

- [ ] **Step 9: Record the reversal**

In `docs/superpowers/specs/2026-08-04-instruments-inbound-ingestion-design.md`, beside D5: keep the original reasoning, add that it was reversed 2026-08-06 at the operator's request, and name the compensating controls (encrypted at rest, permission + re-auth gated, every view audited). Add `INSTRUMENT_TOKEN_KEY` to `.env.example` with a generation command.

- [ ] **Step 10: Verify, commit**

---

### Task 2: Instrument attributes

**Files:**
- Modify: `apps/api/prisma/schema.prisma`, new migration, `routes.ts`, shared schemas + audit actions/templates
- Test: `apps/api/src/e2e/instrument-attributes.test.ts`

**Produces:** `GET|POST /api/instruments/:id/attributes`, `PUT|DELETE /api/instruments/:id/attributes/:key`

- [ ] **Step 1: Schema**

```prisma
model InstrumentAttribute {
  id           String   @id @default(uuid())
  instrumentId String   @map("instrument_id")
  key          String
  value        String
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt    DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  instrument   Instrument @relation(fields: [instrumentId], references: [id], onDelete: Cascade)
  @@unique([instrumentId, key])
  @@index([key])
  @@map("instrument_attributes")
}
```
A child table, not JSONB: each change gets its own audit row naming the key, and `@@unique` makes "set this attribute" idempotent instead of silently duplicating. Hand-author the migration, both databases, drift guard PASS.

- [ ] **Step 2: Routes**

Read on `INSTRUMENT_READ`; write and delete on `INSTRUMENT_UPDATE`. Key: 1–64 chars, trimmed, non-empty after trim. Value: max 1000 chars. Both sanitised through `sanitizeStrings` like every other text field. Upsert on `(instrumentId, key)`. Audit `INSTRUMENT_ATTRIBUTE_SET` / `_REMOVED` inside the transaction, carrying the key and before/after values — an attribute may hold a calibration date, so the change is a §11 record.

- [ ] **Step 3: e2e**

Set/list/update/delete; setting the same key twice updates rather than duplicating; a key of only whitespace is refused; deleting the instrument cascades the attributes away; each mutation writes exactly one audit row with the right before/after.

- [ ] **Step 4: Verify, commit**

---

### Task 3: UI — reveal, set, credential triple, attributes

**Files:** `apps/web/src/routes/instruments/{detail,connection-instructions}.tsx`, new `attributes-panel.tsx`, new `token-panel.tsx`, tests

- [ ] **Step 1: Connection details show the credential three ways**

For every protocol: **Token**, **Username** (= the token), **Password** (empty — say "leave empty", do not render a blank), and **Client ID** where the protocol needs one (MQTT/MQTTS require it: the broker ACL templates on `${clientid}` and the auth hook refuses a mismatch). The point is that a technician can fill a device's config form without inferring anything.

Until revealed, these show `<ACCESS_TOKEN>`; after revealing, the real value — including inside the paste-ready command, which must remain runnable.

- [ ] **Step 2: Token panel**

A **Reveal** button gated on `useCan('instruments.edit')`, triggering the re-auth dialog, then showing the token with a copy affordance and a note that the view was recorded in the audit trail. **Do not leave it revealed indefinitely** — re-hide on navigate away, so a token is not left on screen on an unattended shared workstation.

A **Set token** action for entering a specific value, with the character rules stated up front rather than only as a validation error, and a warning that the device stops working until it is reconfigured.

For a legacy credential the API reports as unrecoverable, say exactly that and offer Regenerate — do not show a broken Reveal button.

- [ ] **Step 3: Attributes panel**

Table with add / edit / delete inline, an empty state, and `useCan('instruments.edit')` gating the mutations while `instruments.view` can read.

- [ ] **Step 4: Tests, typecheck, browser check**

Reveal → re-auth → value appears in both the field and the command; hide on navigate; legacy credential shows the regenerate path; attributes round-trip. Then in the browser: reveal a real token and confirm the displayed `curl`/`mosquitto_pub` command **actually works** when pasted. If it does not, the panel is wrong — that is the whole point of showing it.

- [ ] **Step 5: Full sweep and commit**

```
npx tsc -p apps/api/tsconfig.json --noEmit
cd apps/web && npx tsc -p tsconfig.json --noEmit && npx vitest run && cd ..
cd apps/api && npm test
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-migrations.ps1
```

---

## Self-Review — coverage

| Requirement | Task |
|---|---|
| Token viewable | 1 (crypto + reveal), 3 (UI) |
| Token editable | 1 (set), 3 (UI) |
| Retrievability is gated and audited | 1 |
| Ingest keeps working without the key | 1 |
| Token + username + password + client id shown | 3 |
| Attributes | 2 (API), 3 (UI) |
| The D5 reversal is recorded, not silently made | 1 Step 9 |
