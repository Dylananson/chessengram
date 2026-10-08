# Agent execution conventions

Source of truth: ../PROJECT_PLAN.md. Only coordinator edits its status, decisions and graph.

## Current assignments

| Task | Owner | Allowed output paths | Dependencies |
|---|---|---|---|
| T01 | Lichess audit agent | docs/research/lichess-puzzle-dependencies.md | T00 |
| T02 | Puzzle data agent | tools/puzzles/**, data/puzzles/**, docs/research/puzzle-content-sources.md | T00 |
| T03 | Scheduling design agent | docs/research/scheduling-behavior.md | T00 |

Research scratch work can use /tmp/opencode with distinct task directories. Inspect before overwriting. Prefer pinned upstream revisions. No app framework scaffolding during these tasks.

All three initial assignments completed and were accepted by the coordinator on 2026-10-09. Research acceptance does not imply runtime verification or approval of proposed defaults. T02 tests (8) and pack verification were rerun successfully.

Next eligible wave: T04 contracts/schema design and T05 runnable baseline. Neither has started. Agent session references for continuation:

- T01: `ses_ee253534afferV4r4s8f3clHwU`
- T02: `ses_ee253532bffesaiNNRTlw7zrZR`
- T03: `ses_ee2535319ffeYdAUdQT1FpIr8i`

## Required handoff

1. Task ID and completed acceptance criteria.
2. Paths created/changed.
3. Sources/revisions examined.
4. Verification commands and actual results (research: source cross-checks).
5. Blockers, limitations and unresolved questions.
6. Recommendations clearly separated from confirmed decisions.

Statuses: Not started, In progress, In review, Done, Blocked. Checkbox ticks only after coordinator verifies acceptance. Shared interfaces get a single owner and a reviewed version before parallel implementation.
