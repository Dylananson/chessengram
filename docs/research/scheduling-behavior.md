# T03 — Anki-inspired scheduling behavior

Status: **Accepted as research/design** by coordinator on 2026-10-09 for T04/T06. Numeric defaults remain proposals, not approved product decisions. Original handoff references to review below describe the agent's submission state.

## 1. Authority and scope

Confirmed by `docs/PROJECT_PLAN.md`: correctness precedes time (D05); the first wrong solution move fails the scored attempt while correction remains possible (D06); failure policy is configurable between retry/relearning and step-back (D07); borrow Anki queue concepts (D08); keep interchangeable components and raw history (D09). Reloads and repeated submissions cannot apply scheduling twice.

**Every numeric default and detailed policy below is a recommendation, not a user decision.** The proposed `ladder-v1` is neither Anki's exact implementation nor SM-2 nor FSRS. It is a small, replaceable baseline for validating the player/service/offline boundary. Its intervals are candidate product settings, not empirically validated chess-memory intervals.

## 2. Primary-source research

Sources were fetched and read on 2026-10-09. These are live official Anki documentation pages, not a pinned source-code revision. Section links identify the claims examined.

| Ref | Source and relevant sections |
|---|---|
| A1 | [Studying](https://docs.ankiweb.net/studying.html): Answer Buttons, Fuzz Factor, Display Order, Falling Behind |
| A2 | [Deck Options — Learning Steps](https://docs.ankiweb.net/deck-options.html#learning-steps), Day Boundaries, Graduating Interval |
| A3 | [Deck Options — Lapses](https://docs.ankiweb.net/deck-options.html#lapses), Relearning Steps, Minimum Interval; [New Interval](https://docs.ankiweb.net/deck-options.html#new-interval) |
| A4 | [Deck Options — Display Order](https://docs.ankiweb.net/deck-options.html#display-order), Review Sort Order, Burying; [Daily Limits](https://docs.ankiweb.net/deck-options.html#daily-limits) |
| A5 | [Deck Options — FSRS](https://docs.ankiweb.net/deck-options.html#fsrs), Desired Retention, Learning and Relearning Steps, Reschedule Cards on Change |
| A6 | [What spaced repetition algorithm does Anki use?](https://docs.ankiweb.net/faqs/what-spaced-repetition-algorithm): SM-2, FSRS, Learning/Relearning Cards, Review Cards, Limitations |
| A7 | [Due times after a break](https://docs.ankiweb.net/faqs/due-times-after-a-break) |
| A8 | [Deck Options — Timers](https://docs.ankiweb.net/deck-options.html#timers), Presets, Advanced |

### Documented behavior and algorithm boundaries

| Topic | Anki documentation finding | Implication for ChessReps |
|---|---|---|
| Grading | Again is failure; Hard is **successful** recall with difficulty, not partial failure. Again/Good alone are supported (A1, A5). | Binary fail/clean-success is a sensible initial interpretation. A wrong move cannot become Hard because correction was quick. |
| Learning | With explicit steps, Again returns to the first step, Good advances and finally graduates, Easy graduates immediately. With `1m 10m 1d`, a new-card Good schedules 10m; it does not require the initial 1m step first (A2). | Borrow explicit states and delayed retries, not all four buttons or their exact rules. |
| Lapse/relearning | Again on a Review card is a lapse and enters configured relearning. Further failures in learning/relearning do not further reduce legacy ease (A3, A6). | Distinguish failure count from Review-lapse count; repeated correction moves are neither new attempts nor new lapses. |
| Legacy long-term scheduling | Anki's modified SM-2 uses ease, starting at 2.5 by default. Review Again lowers ease by 0.20 and uses the New Interval multiplier; Hard lowers ease by 0.15; Good retains ease; Easy increases it by 0.15. Minimum ease is 1.30 (A6). New Interval defaults to 0, with a one-day minimum after relearning (A3). | Do not describe the proposed ladder as an ease-based algorithm. |
| FSRS long-term scheduling | FSRS models difficulty, stability and retrievability from review history, elapsed time and ratings; desired retention controls intervals. SM-2-specific options such as graduating interval and easy bonus are hidden (A5, A6). | Keep algorithm-specific state opaque/versioned; a ladder index is not FSRS stability. |
| FSRS short steps | Manual recommends few, same-day steps shorter than 1d. It also documents experimental short-term FSRS scheduling with empty (re)learning steps; Again may then yield a day or longer (A5). | Do not generalize A3's “empty steps → one day by default” to every FSRS version/configuration. |
| Queue ordering | Due intraday learning takes precedence over Review/New; learning is collected across decks in due order. Interday learning placement and new/review mixing are configurable. Default Review order is due date then random (A1, A2, A4). | Separate due eligibility and queue selection from interval calculation. Gathering order used for sibling burying is not a universal display order. |
| Early learning | If nothing else remains, Anki defaults to showing learning up to 20 minutes early. Small steps crossing its study-day boundary convert to day-based scheduling (A2). | Explicitly choose whether to emulate this; proposal below does not. |
| Overdue | Anki retains progress and considers late successful recall. The legacy examples use no lateness credit for Hard, half for Good, all for Easy before multipliers (A6, A7). FSRS instead incorporates elapsed time into its memory model (A6). | A7's arithmetic is legacy guidance, **not an FSRS formula**. No automatic failure merely because a due date passes. |
| Backlog sorting | Legacy relative overdueness compares lateness with interval; FSRS offers ascending retrievability instead (A4). | Initial oldest-due ordering needs neither estimate. |
| Limits | New/day allowance does not accumulate after missed days. Review limits include interday learning; by default review limits also constrain New. Manual recommends stopping new cards while behind (A4). | Limit introductions, preserve pending work, and expose backlog explicitly. |
| Time/randomness | Anki records answer time for statistics (default cap 60s), but **time does not influence scheduling**. Anki also uses review fuzz and learning delay variation (A1, A8). | Chess timing adjustment is our adaptation. Proposed baseline has no fuzz and stores uncapped active time. |

### Research limits and source cross-checks

- Cross-checked A2/A3 with A6 for steps, graduation and lapses; A1 with A4 for queue ordering/backlog; A7 with A6 for legacy overdue arithmetic; A8 with A5 for timing versus FSRS settings.
- The old `faqs.ankiweb.net/what-spaced-repetition-algorithm.html` address returned a redirect page; the actual destination A6 was fetched and read.
- No Anki binary, scheduler source revision, client matrix or empirical chess study was examined. Documentation is version-sensitive and combines common UI concepts, legacy settings and newer FSRS features. Its simplified formulas omit implementation details such as rounding, fuzz and constraints; do not use them as a compatibility specification.
- A2 gives more precise first-step Hard behavior than A6's summary. A5 qualifies A3's empty-step behavior. This document uses those more specific sections rather than silently merging contradictory-looking summaries.
- No claim of optimal retention, exact Anki parity, or ready-made migration to FSRS follows from this research. Acceptance scenarios below are proposed test vectors, not executed application tests.

## 3. Replaceable components and minimum persisted facts

Recommended pipeline:

1. **Attempt interpreter** consumes validated solver moves/assistance and emits one immutable scored outcome.
2. **Timing policy** consumes raw active segments and validity flags, and returns a bounded factor only when eligible.
3. **Scheduler** is a deterministic function of previous schedule, scored outcome, explicit event time and frozen settings; returns a schedule transition.
4. **Selector** chooses an eligible schedule from the current program scope, limits and current time. Selection itself does not grade or advance it.

Persist enough to replace any component without destroying evidence:

- Stable puzzle/content revision, progress key, program/session ID, attempt ID, event IDs/sequence, source state and schedule revision.
- Original moves including wrong ones, assistance events, first-failure reason/time, eventual completion, abandonment, active/correction timing segments and timing-quality flags.
- Scored result and timestamp, interpreter/timing/scheduler IDs and versions, settings snapshot/hash, computed factor/base interval/final interval, previous and next schedule revisions.
- Schedule: `New | Learning | Review | Relearning`, `dueAt`, `rung` for Review, `returnRung` for Relearning, algorithm-specific payload, lapse count and introduction metadata.
- Session cursor and active-attempt reservation must survive reload. History is append-only evidence; current schedule is a derived projection. Never infer raw accuracy from the current schedule.

T04 owns types/storage and the progress-key scope (Q09). For now all transitions operate on one abstract progress key; overlapping collections must not accidentally grant multiple simultaneous scored attempts for that key.

## 4. Proposed candidate defaults and exact arithmetic

| Setting | Recommended initial value |
|---|---|
| Algorithm | `ladder-v1`, no randomness |
| Learning | One confirmation step, 10 minutes; failure retry 1 minute |
| Review ladder `L` | `[1, 3, 7, 14, 30, 60, 120, 240]` elapsed days, indexed 0–7 |
| Failure preset | `retry-reset`: 10-minute relearning, then Review rung 0 |
| Alternative preset | `step-back`: decrease Review rung by 1, no short relearning |
| New introductions | 10 per study day per configured program scope; no carryover |
| Review limit | Unlimited initially; an explicit session stop does not mark work done |
| Early review/look-ahead | Disabled; practice outside eligibility is unscored |
| Day definition | UTC instants for due times; configured IANA zone with midnight rollover for introduction counters |

`rung=i` means the most recently assigned **base** Review interval was `L[i]`, not the next interval to award. Graduation assigns rung 0. Clean Review success assigns `j=min(i+1,7)`. At rung 7 success stays there. Never multiply the prior adjusted interval: each result starts again from its ladder base, preventing timing effects from compounding.

### Small timing influence

Recommended eligibility: clean, unassisted, uninterrupted **Review-to-Review success** with trustworthy timing only. Learning graduation and relearning exit use exact base intervals to avoid rewarding immediate recognition. Failure never consults time. Paused/resumed clean success still advances normally, but gets a neutral factor.

Let `n` be the number of required solver moves in the accepted solution, excluding setup and opponent moves. Proposed target `T=max(30,15*n)` seconds. Let `t` be recorded active solving seconds. For eligible attempts:

```text
f = 1 + 0.10 * clamp((T - t) / T, -1, 1)
baseSeconds = L[j] * 86400
intervalSeconds = min(240 * 86400, floor(baseSeconds * f + 0.5))
dueAt = scoredAt + intervalSeconds
```

Otherwise `f=1`. Valid `t>=0`; missing/invalid timing or unknown `n` also yields `f=1` and a quality flag. Round once to the nearest second, halves upward. The factor is in `[0.90,1.10]`, but the absolute 240-day cap can truncate a positive adjustment. A slow correct solution remains success and advances one rung; speed cannot rescue failure or skip rungs. Raw time is never overwritten by the target or rounded interval.

This explicitly resolves “small adjustment” as ±10% of the **next base interval**, not a score bonus, extra rung, percent of the old due date, or per-move penalty. Target and bound need observation in T06/T08; no evidence here establishes them as optimal.

## 5. State/event transitions

`S` means a full clean solution; `F` means the first wrong legal solution move, or proposed pre-completion hint/reveal failure. `a` is the persisted scoring timestamp. Failure transitions occur immediately at first failure, while the same attempt remains in correction mode. All delays are measured from `a`, not eventual correction completion.

| Schedule before | Event | Schedule after | Due/progress effect |
|---|---|---|---|
| New | Start | New, reserved | Record introduction once; start from solver position; no schedule result yet |
| New | S | Learning | Confirmation due `a+10m` |
| New | F | Learning | Retry due `a+1m` |
| Learning | S | Review, rung 0 | Due `a+1d`, no timing factor |
| Learning | F | Learning | Retry due `a+1m`; no Review lapse |
| Review, rung i | S | Review, rung `min(i+1,7)` | Assign formula above |
| Review, rung i | F, retry-reset | Relearning, returnRung 0 | Due `a+10m`; increment lapse once |
| Relearning, returnRung k | S | Review, rung k | Due `a+L[k]`; no extra rung or timing factor |
| Relearning, returnRung k | F | Relearning, same k | Due `a+10m`; failure count increases, Review-lapse count does not |
| Review, rung i | F, step-back | Review, rung `max(0,i-1)` | Due `a+L[max(0,i-1)]`; increment lapse once; no timing factor |
| Any reserved state | Wrong move after first failure, or correction completed | Already-scheduled state unchanged | Append correction evidence only; no new scored outcome |
| Any reserved state | Pause/background/reload | Same state and reservation | Stop active segment; resume same attempt |
| Any reserved state | Explicit abandon before outcome | Same state, release reservation | Append unscored abandonment; preserve original due/progress |
| Any reserved state | Explicit abandon after F | Already-scheduled state, release reservation | Preserve failure and its schedule |
| Any | Duplicate event/result | Unchanged | Return prior receipt, no counters or interval applied again |
| Any | Time passes/due becomes overdue | Unchanged | Only eligibility changes; no synthetic failure |

Starting a due Learning/Review/Relearning attempt reserves the existing schedule without changing it. New S followed by Learning S therefore requires two separate scored attempts. A New F followed by Learning S also graduates: the failed attempt plus correction is not itself the confirmation success.

### Configurable failure presets

- **Recommended `retry-reset`:** Review failure assigns one short relearning step; its successful completion returns to rung 0. This borrows the legacy default reset idea while keeping our own explicit ladder.
- **Optional `retry-retain`:** Same relearning flow, but configure `returnRung=max(0,i-b)` at the Review failure, with integer `b>=0`. `b=0` retains prior base interval after relearning; `b=1` combines short retry with one-rung reduction. Store that return rung once; repeated relearning failures do not repeatedly step back.
- **Alternative `step-back`:** Configure integer `b>=1`; set rung `max(0,i-b)` immediately and schedule that base interval. At rung 0 this stays at one day, not New or a zero interval. No short scheduled retry; correction is still available immediately.
- New/Learning failures use the learning retry rule under every preset because they have no Review rung to reduce. In-flight Relearning keeps its captured policy until it exits; changing settings does not retroactively rewrite due dates or an open attempt. Preset changes apply to later attempts unless an explicit migration is approved.

## 6. Attempt integrity, correction and exactly-once effects

Exactly-once is a **durable effect guarantee**, not an assumption that clients deliver once:

1. Persist a stable attempt ID and starting schedule revision before scored interaction. Allow only one active scored attempt per progress key; a second tab resumes it or receives a conflict.
2. Durably journal move/assistance events in sequence with stable event IDs. The interpreter cannot finalize clean success while earlier events are missing. Wrong-move feedback should follow a recoverable local record so an offline reload cannot erase the failure.
3. At first F or final S, atomically persist the immutable outcome, schedule transition, counters and receipt, conditional on the expected revision. Enforce a unique scored outcome/transition for the attempt ID. Re-delivery returns that receipt. A conflicting outcome is rejected, not treated as a second review.
4. If atomic storage spans unavailable services, T04 must specify an equivalent durable journal/outbox and idempotent projection; a UI boolean is insufficient. A stale revision is a conflict to reconcile, not permission to silently recompute from a later schedule.
5. After F, keep the puzzle and attempt open for correction. Additional wrong moves, hints, or completion append evidence but cannot alter the scored failure or schedule. Only an explicit close/Next releases the reservation; proposed Next behavior remains a UI decision.
6. A scheduled retry starts a **new attempt ID from the original solver position**, even if the previous correction reached the end. Do not continue a partially corrected line as a successful retry.

Recommendation for assistance: hints or reveal before scoring emit F with an assistance reason; after failure they are correction events. A legal move rejected by the accepted solution fails; an illegal drag/drop does not count as a solution move (proposal, not confirmed). Alternative winning lines require T01/T08 validation policy. Assisted or abandoned attempts must remain identifiable in history for later algorithm evaluation.

## 7. Timing and interruptions

- Start active solving time only when content is loaded, setup is finished, the position is visible, and solver input is enabled. Use monotonic elapsed durations within each segment, not subtraction of wall-clock timestamps.
- Count visible thinking and solver interaction. Exclude initial loading, automatic opponent replies/animations, validation/network waits and any disabled-input period. Stop on final correct move or first failure. Record post-failure active time separately as correction time.
- Explicit pause, background/hidden tab, device lock or loss of usable presentation stops the segment. Resume at input readiness; any user interruption disables the timing modifier for that attempt. No inactivity timeout should automatically fail a hard puzzle; long visible thinking counts.
- Persist segments and lifecycle events. On crash/reload with an unclosed segment, preserve known durations, mark the remaining duration unknown, and use `f=1`. Do not count overnight wall time or invent a fast finish. Resuming after failure returns to correction with the failure intact.
- Leaving and returning retains the attempt. Explicit abandonment before any result is unscored, does not move due time, and does not refund a New introduction. Repeated skips may need later UX policy; they must not fabricate correct answers. Abandonment after failure cannot undo it.
- Due timestamps use the authoritative event clock supplied to the scheduler. T04 must resolve online/offline authority and clock-skew handling. Store client occurrence and server receipt separately; reconnect must not re-anchor a previously committed local interval to receipt time.

## 8. Queue, overdue and daily limits

Recommended selector, recomputed when requesting the next puzzle:

1. Resume the session's active attempt first. Never interrupt correction to serve its now-due retry; reservations exclude the same progress key from every other queue.
2. Among unreserved records in the selected program, serve due Learning/Relearning (`dueAt<=now`) by `(dueAt, progressKey)`.
3. Then serve due Review by `(dueAt, progressKey)` (oldest due first).
4. Then serve eligible New by stable collection/pack order and progress-key tie-breaker, subject to the daily allowance.
5. If nothing is eligible, show the next due instant. Do not pull a 10-minute retry forward just to fill the screen. Optional immediate practice must be explicitly unscored.

The selector has no interday-learning conversion: a 10-minute step at 23:55 is due at 00:05. Review days mean exactly 86,400 elapsed seconds, including across DST; study-day counters alone use local calendar boundaries. This deliberately differs from Anki's day-based handling. Deterministic ties replace Anki's random tie-breaking/fuzz for the initial POC.

**Overdue proposal:** preserve state/rung and serve once, not once per missed day. Next due time anchors to the new scored timestamp. No lateness bonus and no overdue penalty: a rung-2 success advances to rung 3 whether one hour or one month late. Late failure follows the selected preset normally. Store actual elapsed time and previous due time so a later FSRS adapter can use them. A pending Learning step survives days away and graduates after one clean retry; no phantom repeated steps.

**New limits:** count distinct first starts, atomically with the durable New reservation, not completions or retries. The same resumed/abandoned puzzle never consumes another introduction; use a separate `introducedAt` marker even if its schedule remains New until its first outcome. Such introduced-but-ungraded New records are resumed before fresh New introductions and do not consume today's allowance. They remain behind due work. Ten first starts exhaust the proposed allowance; unused allowance does not accumulate. Reset counters by configured study-day key, not every session launch.

Due work has priority, so a backlog naturally prevents fresh introductions until due work is cleared. Learning/Relearning retries do not consume New allowance. Reaching a New limit does not block due Review or retries. No daily Review cap is proposed; a user may stop any session and leave due work outstanding. If a future cap is added, show deferred counts and define learning exemptions explicitly. Scope/time-zone changes must not reset counters opportunistically; T04 owns the scope and rollover migration rule.

## 9. Worked examples and acceptance scenarios

These use the proposed defaults, seconds-based intervals and an authoritative UTC clock. They are specifications for T04 fixtures/T06 tests, not reports of passing code.

Verification: a standalone `python -c` arithmetic check asserted the 14-day timing examples at 30/60/120 seconds as 1,270,080 / 1,209,600 / 1,088,640 seconds and the capped interval as 20,736,000 seconds. All assertions passed. This checks the example arithmetic only, not an implemented scheduler.

| ID | Given / events | Expected result |
|---|---|---|
| AC01 Acquisition | New clean completion 09:00; retry clean 09:10 | Learning due 09:10, then Review rung 0 due next day 09:10. Two scored attempts; no timing adjustment. |
| AC02 Failure survives correction | Review rung 3 wrong move 09:00; correct finish 09:04 | One failed outcome, one lapse, Relearning due 09:10 with return rung 0. Correction completion adds no scheduling effect. |
| AC03 Retry from scratch | AC02 closes; new attempt at 09:10 solves cleanly | Fresh starting position/ID; Review rung 0 due next day at retry completion time. Failure remains in history. |
| AC04 Repeated relearning failure | Relearning fails 09:12 then a later fresh attempt fails 09:23 | Due 09:22 then 09:33; return rung unchanged; two failures, no additional Review lapses. |
| AC05 Step-back | Review rung 3 (14d), `b=1`, fails at time a | Review rung 2 due a+7d, no short retry. At rung 0 failure schedules a+1d. |
| AC06 Retry-retain | Review rung 4, `b=1`, fails; relearning S at a | Return rung captured as 3; exits due a+14d, not a+30d. Relearning failures do not reduce it again. |
| AC07 Timing math | Review rung 2 succeeds; n=4 so T=60s | Next base 14d. t=30s gives f=1.05 and 14.7d (14d16h48m); t=60s gives 14d; t>=120s gives 12.6d (12d14h24m). All advance to rung 3. |
| AC08 Correctness/cap | Failure in 1s; separately clean rung-7 success with f=1.10 | Failure uses failure policy without timing. Top success stays rung 7 with 240d cap, never 264d. |
| AC09 No compounding | After AC07 fast result, next Review success at neutral time | Rung 4 base 30d, not 14.7 multiplied by a growth factor. |
| AC10 Duplicate/conflicting delivery | Resend AC02 failure; later submit completion as success under same ID | Return original failure receipt; no extra lapse/revision. Reject conflicting success; completion may be recorded only as correction. |
| AC11 Interrupted clean solve | 20s active, background 2h, resume 15s and solve | Record 35s active plus interruption; clean outcome, neutral f. Hidden time excluded. |
| AC12 Crash during correction | Failure committed, reload before correction completion | Resume same failed attempt/position; no second schedule effect. Unknown timing marked, not synthesized. |
| AC13 Abandonment | Unscored New first start then abandon; separately abandon after F | First has no schedule transition but keeps consumed introduction. Second retains failure and next due. |
| AC14 Overdue | Review rung 2 due Oct 1, clean S Oct 9 12:00 with neutral f | Rung 3 due Oct 23 12:00, no catch-up attempts or lapse. Late Learning S graduates to rung 0. |
| AC15 Ordering | Due retry 09:10, overdue Review 08:00, fresh New; now 09:11 | Retry first, then Review, then New. At 09:09 Review goes first because retry is not yet eligible. |
| AC16 Correction reservation | AC02 remains open until 09:20 | No concurrent retry at 09:10. After close, retry is overdue and eligible; its eventual success anchors its own next due. |
| AC17 Limits/rollover | Ten fresh starts today; due retry remains; unused quota yesterday | Retry eligible, eleventh fresh start blocked; yesterday contributes nothing. Tomorrow gets ten, while resumed starts consume none. |
| AC18 Boundary | Learning scheduled 23:55 +10m; clocks cross midnight | Due 00:05 exactly; midnight allowance reset does not alter step due time. DST does not alter elapsed intervals. |
| AC19 Assistance/invalid input | Illegal drag, then hint before any wrong solution move | Drag ignored for grading; hint emits assisted failure under proposed interpretation; no later clean-success override. |
| AC20 Concurrency/settings | Two tabs start same progress key; preset changes mid-attempt | Only one active ID accepted; frozen settings govern its outcome. Next eligible attempt can capture the new preset. |
| AC21 Reordered events | Final correct move arrives before an earlier wrong move | Do not finalize clean success with a sequence gap; replay yields one failure once the gap closes. |

## 10. Open decisions and handoff to T04

None of these recommendations upgrades Q04–Q07 or other proposals into confirmed decisions.

| Owner/gate | Decision still required |
|---|---|
| T04 / Q02 | Online versus local scheduling authority; atomic commit boundary; offline event journal, replay/conflict protocol, clock validation and outcome receipts. |
| T04 / Q09 | Shared versus collection-specific progress; progress-key uniqueness, active-attempt locking and New/day scope across overlapping collections. |
| T04 with T06 / Q04–Q05 | Accept/revise ladder, timing eligibility/target/bound, default retry-reset versus step-back, allowed preset parameters and maximum interval. |
| T04/T08 / Q06 | Pause visibility signals on phone/desktop, persistence cadence, crash timing uncertainty, explicit abandonment and Next UX. |
| T04/T08 / Q07–Q08 | Hint/reveal failure semantics, illegal drops, solution-validation alternatives; retain distinct reasons even if initially mapped to one failure outcome. |
| T04 | Stable event ordering, duplicate/conflicting payload response, abandoned-New ordering and study-day/time-zone changes; define schemas and fixtures before parallel adapters. |
| T04/T14 / Q12 | Algorithm/settings versioning, migration/replay and backup policy. Preserve history; do not silently reinterpret old attempts or rewrite due times when switching schedulers. |

**Handoff:** T03 covers primary-source comparison, explicit transitions, candidate intervals/math, failure presets, attempt/correction integrity, timing, queue/overdue/limits, and acceptance examples. Only `docs/research/scheduling-behavior.md` was created. Source cross-checks are recorded in §2; no application code or tests were run. No research blocker remains. Implementation decisions above require T04/coordinator review, and T01 remains an independent dependency for T04's player contracts. Master plan/status ownership remains with the coordinator.
