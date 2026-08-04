# Instruments P1 — Foundation + HTTP/HTTPS Ingest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register instruments (single + bulk) in a new Instruments page, and receive their JSON telemetry over HTTP/HTTPS authenticated by a per-instrument token.

**Architecture:** A flat `Instrument` model plus a hashed `InstrumentCredential`. One protocol-agnostic ingest core (parse → queue → batched partitioned write) sits behind a thin HTTP listener; P2 and P3 add MQTT, WebSocket and TCP listeners in front of that same core without changing it.

**Tech Stack:** Fastify 5, Prisma 6, PostgreSQL 18, React 19 + Vite + SWR, vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-instruments-inbound-ingestion-design.md`

## Global Constraints

- **Migrations are hand-authored.** `prisma migrate dev` auto-generation and `prisma db push` are FORBIDDEN against a populated DB. Write SQL into `apps/api/prisma/migrations/<UTC-timestamp>_<name>/migration.sql`, then run `npm run db:verify-migrations` (must PASS) and `npx prisma migrate resolve --applied <name>` on existing DBs.
- **Always pass `DATABASE_URL` explicitly.** Three `.env` files exist and the repo-root one has historically pointed at a sibling checkout. Use `postgresql://digilog:digilog123@localhost:5432/compliance_core_db?schema=public`.
- **Run the API suite single-fork only:** `cd apps/api && npm test`. The default pool gives unstable counts from a shared-`admin` login race. **Baseline: 14 pre-existing failures in 4 files** (`auth-profile-reauth`, `entities`, `super-admin-unretire`, `block-change-approval-current`). Do not "fix" those.
- **Rebuild shared after editing it:** `npm run build -w @digilog/shared`.
- **vitest never typechecks.** Every task must also pass `npx tsc -p apps/api/tsconfig.json --noEmit` and, for web changes, `cd apps/web && npx tsc -p tsconfig.json --noEmit`.
- **Never bcrypt a device token.** `lib/password.ts` is bcrypt rounds=12 (~300ms). Device tokens are 256-bit random, so SHA-256 + timing-safe compare is correct and ~4 orders of magnitude faster.
- **App runs on port 3001** (`apps/api/.env` `PORT=3001`, `API_HTTPS=true`); web dev server is on 5175/5176 depending on which checkout claimed it first.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/prisma/migrations/<ts>_instruments_p1/migration.sql` | Instrument + credential + telemetry tables |
| `apps/api/src/modules/instruments/token.ts` | Generate / hash / compare device tokens (pure) |
| `apps/api/src/modules/instruments/bulk-csv.ts` | Parse + validate bulk CSV (pure) |
| `apps/api/src/modules/instruments/ingest-auth.ts` | Token → instrument resolution, with TTL cache |
| `apps/api/src/modules/instruments/telemetry.repository.ts` | Batched partitioned writes (ported from tag) |
| `apps/api/src/modules/instruments/payload-parser.ts` | Buffer → readings (ported from tag) |
| `apps/api/src/modules/instruments/routes.ts` | Registry CRUD + bulk create |
| `apps/api/src/modules/instruments/ingest-routes.ts` | Device-facing HTTP ingest |
| `apps/api/src/workers/telemetry-partition.worker.ts` | Monthly partition maintenance (ported) |
| `apps/web/src/routes/instruments/list.tsx` | Instruments list |
| `apps/web/src/routes/instruments/create.tsx` | Single create + one-time token dialog |
| `apps/web/src/routes/instruments/bulk-create.tsx` | CSV upload + results |
| `apps/web/src/routes/instruments/detail.tsx` | Connection details, telemetry, regenerate |

Registry routes and device-facing ingest routes are **separate files on purpose**: one is JWT+permission gated, the other is token-authenticated and on the public allowlist. Keeping them apart makes it obvious in review which file is internet-facing.

---

### Task 1: Device token primitives

**Files:**
- Create: `apps/api/src/modules/instruments/token.ts`
- Test: `apps/api/src/modules/instruments/__tests__/token.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `generateToken(): string`, `hashToken(token: string): string`, `tokenPrefix(token: string): string`, `tokenMatches(token: string, storedHash: string): boolean`, `TOKEN_PREFIX_LEN: number`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/modules/instruments/__tests__/token.test.ts
import { describe, it, expect } from 'vitest';
import { generateToken, hashToken, tokenPrefix, tokenMatches, TOKEN_PREFIX_LEN } from '../token.js';

