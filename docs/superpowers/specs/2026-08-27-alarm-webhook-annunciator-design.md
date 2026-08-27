# Alarm webhook annunciator — design

**Date:** 2026-08-27
**Branch:** `data-injection`
**Surface:** new API module `apps/api/src/modules/alarm-webhooks/`, new worker
`apps/api/src/workers/alarm-webhook.worker.ts`, new page
`apps/web/src/routes/config/alarm-webhooks.tsx`.

## The problem

An alarm today reaches a person — email, SMS, an in-app row. Nothing reaches a
*device*. The operator has IP-addressable hooters on the plant network: a small
box with an HTTP endpoint that buzzes when it is POSTed to.

What is wanted: assign a hooter's URL to **one instrument or a group of
instruments**, define **what body to send**, and have the hooter buzz whenever
any instrument in that set goes into alarm. One URL can serve many instruments;
one instrument can feed several hooters (local panel plus control room).

## The thesis

**Annunciation is keyed off the INSTRUMENT, not off the alarm rule, and it
reuses the grouping the system already has rather than inventing a fourth one.**

Both halves of that sentence are load-bearing, and both rule out the cheap
implementation.

## Why not extend `NotificationRule`

Adding `WEBHOOK` to `NotificationChannel` and a `webhookEnabled` flag to
`NotificationRule` is the obvious move. It does not work here, for three
reasons, in ascending order of severity:

1. `notification-dispatcher.ts` resolves a rule's recipients to **users** and
   does `if (users.length === 0) continue;`. A rule whose only target is a
   hooter has no user recipients and is silently skipped.
2. `NotificationRule` has no instrument scoping. The group would have to be
   smuggled into the `conditions` JSONB, which is not the model the operator
   described and is not queryable as a group.
3. **`Alarm.ruleId` is nullable.** `INSTRUMENT_LIMIT` alarms are raised from the
   instrument's own limit attributes and carry no rule row at all — and on this
   installation those are the alarms that actually fire (see
   `docs/…/2026-08-17-instrument-limit-alarms-design.md` and the attribute
   governance work of 2026-08-19). A design hung off `AlarmRule` would
   annunciate **nothing** while appearing correctly configured. This is the
   decisive one.

Note also that `NotificationChannel` already lists `TELEGRAM`, `WHATSAPP` and
`SLACK` while `notification-delivery/channels/` holds only `email-channel.ts`
and `sms-channel.ts`. The enum is not evidence that a channel exists. Do not
read it as one.

`NotificationRule` is therefore **untouched** by this work. Alerting people is
unchanged.

## Why not a new `InstrumentGroup` model

Root `CLAUDE.md` is explicit that instrument grouping is three concepts with one
job each: `FunctionalLocation` (Block > Area) is the authoritative logical
grouping, `roomId` is geometry on a drawn plan, `profileId` is device type. A
fourth grouping concept would contradict that directly and would immediately
drift from the hierarchy people actually maintain.

The shape that already solves this exact problem is
`role_configs.instrument_scope`: a JSONB selection set of functional-location
ids, with a Block expanding to its Areas through
`functional-locations/tree.ts:resolveLocationIds()`. This design copies that
shape and adds an explicit-instrument list beside it, so "a group **or** a
single instrument" is expressible verbatim without a new concept.

## Data model

Two new models. **No new Prisma enums** — `method`, `event` and `status` are
validated strings, the same deliberate precedent as `FloorplanRoom.grade`
(2026-08-24), so the vocabulary can grow without a migration. Enum count stays
at 13; model count moves 34 → 36.

### `AlarmWebhookTarget` — "the hooter"

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `name` | VarChar(200) | e.g. "QC-3 corridor hooter" |
| `description` | VarChar(500)? | |
| `url` | Text | `http://` or `https://`. Operator-typed, **no allowlist** |
| `method` | VarChar(10) | `POST` \| `PUT` \| `GET`, validated in zod |
| `headers` | JSONB | `{ "Content-Type": "application/json" }` etc. |
| `contentType` | VarChar(100) | drives body escaping; default `application/json` |
| `bodyTemplate` | Text | `${…}` placeholders, see **Body rendering** |
| `successRegex` | Text? | when set it is authoritative over the status code |
| `timeoutMs` | Int | default 5000 |
| `fireOnRaised` | Bool | default true |
| `fireOnCleared` | Bool | default true |
| `fireOnAcknowledged` | Bool | default true |
| `severities` | JSONB? | `null` = all severities; `["CRITICAL","MAJOR"]` narrows |
| `cooldownSeconds` | Int | default 0; throttles `RAISED` only — see **Cooldown** |
| `isActive` | Bool | default true |
| `scopeLocationIds` | JSONB | functional-location ids, `[]` = none |
| `scopeInstrumentIds` | JSONB | instrument ids, `[]` = none |
| `createdAt/By`, `updatedAt/By` | | |

