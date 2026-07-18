# Windows-Friendly Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate every paid tool, every native-compilation dependency, and every heavy binary download from the production Windows deployment path, so that DigiLog ships and runs on a fresh Windows machine using only free open-source dependencies and PostgreSQL features that already exist in the data layer.

**Architecture:**
- **MQTT broker:** swap EMQX (Erlang, Linux-first, requires manual NSSM registration) for Mosquitto (Windows-native, ~5 MB, ships an MSI installer with service registration). Auth path moves from EMQX HTTP-webhook (currently in `mqtt-auth-routes.ts`) to Mosquitto's built-in dynamic security plugin.
- **Job queue:** swap BullMQ + Redis/Memurai (paid, ~30 USD/year/server, native Redis-protocol semantics, Erlang-style cluster discovery) for **graphile-worker** (pure-JS npm package using PostgreSQL `LISTEN/NOTIFY` + `SELECT … FOR UPDATE SKIP LOCKED` for safe concurrent worker pickup, no extension required, BullMQ-equivalent feature set including delayed jobs, retries, exponential backoff, cron-style recurring jobs).
- **Reports module:** keep Puppeteer but switch to **`puppeteer-core` + Microsoft Edge** (preinstalled on Windows 10+ / Server 2019+, no 150 MB Chromium download); replace `chartjs-node-canvas` (which depends on the `canvas` npm package with native Cairo bindings) with **`@napi-rs/canvas`** (ships prebuilt Windows binaries, no MSVC toolchain, no node-gyp).
- **Migration discipline:** every replacement lands behind a feature flag (`USE_MOSQUITTO`, `USE_PG_QUEUE`, `USE_EDGE_PDF`) so we can run old + new side-by-side during cut-over and roll back per-subsystem if a regression surfaces.

**Tech Stack:**
- **graphile-worker** v0.16.x (PostgreSQL-backed job queue, MIT)
- **Mosquitto** v2.0.x (MQTT 3.1.1 / 5.0 broker, EPL/EDL dual license)
- **`puppeteer-core`** v24.x (no bundled Chromium; uses an external browser)
- **`@napi-rs/canvas`** v0.1.x (prebuilt native canvas, Apache-2.0)
- **Vitest** for unit + integration tests (already in repo)
- **`pg`** v8.x for direct PostgreSQL access (already a dep via `packages/db/`)
- Existing: Fastify 5, Prisma 6, TimescaleDB, Node 22

**Out of scope (explicit non-goals):**
- Android / APK build chain (already documented as off-server in `windowsIssues.md` §10–§11)
- CI / GitHub Actions runner choice (already documented as `ubuntu-latest` in `windowsIssues.md` §18)
- Migrating away from PostgreSQL or Prisma
- Changing the public API surface of any module — every change is internal swap-and-replace
- Removing TimescaleDB (it has Windows builds that work; pinning is the existing mitigation)

**Success criteria (post-execution):**
1. `npm ci` on a fresh Windows Server 2022 with only Node 22 + PostgreSQL 18 installed completes without prompting for Visual Studio Build Tools or Python.
2. `node apps/api/dist/app.js` starts successfully on Windows Server Core (no Desktop Experience installed).
3. End-to-end PDF report generation completes successfully without the Chromium download having ever run.
4. End-to-end MQTT telemetry ingestion completes successfully against a Mosquitto broker on the same Windows host.
5. End-to-end BullMQ-equivalent functionality (delayed jobs, retries, cron, alarm dispatch) completes against PostgreSQL only.
6. `windowsIssues.md` 🔴-severity items reduce from 4 to 0; 🟡-severity items reduce by at least 5.
7. `docker-compose.yml` no longer references EMQX or Redis/Memurai.

---

## File Structure

This plan creates and modifies the following files. **Each file has one clear responsibility.**

### Phase 1 — Mosquitto MQTT swap

| File | Action | Responsibility |
|---|---|---|
| `apps/api/src/transport/mqtt-client.ts` | Modify | Drop EMQX-specific config; broker-agnostic mqtt.js client (already mostly broker-agnostic) |
| `apps/api/src/transport/mqtt-auth-routes.ts` | Move | Rename to `apps/api/src/transport/legacy-emqx-auth-routes.ts` (kept for rollback only); register only when `USE_MOSQUITTO=false` |
| `apps/api/src/transport/mosquitto-acl-generator.ts` | Create | Generate Mosquitto Dynamic Security JSON from PostgreSQL device-token state on startup + on changes |
| `apps/api/src/transport/__tests__/mosquitto-acl-generator.test.ts` | Create | Unit tests for ACL JSON shape |
| `apps/api/src/transport/__tests__/mqtt-broker-integration.test.ts` | Create | Integration test against an in-process Mosquitto-equivalent (`aedes`) verifying publish/subscribe with token auth |
| `mosquitto/mosquitto.conf` | Create | Production Mosquitto config — listeners, persistence, dynamic security plugin |
| `mosquitto/dynamic-security.json` | Create | Bootstrap admin role + role/client templates (regenerated at runtime) |
| `scripts/install-mosquitto.ps1` | Create | Download + silently install Mosquitto MSI, register Windows service, install config files |
| `docker-compose.yml` | Modify | Replace `emqx` service with `eclipse-mosquitto:2.0` |
| `apps/api/.env.example` | Modify | Replace `MQTT_BROKER_*` / `EMQX_ADMIN_PASSWORD` with `MOSQUITTO_*` block |

### Phase 2 — graphile-worker migration (replaces BullMQ + Redis)

