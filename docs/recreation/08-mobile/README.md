# Phase 8 — Mobile Application

## Finding: there is no mobile application in compliance-core.

This is not a gap in the analysis. It is the analysis result.

---

## Evidence

```bash
$ ls apps/
api  web
```

Two applications. Neither is mobile.

```bash
$ python -c "import json;print(list(json.load(open('apps/web/package.json'))['dependencies']))"
['@digilog/shared', '@hookform/resolvers', 'clsx', 'exceljs', 'jspdf',
 'jspdf-autotable', 'lucide-react', 'react', 'react-dom', 'react-hook-form',
 'react-router-dom', 'swr', 'tailwind-merge']
```

No `@capacitor/*`. No React Native. No Cordova.

There is additionally **no** `capacitor.config.ts`, `android/` directory, Gradle
build, `AndroidManifest.xml`, or `.apk` anywhere in the tree.

## What the brief asked for, and the actual status

| Brief item | Status |
|---|---|
| Architecture | **N/A** — no mobile app |
| Screens | **N/A** |
| Navigation | **N/A** |
| Offline database | **N/A** — no IndexedDB, no SQLite ([receipt](../02-inventory/absent-subsystems.md#4-no-offline-support-sync-engine-or-indexeddb)) |
| Synchronisation | **N/A** — no sync engine |
| Capacitor plugins | **N/A** — Capacitor is not a dependency |
| Native plugins | **N/A** |
| RFID SDK | **N/A** — no SDK, no `.jar` ([receipt](../02-inventory/absent-subsystems.md#2-no-rfid-or-barcode)) |
| Barcode scanner | **N/A** |
| Printer integration | **N/A** — PDF generation only, no printer path |
| Storage | **N/A** |
| Permissions (device) | **N/A** |
| Push notifications | **N/A** — notifications are in-app + email/SMS |
| Background sync | **N/A** |
| Security (mobile) | **N/A** |

## Why the brief expected one

compliance-core is a fork of **DigiLog**, an IoT cleanroom filter-management
platform. DigiLog did have:

- `apps/android/` — a Capacitor wrapper shipping `DigiLog-FilterOps.apk`
- `rfid_scan_app/` — a native Kotlin app for KC-series UHF RFID readers
- An IndexedDB offline queue with a sync engine, tombstones, and idempotency keys

**None of it was carried into this fork.** The cleanroom domain — and with it
every reason for a tablet-based field application — was removed in commit
`a92ca5d` ("Phase 0: strip cleanroom domain → generic 21 CFR Part 11 admin
core"). The offline-replay subsystem was removed separately in `cbcb913`.

The recreation brief was evidently written against DigiLog, not against
compliance-core. See the root [`../README.md`](../README.md) §1.1.

## Vestigial traces (do not mistake these for a mobile app)

Nine files match `/capacitor/i` and nine match `/rfid/i`. **Every one is a
comment, a historical note, or a dead string**, not working code:

| Location | What it actually is |
|---|---|
| `apps/web/src/lib/api-base.ts` | Comment on WebView TLS behaviour + a `localStorage` server-URL override built for tablets |
| `apps/web/src/lib/api-client.ts` | Comments on Capacitor fetch semantics |
| `apps/web/src/hooks/use-auth.ts` | Comment about a Capacitor redirect edge case |
| `apps/api/src/app.ts` | `capacitor://localhost` left in the CORS allow-list — **dead config, remove it** |
| `apps/web/src/lib/report-types.ts` | An `rfid-track-record` key in the report registry with no page |
| `apps/web/src/lib/export-surfaces.ts` | Similar leftover surface key |

A PWA manifest **is** configured (`vite-plugin-pwa`), so the web app is
installable to a home screen and will render on a phone via the responsive
layout. **That is not a mobile application and it is not offline-capable** —
there is no local database and no sync.

## If a mobile client is wanted in the rebuild

It would be **new work**, not recreation, and the brief's rule "every
implementation decision must be traceable to the original application" cannot be
satisfied for it. The honest sequencing is:

1. Treat it as a new requirement with its own discovery — there is no surviving
   domain workflow that needs a field device.
2. Recognise that offline operation on regulated records is a **compliance
   design problem, not a caching problem**: queued actions must produce audit
   entries with trustworthy timestamps and a defensible signature at replay time.
   The upstream system needed a separate offline-replay grant token precisely
   because a bare "trust the client" header was not defensible.
3. Only then choose a technology.

Recommendation captured in [`../11-rebuild-plan/README.md`](../11-rebuild-plan/README.md):
**do not build it speculatively.**
