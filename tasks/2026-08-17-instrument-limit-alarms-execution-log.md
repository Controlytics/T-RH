# SDD ledger — plan: docs/superpowers/plans/2026-08-17-instrument-limit-alarms.md

Branch: data-injection
Start: ab91af0

Task 1: implementer DONE (commit d6982f4, 13/13 + 361/361 shared, tsc 0)
Task 1: complete (commits 276f694..d6982f4, review clean — spec OK, quality approved)
Task 2: implementer DONE (commit 8ca66b3, tsc api+web clean, 10 keys observed seeded)
Task 2: complete (commits d6d0b59..8ca66b3, review clean — spec OK, quality approved, 10 keys verified in DB)
Task 3: implementer DONE_WITH_CONCERNS (commit 215ce82; both DBs migrated, drift guard PASS, tsc clean; +1 out-of-scope worker narrowing at alarm-evaluation.worker.ts:92)
Task 3: concerns 2/3/4 (routes.ts ruleId schema, ruleSnapshot content, enum count 13) are ALREADY covered by Tasks 6/5/9 respectively — no plan gap
Task 3: complete (commits 8ca66b3..215ce82, review clean — spec OK, quality approved)
Task 3: review findings were all against the PLAN not the code — Important 1 (early return) + Important 2 (ruleSnapshot payload) already covered by Task 5 brief; Minor 3 (source:'RULE' hardening + instrumentsEvaluated) folded into Task 5; Minor 4 (routes.ts alarmProps) owned by Task 6; Minor 5 (stale enum/doc counts) owned by Task 9
Task 3: minor (deferred): no CHECK constraint ties source to rule_id/limit_kind at the DB level — worker query hardening chosen instead
Task 4: implementer DONE_WITH_CONCERNS (commit 5d9d8e7, 10/10 tests, tsc clean)
Task 4: plan errata — brief said "11 tests", the brief's own file has 10. Plan text wrong, not the work.
Task 4: review spec OK, quality approved with 1 Important (NaN self-defense in checkPair) -> fix loop
Task 4: RULING on plan conflict — brief's code gives `!== null`; plan Global Constraints require matching decide.ts's missing-value treatment. Constraints outrank example code, so the guard is added. Recorded rather than silently deviating.
Task 4: fix round 1/5 dispatched (Number.isFinite guard + 1 covering test)
Task 4: fix round 1/5 (1 addressed, 0 open — Number.isFinite guard verified by reverting and re-running; commits 5d9d8e7..adb8801)
Task 4: complete (commits a1c1326..adb8801, review clean after 1 fix round)
Task 4: minor (deferred): the non-finite test discriminates only via the Infinity/HIGH half; NaN passes pre-fix too, and -Infinity/LOW is unasserted. Implementation guards both bounds through the shared `v`, so no live bug — but a regression breaking only the LOW guard would slip past.
Task 5: implementer DONE_WITH_CONCERNS (commit d20cafc). Proved empirically vs live DB with alarm_rules EMPTY: raised 1, no duplicate on re-run, cleared with cleared_value, acknowledged_at untouched, instrumentsEvaluated=21.
Task 5: LIVE SIDE EFFECT — dev cron raised a GENUINE alarm on real instrument CWH-02 (TEMPERATURE LOW, 22.1 vs attribute 'Low Temperature'=25), id c5f0cc1f-1302-4f22-9916-341944752137. Left in place deliberately; surfaced to operator for their decision.
Task 5: fix round 1/5 dispatched — dead probe must not CLEAR a live excursion (null reading was writing state=CLEARED, cleared_value NULL: a false 'excursion ended' in a regulated record).
Task 5: DEFERRED by controller ruling — alarm can stay ACTIVE forever if the limit attribute is renamed/deleted/inverted while open. Auto-clearing on a config change would erase excursion evidence; a stale row an operator can acknowledge is the lesser harm.
Task 5: PRE-EXISTING DEFECT recorded for final review — decide.ts:83-88 clears RULE alarms on a null reading too (same dead-probe bug). Out of this plan's scope; NOT fixed.
Task 5: fix round 1/5 (1 addressed, 0 open — dead-probe hold; verified discriminating by removing the fix line -> 2 failures; commits d20cafc..9e1a5c7)
Task 5: review spec OK, quality Approved with 3 Important + 4 Minor
Task 5: fix round 2/5 dispatched — (1) partial unique index + P2002 catch to make duplicate ACTIVE alarms impossible (loser of the race is otherwise un-clearable forever); (2) test cleanup sweep scoped to its own instrument; (3) typed bound lookup instead of string concat + cast; (4) log instrumentsEvaluated
Task 5: minor (deferred): stale telemetry means the COMMON dead-probe case (stale-but-present breaching value) is unverified; limit pass ignores row.reporting, so a decommissioned instrument can raise an unclearable alarm — parity with rule pass, operator decision
Task 5: minor (deferred): loadLimitConfig() untested despite being the feature master switch; fails OPEN if stored value is string "false" (theoretical — def declares boolean)
Task 5: minor (deferred): limit snapshot omits the attribute's RAW string value and severity (Alarm.severity carries it, record still complete)
Task 5: OPEN QUESTION for operator — no surface exists to retire a stranded ACTIVE alarm; acknowledging does not clear it
Task 5: fix round 2/5 (4 addressed, 0 open — partial unique index verified in both DBs; race REPRODUCED: 3 concurrent evaluateAlarms -> 2 caught P2002 + exactly 1 row; commits 9e1a5c7..f8a94c3)
Task 5: complete (commits 7b97c79..f8a94c3, review clean after 2 fix rounds)
Task 5: DOC DEFECT for Task 9 — apps/api/CLAUDE.md:48 claims the baseline carries a partial unique index schema.prisma cannot express. It does not (grep=0, pg_indexes=none). I repeated that claim as precedent in a dispatch; the implementer disproved it. alarms_active_instrument_limit_unique is the FIRST such index in this repo.
Task 5: minor (deferred): Prisma prints caught P2002s to stderr, so each lost race logs what looks like an unhandled error above the real one-line warning. Fix needs global PrismaClient log config.
Task 6: implementer DONE (commit 4fcc23e; instrumentsWithoutLimits=17 matches my independent SQL; CWH-02 alarm serialises with all 4 fields; 74/74 alarms tests; tsc clean)
Task 6: review spec OK, quality Approved with 2 Important (enabled ignored in /summary; scoped visibility unexercised) + 1 Minor (sequential round trips)
Task 6: RULING — do NOT fold "disabled" into instrumentsWithoutLimits. Add a separate limitAlarmsEnabled flag; reporting all instruments as unwatched would send the operator to set limits when the fix is a switch. Task 7 brief patched to render both states.
Task 6: fix round 1/5 dispatched
Task 6: fix round 1/5 (3 addressed, 0 open — limitAlarmsEnabled in SCHEMA+handler; scoped visibility PROVEN (scope []->0 not 17, [Module-E]->1/CWH-03, both corroborated by independent SQL); queries batched; commits 4fcc23e..ce9dac7)
Task 6: complete (commits 9e42fd7..ce9dac7, review clean after 1 fix round)
Task 6: NO DRIFT on role_configs.VIEWER.instrument_scope — my pre-run baseline query showed it was ALREADY jsonb 'null' (matched IS NOT NULL), so the restore is faithful. Left as found; not "corrected" to SQL NULL on the operator's dev DB.
Task 6: minor (deferred) for final review: apps/api/scripts/probe-visibility.ts:17,46 writes a null scope as `null as never` (JsonNull) rather than Prisma.DbNull, which CLAUDE.md requires. Latent trap — any script templated on it inherits the wrong form. Operator tooling, not touched by this plan.
Task 6: minor (deferred): only an AREA (leaf) scope was exercised end-to-end through /summary; the Block->Area expandScope path via that endpoint is unexercised (expandScope has its own unit tests).
Task 7: implementer DONE (commit ae11112; 665/665 web tests, tsc+vite build clean, live API field shapes confirmed; UI NOT visually verified — browser blocked)
Task 7: review spec OK, 3 Important — all BRIEF defects, not implementer error
Task 7: (B2) MY JSX dropped the Severity column, leaving severity encoded as pill COLOUR only. apps/web/CLAUDE.md: "status colour never carries meaning alone (always a glyph + word)". Regression on a safety field the operator never asked to remove. RULING: restore as its own column, 10 -> 11 cols.
Task 7: (B3) limitText renders em-dash for every RULE alarm — their snapshot has thresholdLow/High/comparison, not `limit`. The existing test only passed an empty snapshot, which is why it survived. Fix + tests built from decide.ts's REAL snapshot shape.
Task 7: (B1) stale subtitle claiming alarms come from rules.
Task 7: fix round 1/5 dispatched
Task 7: fix round 1/5 (3 addressed, 0 open — subtitle, Severity column restored w/ word+colour at 11 cols, limitText RULE fallback with fixtures mirroring decide.ts's real producer; commits ae11112..aefc8fc)
Task 7: complete (commits ce9dac7..aefc8fc, review clean after 1 fix round; 669/669 web tests)
Task 8: implementer DONE (commits b1c46d0, a8ba2fd; 4/4 e2e, tsc clean). Self-caught a TAUTOLOGY in the frozen-limit test — original changed the attribute then read the API with no evaluation pass between, so "unchanged" was guaranteed. Strengthened to run a real evaluateAlarms() against the changed limit first.
Task 8: minor (deferred): evaluateAlarms() is estate-wide, so this file can raise a real alarm on ANOTHER agent's concurrent fixture; Alarm.instrumentId is onDelete:Restrict so their teardown could then fail. Narrow (needs a breaching limit-carrying fixture concurrently) and not fixable from inside this file.
Task 8: review spec OK, quality Approved with 1 Important — the frozen-limit test STILL does not exercise the freeze. Test 3 clears the alarm first, so test 4's pass finds a CLEARED row: neither the raise branch (needs !existingId on ACTIVE) nor the clear branch (needs existingId) fires. It proves "a no-op pass doesn't corrupt a cleared row", not "an OPEN alarm's snapshot survives a mid-excursion limit change" — the actual 21 CFR question.
Task 8: fix round 1/5 dispatched — add a still-ACTIVE freeze test + prove it discriminates by mutation + correct the overstated report claim
Task 8: minor (deferred): test 2 cannot distinguish the in-memory openMap guard from the DB partial unique index; both defend the same invariant (defence in depth), so it verifies the requirement but not either mechanism in isolation
Task 8: informational: loginAs(app) uses the shared admin rather than a per-file user, consistent with both sibling alarm e2e files though against current CLAUDE.md guidance
Task 8: fix round 2/5 (1 addressed, 0 open — still-ACTIVE freeze test hits the genuine no-op branch; mutation proof traced independently and the 3 cascading failures resolve to one root cause; commits a8ba2fd..89926e7)
Task 8: complete (commits aefc8fc..89926e7, review clean after 2 fix rounds; 5/5 e2e)
Task 8: CONTROLLER ERROR corrected by implementer — I instructed a limit change to 99, which makes the reading non-breaching and routes into the CLEAR branch, contradicting the "still ACTIVE" assertion in the same instruction. 25->20 was the only substitution reaching the untested no-op branch.
Task 9: complete (commit 14499f6; all 6 counts re-derived independently and matched; both doc defects fixed; sweep also caught 2 stale files in docs/recreation/ + a stale page count in root CLAUDE.md)

=== FINAL WHOLE-BRANCH REVIEW (opus) ===
Verdict: SAFE TO MERGE, no must-fix. Traced a real excursion through every layer against the live CWH-02 row; §11 properties verified by write-site sweep (4 production write sites, none rewrites ruleSnapshot, none touches ack fields outside the acknowledge route, no delete path); rule subsystem not degraded.
Scope caveats stated: the e2e file was NOT executed (estate-wide evaluator on a shared test DB with other agents live), and the UI is NOT visually verified.
FIX WAVE dispatched (one wave, per skill): (A) status texts unreachable for non-SUPER_ADMIN — requiredRole gates the READ and requireRole is exact-match, so every non-SA operator 403s and gets 3 console errors per page load; fix = narrow authenticated /status-texts route exposing ONLY the four strings. (B) worker clear branch guards `=== null` while limit-decide.ts:58 guards finite — unreachable today, but disagreeing predicates are how a NaN eventually writes a false CLEARED. (C) cleared notification describes the LIVE limit, not the frozen one.
REVIEWER CORRECTED MY FRAMING on 2 of the 3 items I escalated: stranded alarms SELF-HEAL when the attribute is restored, and the amber no-limits banner IS the surface for an inverted pair; the decommissioned-instrument case is subsystem-wide (both passes ignore isActive), not introduced here.
SHOULD-FIX-SOON (operator decision, NOT in this branch): decide.ts:83-88 rule-path dead-probe — after this branch the two paths write CONTRADICTORY records for one physical event; and probe-visibility.ts JsonNull-vs-DbNull.
FIX WAVE: first implementer DIED on a network error (ENOTFOUND) with all work UNCOMMITTED and NO verification run.
FIX WAVE BUG found by controller inspection before committing: the new route returns statusActiveUnack/... while AlarmStatusTexts uses activeUnack/... — the page typed the SWR response as AlarmStatusTexts, so every lookup would be undefined and statusText() would fall back to defaults. The fix would have silently NOT worked, relocating the bug from a 403 to a key mismatch. tsc cannot catch it (SWR generic is an unchecked assertion).
FIX WAVE: second implementer dispatched to fix the mismatch, add a test covering the BOUNDARY (not just statusText), and verify the dead agent's unchecked work — especially whether the new route actually requires auth.
FIX WAVE auth question RESOLVED by controller: plugins/auth.ts:222 is a GLOBAL onRequest hook with an explicit PUBLIC_PATHS/PUBLIC_GET_PATHS allow-list. /api/config/alarm-limits/status-texts is NOT on it, so the new route requires a bearer token despite declaring no preHandler — same as the sibling report-page-titles/current. Correctly gated.
FIX WAVE re-review: all 4 findings ADDRESSED, no new Critical/Important. Mapping test mutation-verified (mis-wired mapper -> 1 failed); auth posture proved empirically (no-token + garbage-token both 401).
ACCURACY CORRECTION: committed code at ae11112 ALREADY mapped status*->unprefixed via asText(). The key mismatch existed ONLY in the dead implementer's uncommitted work. In committed history, findings 1 and A are ONE defect (non-SA 403 -> silent fallback), not two.
PARKED (no second fix wave, per process): (1) alarm-display.ts:120 cites a non-existent test file — the test is in __tests__/alarm-display.test.ts. (2) alarm-limit-hold.test.ts EXECUTES the frozen-description branch but asserts only clearedValue/clearedAt, so a regression to describeLimit(check) would stay green. (3) The API<->display key contract is locked across two files by convention, not construction.
SAMPLE DISCLOSURE: the re-reviewer ran 5 e2e files, not the full suite (~30 files unrun), per the shared-test-DB constraint. Residual risk from the shared-harness change on unrun files is accepted on grep evidence.