`scopeLocationIds` / `scopeInstrumentIds` are `JSONB NOT NULL DEFAULT '[]'` —
**not** nullable. This deliberately differs from `instrument_scope`, where NULL
means *inherit*. There is nothing to inherit from here, and the ambiguity is
dangerous in this direction: see **Empty scope** below.

### `AlarmWebhookDelivery` — the §11 receipt

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `targetId` | uuid | FK, `onDelete: Restrict` |
| `alarmId` | uuid? | FK, `onDelete: Restrict`; NULL for a **test fire** |
| `event` | VarChar(20) | `RAISED` \| `CLEARED` \| `ACKNOWLEDGED` \| `TEST` |
| `url` | Text | the URL actually hit, copied at send time |
| `requestBody` | Text | the rendered body actually sent |
| `httpStatus` | Int? | NULL on timeout / connection refused |
| `responseSnippet` | VarChar(1000)? | truncated; a hooter may return anything |
| `attempt` | Int | 1..3 |
| `status` | VarChar(10) | `SENT` \| `FAILED` |
| `error` | Text? | |
| `createdAt`, `sentAt` | Timestamptz | |

Indexes: `(targetId, createdAt desc)`, `(alarmId)`, `(status)`.

**Both FKs restrict.** A delivery row is evidence that the system did or did not
annunciate a specific excursion; deleting a target must not erase the record of
what it did. Deleting a target is therefore a soft operation — set `isActive`
false — and a hard delete is refused while deliveries reference it. The error
message must say so, rather than surfacing a raw FK violation.

`requestBody` is stored verbatim. It is small, it is the only way to answer "why
didn't the hooter fire", and reconstructing it later from a since-edited
template would be a fabrication.

## Scope resolution

One exported function, server-side, in
`modules/alarm-webhooks/target-scope.ts`:

```
resolveTargetsForInstrument(instrumentId, event, severity) -> AlarmWebhookTarget[]
```

A target matches when **all** of:

- `isActive` is true; and
- the corresponding `fireOn*` flag is true for this event; and
- `severities` is null **or** contains this alarm's severity; and
- `instrumentId ∈ scopeInstrumentIds` **OR** the instrument's
  `functionalLocationId` is in `expandLocations(scopeLocationIds)`, where
  expansion is the existing `resolveLocationIds()` — a Block yields itself plus
  its Areas.

Several targets may match one instrument. **All of them fire.** That is the
local-panel-plus-control-room case and it is intended.

An instrument with a NULL `functionalLocationId` can only be reached through
`scopeInstrumentIds`. This mirrors the visibility rule that unassigned
instruments are invisible to any active scope, and it is worth surfacing in the
UI: the scope picker shows a count of instruments the target currently resolves
to, so "0 instruments" is visible at configuration time rather than discovered
during an excursion.

### Empty scope

**Both lists empty ⇒ the target matches nothing.** Never everything.

A misconfigured target that stays silent is a bug someone finds and fixes. A
target that buzzes every hooter in the plant for every instrument gets the
feature switched off at the panel and never switched back on. The safe default
is asymmetric here and the code must state it, not merely happen to do it — a
unit test pins `[]`/`[]` to zero matches.

## Firing

`enqueueAlarmWebhook(event, input)` lives in
`modules/alarm-webhooks/enqueue.ts`, beside and modelled on
`alarms/enqueue-notification.ts`. It follows that file's contract exactly:

**It never throws.** The alarm is the regulated record and is already committed
by the time this runs. A queue outage, or a hooter that is unplugged, must cost
an annunciation — never the detection of every other excursion in the same
evaluation pass.

Call sites:

| Event | Where |
|---|---|
| `RAISED` | `workers/alarm-evaluation.worker.ts`, beside the two existing `enqueueAlarmNotification('raised', …)` calls (rule alarms and instrument-limit alarms) |
| `CLEARED` | same file, beside the two `('cleared', …)` calls |
| `ACKNOWLEDGED` | `modules/alarms/routes.ts`, `POST /:id/acknowledge` |

The acknowledge hook goes **after** the atomic claim — the update whose `where`
includes `acknowledgedAt: null`. Two simultaneous acknowledgements must produce
one delivery, not two, and the loser of that race must fire nothing.

