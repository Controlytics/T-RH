# API reference — pointer

The hand-written reference that lived here was archived on 2026-10-05 as
[`docs/archive/API_REFERENCE-2026-08-24.md`](docs/archive/API_REFERENCE-2026-08-24.md).
It had not been touched since 2026-08-24, documented ten lines of the removed
filters module and none of the alarms, floorplans, functional-locations,
alarm-webhooks, report-reviews or ingest surfaces, and quoted stale counts in its
own drift banner. It is not maintained and must not be cited.

Read the API from the two sources that cannot drift by hand:

- **The live Swagger UI** at `https://localhost:3001/docs` (this checkout; a
  customer install serves it on its own port) — generated from the registered
  routes and their schemas on every start. `/docs/json` is the OpenAPI document.
- **[`docs/recreation/06-api/endpoints.md`](docs/recreation/06-api/endpoints.md)**
  — the last dumped OpenAPI listing, including the ingest surface. It is a
  snapshot (see the banner in `docs/recreation/README.md`); when it and the
  running server disagree, the server is right.

For the instrument-dashboard endpoints with their rationale, root `CLAUDE.md`
"Key API Endpoints" is kept current with the code.

No endpoint list is hand-maintained here any more.
