# Agent execution conventions

Source of truth: ../PROJECT_PLAN.md. Only the coordinator edits its status, decisions and graph.

## Current phase: product build-out (PB0–PB7)

The architecture decision (ADR-005) is made: extract/reuse, no Lila fork. PB0–PB6
code is done (PWA offline boot verified headlessly); T11 real-device pass remains.
Work now converges on release readiness before new features. See the
"Product build-out" table in ../PROJECT_PLAN.md for scope and status.

## Next focus (user reprioritized 2026-10-16 — see BACKLOG.md)

Proposed build order, highest value first; `PROJECT_PLAN.md` status stays
coordinator-owned:
1. UX-001 queue dead-ends (P0 release blocker).
2. UX-002/UX-003 Progress + History (replace stubs, D09 visibility).
3. T13-followup Collections scope confirmation (T13 marked Done but screen is a stub).
4. AN-001a attempt review (no engine) if wanted pre-T16.
5. **F01 Woodpecker** fixed-set cycles + separate spaced review for failures (design first; see `research/woodpecker-mode.md`).
6. Continue feature work (F03 openings, F05 content, then evaluate F02 schedulers/F04 sync) before release sign-off. T11/T15 real-device checks and T16 are deferred by the user; T07/T09 online and AN-001b Stockfish remain deferred.

| Phase | Scope | Allowed output paths | Depends |
|---|---|---|---|
| PB0 | Rename to `apps/web`; neutralize strings | apps/web/**, docs/** | — |
| PB1 | Monorepo hygiene (workspaces, imports, CSS) | package.json, packages/*/package.json, apps/web/** | PB0 |
| PB2 | App shell + screens; fix spoiler/Skip/counts | apps/web/src/**, apps/web/index.html | PB1 |
| PB3 | Puzzles screen: upload, creator, CSV, PGN | apps/web/src/**, apps/web/tests/** | PB2 |
| PB4 | Settings screen + persisted settings store | apps/web/src/**, apps/web/tests/** | PB3, PB5 |
| PB5 | Data safety: export/import + migration policy | apps/web/src/**, apps/web/tests/** | PB2 |
| PB6 | PWA (manifest + service worker); offline verification | apps/web/**, docs/** | PB4 |
| PB7 | Stockfish analysis + attempt review | apps/web/**, docs/** | PB6 |

Research scratch work can use /tmp/opencode with distinct task directories. Inspect before
overwriting. Prefer pinned upstream revisions.

## Constraints

- **Data continuity:** do not casually change stored program/collection IDs, the IndexedDB
  database name (`chessreps-player-spike`, intentionally retained) or storage schema versions.
- **No silent data loss:** export/import + migration policy (Q12) must land before the first new
  persisted schema (settings). Recorded-record version mismatches must surface, not drop silently.
- **Verification each phase:** `npm test`, `npm run typecheck`, `npm run build` (from repo root)
  must pass; user-visible phases also get a device/browser check. User-visible phases run
  `npm run smoke` (`apps/web/scripts/smoke.mjs`): `puppeteer-core` + system Chromium against
  `vite preview`, verifying boot without console errors, all five nav screens, queue counts,
  board mount, no-solution-spoiler, Reveal and Skip, and screen round-trips. Set `CHROMIUM_PATH`
  if Chromium is not on PATH.
- No commits/pushes unless requested by the coordinator/user.

## Completed research and evidence tasks

T01–T06, T08, T10 and the T05 baseline are Done with coordinator verification (see the task board).
Recovered agent session references for the original research wave:

- T01: `ses_ee253534afferV4r4s8f3clHwU`
- T02: `ses_ee253532bffesaiNNRTlw7zrZR`
- T03: `ses_ee2535319ffeYdAUdQT1FpIr8i`

## Required handoff

1. Task/phase ID and completed acceptance criteria.
2. Paths created/changed.
3. Sources/revisions examined.
4. Verification commands and actual results.
5. Blockers, limitations and unresolved questions.
6. Recommendations clearly separated from confirmed decisions.

Statuses: Not started, In progress, In review, Done, Blocked. Checkbox ticks only after
coordinator verifies acceptance. Shared interfaces get a single owner and a reviewed version
before parallel implementation.

## See also
- [Project plan](../PROJECT_PLAN.md) — source of truth
- [Backlog](./BACKLOG.md) — tasks to be done later (gaps and deferred items)