New graphile-worker task `alarm_webhook`, registered in the `taskList` in
`app.ts` (5 → 6 tasks), with `alarmWebhookJobSchema` in
`packages/queue/src/schemas.ts`.

### Job payload

```ts
{
  event: 'RAISED' | 'CLEARED' | 'ACKNOWLEDGED',
  alarmId: string,
  instrumentId: string,
  severity: string,
  variables: Record<string, string>,   // strings only, as the notification job does
}
```

`variables` is built by a pure function beside `alarms/notify.ts`'s
`alarmNotificationJob`, reusing its formatting decisions — notably
`formatDecimals(value, instrument decimals)`, so the hooter payload, the email
and the dashboard all quote one excursion identically.

Variables offered: `event`, `alarmId`, `instrument` (code, falling back to id),
`instrumentName`, `instrumentId`, `metric`, `value`, `severity`, `condition`,
`ruleName`, `timestamp`, plus `raisedAt` and `duration` on `CLEARED`, and
`acknowledgedBy` and `acknowledgeReason` on `ACKNOWLEDGED`.

That list is exported as `ALARM_WEBHOOK_VARIABLES` and the config page renders
the picker **from it**, so the UI cannot advertise a placeholder the renderer
does not produce. `alarms/notify.ts` carries a comment explaining that an event
type is described in five hand-written places and a variable missing from one
of them renders as an empty cell in the record an inspector reads. One exported
constant is the fix, and a test holds the picker against it.

## Body rendering

New module `modules/alarm-webhooks/render-body.ts`:

```
renderWebhookBody(template, variables, contentType) -> string
```

For `application/json` every substituted value is **JSON-string-escaped**
(`JSON.stringify(v).slice(1, -1)`). For any other content type the value is
inserted raw. It does **not** HTML-escape, and it is **not**
`template-engine.ts:resolveTemplate()`.

This is not a stylistic preference. `resolveTemplate()` escapes `&`, `<`, `>`
and `"` into HTML entities — correct for an email body, wrong for a JSON
payload. Instrument codes in this fork are deliberately unrestricted free text
(the charset rule was removed in 2026-08-07 and replaced by UUID-addressed MQTT
topics), so an instrument named `Chiller "A" & B` would render
`&quot;A&quot; &amp; B` into the body. The hooter then rejects the request as
malformed — intermittently, for one instrument, in a way that looks like a
network fault. A unit test pins exactly that instrument name.

Default template on a new target:

```json
{"event":"${event}","instrument":"${instrument}","metric":"${metric}",
 "value":"${value}","severity":"${severity}","condition":"${condition}",
 "alarmId":"${alarmId}","timestamp":"${timestamp}"}
```

