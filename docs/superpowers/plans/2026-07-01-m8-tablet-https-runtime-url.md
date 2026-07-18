# M8 — Tablet HTTPS-on-LAN + Runtime Server URL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ship one distributable APK that asks the operator for the server address on first launch, connects over HTTPS to the customer's bundled server, and trusts the server-generated CA the operator installs on the tablet.

**Architecture:** a single `getApiBase()` resolver (stored → window → build-env → same-origin) replaces the ~8 scattered compile-time `VITE_API_URL` reads; a native-only first-launch "Server Address" screen persists the URL to `localStorage`. The installer generates an HTTPS cert (SAN = LAN IP) into ProgramData and the APK's network-security config is extended to trust an operator-installed CA.

**Tech Stack:** React 19 + Vite 6 + React Router v6, vitest/jsdom (web tests); Capacitor (Android WebView, detected via `window.Capacitor.isNativePlatform()`); PowerShell 5.1 + bundled openssl (installer); Inno Setup 6.

**Spec:** `docs/superpowers/specs/2026-07-01-m8-tablet-https-runtime-url-design.md`

## Global Constraints

- Light theme only (`bg-white`, `bg-slate-50`, `border-slate-200`); no dark theme.
- Desktop-browser behavior MUST NOT change: with no stored URL and non-native platform, `getApiBase()` returns `''` (same-origin). The Server Address screen appears ONLY on Capacitor native.
- `localStorage` key is exactly `digilog.serverUrl`. Runtime window global is exactly `window.__API_BASE__` (existing precedent in `guest-request.tsx`).
- PowerShell scripts: ASCII only (no em-dash/section-sign — PS 5.1 parser), gate on `$LASTEXITCODE`, explicit `exit 0` on success.
- Certs + secrets live in `C:\ProgramData\DigiLog` and survive upgrades — never regenerate on upgrade.
- Web tests: `cd apps/web && npx vitest run <path>`. API typecheck: `cd apps/api && npx tsc --noEmit`. Web typecheck: `cd apps/web && npx tsc --noEmit` (or `npm run build`).

---

### Task 1: `getApiBase()` runtime base-URL resolver

**Files:**
- Create: `apps/web/src/lib/api-base.ts`
- Test: `apps/web/src/lib/__tests__/api-base.test.ts`

**Interfaces:**
- Produces:
  - `getApiBase(): string` — `localStorage['digilog.serverUrl']` → `window.__API_BASE__` → `import.meta.env.VITE_API_URL` → `''`
  - `setApiBase(url: string): string` — normalizes, persists to localStorage + `window.__API_BASE__`, returns normalized
  - `clearApiBase(): void`
  - `normalizeServerUrl(raw: string): string` — trims, strips trailing `/`, requires `http(s)://` scheme, throws on invalid
  - `initApiBaseFromStorage(): void` — mirrors stored value into `window.__API_BASE__` at boot

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/api-base.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getApiBase, setApiBase, clearApiBase, normalizeServerUrl, initApiBaseFromStorage } from '../api-base';

