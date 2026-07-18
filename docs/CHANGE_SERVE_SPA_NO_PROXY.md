# Change Guide — Serve the SPA from the Fastify API (enables "no reverse proxy")

**Date:** 2026-06-25
**File to edit:** `apps/api/src/app.ts`
**Goal:** Make the single Fastify HTTPS service on `:3000` serve the React SPA **in addition to** the API and `/uploads/`, so the deployment needs **no Nginx / IIS / reverse proxy** and **no second web service**.
**Type:** Small, additive code change (~20 lines). No rewrite. Reversible.

---

## 1. Why this change is needed

Today `apps/api/src/app.ts` registers `@fastify/static` **only for `/uploads/`** — it does **not** serve the SPA. In dev the SPA is served by Vite (`:5175`); in the old prod notes it was a separate `vite preview` service. For a clean on-premise single-service deployment we want one process to serve:

- `/api/*` — REST API (already done)
- `/uploads/*` — uploaded files (already done)
- everything else — the SPA (`apps/web/dist`) ← **this change adds it**

After this change: browser loads `https://digilog.pharma.local:3000`, gets the SPA; the SPA calls `/api/...` same-origin (no CORS); client-side routes like `/filters` resolve to `index.html`.

---

## 2. Critical caveat — `decorateReply` (read before editing)

`@fastify/static` adds a `reply.sendFile()` decorator. When it is registered **more than once**, only **one** registration may decorate the reply — the others must pass `decorateReply: false`, or Fastify throws *"reply.sendFile already decorated"* at boot.

In this codebase the **existing uploads registration already sets `decorateReply: false`** (app.ts ~line 161). That means **no registration currently provides `reply.sendFile`**. Therefore the **new SPA registration must be the one that decorates** (i.e. leave `decorateReply` at its default `true`), so the SPA fallback can call `reply.sendFile('index.html')`.

Rule for this file: **uploads = `decorateReply: false` (unchanged); SPA = decorates (default).** Exactly one decorator. ✅

---

## 3. The change

### 3.1 Locate the web-dist directory (robust for dev, prod, and the installer)

`__dirname` and `path` are already set up in `app.ts` (lines 10, 67–68). Both dev (`apps/api/src`) and compiled prod (`apps/api/dist`) sit three levels below the repo root, so `../../../apps/web/dist` resolves correctly in both. For the bundled installer (where layout may differ), allow an env override.

Add near the other path constants (e.g. just after `const uploadsDir = ...`):

```ts
// Built SPA location. Override with WEB_DIST_DIR in the installer if the
// bundle layout differs from the repo layout.
const webDistDir = process.env.WEB_DIST_DIR
  ? path.resolve(process.env.WEB_DIST_DIR)
  : path.resolve(__dirname, '../../../apps/web/dist');
```

### 3.2 Register SPA static serving + SPA fallback

Add this **after** the existing `/uploads/` registration (app.ts ~line 165) and **before** the API route registrations:

```ts
import fs from 'node:fs'; // already imported in app.ts — do not duplicate

// Serve the built SPA. This registration DECORATES reply.sendFile (the uploads
// one above uses decorateReply:false), so exactly one decorator exists.
if (fs.existsSync(webDistDir)) {
  await app.register(fastifyStatic, {
    root: webDistDir,
    prefix: '/',          // serves index.html, /assets/*, favicon, etc.
    wildcard: false,      // let setNotFoundHandler own unmatched paths (SPA routing)
    // decorateReply: true (default) — this is the sole decorator
  });

  // SPA fallback: any path that is NOT an API or uploads route returns
  // index.html so client-side routing (/filters, /audit, ...) works on refresh
  // and deep links. API 404s must still return JSON, not HTML.
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '';
    if (url.startsWith('/api') || url.startsWith('/uploads') || url.startsWith('/docs')) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Route not found' });
    }
    return reply.sendFile('index.html', webDistDir);
  });
} else {
  app.log.warn(`WEB_DIST not found at ${webDistDir} — SPA will not be served by the API (dev mode uses Vite on :5175).`);
}
```

Notes:
- Guard on `fs.existsSync` so **dev is unaffected** (no `apps/web/dist` in pure dev → Vite still serves on `:5175`; the API just logs a warning).
- The `/docs` guard preserves Swagger; drop it if Swagger is disabled in prod.
- If the app already defines a `setNotFoundHandler` elsewhere, **merge** the logic rather than registering a second one (Fastify allows only one per encapsulation context).

### 3.3 Build prerequisite

`apps/web/dist` must exist when the API runs in prod. Ensure the deploy/build does:

```bash
cd apps/web && npx vite build      # produces apps/web/dist
```

and that the installer bundles `apps/web/dist` to the path `webDistDir` resolves to (or sets `WEB_DIST_DIR`).

### 3.4 Same-origin config (so CORS/abs-URLs are not needed for the browser)

Because the SPA is now same-origin with the API, the browser can call `/api` relatively. For the **APK** (different origin) keep `VITE_API_URL` pointed at the production hostname before building the web bundle. CORS (`CORS_ORIGIN`/`ALLOWED_ORIGINS`) then only needs the APK/non-browser origins.

---

## 4. How to test

1. **Build:** `cd apps/web && npx vite build`, then start the API (`node apps/api/dist/app.js` after `tsc`, or `tsx watch` with `apps/web/dist` present).
2. **SPA loads:** open `https://localhost:3000/` → the DigiLog login page renders (served by Fastify, not Vite).
3. **Deep-link / refresh:** navigate to `https://localhost:3000/filters` and **hard-refresh** → still loads the SPA (fallback working), not a 404.
4. **API still JSON:** `curl -sk https://localhost:3000/api/nonexistent` → `{"error":"NOT_FOUND",...}` (JSON, **not** HTML). This proves the guard works.
5. **Uploads still work:** an existing `/uploads/...` URL still serves the file.
6. **Boot clean:** API starts with **no** *"reply.sendFile already decorated"* error (confirms the `decorateReply` rule in §2).

---

## 5. Rollback

The change is additive and guarded. To revert: delete the SPA `fastifyStatic` registration + the `setNotFoundHandler` block + the `webDistDir` constant. The API returns to serving only `/api` and `/uploads`; the SPA goes back to being served by Vite/separate static host. No data or schema impact.

---

## 6. Effect on the deployment

| Before this change | After this change |
|---|---|
| API serves `/api` + `/uploads` only | API also serves the SPA + SPA fallback |
| SPA needs Vite preview / separate static server / reverse proxy | **One service on `:3000` serves everything** |
| Cross-origin (SPA :5175 → API :3000) → CORS required | **Same-origin** → no CORS for the browser |
| Two services (web + api) to install & supervise | **One** NSSM service to install & supervise |

This is the single code change that makes the "no reverse proxy, single `.exe` service" model in the Pharma Deployment guide actually true.