An unknown placeholder is left literal (matching `resolveTemplate`'s behaviour)
rather than rendered as an empty string, so a typo is visible in the delivery
log instead of silently producing `"instrument":""`.

## Delivery

Worker `workers/alarm-webhook.worker.ts`:

1. Resolve matching targets.
2. Per target, check the cooldown (see **Cooldown** below).
3. Render the body; issue the request with `AbortSignal.timeout(timeoutMs)`,
   `redirect: 'error'`, no cookies, no credentials.
4. Success = a 2xx status **and**, when `successRegex` is set, a response body
   matching it. When set, the regex is authoritative — cheap hardware returns
   HTTP 200 on failure, which is exactly the lesson already recorded at
   `SmsConfig.httpGatewaySuccessRegex` (`#sms-2xx`).
5. On failure, retry — **3 attempts total, ~2s apart, inside the one job**.
6. Write an `AlarmWebhookDelivery` row for **every attempt**, success or
   failure.

The job is enqueued with `maxAttempts: 1`. graphile-worker's own exponential
backoff must not deliver a buzz twenty minutes after the excursion cleared: a
late annunciation is worse than none, because it announces a condition that no
longer exists. Bounded retry lives inside the job where its timing is visible;
the permanent record of the failure lives in the delivery log.

A target whose `url` is unreachable therefore produces three FAILED rows and
nothing else. It does not block, retry forever, or affect any other target in
the same job.

### Cooldown

`cooldownSeconds` throttles **`RAISED` only**. `CLEARED` and `ACKNOWLEDGED` are
never suppressed by it, whatever its value.

The reason is asymmetric and easy to get wrong: a cooldown exists to stop a
flapping instrument buzzing every minute. But `CLEARED` and `ACKNOWLEDGED` are
*silence* signals. Throttling them means the buzzer keeps sounding for a
condition that has already gone away, and the operator's only remedy is to
unplug the hooter — the exact outcome the cooldown was meant to prevent. Never
rate-limit the off switch.

The cooldown is tracked in an in-memory `Map` keyed by target id — the same
approach, and the same single-instance caveat, as the dispatcher's
`cooldownMap`. Recorded here rather than inherited silently: on a restart the
map is empty and the next raise fires immediately, which is the correct failure
direction.

## Governance

- **Permissions: reuse `ALARM_RULE_READ` / `ALARM_RULE_MANAGE`.** A role that
  can decide when an alarm fires can already decide where it is announced.
  Permission count stays at **42**; no sidebar item is added (the page lives
  under Config, 12 sidebar items unchanged).
- **One new reauth action `MANAGE_ALARM_WEBHOOK`** in the existing
  `Configuration` category — 47 → **48** actions, categories stay at **8**.
  Enforced on create, update, delete and test-fire. Disabling a target silences
  a plant-floor buzzer; that is a signed act, not a preference toggle.
- **New audit actions and templates** for create / update / delete / test:
  93 → **97** actions, 87 → **91** templates, 7 categories unchanged. An audit
  template is **two** edits — the template in
  `packages/shared/src/types/audit-templates.ts` **and** the substitution in
  `apps/web/src/routes/audit/audit-helpers.ts` — or the placeholder renders
  literally in the exported §11 record. `template-placeholders.test.ts` catches
  a miss.
- Any free-text `reason` on delete is **exempt from `sanitizeStrings`**, read
  through the same exempted helper the attribute routes use, and passed
  explicitly as `sanitizeStrings(body, ['reason'])` so the exemption is stated
  rather than achieved by reading around the sanitiser.
- Audit sentences must clamp interpolated free text: `audit_trail
  .signature_meaning` is `VarChar(255)` and the overflow throws **inside**
  `auditLog`, after the action it describes has committed — leaving a regulated
  change with no audit row. Target names go through a `codeLabel()`-style
  truncation in the sentence only; the full value goes to the before/after JSON.

## Outbound-request stance

The server POSTs to an operator-typed URL. That is SSRF-shaped by construction
and cannot be avoided — a hooter is on the operator's LAN and any allowlist
would have to contain it.

No allowlist is built. The guards are:

- a hard per-request timeout (`timeoutMs`, default 5s);
- `redirect: 'error'` — a hooter does not redirect, and following one is how an
  internal-IP POST becomes an external one;
- no cookies, no credentials, no session token forwarded — headers are only
  what the operator typed;
- the exact URL, body, status and response snippet recorded in the delivery log
  for every attempt.

Stated so the decision is on the record, not so it can be revisited quietly.

## Surface

New API module `alarm-webhooks` (23 → **24** modules):

```
GET    /api/alarm-webhooks                 list targets (+ resolved instrument count)
POST   /api/alarm-webhooks                 create        (reauth + audit)
GET    /api/alarm-webhooks/:id             one target
PUT    /api/alarm-webhooks/:id             update        (reauth + audit)
DELETE /api/alarm-webhooks/:id             delete        (reauth + audit; refused
                                                          while deliveries exist)
POST   /api/alarm-webhooks/:id/test        test fire     (reauth + audit)
GET    /api/alarm-webhooks/:id/deliveries  paged delivery log
```

The module is registered in **both** `apps/api/src/app.ts` **and**
`apps/api/src/e2e/test-helper.ts` in the same commit. A module registered only
in `app.ts` 404s on every request in every e2e test, and two modules have
already shipped here with HTTP-level coverage that could not be written.

Every field returned must be declared in the Fastify `response` schema in the
**same edit** that adds it to the payload. Fastify silently strips what it does
not declare — no error, no warning, and the server-side test still passes
because the value was there before serialisation. This has bitten twice.

New page `apps/web/src/routes/config/alarm-webhooks.tsx` (24 → **25** config
pages; 49 → **50** routes in `main.tsx`), with a card registered in
`config/index.tsx`. It carries:

- the target form — name, URL, method, headers, content type, body template
  with a placeholder picker rendered from `ALARM_WEBHOOK_VARIABLES`, success
  regex, timeout, cooldown, severities, the three `fireOn*` switches;
- a scope picker reusing the functional-location tree widget from Instrument
  Scope, plus an explicit instrument multi-select, showing the resolved
  instrument count live;
- **Send test** — fires a synthetic payload and shows the raw status and
  response body. This is the only way to commission a hooter without waiting
  for a real excursion. It makes a real buzzer sound, so it is audited;
- a delivery log tab, filterable by status.

UI copy at label density — labels and values, no helper paragraphs. The one
sentence that stays is the audit notice on the test button, because it is
load-bearing for a compliance control.

## What this is not

- **It annunciates; it does not latch.** One POST per event. If a hooter needs a
  continuous "still ringing" heartbeat rather than an edge trigger, that is a
  repeat-while-active timer and a different design.
- **Acknowledged is not cleared.** Acknowledging silences the buzzer while the
  instrument may still be out of limit. That is what was asked for, and it is
  also the failure mode where someone silences a hooter and walks away — the
  alarm row still reads ACTIVE and the alarms page still shows it.
- **No inbound channel.** The hooter is not polled and does not report back.
  Success is what the HTTP response said at the moment of sending, and nothing
  more is claimed.

## Testing

Unit (`packages/shared` and `apps/api`):

- scope resolution — instrument-only, location-only, Block expanding to Areas,
  union, unassigned instrument, `[]`/`[]` ⇒ zero matches;
- `renderWebhookBody` — JSON escaping of `"`, `&`, `<`, backslash and newline;
  the `Chiller "A" & B` case; non-JSON content type inserts raw; unknown
  placeholder stays literal;
- severity narrowing, `fireOn*` gating, cooldown;
- success decision — 2xx alone, regex authoritative, 200-with-failure-body;
- `ALARM_WEBHOOK_VARIABLES` matches what the builder produces.

E2E over `app.inject`: CRUD, reauth enforcement, audit rows written, response
schema completeness, delete refused while deliveries exist, `/test` writes a
`TEST` delivery row.

Delivery worker tested against a throwaway local HTTP listener — 2xx, 500,
200-with-failure-body, timeout, connection refused — asserting the delivery
rows, not the function's return value.

Suites are run **per package**, individually, with
`--pool=forks --poolOptions.forks.singleFork=true`. A combined invocation across
packages manufactures ~129 false failures from e2e database contention and will
tempt someone into "fixing" green code. Known-failing baseline is **zero**.

`npx tsc --noEmit` for `apps/api` and `apps/web` separately — vitest runs
through esbuild and never typechecks.

## Migration mechanics

- Author the migration by hand. `prisma migrate diff` in this repo emits three
  destructive statements that must be stripped every time: `DROP TABLE
  instrument_telemetry_history` (Prisma cannot express `PARTITION BY`), `ALTER
  audit_trail.chain_position DROP NOT NULL` (the §11 hash-chain position), and a
  needless drop/recreate of the `instrument_credentials` FK. The header of
  `20260811120000_instrument_floorplans/migration.sql` lists all three.
- Apply to **`compliance_core_db` and `compliance_core_db_test`**. They are
  migrated separately; a migration applied to only one makes every
  instrument-touching e2e 500 in a way that looks like new code is broken.
- Stop the API before `prisma generate` — `tsx watch` holds
  `query_engine-windows.dll.node` open, the copy EPERMs, and a stale client
  hides real type errors.
- Run the drift guard as `powershell -NoProfile -ExecutionPolicy Bypass -File
  scripts/verify-migrations.ps1`.

## Verification limits

**The UI cannot be verified by the implementing agent.** Playwright's browser in
this repo does not trust the mkcert API certificate for cross-origin XHR, so the
SPA never gets past `/login`. Everything beneath the UI is verified — endpoints,
unit and e2e tests, typecheck, `vite build` — and the visual check is handed to
the operator with the exact URL and a list of what to look at, stated plainly as
"I have not seen this render".

The end-to-end proof that the hooter actually buzzes requires the physical
device on the operator's network and belongs to them.

## Count changes

| | before | after |
|---|---|---|
| Prisma models | 34 | 36 |
| Prisma enums | 13 | **13** (deliberate — validated strings) |
| Permissions | 42 | **42** (reused) |
| Reauth actions / categories | 47 / 8 | 48 / **8** |
| Audit actions / templates | 93 / 87 | 97 / 91 |
| API modules | 23 | 24 |
| Config defs | 25 | **25** (no dynamic def; a real CRUD module) |
| Config pages | 24 | 25 |
| Frontend routes | 49 | 50 |
| Worker tasks | 5 | 6 |
| Sidebar items | 12 | **12** |

Every one of these is re-derived with the command beside it in `CLAUDE.md` at
the moment the docs are touched, not copied from this table. The table records
intent; the greps record fact.