describe('device tokens', () => {
  it('generates a distinct high-entropy token each call', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);   // base64url, safe in a header
  });

  it('hashes deterministically to 64 hex chars (sha256)', () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives a stable prefix for lookup', () => {
    const t = generateToken();
    expect(tokenPrefix(t)).toBe(t.slice(0, TOKEN_PREFIX_LEN));
    expect(tokenPrefix(t)).toHaveLength(TOKEN_PREFIX_LEN);
  });

  it('matches a token against its own hash', () => {
    const t = generateToken();
    expect(tokenMatches(t, hashToken(t))).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(tokenMatches(generateToken(), hashToken(generateToken()))).toBe(false);
  });

  it('rejects a malformed stored hash without throwing', () => {
    const t = generateToken();
    expect(tokenMatches(t, '')).toBe(false);
    expect(tokenMatches(t, 'not-hex')).toBe(false);
    expect(tokenMatches(t, 'ab'.repeat(10))).toBe(false);  // wrong length
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/instruments/__tests__/token.test.ts`
Expected: FAIL — cannot resolve `../token.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/modules/instruments/token.ts
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** Length of the stored, non-secret prefix used to index-seek a credential. */
export const TOKEN_PREFIX_LEN = 8;

/**
 * 32 random bytes -> 43 base64url chars. base64url so the value is safe in an
 * Authorization header, an MQTT username and a JSON line without escaping.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256, NOT bcrypt. bcrypt exists to make guessing LOW-entropy human
 * passwords slow; at rounds=12 it costs ~300ms, which would cap ingest at a
 * handful of readings per second. A 256-bit random token cannot be guessed, so
 * a fast hash is the correct control here.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX_LEN);
}

/** Timing-safe compare so a response-time oracle cannot reveal the hash. */
export function tokenMatches(token: string, storedHash: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/instruments/__tests__/token.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p apps/api/tsconfig.json --noEmit`
Expected: no output

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/instruments/token.ts apps/api/src/modules/instruments/__tests__/token.test.ts
git commit -m "feat(instruments): device token generation, hashing and timing-safe compare"
```

---

### Task 2: Schema — Instrument, InstrumentCredential, telemetry tables

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260804120000_instruments_p1/migration.sql`

**Interfaces:**
- Consumes: nothing
- Produces: Prisma models `Instrument`, `InstrumentCredential`; tables `instrument_telemetry_latest`, `instrument_telemetry_history` (partitioned), `dead_letters`

- [ ] **Step 1: Add the Prisma models**

```prisma
model Instrument {
  id                  String   @id @default(uuid())
  name                String
  code                String   @unique
  transport           String
  isActive            Boolean  @default(true) @map("is_active")
  instrumentType      String?  @map("instrument_type")
  manufacturer        String?
  model               String?
  serialNumber        String?  @map("serial_number")
  description         String?
  expectedIntervalSec Int?     @map("expected_interval_sec")
  createdAt           DateTime @default(now()) @map("created_at")
  updatedAt           DateTime @updatedAt @map("updated_at")
  createdBy           String?  @map("created_by")

  credentials InstrumentCredential[]

  @@map("instruments")
}

model InstrumentCredential {
  id           String    @id @default(uuid())
  instrumentId String    @map("instrument_id")
  tokenHash    String    @map("token_hash")
  tokenPrefix  String    @map("token_prefix")
  createdAt    DateTime  @default(now()) @map("created_at")
  lastUsedAt   DateTime? @map("last_used_at")
  revokedAt    DateTime? @map("revoked_at")

  instrument Instrument @relation(fields: [instrumentId], references: [id], onDelete: Cascade)

  @@index([tokenPrefix])
  @@index([instrumentId])
  @@map("instrument_credentials")
}
```

- [ ] **Step 2: Hand-author the migration**

```sql
-- apps/api/prisma/migrations/20260804120000_instruments_p1/migration.sql
CREATE TABLE "instruments" (
  "id"                    TEXT NOT NULL,
  "name"                  TEXT NOT NULL,
  "code"                  TEXT NOT NULL,
  "transport"             TEXT NOT NULL,
  "is_active"             BOOLEAN NOT NULL DEFAULT true,
  "instrument_type"       TEXT,
  "manufacturer"          TEXT,
  "model"                 TEXT,
  "serial_number"         TEXT,
  "description"           TEXT,
  "expected_interval_sec" INTEGER,
  "created_at"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(3) NOT NULL,
  "created_by"            TEXT,
  CONSTRAINT "instruments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "instruments_code_key" ON "instruments"("code");

CREATE TABLE "instrument_credentials" (
  "id"            TEXT NOT NULL,
  "instrument_id" TEXT NOT NULL,
  "token_hash"    TEXT NOT NULL,
  "token_prefix"  TEXT NOT NULL,
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at"  TIMESTAMPTZ(3),
  "revoked_at"    TIMESTAMPTZ(3),
  CONSTRAINT "instrument_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "instrument_credentials_instrument_id_fkey"
    FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE
);
CREATE INDEX "instrument_credentials_token_prefix_idx" ON "instrument_credentials"("token_prefix");
CREATE INDEX "instrument_credentials_instrument_id_idx" ON "instrument_credentials"("instrument_id");

-- Latest value per (instrument, key) — what the UI reads.
CREATE TABLE "instrument_telemetry_latest" (
  "instrument_id" TEXT NOT NULL,
  "key"           TEXT NOT NULL,
  "value"         JSONB NOT NULL,
  "value_type"    TEXT NOT NULL,
  "ts"            TIMESTAMPTZ NOT NULL,
  CONSTRAINT "instrument_telemetry_latest_pkey" PRIMARY KEY ("instrument_id","key")
);
CREATE INDEX "instrument_telemetry_latest_instrument_id_idx"
  ON "instrument_telemetry_latest"("instrument_id");

-- History: monthly range partitions. Prisma cannot express PARTITION BY, so this
-- is raw SQL. The primary key MUST contain "ts" — PostgreSQL requires a
-- partitioned table's PK to include every partition column.
CREATE TABLE "instrument_telemetry_history" (
  "instrument_id" TEXT NOT NULL,
  "key"           TEXT NOT NULL,
  "value"         JSONB NOT NULL,
  "value_type"    TEXT NOT NULL,
  "ts"            TIMESTAMPTZ NOT NULL,
  PRIMARY KEY ("instrument_id","key","ts")
) PARTITION BY RANGE ("ts");

CREATE INDEX "instrument_telemetry_history_lookup_idx"
  ON "instrument_telemetry_history"("instrument_id","key","ts" DESC);

-- NOT housekeeping: an insert whose ts falls outside every partition is
-- REJECTED ("no partition of relation ... found for row"), so without a future
-- partition ingestion stops dead at midnight on the 1st. Task 8 automates this.
CREATE TABLE "instrument_telemetry_history_2026_08" PARTITION OF "instrument_telemetry_history"
  FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');
CREATE TABLE "instrument_telemetry_history_2026_09" PARTITION OF "instrument_telemetry_history"
  FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');

CREATE TABLE "dead_letters" (
  "id"          TEXT NOT NULL,
  "instrument_id" TEXT,
  "transport"   TEXT NOT NULL,
  "reason"      TEXT NOT NULL,
  "raw_payload" TEXT,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "dead_letters_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "dead_letters_received_at_idx" ON "dead_letters"("received_at");
```

- [ ] **Step 3: Apply and verify no drift**

```bash
DATABASE_URL="postgresql://digilog:digilog123@localhost:5432/compliance_core_db?schema=public" npm run db:migrate
DATABASE_URL="postgresql://digilog:digilog123@localhost:5432/compliance_core_db?schema=public" npx prisma generate --schema apps/api/prisma/schema.prisma
npm run db:verify-migrations
```

Expected: migrate applies; drift guard PASSES.

- [ ] **Step 4: Confirm the partition constraint actually holds**

```bash
PGPASSWORD=digilog123 psql -h localhost -U digilog -d compliance_core_db -c \
 "INSERT INTO instrument_telemetry_history VALUES ('x','k','1'::jsonb,'int','2099-01-01T00:00:00Z');"
```

Expected: **ERROR: no partition of relation "instrument_telemetry_history" found for row.** This proves the partition requirement is real and motivates Task 8. (No cleanup needed — the insert failed.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260804120000_instruments_p1
git commit -m "feat(db): instruments, credentials and partitioned telemetry tables"
```

---

### Task 3: Port the payload parser and telemetry repository from the tag

**Files:**
- Create: `apps/api/src/modules/instruments/payload-parser.ts` (from `pre-data-injection-drop`)
- Create: `apps/api/src/modules/instruments/telemetry.repository.ts` (from tag, trimmed)
- Test: `apps/api/src/modules/instruments/__tests__/payload-parser.test.ts` (from tag)

**Interfaces:**
- Consumes: Task 2 tables
- Produces: `parsePayload(buf: Buffer): ParsedPayload`, `toReadings(values: Record<string, unknown>, ts: Date): Reading[]`, `classifyValue(v: unknown): ValueType`, `writeBatch(rows)`, `writeDeadLetters(rows)`, `getLatest(instrumentId)`, `getHistory(opts)`

- [ ] **Step 1: Recover the files**

```bash
git show pre-data-injection-drop:apps/api/src/modules/data-injection/payload-parser.ts \
  > apps/api/src/modules/instruments/payload-parser.ts
git show pre-data-injection-drop:apps/api/src/modules/data-injection/__tests__/payload-parser.test.ts \
  > apps/api/src/modules/instruments/__tests__/payload-parser.test.ts
git show pre-data-injection-drop:apps/api/src/modules/data-injection/telemetry.repository.ts \
  > apps/api/src/modules/instruments/telemetry.repository.ts
```

- [ ] **Step 2: Fix imports and delete outbound-only code**

In `telemetry.repository.ts`, delete `buildResolverMaps` and `buildResolverCache` — they resolved *outbound* broker topics to instruments and have no inbound equivalent. Update relative imports (`../../lib/prisma.js` still resolves; verify each). In the test file, fix the import path to `../payload-parser.js`.

- [ ] **Step 3: Run the ported tests**

Run: `cd apps/api && npx vitest run src/modules/instruments/__tests__/payload-parser.test.ts`
Expected: PASS. If any fail, the port is wrong — do not edit the assertions to match; re-read the original.

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p apps/api/tsconfig.json --noEmit`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/instruments/payload-parser.ts apps/api/src/modules/instruments/telemetry.repository.ts apps/api/src/modules/instruments/__tests__/payload-parser.test.ts
git commit -m "feat(instruments): port payload parser and telemetry repository from pre-data-injection-drop"
```

---

### Task 4: Ingest authentication (token → instrument) with TTL cache

**Files:**
- Create: `apps/api/src/modules/instruments/ingest-auth.ts`
- Test: `apps/api/src/modules/instruments/__tests__/ingest-auth.test.ts`

**Interfaces:**
- Consumes: Task 1 (`tokenPrefix`, `tokenMatches`), Task 2 models
- Produces: `resolveInstrumentByToken(token: string): Promise<{ id: string; code: string; transport: string } | null>`, `invalidateIngestAuthCache(instrumentId?: string): void`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/modules/instruments/__tests__/ingest-auth.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
vi.mock('../../../lib/prisma.js', () => ({
  prisma: { instrumentCredential: { findMany: (...a: unknown[]) => findMany(...a) } },
}));

import { generateToken, hashToken, tokenPrefix } from '../token.js';
import { resolveInstrumentByToken, invalidateIngestAuthCache } from '../ingest-auth.js';

const row = (token: string, over: Record<string, unknown> = {}) => ({
  id: 'cred-1',
  tokenHash: hashToken(token),
  tokenPrefix: tokenPrefix(token),
  revokedAt: null,
  instrument: { id: 'inst-1', code: 'TEMP-01', transport: 'http', isActive: true },
  ...over,
});

beforeEach(() => { findMany.mockReset(); invalidateIngestAuthCache(); });

describe('resolveInstrumentByToken', () => {
  it('resolves a valid token to its instrument', async () => {
    const t = generateToken();
    findMany.mockResolvedValue([row(t)]);
    await expect(resolveInstrumentByToken(t)).resolves.toMatchObject({ id: 'inst-1', code: 'TEMP-01' });
  });

  it('returns null for an unknown token', async () => {
    findMany.mockResolvedValue([]);
    expect(await resolveInstrumentByToken(generateToken())).toBeNull();
  });

  it('returns null when the stored hash belongs to a different token', async () => {
    findMany.mockResolvedValue([row(generateToken())]);
    expect(await resolveInstrumentByToken(generateToken())).toBeNull();
  });

  it('refuses a revoked credential', async () => {
    const t = generateToken();
    findMany.mockResolvedValue([row(t, { revokedAt: new Date() })]);
    expect(await resolveInstrumentByToken(t)).toBeNull();
  });

  it('refuses an inactive instrument', async () => {
    const t = generateToken();
    findMany.mockResolvedValue([row(t, { instrument: { id: 'i', code: 'C', transport: 'http', isActive: false } })]);
    expect(await resolveInstrumentByToken(t)).toBeNull();
  });

  it('caches so a hot device does not hit the DB every reading', async () => {
    const t = generateToken();
    findMany.mockResolvedValue([row(t)]);
    await resolveInstrumentByToken(t);
    await resolveInstrumentByToken(t);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('re-queries after the cache is invalidated — revocation must take effect', async () => {
    const t = generateToken();
    findMany.mockResolvedValue([row(t)]);
    await resolveInstrumentByToken(t);
    invalidateIngestAuthCache();
    findMany.mockResolvedValue([]);
    expect(await resolveInstrumentByToken(t)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/instruments/__tests__/ingest-auth.test.ts`
Expected: FAIL — cannot resolve `../ingest-auth.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/modules/instruments/ingest-auth.ts
import { prisma } from '../../lib/prisma.js';
import { tokenMatches, tokenPrefix } from './token.js';

export interface IngestIdentity { id: string; code: string; transport: string }

// Short TTL, mirroring lib/reauth-check.ts. A device may post every second; a DB
// round trip per reading is the difference between working and not. The TTL is
// also the worst-case delay before a revocation takes effect, so keep it small.
const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { identity: IngestIdentity | null; at: number }>();

export function invalidateIngestAuthCache(instrumentId?: string): void {
  if (!instrumentId) { cache.clear(); return; }
  for (const [k, v] of cache) if (v.identity?.id === instrumentId) cache.delete(k);
}

export async function resolveInstrumentByToken(token: string): Promise<IngestIdentity | null> {
  if (!token) return null;

  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.identity;

  // Seek on the non-secret prefix, then compare hashes in constant time. Several
  // credentials can share a prefix, so this is a list, not a findUnique.
  const rows = await prisma.instrumentCredential.findMany({
    where: { tokenPrefix: tokenPrefix(token), revokedAt: null },
    include: { instrument: true },
  });

  let identity: IngestIdentity | null = null;
  for (const r of rows) {
    if (!tokenMatches(token, r.tokenHash)) continue;
    if (!r.instrument?.isActive) break;      // known token, disabled device
    identity = { id: r.instrument.id, code: r.instrument.code, transport: r.instrument.transport };
    break;
  }

  cache.set(token, { identity, at: Date.now() });
  return identity;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/instruments/__tests__/ingest-auth.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/instruments/ingest-auth.ts apps/api/src/modules/instruments/__tests__/ingest-auth.test.ts
git commit -m "feat(instruments): resolve device tokens to instruments with a short-TTL cache"
```

---

### Task 5: HTTP/HTTPS ingest endpoint + auth-hook allowlist + invariant test

**Files:**
- Create: `apps/api/src/modules/instruments/ingest-routes.ts`
- Modify: `apps/api/src/plugins/auth.ts:170-184` (add to `PUBLIC_PATHS`)
- Modify: `apps/api/src/app.ts` (register at `/api/ingest/v1`)
- Test: `apps/api/src/e2e/instrument-ingest.test.ts`
- Test: `apps/api/src/plugins/__tests__/public-paths.test.ts`

**Interfaces:**
- Consumes: Task 3 (`parsePayload`, `toReadings`, `writeBatch`, `writeDeadLetters`), Task 4 (`resolveInstrumentByToken`)
- Produces: `POST /api/ingest/v1/telemetry`

- [ ] **Step 1: Write the failing invariant test for the allowlist**

```typescript
// apps/api/src/plugins/__tests__/public-paths.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * An allowlist on an auth hook is where holes get made. This pins the EXACT set
 * of unauthenticated paths, so adding one is a deliberate, reviewed act rather
 * than a side effect. If you are here because this failed: confirm the new path
 * must genuinely be reachable without a login, then update this list.
 */
describe('auth plugin public paths', () => {
  const src = readFileSync(resolve(__dirname, '../auth.ts'), 'utf8');
  const block = src.slice(src.indexOf('const PUBLIC_PATHS'), src.indexOf('// Paths that are public only for GET'));
  const paths = [...block.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]).sort();

  it('exposes only the expected unauthenticated paths', () => {
    expect(paths).toEqual([
      '/api/auth/beacon-logout',
      '/api/auth/forgot-password',
      '/api/auth/login',
      '/api/guest/cleaning-request',
      '/api/health',
      '/api/ingest/v1/telemetry',
      '/api/notification-settings/email/oauth2/code',
      '/docs',
      '/docs/',
    ]);
  });

  it('exposes exactly one ingest path in P1', () => {
    expect(paths.filter((p) => p.startsWith('/api/ingest/'))).toEqual(['/api/ingest/v1/telemetry']);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd apps/api && npx vitest run src/plugins/__tests__/public-paths.test.ts`
Expected: FAIL — `/api/ingest/v1/telemetry` missing.

- [ ] **Step 3: Add the ingest path to the allowlist**

In `apps/api/src/plugins/auth.ts`, inside `PUBLIC_PATHS`, add:

```typescript
  // Device-facing ingest. Authenticated by a per-instrument token in
  // ingest-routes.ts, NOT by a user JWT — so it must bypass this hook.
  // Guarded by plugins/__tests__/public-paths.test.ts.
  '/api/ingest/v1/telemetry',
```

- [ ] **Step 4: Write the ingest route**

```typescript
// apps/api/src/modules/instruments/ingest-routes.ts
import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { resolveInstrumentByToken } from './ingest-auth.js';
import { parsePayload, toReadings } from './payload-parser.js';
import { writeBatch, writeDeadLetters } from './telemetry.repository.js';

function bearer(header?: string): string {
  if (!header) return '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : '';
}

export default async function ingestRoutes(app: FastifyInstance) {
  app.post('/telemetry', {
    // Tighter than the global 5000/min: this is the only route a device (or
    // anyone) can reach without logging in.
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    schema: {
      tags: ['Ingest'],
      summary: 'Submit telemetry (device token auth)',
      response: {
        200: { type: 'object', properties: { accepted: { type: 'integer' } } },
        401: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (req, reply) => {
    const identity = await resolveInstrumentByToken(bearer(req.headers.authorization));
    if (!identity) return reply.code(401).send({ error: 'INVALID_DEVICE_TOKEN' });

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? ''));
    const parsed = parsePayload(raw);
    if (!parsed.ok) {
      // Never 500 on a malformed device payload — record it and move on, so one
      // bad device cannot take the endpoint down for the others.
      await writeDeadLetters([{
        id: randomUUID(), instrumentId: identity.id, transport: 'http',
        reason: parsed.error, rawPayload: raw.toString('utf8').slice(0, 4000),
      }]);
      return reply.code(202).send({ accepted: 0 });
    }

    const readings = toReadings(parsed.values, parsed.ts ?? new Date());
    await writeBatch(readings.map((r) => ({ ...r, instrumentId: identity.id })));
    return reply.send({ accepted: readings.length });
  });
}
```

> If `parsePayload`'s returned shape differs from `{ ok, values, ts, error }`, adapt to the ported file — it is the source of truth, not this snippet.

- [ ] **Step 5: Register it**

In `apps/api/src/app.ts`, beside the other registrations:

```typescript
await app.register(ingestRoutes, { prefix: '/api/ingest/v1' });
```

- [ ] **Step 6: Write the e2e test**

```typescript
// apps/api/src/e2e/instrument-ingest.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { generateToken, hashToken, tokenPrefix } from '../modules/instruments/token.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let token: string;
let instrumentId: string;

beforeAll(async () => {
  app = await buildApp();
  token = generateToken();
  const inst = await prisma.instrument.create({
    data: { name: 'Ingest Probe', code: `ING-${Date.now()}`, transport: 'http' },
  });
  instrumentId = inst.id;
  await prisma.instrumentCredential.create({
    data: { instrumentId, tokenHash: hashToken(token), tokenPrefix: tokenPrefix(token) },
  });
});

afterAll(async () => {
  await prisma.instrument.delete({ where: { id: instrumentId } });
  await app.close();
});

describe('POST /api/ingest/v1/telemetry', () => {
  it('accepts readings with a valid token and stores them', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${token}` },
      payload: { temp: 22.5, rh: 45 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(2);

    const latest = await prisma.$queryRaw<Array<{ key: string }>>`
      SELECT key FROM instrument_telemetry_latest WHERE instrument_id = ${instrumentId} ORDER BY key`;
    expect(latest.map((r) => r.key)).toEqual(['rh', 'temp']);
  });

  it('rejects a missing token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ingest/v1/telemetry', payload: { a: 1 } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${generateToken()}` }, payload: { a: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('dead-letters malformed JSON instead of 500ing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: 'not json at all',
    });
    expect(res.statusCode).not.toBe(500);
  });
});
```

- [ ] **Step 7: Run both test files**

Run: `cd apps/api && npx vitest run src/plugins/__tests__/public-paths.test.ts src/e2e/instrument-ingest.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS.

- [ ] **Step 8: Verify against the running API, not just tests**

```bash
# start the API, then:
TOKEN=<paste a token created via psql or the API>
curl -sk -X POST https://localhost:3001/api/ingest/v1/telemetry \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"temp":22.5,"rh":45}' -w '\n%{http_code}\n'
```

Expected: `{"accepted":2}` and `200`. Then confirm the row exists:

```bash
PGPASSWORD=digilog123 psql -h localhost -U digilog -d compliance_core_db \
  -c "SELECT key, value, ts FROM instrument_telemetry_latest ORDER BY ts DESC LIMIT 5;"
```

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/instruments/ingest-routes.ts apps/api/src/plugins/auth.ts apps/api/src/app.ts apps/api/src/e2e/instrument-ingest.test.ts apps/api/src/plugins/__tests__/public-paths.test.ts
git commit -m "feat(instruments): HTTP telemetry ingest with device-token auth and pinned allowlist"
```

---

### Task 6: Bulk CSV parsing and validation (pure)

**Files:**
- Create: `apps/api/src/modules/instruments/bulk-csv.ts`
- Test: `apps/api/src/modules/instruments/__tests__/bulk-csv.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `parseInstrumentCsv(text: string): { rows: InstrumentDraft[]; errors: RowError[] }`, `TRANSPORTS: readonly string[]`, types `InstrumentDraft { name; code; transport; instrumentType?; manufacturer?; model?; serialNumber?; description? }` and `RowError { row: number; message: string }`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/modules/instruments/__tests__/bulk-csv.test.ts
import { describe, it, expect } from 'vitest';
import { parseInstrumentCsv } from '../bulk-csv.js';

const HEADER = 'name,code,transport';

describe('parseInstrumentCsv', () => {
  it('parses valid rows', () => {
    const r = parseInstrumentCsv(`${HEADER}\nProbe A,PA-1,http\nProbe B,PB-1,mqtt`);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { name: 'Probe A', code: 'PA-1', transport: 'http' },
      { name: 'Probe B', code: 'PB-1', transport: 'mqtt' },
    ]);
  });

  it('reports bad rows by line number but keeps the good ones (partial success)', () => {
    const r = parseInstrumentCsv(`${HEADER}\nGood,G-1,http\n,MISSING-NAME,http\nBad,B-1,carrier-pigeon`);
    expect(r.rows).toEqual([{ name: 'Good', code: 'G-1', transport: 'http' }]);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatchObject({ row: 3 });
    expect(r.errors[1]).toMatchObject({ row: 4 });
    expect(r.errors[1].message).toMatch(/transport/i);
  });

  it('rejects duplicate codes within the same file', () => {
    const r = parseInstrumentCsv(`${HEADER}\nA,DUP,http\nB,DUP,http`);
    expect(r.rows).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/duplicate/i);
  });

  it('rejects a missing or misspelled header', () => {
    expect(parseInstrumentCsv('nombre,code,transport\nA,B,http').errors[0].message).toMatch(/header/i);
    expect(parseInstrumentCsv('').errors[0].message).toMatch(/header/i);
  });

  it('tolerates CRLF, blank lines and surrounding whitespace', () => {
    const r = parseInstrumentCsv(`${HEADER}\r\n Probe A , PA-1 , http \r\n\r\n`);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([{ name: 'Probe A', code: 'PA-1', transport: 'http' }]);
  });

  it('keeps optional columns when present', () => {
    const r = parseInstrumentCsv('name,code,transport,manufacturer\nA,A-1,http,Vaisala');
    expect(r.rows[0]).toMatchObject({ manufacturer: 'Vaisala' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/instruments/__tests__/bulk-csv.test.ts`
Expected: FAIL — cannot resolve `../bulk-csv.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/modules/instruments/bulk-csv.ts
export const TRANSPORTS = ['http', 'https', 'mqtt', 'mqtts', 'websocket', 'wss', 'tcp'] as const;

const REQUIRED = ['name', 'code', 'transport'] as const;
const OPTIONAL = ['instrumentType', 'manufacturer', 'model', 'serialNumber', 'description'] as const;

export interface InstrumentDraft {
  name: string; code: string; transport: string;
  instrumentType?: string; manufacturer?: string; model?: string;
  serialNumber?: string; description?: string;
}
export interface RowError { row: number; message: string }

/**
 * Deliberately partial-success: valid rows are returned even when others fail,
 * so one typo does not reject a 200-device import. Row numbers are 1-based and
 * count the header, matching what the operator sees in a spreadsheet.
 */
export function parseInstrumentCsv(text: string): { rows: InstrumentDraft[]; errors: RowError[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return { rows: [], errors: [{ row: 1, message: 'Missing header row' }] };

  const header = lines[0].split(',').map((h) => h.trim());
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return { rows: [], errors: [{ row: 1, message: `Missing header column(s): ${missing.join(', ')}` }] };
  }

  const rows: InstrumentDraft[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const rowNo = i + 1;
    const cells = lines[i].split(',').map((c) => c.trim());
    const get = (col: string) => { const idx = header.indexOf(col); return idx === -1 ? '' : (cells[idx] ?? ''); };

    const name = get('name'), code = get('code'), transport = get('transport').toLowerCase();

    if (!name) { errors.push({ row: rowNo, message: 'name is required' }); continue; }
    if (!code) { errors.push({ row: rowNo, message: 'code is required' }); continue; }
    if (!TRANSPORTS.includes(transport as (typeof TRANSPORTS)[number])) {
      errors.push({ row: rowNo, message: `transport must be one of: ${TRANSPORTS.join(', ')}` });
      continue;
    }
    if (seen.has(code)) { errors.push({ row: rowNo, message: `duplicate code "${code}" in this file` }); continue; }
    seen.add(code);

    const draft: InstrumentDraft = { name, code, transport };
    for (const col of OPTIONAL) { const v = get(col); if (v) (draft as Record<string, string>)[col] = v; }
    rows.push(draft);
  }

  return { rows, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/instruments/__tests__/bulk-csv.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/instruments/bulk-csv.ts apps/api/src/modules/instruments/__tests__/bulk-csv.test.ts
git commit -m "feat(instruments): CSV parsing with partial success for bulk creation"
```

---

### Task 7: Registry API — CRUD, bulk create, token regeneration

**Files:**
- Create: `apps/api/src/modules/instruments/routes.ts`
- Modify: `apps/api/src/app.ts` (register at `/api/instruments`)
- Modify: `packages/shared/src/types/permissions.ts`, `packages/shared/src/types/permission-tree.ts`, `packages/shared/src/types/reauth-actions.ts`
- Test: `apps/api/src/e2e/instruments.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, 6
- Produces: `GET /api/instruments`, `GET /api/instruments/:id`, `POST /api/instruments`, `PUT /api/instruments/:id`, `DELETE /api/instruments/:id`, `POST /api/instruments/bulk`, `POST /api/instruments/:id/regenerate-token`

- [ ] **Step 1: Add permissions and reauth action to shared**

In `packages/shared/src/types/permissions.ts` add `INSTRUMENT_READ`, `INSTRUMENT_CREATE`, `INSTRUMENT_UPDATE`, `INSTRUMENT_DELETE`. In `reauth-actions.ts` add `REGENERATE_INSTRUMENT_TOKEN` under a new `Instruments` category. In `permission-tree.ts` add an `instruments` group with a page node and action nodes whose `gate` values are the four permissions above.

Then: `npm run build -w @digilog/shared`

- [ ] **Step 2: Update the frozen snapshot test**

The shared package has a frozen-snapshot test locking `FEATURE_PRIVILEGES` counts. Run `cd packages/shared && npx vitest run` — it will fail with the old counts. Update the snapshot to the new values **only after confirming the delta equals exactly the nodes you added**.

- [ ] **Step 3: Write the e2e test**

```typescript
// apps/api/src/e2e/instruments.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let auth: Record<string, string>;
const created: string[] = [];

// test-helper exports buildApp()/loginAs() and returns a RAW TOKEN STRING, not
// a headers object — build the header here.
beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});
afterAll(async () => {
  for (const id of created) await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  await app.close();
});

describe('Instruments registry', () => {
  it('creates an instrument and returns the token EXACTLY once', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth,
      payload: { name: 'Probe', code: `P-${Date.now()}`, transport: 'http' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    created.push(body.id);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43,}$/);

    // Re-reading must NOT expose it.
    const again = await app.inject({ method: 'GET', url: `/api/instruments/${body.id}`, headers: auth });
    expect(again.json().token).toBeUndefined();
    expect(again.json().tokenPrefix).toBeDefined();
  });

  it('rejects a duplicate code', async () => {
    const code = `DUP-${Date.now()}`;
    const a = await app.inject({ method: 'POST', url: '/api/instruments', headers: auth, payload: { name: 'A', code, transport: 'http' } });
    created.push(a.json().id);
    const b = await app.inject({ method: 'POST', url: '/api/instruments', headers: auth, payload: { name: 'B', code, transport: 'http' } });
    expect(b.statusCode).toBe(409);
  });

  it('rejects an unknown transport', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/instruments', headers: auth, payload: { name: 'X', code: `X-${Date.now()}`, transport: 'carrier-pigeon' } });
    expect(res.statusCode).toBe(400);
  });

  it('bulk-creates with partial success and returns one token per created row', async () => {
    const stamp = Date.now();
    const csv = `name,code,transport\nBulk A,BA-${stamp},http\nBulk B,BB-${stamp},nonsense`;
    const res = await app.inject({
      method: 'POST', url: '/api/instruments/bulk', headers: auth,
      payload: { csv },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toHaveLength(1);
    expect(body.created[0].token).toBeDefined();
    expect(body.errors).toHaveLength(1);
    created.push(body.created[0].id);
  });

  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/instruments' })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 4: Implement the routes**

Follow `apps/api/src/modules/users/routes.ts` for structure: `app.requirePermission(...)` in `preHandler`, `safeParse` + `reply.code(400).send({ error: 'VALIDATION_ERROR', details })` for bodies (**never `.parse()`** — a thrown ZodError becomes a 500), `...errorResponses` in every response schema, and `auditLog(...)` after each mutation.

Key behaviours the tests above pin:
- `POST /` creates instrument + credential in **one transaction**, returns `201` with `{ ...instrument, token }`. Duplicate code → `409`.
- `GET /:id` and `GET /` return `tokenPrefix` but **never** `token` or `tokenHash`.
- `POST /bulk` takes `{ csv }`, runs `parseInstrumentCsv`, creates the valid rows (each with a credential, each with its own audit row), returns `{ created: [{id, code, token}], errors: [{row, message}] }`.
- `POST /:id/regenerate-token` requires `enforceReauth('REGENERATE_INSTRUMENT_TOKEN', req, reply)`, revokes the current credential, inserts a new one, calls `invalidateIngestAuthCache(id)`, returns the new token once.
- `DELETE /:id` cascades the credential.

- [ ] **Step 5: Register and run**

```typescript
await app.register(instrumentRoutes, { prefix: '/api/instruments' });
```

Run: `cd apps/api && npx vitest run src/e2e/instruments.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (5 tests)

- [ ] **Step 6: Verify regeneration actually revokes**

Create an instrument, POST telemetry with its token (expect 200), regenerate, then POST with the **old** token. Expect `401` — with no more than the 10 s cache TTL of delay. This is the test that proves `invalidateIngestAuthCache` is wired.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/instruments/routes.ts apps/api/src/app.ts packages/shared/src apps/api/src/e2e/instruments.test.ts
git commit -m "feat(instruments): registry CRUD, bulk create and token regeneration"
```

---

### Task 8: Partition maintenance worker

**Files:**
- Create: `apps/api/src/workers/telemetry-partition.worker.ts` (from tag)
- Modify: `apps/api/src/workers/task-list.ts` or the graphile taskList in `app.ts`
- Modify: `packages/queue/crontab.txt`
- Test: `apps/api/src/workers/__tests__/telemetry-partition.test.ts` (from tag)

**Interfaces:**
- Consumes: Task 2 tables
- Produces: graphile task `telemetry_partition_maintenance`

- [ ] **Step 1: Recover the worker and its test**

```bash
git show pre-data-injection-drop:apps/api/src/workers/telemetry-partition.worker.ts > apps/api/src/workers/telemetry-partition.worker.ts
git show pre-data-injection-drop:apps/api/src/workers/__tests__/telemetry-partition.test.ts > apps/api/src/workers/__tests__/telemetry-partition.test.ts
```

- [ ] **Step 2: Make the test use a SCRATCH table**

⚠️ The original version of this test ran `dropExpiredPartitions` against the **real** table with a far-future `now`, destroying every 2026 partition and breaking 12 other tests — and the guard test written to catch that passed, because it ran after the drop against an already-empty baseline. Rewrite the test to create and operate on a scratch partitioned table, never `instrument_telemetry_history`.

- [ ] **Step 3: Register the task and cron entry**

Add `telemetry_partition_maintenance` to the graphile `taskList`, and to `packages/queue/crontab.txt`:

```
# Telemetry partitions — 1st and 15th at 00:05. Creates next month's partition
# ahead of time; without it, inserts are REJECTED from midnight on the 1st.
5 0 1 * * telemetry_partition_maintenance ?id=telemetry_partition_dom01&max=1&fill=0s
5 0 15 * * telemetry_partition_maintenance ?id=telemetry_partition_dom15&max=1&fill=0s
```

⚠️ Every identifier in that file must have a handler, and one malformed entry rejects the whole crontab at boot. After editing, **boot the API and confirm both entries registered**:

```bash
PGPASSWORD=digilog123 psql -h localhost -U digilog -d compliance_core_db \
  -c "SELECT identifier FROM graphile_worker._private_known_crontabs ORDER BY 1;"
```

Expected: includes both `telemetry_partition_dom01` and `telemetry_partition_dom15`, and still includes `session_sweep` and `password_expiry_check`.

- [ ] **Step 4: Run the test**

Run: `cd apps/api && npx vitest run src/workers/__tests__/telemetry-partition.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workers/telemetry-partition.worker.ts apps/api/src/workers/__tests__/telemetry-partition.test.ts packages/queue/crontab.txt apps/api/src/workers/task-list.ts
git commit -m "feat(instruments): telemetry partition maintenance worker and cron entries"
```

---

### Task 9: Sidebar entry + route tree + parity test

**Files:**
- Modify: `packages/shared/src/types/sidebar-items.ts`
- Modify: `apps/web/src/components/layout/sidebar.tsx`
- Modify: `apps/web/src/main.tsx`
- Test: `apps/web/src/components/layout/__tests__/sidebar-parity.test.ts` (restore from tag)

**Interfaces:**
- Consumes: Task 7 permissions
- Produces: `/instruments` route, `instruments` sidebar id

- [ ] **Step 1: Restore the parity test FIRST**

```bash
git show pre-data-injection-drop:apps/web/src/components/layout/__tests__/sidebar-parity.test.ts \
  > apps/web/src/components/layout/__tests__/sidebar-parity.test.ts
```

Run it now: `cd apps/web && npx vitest run src/components/layout/__tests__/sidebar-parity.test.ts`
Expected: PASS against the current 9/9 ids. This establishes the guard **before** you add a tenth.

- [ ] **Step 2: Add the id to BOTH lists**

There are two independent lists and updating only one ships a feature with no nav link — that has happened here before:
- `packages/shared/src/types/sidebar-items.ts`: `{ id: 'instruments', label: 'Instruments', icon: '📟', description: 'Devices and telemetry' }`
- `apps/web/src/components/layout/sidebar.tsx` `allNavItems`: matching entry with `href: "/instruments"`

Then: `npm run build -w @digilog/shared`

- [ ] **Step 3: Re-run the parity test**

Run: `cd apps/web && npx vitest run src/components/layout/__tests__/sidebar-parity.test.ts`
Expected: PASS with 10 ids each. If it fails, one list is missing the entry — that is exactly the bug it exists to catch.

- [ ] **Step 4: Add the routes**

In `apps/web/src/main.tsx`, add lazy routes for `/instruments`, `/instruments/new`, `/instruments/bulk`, `/instruments/:id`, each wrapped in `<RequireRole permissions={[PERMISSIONS.INSTRUMENT_READ]}>`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/sidebar-items.ts apps/web/src/components/layout/sidebar.tsx apps/web/src/main.tsx apps/web/src/components/layout/__tests__/sidebar-parity.test.ts
git commit -m "feat(web): Instruments sidebar entry, routes, and restored sidebar parity test"
```

---

### Task 10: Instruments list page

**Files:**
- Create: `apps/web/src/routes/instruments/list.tsx`

**Interfaces:**
- Consumes: `GET /api/instruments` (Task 7)
- Produces: the `/instruments` page

- [ ] **Step 1: Build the page following `users/list.tsx`**

Use `useSWR` and `usePaginationConfig()` exactly as `apps/web/src/routes/users/list.tsx` does. Columns: name, code, transport, status, last seen, actions. Filters: transport, active/inactive, search. Buttons for **New Instrument** and **Bulk Upload**, gated with `useCan('instruments.create')`.

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc -p tsconfig.json --noEmit`
Expected: no output.

- [ ] **Step 3: Verify in the browser**

Log in (note: **:5176** if the sibling checkout holds :5175), open `/instruments`, confirm the page renders, the nav item is present and highlighted, and the browser console has **no errors**.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/instruments/list.tsx
git commit -m "feat(web): Instruments list page"
```

---

### Task 11: Single create + one-time credential dialog

**Files:**
- Create: `apps/web/src/routes/instruments/create.tsx`
- Create: `apps/web/src/routes/instruments/connection-instructions.tsx`
- Test: `apps/web/src/routes/instruments/__tests__/connection-instructions.test.tsx`

**Interfaces:**
- Consumes: `POST /api/instruments`
- Produces: `<ConnectionInstructions transport={string} code={string} token={string} />`

- [ ] **Step 1: Write the failing test for the instructions component**

```tsx
// apps/web/src/routes/instruments/__tests__/connection-instructions.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionInstructions } from '../connection-instructions';

describe('ConnectionInstructions', () => {
  it('shows a curl example for http', () => {
    render(<ConnectionInstructions transport="http" code="T-1" token="TOK" />);
    expect(screen.getByText(/curl/)).toBeInTheDocument();
    expect(screen.getByText(/Bearer TOK/)).toBeInTheDocument();
  });

  it('shows the topic and username for mqtt', () => {
    render(<ConnectionInstructions transport="mqtt" code="T-1" token="TOK" />);
    expect(screen.getByText(/instruments\/T-1\/telemetry/)).toBeInTheDocument();
  });

  it('shows exactly one example — never all transports at once', () => {
    render(<ConnectionInstructions transport="http" code="T-1" token="TOK" />);
    expect(screen.queryByText(/mosquitto_pub/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/routes/instruments/__tests__/connection-instructions.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component and the create page**

`ConnectionInstructions` switches on `transport` and renders exactly one block: endpoint/topic plus a paste-ready example. The create form posts to `/api/instruments`; on success it opens a modal showing the token with a copy button, the words **"This is the only time this token will be shown"**, and `<ConnectionInstructions />`.

- [ ] **Step 4: Run the test**

Expected: PASS (3 tests)

- [ ] **Step 5: End-to-end check in the browser**

Create an instrument, copy the token, and actually run the displayed `curl` command. It must return `{"accepted":N}`. **If the pasted command does not work, the instructions are wrong** — that is the whole point of this task.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/instruments/create.tsx apps/web/src/routes/instruments/connection-instructions.tsx apps/web/src/routes/instruments/__tests__/connection-instructions.test.tsx
git commit -m "feat(web): single instrument creation with one-time token and connection instructions"
```

---

### Task 12: Bulk create UI and detail page

**Files:**
- Create: `apps/web/src/routes/instruments/bulk-create.tsx`
- Create: `apps/web/src/routes/instruments/detail.tsx`

**Interfaces:**
- Consumes: `POST /api/instruments/bulk`, `GET /api/instruments/:id`, `POST /api/instruments/:id/regenerate-token`

- [ ] **Step 1: Build the bulk page**

A **Download template** link producing `name,code,transport\n`, a file input accepting `.csv`, and a results view listing created instruments (with tokens) and per-row errors with row numbers.

Include a **Download results CSV** button, and label it clearly: *"Contains device tokens in plain text — store securely. Tokens cannot be retrieved later."*

- [ ] **Step 2: Build the detail page**

Connection instructions for that transport, latest telemetry table, recent history, this device's dead letters, and a **Regenerate token** button gated by `useCan('instruments.update')` that triggers the reauth dialog.

- [ ] **Step 3: Verify in the browser**

Upload a CSV with 3 good rows and 1 bad. Confirm: 3 created, 1 error with the correct row number, results CSV downloads, and one of the new tokens actually works against the ingest endpoint.

- [ ] **Step 4: Full verification sweep**

```bash
npx tsc -p apps/api/tsconfig.json --noEmit
cd apps/web && npx tsc -p tsconfig.json --noEmit && cd ..
cd apps/api && npm test        # single-fork; expect 14 pre-existing failures, no new ones
cd ../.. && npm run db:verify-migrations
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/instruments/
git commit -m "feat(web): bulk instrument creation and instrument detail page"
```

---

## Self-Review — spec coverage

| Spec section | Covered by |
|---|---|
| §4.1 `Instrument` | Task 2 |
| §4.2 `InstrumentCredential` | Task 2 |
| §4.3 Reused telemetry tables | Tasks 2, 3 |
| §5 Ingest pipeline | Tasks 3, 5 |
| §5.1 HTTP/HTTPS auth | Task 5 |
| §5.1 MQTT / WS / TCP auth | **P2 and P3** (see below) |
| §5.2 Auth-hook exemption | Task 5 |
| §6.1 Sidebar | Task 9 |
| §6.2 List page | Task 10 |
| §6.3 Single create + one-time token | Task 11 |
| §6.4 Bulk create | Tasks 6, 7, 12 |
| §6.5 Detail page | Task 12 |
| §7 RBAC and audit | Task 7 |
| §8 Testing (HTTP) | Tasks 5, 7 |
| §8 Testing (MQTT/WS/TCP) | **P2 and P3** |
| §9 Partition risk | Task 8 |

## Follow-on plans

- **P2 — MQTT/MQTTS:** EMQX HTTP auth hook (`POST /api/ingest/v1/mqtt-auth`), broker subscription to `instruments/+/telemetry`, verified against the real EMQX 5.3.2 on this machine, including revocation taking effect immediately.
- **P3 — WebSocket + TCP:** re-add `@fastify/websocket` (removed as dead code 2026-07-03), a WS upgrade handler, and a `net.Server` with newline framing, connection caps, idle timeouts and the mandatory **split-packet test**.

Both build on the ingest core from Task 3 and the auth from Task 4 without modifying them.