describe('api-base', () => {
  beforeEach(() => { localStorage.clear(); delete (window as any).__API_BASE__; });

  it('returns "" when nothing is configured (desktop same-origin default)', () => {
    expect(getApiBase()).toBe('');
  });

  it('setApiBase persists to localStorage and getApiBase returns it', () => {
    setApiBase('https://192.168.1.55:3000');
    expect(getApiBase()).toBe('https://192.168.1.55:3000');
    expect(localStorage.getItem('digilog.serverUrl')).toBe('https://192.168.1.55:3000');
  });

  it('stored value takes precedence over window.__API_BASE__', () => {
    localStorage.setItem('digilog.serverUrl', 'https://stored:3000');
    (window as any).__API_BASE__ = 'https://window:3000';
    expect(getApiBase()).toBe('https://stored:3000');
  });

  it('falls back to window.__API_BASE__ when no stored value', () => {
    (window as any).__API_BASE__ = 'https://window:3000';
    expect(getApiBase()).toBe('https://window:3000');
  });

  it('normalizeServerUrl trims whitespace and strips a trailing slash', () => {
    expect(normalizeServerUrl('  https://x:3000/  ')).toBe('https://x:3000');
  });

  it('normalizeServerUrl throws when the scheme is missing', () => {
    expect(() => normalizeServerUrl('192.168.1.55:3000')).toThrow();
  });

  it('clearApiBase removes stored value and window global', () => {
    setApiBase('https://x:3000');
    clearApiBase();
    expect(getApiBase()).toBe('');
    expect((window as any).__API_BASE__).toBeUndefined();
  });

  it('initApiBaseFromStorage mirrors the stored value into window', () => {
    localStorage.setItem('digilog.serverUrl', 'https://boot:3000');
    initApiBaseFromStorage();
    expect((window as any).__API_BASE__).toBe('https://boot:3000');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/__tests__/api-base.test.ts`
Expected: FAIL — cannot resolve `../api-base`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/lib/api-base.ts
// Single source of truth for the API base URL. On the desktop browser this is
// '' (same-origin). On the Capacitor tablet it is the runtime address the
// operator set on the Server Address screen (persisted in localStorage, which
// persists across launches in the Android WebView). See EXE-PACKAGING-PLAN §13.
const STORAGE_KEY = 'digilog.serverUrl';

export function normalizeServerUrl(raw: string): string {
  const t = (raw ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(t)) {
    throw new Error('Enter a full address, e.g. https://192.168.1.55:3000');
  }
  return t;
}

export function getApiBase(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch { /* localStorage unavailable — fall through */ }
  const w = (window as any).__API_BASE__;
  if (w) return w;
  const env = (import.meta as any).env?.VITE_API_URL;
  if (env) return env;
  return '';
}

export function setApiBase(url: string): string {
  const norm = normalizeServerUrl(url);
  try { localStorage.setItem(STORAGE_KEY, norm); } catch { /* ignore */ }
  (window as any).__API_BASE__ = norm;
  return norm;
}

export function clearApiBase(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  delete (window as any).__API_BASE__;
}

// Call once at boot, before any module reads the base, so synchronous reads of
// window.__API_BASE__ (existing precedent) see the persisted value.
export function initApiBaseFromStorage(): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && !(window as any).__API_BASE__) (window as any).__API_BASE__ = stored;
  } catch { /* ignore */ }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/__tests__/api-base.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api-base.ts apps/web/src/lib/__tests__/api-base.test.ts
git commit -m "feat(web): getApiBase runtime server-URL resolver (M8)"
```

---

### Task 2: Wire the resolver into the ~8 base-URL read sites + boot

**Files:**
- Modify: `apps/web/src/main.tsx` (boot: call `initApiBaseFromStorage()` at top)
- Modify: `apps/web/src/lib/api-client.ts:5`, `apps/web/src/lib/connectivity.ts:51`, `apps/web/src/lib/pdf-report.ts:75,92`, `apps/web/src/lib/url-utils.ts:1`, `apps/web/src/components/hard-cutoff-blocker.tsx:62`, `apps/web/src/routes/auth/guest-request.tsx:28`, `apps/web/src/routes/mobile/mobile-login.tsx:15`

**Interfaces:**
- Consumes: `getApiBase`, `initApiBaseFromStorage` from `lib/api-base` (Task 1)

- [ ] **Step 1: Find every base-URL read site (do not trust the list — grep)**

Run: `cd apps/web && grep -rn "VITE_API_URL" src`
Expected: the sites listed above (plus a comment reference in `api-client.ts:211`). Update every real read; add any new ones to this task.

- [ ] **Step 2: Add the boot initializer to `main.tsx`**

At the very top of `apps/web/src/main.tsx`, immediately after the imports and before the Capacitor redirect block (`main.tsx:122`), add:

```tsx
import { initApiBaseFromStorage } from './lib/api-base';
// Mirror any persisted server URL into window.__API_BASE__ BEFORE any API call
// or the Capacitor redirect runs, so every module resolves the same base.
initApiBaseFromStorage();
```

- [ ] **Step 3: Replace each read site**

In each file, replace the module-level `const X = import.meta.env.VITE_API_URL ?? ''` (or the inline `(import.meta as any).env?.VITE_API_URL ?? ''`, and `guest-request.tsx`'s `(window as any).__API_BASE__ ?? ... ?? ''`) with a call to `getApiBase()` at the point of use. Add `import { getApiBase } from '@/lib/api-base'` (or the correct relative path). Examples:

- `apps/web/src/lib/api-client.ts:5` — change `const BASE_URL = import.meta.env.VITE_API_URL ?? '';` to compute per-request: replace `BASE_URL` usages with `getApiBase()` (call inside `request()` so a URL set after load is honored).
- `apps/web/src/lib/url-utils.ts` — replace the whole file body:

```ts
import { getApiBase } from './api-base';

export function getPhotoUrl(url: string | undefined): string {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${getApiBase()}${url}`;
}
```

  Then grep for other importers of `API_BASE` from `url-utils` and switch them to `getApiBase()`:
  Run: `cd apps/web && grep -rn "API_BASE" src` — update any `import { API_BASE } from ...url-utils` site to call `getApiBase()`.
- `connectivity.ts:51`, `pdf-report.ts:75` + `:92`, `hard-cutoff-blocker.tsx:62`, `mobile-login.tsx:15`, `guest-request.tsx:28` — replace the local `base`/`API_BASE` constant with `getApiBase()` at use.

- [ ] **Step 4: Typecheck + existing tests**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.
Run: `cd apps/web && npx vitest run`
Expected: no NEW failures vs the pre-change baseline.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "refactor(web): resolve API base via getApiBase() at all read sites (M8)"
```

---

### Task 3: Server Address screen + route

**Files:**
- Create: `apps/web/src/routes/mobile/server-config.tsx`
- Create: `apps/web/src/routes/mobile/__tests__/server-config.test.tsx`
- Modify: `apps/web/src/main.tsx` (add the `/m/server-config` route)

**Interfaces:**
- Consumes: `getApiBase`, `setApiBase` from `lib/api-base`
- Produces: default-exported `ServerConfigPage` React component; route `/m/server-config`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/routes/mobile/__tests__/server-config.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ServerConfigPage from '../server-config';

describe('ServerConfigPage', () => {
  beforeEach(() => { localStorage.clear(); delete (window as any).__API_BASE__; vi.restoreAllMocks(); });

  it('saves the URL when the health check succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    render(<ServerConfigPage />);
    fireEvent.change(screen.getByPlaceholderText(/https:\/\//i), { target: { value: 'https://192.168.1.55:3000' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    await waitFor(() => expect(localStorage.getItem('digilog.serverUrl')).toBe('https://192.168.1.55:3000'));
    expect((fetch as any)).toHaveBeenCalledWith('https://192.168.1.55:3000/api/health', expect.anything());
  });

  it('shows an error and saves nothing when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    render(<ServerConfigPage />);
    fireEvent.change(screen.getByPlaceholderText(/https:\/\//i), { target: { value: 'https://192.168.1.55:3000' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    await waitFor(() => expect(screen.getByText(/couldn't reach/i)).toBeInTheDocument());
    expect(localStorage.getItem('digilog.serverUrl')).toBeNull();
  });

  it('rejects a URL with no scheme before hitting the network', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    render(<ServerConfigPage />);
    fireEvent.change(screen.getByPlaceholderText(/https:\/\//i), { target: { value: '192.168.1.55:3000' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    await waitFor(() => expect(screen.getByText(/full address/i)).toBeInTheDocument());
    expect(f).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/routes/mobile/__tests__/server-config.test.tsx`
Expected: FAIL — cannot resolve `../server-config`.

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/routes/mobile/server-config.tsx
import { useState } from 'react';
import { getApiBase, setApiBase, normalizeServerUrl } from '@/lib/api-base';

// First-launch (and re-configure) screen where the tablet operator sets the
// server address. Validates with a /api/health ping before saving so a typo or
// an untrusted cert surfaces here instead of a broken login. See spec §3.3.
export default function ServerConfigPage() {
  const [url, setUrl] = useState(getApiBase());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function connect() {
    setError('');
    let norm: string;
    try { norm = normalizeServerUrl(url); }
    catch (e: any) { setError(e.message); return; }
    setBusy(true);
    try {
      const res = await fetch(`${norm}/api/health`, { method: 'GET' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setApiBase(norm);
      window.location.href = '/m/login';
    } catch {
      setError(
        `Couldn't reach the server at ${norm}. Check the address, that the ` +
        `server is turned on, and that you installed the DigiLog certificate on this tablet.`
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
        <h1 className="text-lg font-semibold text-slate-800">Connect to DigiLog server</h1>
        <p className="text-sm text-slate-500">Enter the address shown on the DigiLog PC.</p>
        <input
          type="url"
          inputMode="url"
          autoCapitalize="none"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-slate-800"
          placeholder="https://192.168.1.55:3000"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="button"
          disabled={busy}
          onClick={connect}
          className="w-full rounded-lg bg-cyan-600 text-white py-2 font-medium disabled:opacity-60"
        >
          {busy ? 'Connecting...' : 'Connect'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the route to `main.tsx`**

Next to the other `/m/*` routes (near `main.tsx:152`), add:

```tsx
<Route path="/m/server-config" element={<Suspense fallback={<LazyFallback />}><ServerConfigPage /></Suspense>} />
```

Add a lazy import alongside the other mobile lazy imports:

```tsx
const ServerConfigPage = lazy(() => import('./routes/mobile/server-config'));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/routes/mobile/__tests__/server-config.test.tsx`
Expected: PASS (3 tests). Then `cd apps/web && npx tsc --noEmit` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/mobile/server-config.tsx apps/web/src/routes/mobile/__tests__/server-config.test.tsx apps/web/src/main.tsx
git commit -m "feat(web): tablet Server Address screen with health-check validation (M8)"
```

---

### Task 4: Gating — first-launch redirect + login-screen re-configure link

**Files:**
- Modify: `apps/web/src/main.tsx` (gate before the `/m/login` redirect)
- Modify: `apps/web/src/routes/mobile/mobile-login.tsx` (add "Change server address" link)

**Interfaces:**
- Consumes: `getApiBase` from `lib/api-base`

- [ ] **Step 1: Add the native first-launch gate in `main.tsx`**

Replace the Capacitor redirect block (`main.tsx:122-128`) so that a native launch with no configured server goes to the Server Address screen first:

```tsx
{
  const path = window.location.pathname;
  const isNative = (window as any).Capacitor?.isNativePlatform?.();
  const allowedOnTablet = path.startsWith('/m') || path.startsWith('/change-password');
  if (isNative) {
    // No server configured yet -> force the Server Address screen first.
    if (!getApiBase() && path !== '/m/server-config') {
      window.location.href = '/m/server-config';
    } else if (!allowedOnTablet) {
      window.location.href = '/m/login';
    }
  }
}
```

Add `import { getApiBase } from './lib/api-base';` at the top (alongside `initApiBaseFromStorage`).

- [ ] **Step 2: Add the re-configure link to the mobile login screen**

In `apps/web/src/routes/mobile/mobile-login.tsx`, add a small link (native only) that navigates to `/m/server-config`, so a changed server IP is fixable without reinstalling:

```tsx
{(window as any).Capacitor?.isNativePlatform?.() && (
  <a href="/m/server-config" className="block text-center text-xs text-slate-400 mt-4">
    Change server address
  </a>
)}
```

Place it near the bottom of the login form's JSX.

- [ ] **Step 3: Verify typecheck + build**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.
Run: `cd apps/web && npx vitest run`
Expected: no new failures.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/main.tsx apps/web/src/routes/mobile/mobile-login.tsx
git commit -m "feat(web): native first-launch server-config gate + re-configure link (M8)"
```

---

### Task 5: APK enablement — trust user CA + blank baked URL

**Files:**
- Modify: `apps/android/android/app/src/main/res/xml/network_security_config.xml`
- Modify: `apps/web/.env.production`

- [ ] **Step 1: Trust an operator-installed CA in the APK**

Edit `network_security_config.xml` to add `<certificates src="user" />` inside `<trust-anchors>` (keep `system` + `@raw/rootca`):

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
            <!-- Operator-installed CA (customer server's rootCA.pem) -->
            <certificates src="user" />
            <!-- Dev/test mkcert root CA -->
            <certificates src="@raw/rootca" />
        </trust-anchors>
    </base-config>
</network-security-config>
```

- [ ] **Step 2: Blank the baked server URL so first launch prompts**

Edit `apps/web/.env.production`: set `VITE_API_URL=` (empty). This makes `getApiBase()` fall through to the Server Address screen on a fresh APK.

- [ ] **Step 3: Verify (build-config only — no unit test)**

Run: `cd apps/web && grep -n "VITE_API_URL" .env.production` → shows `VITE_API_URL=` (empty).
Confirm the XML is well-formed (no schema tool here; visual check + it is loaded by the Android build).

- [ ] **Step 4: Commit**

```bash
git add apps/android/android/app/src/main/res/xml/network_security_config.xml apps/web/.env.production
git commit -m "feat(apk): trust operator-installed CA + blank baked server URL (M8)"
```

---

### Task 6: Installer HTTPS-on-LAN cert generation (`install.ps1`)

**Files:**
- Modify: `apps/api` — none (app.ts already honors `TLS_KEY_PATH`/`TLS_CERT_PATH`)
- Modify: `scripts/install.ps1` (fresh-install env block + new cert step)

**Note:** openssl cert generation runs on the customer/build machine. Here, verification is AST-parse + `-DryRun`; the real cert issuance is a deferred gate.

- [ ] **Step 1: Add LAN-IP detection + cert generation before the env-file write**

In `scripts/install.ps1`, before the env-file block (`Test-Path $envFile` section), add:

```powershell
# --- M8: HTTPS-on-LAN certs (so the Android tablet can connect) ---
$certDir = Join-Path $DataRoot 'certs'
$openssl = Join-Path $pgBin 'openssl.exe'
# LAN IPv4 the tablet will use (default-route interface).
$lanIp = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } |
          Select-Object -First 1).IPv4Address.IPAddress
if (-not $lanIp) { $lanIp = '127.0.0.1' }
$srvKey = Join-Path $certDir 'server.key'
$srvCrt = Join-Path $certDir 'server.crt'
$caPem  = Join-Path $certDir 'rootCA.pem'

if (Test-Path $srvCrt) {
  Write-Host "==> Reusing existing certs in $certDir (upgrade-safe)" -ForegroundColor Cyan
} elseif (-not (Test-Path $openssl)) {
  Write-Host "FATAL: openssl.exe not found at $openssl (needed for HTTPS-on-LAN)." -ForegroundColor Red; exit 1
} else {
  New-Item -ItemType Directory -Force -Path $certDir | Out-Null
  $caKey = Join-Path $certDir 'rootCA.key'
  $ext = Join-Path $certDir 'server.ext'
  Set-Content -Path $ext -Encoding ascii -Value @"
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
subjectAltName = @alt
[alt]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = $lanIp
"@
  if ($DryRun) {
    Write-Host "[dry-run] openssl generate rootCA + server cert (SAN: localhost,127.0.0.1,$lanIp) in $certDir" -ForegroundColor Yellow
  } else {
    & $openssl genrsa -out $caKey 2048
    & $openssl req -x509 -new -nodes -key $caKey -sha256 -days 3650 -subj "/CN=DigiLog Local CA" -out $caPem
    & $openssl genrsa -out $srvKey 2048
    & $openssl req -new -key $srvKey -subj "/CN=$lanIp" -out (Join-Path $certDir 'server.csr')
    & $openssl x509 -req -in (Join-Path $certDir 'server.csr') -CA $caPem -CAkey $caKey -CAcreateserial -days 3650 -sha256 -extfile $ext -out $srvCrt
    if (-not (Test-Path $srvCrt)) { Write-Host "FATAL: server cert generation failed." -ForegroundColor Red; exit 1 }
    # Trust the CA on the SERVER so the PC's own browser doesn't warn under HTTPS.
    Import-Certificate -FilePath $caPem -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
    Write-Host "==> Generated HTTPS certs (SAN includes $lanIp); rootCA.pem = $caPem" -ForegroundColor Cyan
  }
}
```

- [ ] **Step 2: Set HTTPS env in the generated `digilog.env`**

In the env-body here-string, change `API_HTTPS=false` to `API_HTTPS=true`, and add the TLS + LAN origin lines. Replace the `API_HTTPS=false` line and the `ALLOWED_ORIGINS` line with:

```
API_HTTPS=true
TLS_KEY_PATH=$srvKey
TLS_CERT_PATH=$srvCrt
```

and

```
ALLOWED_ORIGINS=https://localhost:$ApiPort,https://${lanIp}:$ApiPort
```

- [ ] **Step 3: Make the health check use HTTPS**

Change the health-check URL in `install.ps1` from `http://localhost:$ApiPort/api/health` to `https://localhost:$ApiPort/api/health` (trusted after the CA import in Step 1).

- [ ] **Step 4: Verify AST + dry-run**

Run: `powershell -NoProfile -Command "$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('scripts/install.ps1',[ref]$null,[ref]([ref]$e).Value)|Out-Null; if($e){$e}else{'AST OK'}"`
Expected: `AST OK`.
Run (dry): the installer dry-run path prints the cert-gen plan without executing.
Expected: shows `[dry-run] openssl generate rootCA + server cert (SAN: ... $lanIp)`.

- [ ] **Step 5: Commit**

```bash
git add scripts/install.ps1
git commit -m "feat(installer): generate HTTPS-on-LAN certs + API_HTTPS env (M8)"
```

---

### Task 7: Installer shortcut + tablet-certificate helper (`DigiLog.iss`)

**Files:**
- Modify: `installer/DigiLog.iss`

- [ ] **Step 1: Point the app shortcut at HTTPS**

In the `CurStepChanged` `ssPostInstall` block, change the URL written into `DigiLog.url` from `http://localhost:3000` to `https://localhost:3000`.

- [ ] **Step 2: Add a "Install tablet certificate" Start-menu entry**

In `[Icons]`, add an entry pointing the operator at the exported CA so they can sideload it onto the tablet:

```
Name: "{group}\Install tablet certificate (rootCA.pem)"; Filename: "{commonappdata}\DigiLog\certs"; \
  Comment: "Copy rootCA.pem to the tablet and install it under Settings > Security > Install certificate"
```

- [ ] **Step 3: Verify (Inno compile is a deferred build-machine gate)**

Visual review that the `[Icons]` entry + the `https://` URL are correct. (ISCC compile runs on the build machine.)

- [ ] **Step 4: Commit**

```bash
git add installer/DigiLog.iss
git commit -m "feat(installer): HTTPS shortcut + tablet-certificate helper (M8)"
```

---

### Task 8: Docs + deferred-validation addendum

**Files:**
- Modify: `tasks/EXE-PACKAGING-PLAN.md` (M8 rows → done; §13 status)
- Modify: `tasks/M7-CLEAN-VM-ACCEPTANCE-RUNBOOK.md` (add a tablet-connect section — deferred, needs a device)
- Modify: `CHANGELOG.md`
- Modify: memory `project_exe_packaging_m0_2026_06_30.md` + `MEMORY.md` hook

- [ ] **Step 1: Update the plan M8 row + §13 to DONE**, noting what shipped vs the deferred device gate.

- [ ] **Step 2: Add a "Tablet connect (deferred — needs a real Android device on a LAN)" section** to the acceptance runbook: install rootCA.pem on the tablet, open the APK, enter `https://<LAN-IP>:3000`, Connect, log in.

- [ ] **Step 3: CHANGELOG entry** summarizing the M8 client feature + server HTTPS + APK trust change.

- [ ] **Step 4: Update memory** (M8 done facts, deferred gates).

- [ ] **Step 5: Commit**

```bash
git add tasks/EXE-PACKAGING-PLAN.md tasks/M7-CLEAN-VM-ACCEPTANCE-RUNBOOK.md CHANGELOG.md
git commit -m "docs(m8): mark tablet HTTPS + runtime server-URL done; deferred device gate"
```

---

## Notes for the implementer

- **Desktop must stay same-origin.** After Task 2, run the desktop bundle (`SERVE_WEB=true`) and confirm login still works with no stored URL — `getApiBase()` returns `''`.
- **Do not add `@capacitor/preferences`** — `localStorage` persists in the Android WebView and avoids a native plugin + rebuild.
- **Deferred gates (cannot verify in this dev env):** openssl cert issuance (customer/build machine), the full tablet round-trip (real Android device + LAN + operator CA install), ISCC compile. These are documented, same class as M5–M7's gates.