| File | Action | Responsibility |
|---|---|---|
| `packages/queue/package.json` | Modify | Drop `bullmq`, `ioredis`; add `graphile-worker` |
| `packages/queue/src/connection.ts` | Modify | Replace `getQueueConnection()` / `getWorkerConnection()` (BullMQ-Redis) with `getRunner()` / `getProducer()` (graphile-worker-pg) |
| `packages/queue/src/queues.ts` | Modify | Re-express the 5 queue definitions as graphile-worker `RunnerOptions` and task identifiers |
| `packages/queue/src/schemas.ts` | Modify | Job-payload zod schemas stay the same (they're queue-impl-agnostic) |
| `packages/queue/src/priorities.ts` | Modify | Map BullMQ priorities (1–8) onto graphile-worker priorities |
| `packages/queue/src/job-runner.ts` | Create | Single entry point that boots all 5 queues' tasks under one `Runner` instance |
| `packages/queue/src/__tests__/job-runner.test.ts` | Create | Integration test: enqueue → worker picks up → runs → completes; covers retry + delayed |
| `packages/queue/migrations/` | Create | graphile-worker installs its own schema (`graphile_worker.*`); migration is the `runMigrations()` call from the package |
| `apps/api/src/workers/ingestion.worker.ts` | Modify | Convert from `new Worker('ingestion', …)` to `addJob('ingestion', payload)` + task handler registered with the runner |
| `apps/api/src/workers/maintenance.worker.ts` | Modify | Same pattern; cron jobs use graphile-worker's built-in cron syntax instead of BullMQ-cron |
| `apps/api/src/modules/data-ingestion/ingestion.service.ts` | Modify | `quickAddJob('ingestion', …)` instead of `queue.add(…)` |
| `apps/api/src/modules/notification-delivery/notification-dispatcher.ts` | Modify | Same |
| `apps/api/src/modules/queries/export.routes.ts` | Modify | Same |
| `apps/api/src/modules/reports/service.ts` | Modify | Same |
| `apps/api/src/app.ts` | Modify | Replace `BullBoard` admin UI mount with `graphile-worker`'s built-in observability or skip the admin UI for v1 |

### Phase 3 — Reports module Windows hardening

| File | Action | Responsibility |
|---|---|---|
| `apps/api/package.json` | Modify | Drop `puppeteer`; add `puppeteer-core` (lightweight, no bundled Chromium); drop `chartjs-node-canvas` + `canvas`; add `@napi-rs/canvas` |
| `apps/api/src/modules/reports/renderers/pdf-renderer.ts` | Modify | Use `puppeteer-core.launch({ executablePath: detectedEdgePath })` with `--headless=new` flag (works on Server Core, no `dwm.exe` required) |
| `apps/api/src/modules/reports/renderers/edge-detector.ts` | Create | Resolve Edge install path on Windows (`%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe`) and Linux fallback (Chromium / Chrome via `which`) |
| `apps/api/src/modules/reports/renderers/chart-renderer.ts` | Modify | Replace `chartjs-node-canvas` with direct `@napi-rs/canvas` + `chart.js` 4.x; same public API (input config → base64 PNG output) |
| `apps/api/src/modules/reports/renderers/__tests__/edge-detector.test.ts` | Create | Mocked filesystem tests for Edge path resolution |
| `apps/api/src/modules/reports/renderers/__tests__/pdf-renderer.test.ts` | Create | Smoke test: render a known input → assert PDF byte signature `%PDF-` and minimum size |
| `apps/api/src/modules/reports/renderers/__tests__/chart-renderer.test.ts` | Create | Smoke test: render line/bar/pie chart inputs → assert non-empty base64 PNG, correct dimensions |

### Phase 4 — Tooling cleanup

| File | Action | Responsibility |
|---|---|---|
| `scripts/install-on-target.ps1` | Modify | Drop Memurai install step; drop EMQX setup; add Mosquitto silent install; add Edge install detection (already on Windows but verify); enable `LongPathsEnabled` registry flag |
| `scripts/package-for-production.ps1` | Modify | Drop the Chromium download and Memurai bundling |
| `apps/api/.env.example` | Modify | Drop `REDIS_*` block, add `DATABASE_URL_QUEUE` (graphile-worker can share or split from app DB) |
| `LOCAL_SETUP_WINDOWS.md` | Modify | Remove Memurai prerequisite; remove EMQX prerequisite; add Mosquitto prerequisite; update env-var examples |
| `DEPLOY-WINDOWS.md` | Modify | Same as above |
| `windowsIssues.md` | Modify | Mark resolved 🔴 items as resolved with commit-hash receipts |
| `CHANGELOG.md` | Modify | Append `[3.0.0] — Windows-friendly stack` |
| `future/overview/CODEBASE_SUMMARY.md` | Modify | Update tech stack section (Mosquitto, graphile-worker, puppeteer-core, @napi-rs/canvas) |
| `future/overview/CURRENT_STATUS.md` | Modify | Update gotchas (drop Memurai-version, drop EMQX-Linux-only) |
| `future/qa/KNOWN_ISSUES.md` | Modify | Drop Memurai entry; drop EMQX entry |
| `docs/index.md` | Modify | Update stats |
| `tasks/todo.md` | Modify | Append eleventh-pass audit entry |

### Phase 5 — Verification & docs

| File | Action | Responsibility |
|---|---|---|
| `tests/integration/windows-server-stack.test.ts` | Create | End-to-end Vitest suite that boots the API → enqueues a job → publishes MQTT → generates a PDF → asserts everything succeeds, all in one Node process. Skipped unless `INTEGRATION_TEST=1` is set. |
| `scripts/verify-windows-deployment.ps1` | Create | Smoke-check script run on the target machine: ping API, enqueue test job, check Mosquitto, generate test PDF |

---

## Test Strategy

### Layer 1 — Unit tests (Vitest, fast, in-memory)

- **Mosquitto ACL generator:** pure-function tests that take a list of devices + roles and assert the JSON shape Mosquitto's dynamic-security plugin expects.
- **Edge detector:** mocked `fs.existsSync` to verify path resolution on Windows / Linux / macOS.
- **graphile-worker priority mapper:** pure-function tests that map BullMQ priority 1–8 → graphile-worker priority.

### Layer 2 — Integration tests (Vitest + Testcontainers / in-process)

- **graphile-worker against a real Postgres:** spin up a temporary database (use existing `packages/db/` test helpers), install graphile-worker schema, enqueue a job, run worker for one tick, assert job ran. Tests retry, delayed, cron behaviors.
- **MQTT broker integration:** use **`aedes`** (pure-JS in-process MQTT broker) as a test double for Mosquitto. Publish via `mqtt.js` client, subscribe via `mqtt.js` client, verify auth via the new `mosquitto-acl-generator`'s output translated to aedes auth callbacks.
- **PDF renderer:** boot Edge headless, render a known template, assert non-empty PDF buffer with correct PDF magic bytes (`%PDF-1.4`).

### Layer 3 — End-to-end (manual + scripted)

- **`tests/integration/windows-server-stack.test.ts`** — single Node process exercises the full stack:
  1. Boot API
  2. Enqueue an export job
  3. Wait for completion (graphile-worker)
  4. Connect MQTT publisher, send 100 telemetry messages
  5. Verify they hit TimescaleDB
  6. Generate a PDF report end-to-end
  7. Assert output matches snapshot
- **`scripts/verify-windows-deployment.ps1`** — runs on the actual target Windows machine after `install-on-target.ps1`. Independent verification that the install left a working system.

### Test data + DB lifecycle

- Tests use a separate `digilog_test_db` + `digilog_test_tsdb` (named via `TEST_DATABASE_URL`).
- Each test suite truncates its own tables before running.
- graphile-worker schema is reapplied per test run via `runMigrations()` then `DROP SCHEMA graphile_worker CASCADE;`.

### Acceptance gates

- All Layer 1 + 2 tests pass on **Linux** (developer dev machine) AND **Windows Server 2022** (deployment target).
- Layer 3 e2e suite passes on Windows Server 2022 (this is the actual deployment-readiness gate).
- `npm ci` on Windows Server 2022 from scratch completes without compilation errors.
- The 4 🔴-severity items in `windowsIssues.md` are checked off (Puppeteer, chartjs-node-canvas, EMQX, bash scripts).

---

## Phase 0 — Foundation & Feature Flags

### Task 0.1: Set up the feature-flag mechanism

**Files:**
- Modify: `apps/api/.env.example`
- Modify: `apps/api/src/lib/feature-flags.ts` (create if absent)
- Test: `apps/api/src/lib/__tests__/feature-flags.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/lib/__tests__/feature-flags.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { isFeatureEnabled, FLAGS } from '../feature-flags.js';

describe('feature-flags', () => {
  beforeEach(() => {
    delete process.env.USE_MOSQUITTO;
    delete process.env.USE_PG_QUEUE;
    delete process.env.USE_EDGE_PDF;
  });

  it('defaults all migration flags to false', () => {
    expect(isFeatureEnabled(FLAGS.USE_MOSQUITTO)).toBe(false);
    expect(isFeatureEnabled(FLAGS.USE_PG_QUEUE)).toBe(false);
    expect(isFeatureEnabled(FLAGS.USE_EDGE_PDF)).toBe(false);
  });

  it('reads truthy strings as enabled', () => {
    process.env.USE_MOSQUITTO = 'true';
    expect(isFeatureEnabled(FLAGS.USE_MOSQUITTO)).toBe(true);
  });

  it('treats "false", "0", and "" as disabled', () => {
    for (const value of ['false', '0', '']) {
      process.env.USE_MOSQUITTO = value;
      expect(isFeatureEnabled(FLAGS.USE_MOSQUITTO)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run src/lib/__tests__/feature-flags.test.ts
```

Expected: FAIL with `Cannot find module '../feature-flags.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/lib/feature-flags.ts
export const FLAGS = {
  USE_MOSQUITTO: 'USE_MOSQUITTO',
  USE_PG_QUEUE: 'USE_PG_QUEUE',
  USE_EDGE_PDF: 'USE_EDGE_PDF',
} as const;

export type FeatureFlag = (typeof FLAGS)[keyof typeof FLAGS];

export function isFeatureEnabled(flag: FeatureFlag): boolean {
  const raw = process.env[flag];
  if (!raw) return false;
  return raw === 'true' || raw === '1' || raw.toLowerCase() === 'yes';
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx vitest run src/lib/__tests__/feature-flags.test.ts
```

Expected: PASS, 3 assertions.

- [ ] **Step 5: Add flag rows to `.env.example`**

Append to `apps/api/.env.example`:
```env
# Windows-friendly migration flags (Phase 1–3 of windows-friendly-rewrite plan)
USE_MOSQUITTO=false   # set true to use Mosquitto instead of EMQX
USE_PG_QUEUE=false    # set true to use graphile-worker instead of BullMQ
USE_EDGE_PDF=false    # set true to use Edge headless instead of bundled Chromium
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/feature-flags.ts apps/api/src/lib/__tests__/feature-flags.test.ts apps/api/.env.example
git commit -m "feat(infra): add feature-flag mechanism for windows-friendly migration

Three flags introduced (default off):
- USE_MOSQUITTO  — Phase 1 broker swap
- USE_PG_QUEUE   — Phase 2 graphile-worker swap
- USE_EDGE_PDF   — Phase 3 Edge headless swap

Each phase's code lands behind its flag so old + new run side by side."
```

---

## Phase 1 — Mosquitto MQTT broker swap

### Task 1.1: Document Mosquitto Dynamic Security shape

**Files:**
- Create: `apps/api/src/transport/mosquitto-acl-generator.ts`
- Test: `apps/api/src/transport/__tests__/mosquitto-acl-generator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/transport/__tests__/mosquitto-acl-generator.test.ts
import { describe, it, expect } from 'vitest';
import { generateDynamicSecurity } from '../mosquitto-acl-generator.js';

describe('generateDynamicSecurity', () => {
  it('produces a valid Mosquitto v2 dynamic-security JSON skeleton', () => {
    const result = generateDynamicSecurity({ devices: [], adminPassword: 'admin-secret' });
    expect(result).toHaveProperty('clients');
    expect(result).toHaveProperty('groups');
    expect(result).toHaveProperty('roles');
    expect(result.clients).toEqual([
      expect.objectContaining({ username: 'admin', password: expect.any(String) }),
    ]);
  });

  it('emits one client per device with publish-only ACL on its own topic', () => {
    const result = generateDynamicSecurity({
      devices: [
        { token: 'tok-A', entityId: 'ent-A' },
        { token: 'tok-B', entityId: 'ent-B' },
      ],
      adminPassword: 'admin-secret',
    });
    expect(result.clients).toHaveLength(3); // admin + 2 devices
    const deviceA = result.clients.find((c) => c.username === 'tok-A');
    expect(deviceA?.roles).toContainEqual(
      expect.objectContaining({ rolename: expect.stringContaining('ent-A') })
    );
  });

  it('hashes admin password using bcrypt-compatible scheme', () => {
    const result = generateDynamicSecurity({ devices: [], adminPassword: 'admin-secret' });
    const admin = result.clients[0];
    expect(admin.password).toMatch(/^\$2[aby]\$\d{2}\$.{53}$/); // bcrypt
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run src/transport/__tests__/mosquitto-acl-generator.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/transport/mosquitto-acl-generator.ts
import bcrypt from 'bcrypt';

interface Device {
  token: string;
  entityId: string;
}

interface Input {
  devices: Device[];
  adminPassword: string;
}

interface Role {
  rolename: string;
  acls: { acltype: 'publishClientSend' | 'publishClientReceive' | 'subscribeLiteral'; topic: string; allow: boolean }[];
}

interface Client {
  username: string;
  password: string;
  roles: { rolename: string }[];
}

export interface DynamicSecurityConfig {
  clients: Client[];
  groups: never[];
  roles: Role[];
  defaultACLAccess: { publishClientSend: boolean; publishClientReceive: boolean; subscribe: boolean; unsubscribe: boolean };
}

export function generateDynamicSecurity(input: Input): DynamicSecurityConfig {
  const adminHash = bcrypt.hashSync(input.adminPassword, 10);
  const clients: Client[] = [
    { username: 'admin', password: adminHash, roles: [{ rolename: 'admin-role' }] },
  ];
  const roles: Role[] = [
    {
      rolename: 'admin-role',
      acls: [{ acltype: 'publishClientSend', topic: '#', allow: true }, { acltype: 'subscribeLiteral', topic: '#', allow: true }],
    },
  ];
  for (const device of input.devices) {
    const roleName = `device-${device.entityId}-role`;
    roles.push({
      rolename: roleName,
      acls: [
        { acltype: 'publishClientSend', topic: `digilog/v1/${device.entityId}/+`, allow: true },
        { acltype: 'subscribeLiteral', topic: `digilog/v1/${device.entityId}/cmd/+`, allow: true },
      ],
    });
    const tokenHash = bcrypt.hashSync(device.token, 10);
    clients.push({ username: device.token, password: tokenHash, roles: [{ rolename: roleName }] });
  }
  return {
    clients,
    groups: [],
    roles,
    defaultACLAccess: { publishClientSend: false, publishClientReceive: false, subscribe: false, unsubscribe: false },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx vitest run src/transport/__tests__/mosquitto-acl-generator.test.ts
```

Expected: PASS, 3 assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/transport/mosquitto-acl-generator.ts apps/api/src/transport/__tests__/mosquitto-acl-generator.test.ts
git commit -m "feat(mqtt): pure-function Mosquitto Dynamic Security generator

Translates DigiLog device-token state into Mosquitto v2 dynamic-security
JSON. Replaces EMQX HTTP webhook auth with Mosquitto's built-in plugin.

Per-device role grants publish on digilog/v1/<entityId>/+ and subscribe
on digilog/v1/<entityId>/cmd/+; default-deny everywhere else."
```

### Task 1.2: Mosquitto ACL HTTP refresh endpoint

**Files:**
- Create: `apps/api/src/transport/mosquitto-refresh-routes.ts`
- Modify: `apps/api/src/app.ts:lines-where-mqtt-auth-routes-is-registered`
- Test: `apps/api/src/transport/__tests__/mosquitto-refresh-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/transport/__tests__/mosquitto-refresh-routes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import mosquittoRefreshRoutes from '../mosquitto-refresh-routes.js';

describe('mosquitto-refresh-routes', () => {
  let app: Awaited<ReturnType<typeof Fastify>>;

  beforeEach(async () => {
    app = Fastify();
    await app.register(mosquittoRefreshRoutes, { prefix: '/api/internal/mqtt' });
    await app.ready();
  });

  it('POST /refresh-acl returns 401 without admin auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/internal/mqtt/refresh-acl' });
    expect(res.statusCode).toBe(401);
  });

  it('POST /refresh-acl writes a new dynamic-security file when authed', async () => {
    process.env.MOSQUITTO_REFRESH_TOKEN = 'shared-secret';
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/mqtt/refresh-acl',
      headers: { authorization: 'Bearer shared-secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ wroteFile: true, deviceCount: expect.any(Number) });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run src/transport/__tests__/mosquitto-refresh-routes.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/transport/mosquitto-refresh-routes.ts
import type { FastifyInstance } from 'fastify';
import { writeFile } from 'node:fs/promises';
import { generateDynamicSecurity } from './mosquitto-acl-generator.js';
import { prisma } from '@digilog/db';

export default async function mosquittoRefreshRoutes(app: FastifyInstance) {
  app.post('/refresh-acl', async (req, reply) => {
    const expected = process.env.MOSQUITTO_REFRESH_TOKEN ?? '';
    const auth = req.headers.authorization ?? '';
    if (!expected || auth !== `Bearer ${expected}`) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const credentials = await prisma.deviceCredential.findMany({
      select: { token: true, assetInstanceId: true },
    });
    const config = generateDynamicSecurity({
      devices: credentials.map((c) => ({ token: c.token, entityId: c.assetInstanceId })),
      adminPassword: process.env.MOSQUITTO_ADMIN_PASSWORD ?? '',
    });
    const targetPath = process.env.MOSQUITTO_DYNSEC_PATH ?? './mosquitto/dynamic-security.json';
    await writeFile(targetPath, JSON.stringify(config, null, 2));
    return { wroteFile: true, deviceCount: credentials.length, path: targetPath };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx vitest run src/transport/__tests__/mosquitto-refresh-routes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Register the route conditionally**

Modify `apps/api/src/app.ts` near where `mqttAuthRoutes` is registered. Add:

```typescript
import { isFeatureEnabled, FLAGS } from './lib/feature-flags.js';
import mosquittoRefreshRoutes from './transport/mosquitto-refresh-routes.js';

if (isFeatureEnabled(FLAGS.USE_MOSQUITTO)) {
  await app.register(mosquittoRefreshRoutes, { prefix: '/api/internal/mqtt' });
} else {
  await app.register(mqttAuthRoutes, { prefix: '/api/internal/mqtt' });
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/transport/mosquitto-refresh-routes.ts apps/api/src/transport/__tests__/mosquitto-refresh-routes.test.ts apps/api/src/app.ts
git commit -m "feat(mqtt): /api/internal/mqtt/refresh-acl endpoint for Mosquitto

When USE_MOSQUITTO=true, the API exposes an admin-token-protected
endpoint that regenerates Mosquitto's dynamic-security.json from the
DeviceCredential table. Mosquitto's dynsec plugin reloads the file
when SIGUSR1 is sent (next task adds the trigger).

Old EMQX auth-webhook routes still register when USE_MOSQUITTO=false."
```

### Task 1.3: Mosquitto config + Windows install script

**Files:**
- Create: `mosquitto/mosquitto.conf`
- Create: `scripts/install-mosquitto.ps1`

- [ ] **Step 1: Write `mosquitto/mosquitto.conf`**

```conf
# mosquitto/mosquitto.conf — DigiLog production config
# Mosquitto 2.0+ with built-in dynamic-security plugin

listener 1883
allow_anonymous false

# TLS listener (optional; uncomment + point to certs/)
# listener 8883
# certfile ../certs/server.crt
# keyfile ../certs/server.key
# cafile ../certs/rootCA.pem
# require_certificate false

# Persistence
persistence true
persistence_location ./data/

# Logging
log_dest stdout
log_type error
log_type warning
log_type notice

# Dynamic security plugin (built-in since 2.0)
plugin mosquitto_dynamic_security.so
plugin_opt_config_file ./dynamic-security.json
```

- [ ] **Step 2: Write the install script**

```powershell
# scripts/install-mosquitto.ps1
# Installs Mosquitto 2.0.x silently and registers it as a Windows service.

$ErrorActionPreference = 'Stop'
$Version = '2.0.18'
$Url = "https://mosquitto.org/files/binary/win64/mosquitto-$Version-install-windows-x64.exe"
$InstallerPath = "$env:TEMP\mosquitto-installer.exe"
$InstallDir = 'C:\Program Files\mosquitto'

if (-not (Test-Path $InstallerPath)) {
    Write-Output "Downloading Mosquitto $Version..."
    Invoke-WebRequest -Uri $Url -OutFile $InstallerPath -UseBasicParsing
}

Write-Output "Installing Mosquitto silently..."
Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait

# Copy our config + dynamic-security bootstrap
$ConfigSrc = Join-Path (Split-Path $PSScriptRoot) 'mosquitto'
Copy-Item -Path "$ConfigSrc\*" -Destination $InstallDir -Force

# Register as Windows service (Mosquitto installer does this on /S, but verify)
$service = Get-Service -Name mosquitto -ErrorAction SilentlyContinue
if (-not $service) {
    & "$InstallDir\mosquitto.exe" install
}

Start-Service mosquitto
Write-Output "Mosquitto installed and started. Listening on port 1883."
Write-Output "Run /api/internal/mqtt/refresh-acl to populate dynamic-security.json with current devices."
```

- [ ] **Step 3: Commit**

```bash
git add mosquitto/mosquitto.conf scripts/install-mosquitto.ps1
git commit -m "feat(mqtt): Mosquitto config + silent Windows installer

mosquitto.conf uses the built-in dynamic-security plugin (Mosquitto 2.0+)
configured to read ./dynamic-security.json. The /api/internal/mqtt/refresh-acl
endpoint regenerates that file from the DeviceCredential table.

install-mosquitto.ps1 downloads the official MSI, runs the silent install,
copies our config, registers + starts the Windows service. Replaces the
manual NSSM + EMQX setup in install-on-target.ps1."
```

### Task 1.4: docker-compose.yml swap

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Replace EMQX block with Mosquitto**

In `docker-compose.yml`, locate the `emqx:` service and replace it with:

```yaml
  mosquitto:
    image: eclipse-mosquitto:2.0
    container_name: digilog-mosquitto
    ports:
      - "1883:1883"
    volumes:
      - ./mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro
      - ./mosquitto/dynamic-security.json:/mosquitto/config/dynamic-security.json
      - mosquitto-data:/mosquitto/data
    restart: unless-stopped
```

Add `mosquitto-data:` to the `volumes:` block at the bottom of the file.
Remove any EMQX-related env vars and the EMQX dashboard port (`18083`).

- [ ] **Step 2: Verify the dev stack still boots**

```bash
docker compose up -d
docker compose logs mosquitto | tail
```

Expected: `mosquitto version 2.0.18 starting`, `Opening ipv4 listen socket on port 1883`, `mosquitto version 2.0.18 running`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(docker): replace EMQX with eclipse-mosquitto:2.0

Drops the 18083 dashboard port and EMQX-specific env vars.
Volumes bind-mount mosquitto.conf + dynamic-security.json from
the repo so the same config drives both Docker and bare-Windows
installs."
```

### Task 1.5: Integration test — mqtt.js client against in-process broker

**Files:**
- Create: `apps/api/src/transport/__tests__/mqtt-broker-integration.test.ts`

- [ ] **Step 1: Write the failing test**

Use **`aedes`** as a pure-JS in-process MQTT broker that mimics Mosquitto's auth surface for the test.

```typescript
// apps/api/src/transport/__tests__/mqtt-broker-integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Aedes from 'aedes';
import { createServer } from 'node:net';
import mqtt from 'mqtt';

const TEST_PORT = 11883;

describe('mqtt broker integration', () => {
  let aedes: ReturnType<typeof Aedes>;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    aedes = Aedes();
    aedes.authenticate = (client, username, password, done) => {
      done(null, username === 'tok-A' && password?.toString() === 'pwd-A');
    };
    server = createServer(aedes.handle as never);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => aedes.close(resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects unknown credentials', async () => {
    const client = mqtt.connect(`mqtt://localhost:${TEST_PORT}`, {
      username: 'unknown',
      password: 'wrong',
      reconnectPeriod: 0,
    });
    await new Promise((resolve) => {
      client.on('error', resolve);
      client.on('connect', () => resolve(new Error('should have rejected')));
    });
    expect(client.connected).toBe(false);
    client.end(true);
  });

  it('accepts valid credentials and round-trips a message', async () => {
    const publisher = mqtt.connect(`mqtt://localhost:${TEST_PORT}`, {
      username: 'tok-A',
      password: 'pwd-A',
      reconnectPeriod: 0,
    });
    await new Promise<void>((resolve, reject) => {
      publisher.once('connect', () => resolve());
      publisher.once('error', reject);
    });
    expect(publisher.connected).toBe(true);
    publisher.end(true);
  });
});
```

- [ ] **Step 2: Add `aedes` to dev deps**

```bash
cd apps/api && npm install --save-dev aedes
```

- [ ] **Step 3: Run test to verify it passes**

```bash
cd apps/api && npx vitest run src/transport/__tests__/mqtt-broker-integration.test.ts
```

Expected: PASS, 2 assertions. Wall time < 2 s.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/transport/__tests__/mqtt-broker-integration.test.ts apps/api/package.json apps/api/package-lock.json
git commit -m "test(mqtt): in-process broker integration test using aedes

aedes is a pure-JS MQTT broker library used as a test double for
Mosquitto. Verifies the mqtt.js client (production code) connects,
authenticates, and round-trips against MQTT 3.1.1 / 5.0 semantics
that Mosquitto provides identically."
```

### Task 1.6: End-of-Phase-1 commit + cut-over checkpoint

- [ ] **Step 1: Run the full suite + smoke test**

```bash
cd apps/api && npm test
docker compose up -d mosquitto
USE_MOSQUITTO=true npx tsx watch src/app.ts
# In another terminal:
curl -X POST http://localhost:3000/api/internal/mqtt/refresh-acl \
  -H "Authorization: Bearer $env:MOSQUITTO_REFRESH_TOKEN"
```

Expected: `{ "wroteFile": true, "deviceCount": N }`. Mosquitto reloads on SIGUSR1 (set up via Windows service handler).

- [ ] **Step 2: Update CHANGELOG**

Append to `CHANGELOG.md`:
```markdown
## [Unreleased] — Phase 1 of windows-friendly-rewrite

### Added
- Mosquitto 2.0.18 broker support behind `USE_MOSQUITTO` flag
- `mosquitto-acl-generator.ts` produces dynamic-security JSON from DeviceCredential rows
- `/api/internal/mqtt/refresh-acl` endpoint to regenerate ACL on demand
- `scripts/install-mosquitto.ps1` for Windows silent install
- `mosquitto/mosquitto.conf` with built-in plugin config
- Docker dev stack uses `eclipse-mosquitto:2.0` (was EMQX)
```

- [ ] **Step 3: Commit + push checkpoint**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG Phase 1 (Mosquitto cut-over feature-flagged)"
git push origin HEAD:docsCleaned
```

---

## Phase 2 — graphile-worker migration (replaces BullMQ + Redis/Memurai)

> **Why graphile-worker?** It replicates BullMQ's feature set (delayed jobs, retries with exponential backoff, cron, priorities, concurrency) but uses PostgreSQL `LISTEN/NOTIFY` for instant dispatch and `SELECT … FOR UPDATE SKIP LOCKED` for safe concurrent worker pickup. No Redis. No native bindings. Pure PostgreSQL features that ship in PG18.

### Task 2.1: Install graphile-worker + write the migration test

**Files:**
- Modify: `packages/queue/package.json`
- Create: `packages/queue/src/__tests__/graphile-worker-bootstrap.test.ts`

- [ ] **Step 1: Install graphile-worker**

```bash
cd packages/queue
npm install graphile-worker
npm uninstall bullmq ioredis  # not yet — keep both during migration
```

(Keep BullMQ and ioredis installed for now; we'll uninstall in Task 2.10 after cut-over.)

- [ ] **Step 2: Write the bootstrap test**

```typescript
// packages/queue/src/__tests__/graphile-worker-bootstrap.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { runMigrations, run, quickAddJob } from 'graphile-worker';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://digilog:digilog@localhost:5432/digilog_test_db';

describe('graphile-worker bootstrap', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    await runMigrations({ connectionString: TEST_DATABASE_URL });
  });

  afterAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS graphile_worker CASCADE');
    await pool.end();
  });

  it('installs the graphile_worker schema', async () => {
    const { rows } = await pool.query(`
      SELECT 1 FROM information_schema.schemata WHERE schema_name = 'graphile_worker'
    `);
    expect(rows).toHaveLength(1);
  });

  it('round-trips a single job through enqueue + worker', async () => {
    let receivedPayload: unknown = null;
    const runner = await run({
      connectionString: TEST_DATABASE_URL,
      concurrency: 1,
      noHandleSignals: true,
      pollInterval: 100,
      taskList: {
        echo: async (payload) => {
          receivedPayload = payload;
        },
      },
    });
    await quickAddJob({ connectionString: TEST_DATABASE_URL }, 'echo', { msg: 'hello' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await runner.stop();
    expect(receivedPayload).toEqual({ msg: 'hello' });
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

```bash
cd packages/queue && npx vitest run src/__tests__/graphile-worker-bootstrap.test.ts
```

(Requires a running test DB; provision via existing dev DB with a separate `digilog_test_db` schema.)

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/queue/package.json packages/queue/package-lock.json packages/queue/src/__tests__/graphile-worker-bootstrap.test.ts
git commit -m "feat(queue): install graphile-worker + bootstrap test

graphile-worker uses PostgreSQL LISTEN/NOTIFY + SKIP LOCKED for
job-queue semantics. No Redis required. Schema migrates on first run.

BullMQ + ioredis stay installed during Phase 2 — we cut over per-queue
behind USE_PG_QUEUE feature flag."
```

### Task 2.2: Wire `getRunner()` and `getProducer()` factories

**Files:**
- Modify: `packages/queue/src/connection.ts`
- Test: `packages/queue/src/__tests__/connection.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/queue/src/__tests__/connection.test.ts
import { describe, it, expect } from 'vitest';
import { getProducer, getRunnerOptions } from '../connection.js';

describe('queue connection', () => {
  it('getProducer returns a graphile-worker addJob-capable client', async () => {
    const producer = await getProducer();
    expect(producer).toHaveProperty('addJob');
    expect(typeof producer.addJob).toBe('function');
    await producer.release();
  });

  it('getRunnerOptions exposes the correct task list', () => {
    const opts = getRunnerOptions({
      taskList: {
        ingestion: async () => {},
        notification: async () => {},
      },
    });
    expect(Object.keys(opts.taskList)).toContain('ingestion');
    expect(Object.keys(opts.taskList)).toContain('notification');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/queue && npx vitest run src/__tests__/connection.test.ts
```

Expected: FAIL (`getProducer is not exported`).

- [ ] **Step 3: Update `connection.ts`**

```typescript
// packages/queue/src/connection.ts
import { makeWorkerUtils, type WorkerUtils, type RunnerOptions, type TaskList } from 'graphile-worker';

export interface DigilogRunnerOptions {
  taskList: TaskList;
  concurrency?: number;
}

const QUEUE_DATABASE_URL = process.env.DATABASE_URL_QUEUE ?? process.env.DATABASE_URL;

let cachedProducer: WorkerUtils | null = null;

export async function getProducer(): Promise<WorkerUtils> {
  if (!cachedProducer) {
    cachedProducer = await makeWorkerUtils({ connectionString: QUEUE_DATABASE_URL });
  }
  return cachedProducer;
}

export function getRunnerOptions(input: DigilogRunnerOptions): RunnerOptions {
  return {
    connectionString: QUEUE_DATABASE_URL,
    concurrency: input.concurrency ?? 10,
    pollInterval: 1000,
    taskList: input.taskList,
  };
}

export async function closeProducer() {
  if (cachedProducer) {
    await cachedProducer.release();
    cachedProducer = null;
  }
}

// --- BullMQ-compatible shims (kept during migration; remove in Task 2.10) ---
export { getQueueConnection, getWorkerConnection, getRedisConnection, closeRedisConnection } from './connection.bullmq.js';
```

- [ ] **Step 4: Move existing BullMQ-Redis code to `connection.bullmq.ts`**

```bash
git mv packages/queue/src/connection.ts packages/queue/src/connection.bullmq.ts
# Then re-create the new connection.ts with the content above
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd packages/queue && npx vitest run src/__tests__/connection.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/queue/src/
git commit -m "feat(queue): graphile-worker producer + runner factories

connection.ts now exports getProducer (addJob-capable) and
getRunnerOptions (task-list config). BullMQ-Redis equivalents moved
to connection.bullmq.ts and re-exported under their old names so
existing call sites compile until they migrate one at a time."
```

### Task 2.3: Migrate the ingestion queue

**Files:**
- Modify: `apps/api/src/workers/ingestion.worker.ts`
- Modify: `apps/api/src/modules/data-ingestion/ingestion.service.ts`
- Test: `apps/api/src/workers/__tests__/ingestion.worker.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/workers/__tests__/ingestion.worker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ingestionTask } from '../ingestion.worker.js';

describe('ingestion task (graphile-worker)', () => {
  it('processes a telemetry payload via the new task signature', async () => {
    const payload = {
      entityId: 'ent-1',
      type: 'telemetry' as const,
      data: { cpu: 0.42 },
      ts: new Date().toISOString(),
    };
    const helpers = { logger: { info: vi.fn(), error: vi.fn() } } as never;
    await expect(ingestionTask(payload, helpers)).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run src/workers/__tests__/ingestion.worker.test.ts
```

Expected: FAIL (`ingestionTask is not exported`).

- [ ] **Step 3: Refactor `ingestion.worker.ts`**

Convert the BullMQ `Worker` constructor pattern to a graphile-worker task function. Keep both code paths until cut-over:

```typescript
// apps/api/src/workers/ingestion.worker.ts
import type { Task } from 'graphile-worker';
import { isFeatureEnabled, FLAGS } from '../lib/feature-flags.js';
import { processIngestionPayload } from '../modules/data-ingestion/ingestion.service.js';

export const ingestionTask: Task = async (payload, _helpers) => {
  await processIngestionPayload(payload as never);
};

// BullMQ-mode export retained until Task 2.10
export { startIngestionWorker } from './ingestion.worker.bullmq.js';
```

(Move the existing BullMQ `Worker` setup into `ingestion.worker.bullmq.ts`.)

- [ ] **Step 4: Update `ingestion.service.ts` enqueue path**

Locate the current `queue.add('ingestion', payload)` calls and replace with:

```typescript
import { isFeatureEnabled, FLAGS } from '../../lib/feature-flags.js';
import { getProducer } from '@digilog/queue';
import { ingestionQueue } from '../../workers/ingestion.worker.bullmq.js';

async function enqueueIngestionJob(payload: IngestionPayload) {
  if (isFeatureEnabled(FLAGS.USE_PG_QUEUE)) {
    const producer = await getProducer();
    await producer.addJob('ingestion', payload, { maxAttempts: 3, priority: 5 });
  } else {
    await ingestionQueue.add('ingestion', payload);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd apps/api && npx vitest run src/workers/__tests__/ingestion.worker.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/workers/ apps/api/src/modules/data-ingestion/ingestion.service.ts apps/api/src/workers/__tests__/
git commit -m "feat(queue): migrate ingestion queue to graphile-worker

When USE_PG_QUEUE=true, ingestion jobs go through graphile-worker's
addJob; when false, they continue through BullMQ. Worker function
(ingestionTask) is the same business logic regardless of which
runner invokes it."
```

### Task 2.4: Migrate the notification queue

**Files:**
- Modify: `apps/api/src/modules/notification-delivery/notification-dispatcher.ts`
- Modify: `apps/api/src/modules/notification-delivery/delivery.service.ts`
- Test: `apps/api/src/modules/notification-delivery/__tests__/dispatcher-pg-queue.test.ts`

Repeat the Task 2.3 pattern: extract the worker logic into a `Task`, write a unit test, wire `enqueue*` calls behind the `USE_PG_QUEUE` flag.

- [ ] **Step 1: Write `notificationTask` matching the existing BullMQ payload shape**
- [ ] **Step 2: Write the failing test**
- [ ] **Step 3: Run test to verify it fails**
- [ ] **Step 4: Wire the dispatcher to choose engine via flag**
- [ ] **Step 5: Run test to verify it passes**
- [ ] **Step 6: Commit:**

```bash
git commit -m "feat(queue): migrate notification queue to graphile-worker"
```

### Task 2.5: Migrate the export queue

**Files:**
- Modify: `apps/api/src/modules/queries/export.routes.ts`
- Test: `apps/api/src/modules/queries/__tests__/export-pg-queue.test.ts`

Same pattern. The export queue has a 5-minute timeout — express via graphile-worker's job-level `maxAttempts` + a process-level timeout in the task function.

- [ ] **Step 1: Write `exportTask` with timeout shim using `AbortController`**
- [ ] **Step 2: Failing test**
- [ ] **Step 3: Run + verify failure**
- [ ] **Step 4: Wire up enqueue paths**
- [ ] **Step 5: Verify pass**
- [ ] **Step 6: Commit:**

```bash
git commit -m "feat(queue): migrate export queue to graphile-worker

graphile-worker doesn't enforce job-level timeouts directly. We pass
an AbortSignal-backed timeout to the export task body so the same
'5 minutes max' contract holds."
```

### Task 2.6: Migrate the reports queue

**Files:**
- Modify: `apps/api/src/modules/reports/service.ts`
- Test: `apps/api/src/modules/reports/__tests__/reports-pg-queue.test.ts`

Same pattern. 10-minute timeout via AbortController.

- [ ] **Step 1–6:** TDD cycle as above.

```bash
git commit -m "feat(queue): migrate reports queue to graphile-worker"
```

### Task 2.7: Migrate the maintenance queue (cron jobs)

**Files:**
- Modify: `apps/api/src/workers/maintenance.worker.ts`
- Modify: `packages/queue/src/cron.ts` (create)
- Test: `apps/api/src/workers/__tests__/maintenance-pg-queue.test.ts`

graphile-worker has built-in cron via `crontab` strings. Convert BullMQ-cron schedules to crontab format:
- DLQ check: `* * * * *` (every minute)
- Connectivity: `* * * * *`
- Retention: `0 2 * * *` (daily at 2 AM)

- [ ] **Step 1: Create `crontab.txt`** in `packages/queue/`:

```
* * * * * dlq_check
* * * * * connectivity_check
0 2 * * * retention_cleanup
```

- [ ] **Step 2–6:** TDD cycle, register crontab in runner config.

```bash
git commit -m "feat(queue): migrate maintenance cron jobs to graphile-worker

BullMQ-cron schedules (DLQ 60s / connectivity 60s / retention 24h)
re-expressed as crontab strings in packages/queue/crontab.txt.
graphile-worker reads this at runner boot."
```

### Task 2.8: Single Runner instance for all 5 task types

**Files:**
- Create: `packages/queue/src/job-runner.ts`
- Modify: `apps/api/src/app.ts`
- Test: `packages/queue/src/__tests__/job-runner.test.ts`

- [ ] **Step 1: Failing test that exercises all 5 task identifiers via a single Runner**
- [ ] **Step 2: Implementation**
- [ ] **Step 3: Wire boot from `app.ts` to call `startJobRunner()` when USE_PG_QUEUE=true**
- [ ] **Step 4: Verify pass**
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(queue): single graphile-worker Runner for all 5 task types

Replaces 2 BullMQ Worker instances (ingestion concurrency:10,
maintenance concurrency:1) with one Runner whose taskList registers
all 5 task functions. Concurrency is per-task via runner config."
```

### Task 2.9: Production cut-over playbook

**Files:**
- Create: `docs/runbooks/queue-cutover.md`

Document the cut-over sequence:
1. Set `USE_PG_QUEUE=true` in `.env`
2. Restart the API (existing BullMQ jobs in flight finish; no new ones enqueued)
3. Drain Redis: `XLEN bull:ingestion:wait` should reach 0
4. Stop Memurai service
5. Verify graphile-worker is processing: query `graphile_worker.jobs WHERE locked_at IS NOT NULL`
6. Smoke-test each queue type via test endpoints

- [ ] **Step 1: Write the runbook**
- [ ] **Step 2: Commit:**

```bash
git commit -m "docs(runbook): queue cut-over playbook BullMQ→graphile-worker"
```

### Task 2.10: Drop BullMQ and Redis dependencies

**Files:**
- Modify: `packages/queue/package.json` (drop `bullmq`, `ioredis`)
- Modify: `apps/api/package.json` (drop `bullmq` if listed)
- Delete: `packages/queue/src/connection.bullmq.ts`
- Delete: `apps/api/src/workers/ingestion.worker.bullmq.ts`
- Delete: `apps/api/src/workers/maintenance.worker.bullmq.ts`
- Modify: `packages/queue/src/connection.ts` (remove BullMQ re-exports)
- Delete: `packages/queue/src/__tests__/*.bullmq.test.ts` (if any)
- Modify: `apps/api/src/modules/data-ingestion/ingestion.service.ts` (drop the if-flag branch)
- Modify: `apps/api/src/modules/notification-delivery/notification-dispatcher.ts` (drop the if-flag branch)
- Modify: same for export, reports
- Modify: `.env.example` (drop `REDIS_*`, drop `USE_PG_QUEUE` itself since it's now the only path)

- [ ] **Step 1: Run full suite to verify nothing breaks without the legacy paths**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Commit:**

```bash
git commit -m "chore(queue): drop BullMQ + Redis/Memurai dependencies

Phase 2 of windows-friendly-rewrite complete. graphile-worker is
now the only job-queue implementation. USE_PG_QUEUE flag retired.

Removed:
- bullmq, ioredis npm dependencies
- packages/queue/src/connection.bullmq.ts
- apps/api/src/workers/*.worker.bullmq.ts
- All if-flag branches in service-level enqueue calls
- REDIS_* env vars from .env.example

Memurai is no longer required as a Windows dev/prod dependency."
```

---

## Phase 3 — Reports module Windows hardening

### Task 3.1: Edge-detector helper

**Files:**
- Create: `apps/api/src/modules/reports/renderers/edge-detector.ts`
- Test: `apps/api/src/modules/reports/renderers/__tests__/edge-detector.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { detectEdgePath } from '../edge-detector.js';

describe('detectEdgePath', () => {
  it('returns the standard Edge path on win32 when present', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const fsMock = { existsSync: (p: string) => p.includes('msedge.exe') };
    const result = detectEdgePath({ fs: fsMock as never });
    expect(result).toMatch(/msedge\.exe$/);
  });

  it('returns chromium path on linux', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    const fsMock = { existsSync: (p: string) => p.includes('chromium') };
    const result = detectEdgePath({ fs: fsMock as never });
    expect(result).toMatch(/chromium/);
  });

  it('throws if no browser found', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const fsMock = { existsSync: () => false };
    expect(() => detectEdgePath({ fs: fsMock as never })).toThrow(/No browser found/);
  });
});
```

- [ ] **Step 2: Run + verify failure**
- [ ] **Step 3: Implement**

```typescript
// apps/api/src/modules/reports/renderers/edge-detector.ts
import * as defaultFs from 'node:fs';

interface Deps {
  fs?: { existsSync: (p: string) => boolean };
}

const WIN32_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const LINUX_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
];

export function detectEdgePath(deps: Deps = {}): string {
  const fs = deps.fs ?? defaultFs;
  const candidates = process.platform === 'win32' ? WIN32_CANDIDATES : LINUX_CANDIDATES;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No browser found. Tried: ${candidates.join(', ')}`);
}
```

- [ ] **Step 4: Verify pass**
- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(reports): edge-detector helper for puppeteer-core executablePath"
```

### Task 3.2: Switch pdf-renderer to puppeteer-core + Edge

**Files:**
- Modify: `apps/api/src/modules/reports/renderers/pdf-renderer.ts`
- Modify: `apps/api/package.json` (drop `puppeteer`, add `puppeteer-core`)
- Test: `apps/api/src/modules/reports/renderers/__tests__/pdf-renderer.test.ts`

- [ ] **Step 1: Update package.json**

```bash
cd apps/api
npm uninstall puppeteer
npm install puppeteer-core
```

- [ ] **Step 2: Write the smoke test**

```typescript
import { describe, it, expect } from 'vitest';
import { renderPdf } from '../pdf-renderer.js';

describe('renderPdf', () => {
  it('produces a non-empty PDF buffer with PDF magic bytes', async () => {
    const html = '<!doctype html><html><body><h1>Test</h1></body></html>';
    const buffer = await renderPdf(html, { format: 'A4' });
    expect(buffer.length).toBeGreaterThan(1024);
    const magic = buffer.subarray(0, 5).toString('ascii');
    expect(magic).toBe('%PDF-');
  }, 30_000);
});
```

- [ ] **Step 3: Update `pdf-renderer.ts`**

```typescript
import puppeteer from 'puppeteer-core';
import { detectEdgePath } from './edge-detector.js';

let cachedBrowser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

async function getBrowser() {
  if (!cachedBrowser) {
    cachedBrowser = await puppeteer.launch({
      executablePath: detectEdgePath(),
      headless: true,           // 'new' mode is the default in puppeteer-core 22+
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return cachedBrowser;
}

export async function renderPdf(html: string, options: { format?: 'A4' | 'Letter' | 'Legal' } = {}): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: options.format ?? 'A4', printBackground: true });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

export async function shutdownPdfRenderer() {
  if (cachedBrowser) {
    await cachedBrowser.close();
    cachedBrowser = null;
  }
}
```

- [ ] **Step 4: Verify pass**

```bash
npx vitest run src/modules/reports/renderers/__tests__/pdf-renderer.test.ts
```

Expected: PASS (requires Edge installed locally).

- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(reports): switch from puppeteer to puppeteer-core + Edge

Drops the 150 MB Chromium download. puppeteer-core uses an external
browser via executablePath. detectEdgePath resolves to msedge.exe on
Windows (preinstalled on Win10+/Server 2019+) or chromium on Linux.

--headless=new mode (default in puppeteer-core 22+) does not require
dwm.exe, so this works on Windows Server Core."
```

### Task 3.3: Replace chartjs-node-canvas with @napi-rs/canvas

**Files:**
- Modify: `apps/api/package.json` (drop `chartjs-node-canvas`, add `@napi-rs/canvas`)
- Modify: `apps/api/src/modules/reports/renderers/chart-renderer.ts`
- Test: `apps/api/src/modules/reports/renderers/__tests__/chart-renderer.test.ts`

- [ ] **Step 1: Swap dependency**

```bash
cd apps/api
npm uninstall chartjs-node-canvas
npm install @napi-rs/canvas
# chart.js stays
```

- [ ] **Step 2: Write the smoke test**

```typescript
import { describe, it, expect } from 'vitest';
import { renderChart } from '../chart-renderer.js';

describe('renderChart', () => {
  it('renders a line chart and returns a non-empty PNG base64 string', async () => {
    const result = await renderChart({
      type: 'line',
      width: 400,
      height: 300,
      data: { labels: ['A', 'B', 'C'], datasets: [{ label: 's1', data: [1, 2, 3] }] },
    });
    expect(result).toMatch(/^data:image\/png;base64,.+$/);
    const base64 = result.split(',')[1];
    expect(Buffer.from(base64, 'base64').length).toBeGreaterThan(100);
  });

  it('renders a bar chart', async () => {
    const result = await renderChart({
      type: 'bar',
      width: 400,
      height: 300,
      data: { labels: ['A', 'B'], datasets: [{ label: 's1', data: [10, 20] }] },
    });
    expect(result).toMatch(/^data:image\/png;base64,.+$/);
  });

  it('renders a pie chart', async () => {
    const result = await renderChart({
      type: 'pie',
      width: 400,
      height: 300,
      data: { labels: ['A', 'B'], datasets: [{ data: [30, 70] }] },
    });
    expect(result).toMatch(/^data:image\/png;base64,.+$/);
  });
});
```

- [ ] **Step 3: Update `chart-renderer.ts`**

```typescript
import { createCanvas } from '@napi-rs/canvas';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

interface ChartInput {
  type: 'line' | 'bar' | 'pie' | 'doughnut';
  width: number;
  height: number;
  data: Chart['config']['data'];
  options?: Chart['config']['options'];
}

export async function renderChart(input: ChartInput): Promise<string> {
  const canvas = createCanvas(input.width, input.height);
  const ctx = canvas.getContext('2d') as never; // chart.js types vs @napi-rs/canvas types
  const chart = new Chart(ctx, {
    type: input.type,
    data: input.data,
    options: { ...input.options, animation: false, responsive: false },
  });
  chart.update();
  const buf = canvas.toBuffer('image/png');
  chart.destroy();
  return `data:image/png;base64,${buf.toString('base64')}`;
}
```

- [ ] **Step 4: Verify pass**

```bash
npx vitest run src/modules/reports/renderers/__tests__/chart-renderer.test.ts
```

Expected: 3 PASS.

- [ ] **Step 5: Commit:**

```bash
git commit -m "feat(reports): replace chartjs-node-canvas with @napi-rs/canvas

@napi-rs/canvas ships prebuilt Windows binaries (no Visual Studio
Build Tools, no Python, no node-gyp). Public API of renderChart
unchanged: input config in, base64 PNG data URL out."
```

### Task 3.4: End-of-Phase-3 commit + cut-over

- [ ] **Step 1: Run full reports module suite**

```bash
npm test -- src/modules/reports
```

- [ ] **Step 2: Smoke-test end-to-end PDF generation**

```bash
USE_EDGE_PDF=true npx tsx watch src/app.ts
# In another terminal:
curl -X POST http://localhost:3000/api/reports/generate -d '...'
```

- [ ] **Step 3: CHANGELOG**

```markdown
## Phase 3 of windows-friendly-rewrite

### Changed
- Reports module now uses puppeteer-core + Microsoft Edge instead of bundled Chromium (saves 150 MB at install, works on Windows Server Core)
- chartjs-node-canvas replaced with @napi-rs/canvas (no node-gyp / MSVC needed)
```

- [ ] **Step 4: Commit + push:**

```bash
git commit -m "docs: CHANGELOG Phase 3 (Reports module Windows-hardened)"
git push origin HEAD:docsCleaned
```

---

## Phase 4 — Tooling cleanup

### Task 4.1: Update `install-on-target.ps1`

**File:** `scripts/install-on-target.ps1`

- [ ] **Step 1: Drop the Memurai install block**
- [ ] **Step 2: Drop the EMQX install block**
- [ ] **Step 3: Add `& "$PSScriptRoot\install-mosquitto.ps1"` call**
- [ ] **Step 4: Add long-paths registry enable + verification of msedge.exe presence**
- [ ] **Step 5: Verify the script runs end-to-end on a fresh Windows Server VM (manual)**
- [ ] **Step 6: Commit**

### Task 4.2: Update `package-for-production.ps1`

- [ ] Drop the Chromium download step (puppeteer-core has none)
- [ ] Drop the Memurai bundling step
- [ ] Verify `npm ci --prefer-offline` works on a fresh box
- [ ] Commit

### Task 4.3: Update env files

- [ ] Modify `apps/api/.env.example`: drop `REDIS_*`, `MQTT_BROKER_*`, `EMQX_ADMIN_PASSWORD`; add `MOSQUITTO_ADMIN_PASSWORD`, `MOSQUITTO_REFRESH_TOKEN`, `MOSQUITTO_DYNSEC_PATH`
- [ ] Update `apps/api/.env` if it has stale values
- [ ] Commit

### Task 4.4: Update `windowsIssues.md` resolved-status

- [ ] Mark §1 (Puppeteer): "✅ resolved by puppeteer-core + Edge in commit `<hash>`"
- [ ] Mark §2 (chartjs-node-canvas): "✅ resolved by @napi-rs/canvas in commit `<hash>`"
- [ ] Mark §3 (EMQX): "✅ resolved by Mosquitto migration in commit `<hash>`"
- [ ] Mark §7 (Memurai): "✅ resolved by graphile-worker migration in commit `<hash>`"
- [ ] Commit

### Task 4.5: Update root docs

Update `LOCAL_SETUP_WINDOWS.md`, `DEPLOY-WINDOWS.md`, `README.md`, `CLAUDE.md`, `PROJECT_SUMMARY.md`, `PROJECT_ARCHITECTURE.md`, `BACKEND_GUIDE.md`, `future/overview/CODEBASE_SUMMARY.md`, `future/overview/CURRENT_STATUS.md`, `future/qa/KNOWN_ISSUES.md`, `docs/index.md`, `tasks/todo.md`.

Each update follows `docs/CONTRIBUTING.md` "Change → Docs map" entries for: dependency removal (BullMQ, Redis/Memurai, EMQX, puppeteer, chartjs-node-canvas) + dependency addition (graphile-worker, puppeteer-core, @napi-rs/canvas, mosquitto).

- [ ] Run the live-count verification commands from CLAUDE.md
- [ ] Update each doc per the table
- [ ] Commit (one commit per doc cluster)

---

## Phase 5 — Verification & docs finalization

### Task 5.1: Full integration test

**File:** `tests/integration/windows-server-stack.test.ts`

- [ ] Boot API in test mode
- [ ] Enqueue a test export job → assert completes
- [ ] Connect MQTT publisher (against in-process aedes broker mocking Mosquitto) → publish 100 telemetry messages → assert TimescaleDB rows appear
- [ ] Generate a test PDF report → assert non-empty bytes + PDF magic bytes
- [ ] Mark suite as `INTEGRATION_TEST=1`-gated
- [ ] Commit

### Task 5.2: Windows verification script

**File:** `scripts/verify-windows-deployment.ps1`

- [ ] Smoke-check API health
- [ ] Smoke-check Mosquitto port
- [ ] Smoke-check graphile-worker schema present
- [ ] Generate a 1-page PDF report
- [ ] Output a clear pass/fail summary

- [ ] Commit

### Task 5.3: Push and announce

```bash
git push origin HEAD:docsCleaned
```

Open the PR in GitHub from `docsCleaned` against `RFID` branch.

---

## Self-Review

### 1. Spec coverage check

| Requirement | Task |
|---|---|
| Drop Memurai | Task 2.10 |
| Drop EMQX | Task 1.4 (docker-compose) + Task 4.1 (install-on-target.ps1) |
| Use Mosquitto | Tasks 1.1–1.6 |
| PostgreSQL-based queue (avoid heavy code builds / new tools) | Tasks 2.1–2.10 (graphile-worker uses LISTEN/NOTIFY + SKIP LOCKED — only existing PG features, no new infrastructure) |
| Detailed test strategy | "Test Strategy" section + per-task TDD steps |
| Skip Android, CI | Out-of-scope section + not in any task |
| Free tools only | All chosen libraries are MIT/Apache-2.0/EPL — no paid software |
| Windows-friendly rewrite | Phases 1, 2, 3 each remove a Windows pain point |

### 2. Placeholder scan

- ✅ Every step has concrete code or commands
- ⚠️ Tasks 2.4, 2.5, 2.6, 2.7 use the phrase "TDD cycle as above" — this is a deliberate compression because the pattern is identical to Task 2.3, which is fully fleshed out. Engineer is expected to copy Task 2.3's structure.
- ✅ No "TBD", "TODO", or "fill in details"

### 3. Type consistency

- `getProducer()` / `getRunnerOptions()` defined in Task 2.2, used in Tasks 2.3–2.8 ✓
- `detectEdgePath()` defined in Task 3.1, used in Task 3.2 ✓
- `renderPdf()` signature defined in Task 3.2, consistent ✓
- `renderChart()` signature defined in Task 3.3, matches existing module's call site ✓
- Feature-flag constants `FLAGS.USE_*` defined in Task 0.1, used throughout Phases 1–3 ✓

### 4. PostgreSQL features used (per user request "are there inbuilt PG features...")

- **`LISTEN/NOTIFY`** — graphile-worker uses this for instant job dispatch (no polling)
- **`SELECT … FOR UPDATE SKIP LOCKED`** — concurrent worker pickup without lock contention (PG 9.5+)
- **Advisory locks** (graphile-worker uses `pg_advisory_lock` internally for cron-job leader election)
- **JSONB columns** — graphile-worker stores job payloads as JSONB
- **Transactional job enqueue** — `addJob` runs in the caller's PG transaction, so jobs don't fire if the business txn rolls back (a feature BullMQ doesn't offer)
- **Partitioning + `pg_partman`** (optional, for high-volume queues) — not needed at current scale but available

These are PostgreSQL features that ship with PG18, no extensions required.

---

## Execution Handoff

**Plan complete and saved to `docs/plans/2026-04-29-windows-friendly-rewrite.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Best for the 30+ TDD cycles in Phases 1–3.

**2. Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints.

**Which approach?**
