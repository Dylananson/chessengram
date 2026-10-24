# AGENTS.md

## Project overview
ChessEngram is a personal offline-first chess trainer. It reuses Lichess libraries (chessground, chessops) and CC0 Lichess puzzle content, owns its training-service boundary, and uses the extracted/local-adapter path (ADR-005).

## Conventions
- Source of truth: docs/PROJECT_PLAN.md
- Do not change stored program/collection IDs, IndexedDB DB name (`chessreps-player-spike`), or schema versions without explicit approval
- Export/import + migration policy must land before new persisted schemas
- Tests: `npm test`, `npm run typecheck`, `npm run build` must pass at repo root; user-visible changes require `npm run smoke`

## Key paths
- `apps/web/` — Vite app
- `packages/contracts/` — TrainingService boundary
- `packages/scheduler/` — pure scheduler
- `docs/tasks/` — task conventions and backlog
- `tools/puzzles/` — content tooling

## Agent rules
- Never commit/push unless requested
- Prefer small, focused changes
- Keep data continuity and no silent data loss
- Shared interfaces get single owner
- Always separate recommendations from confirmed decisions
- Update docs when adding tasks

## Git workflow (trunk-based)
- `main` is the trunk and the base branch for all work. Start each change from the latest `origin/main` on a short-lived feature or fix branch; never work directly on `main`.
- Keep changes in small, focused chunks, normally one issue or logical change per branch and PR.
- Push topic branches and raise PRs targeting `main`; do not push commits directly to `main`. Follow the repository's PR checks and review process before merge.
- Commit and push only when requested or explicitly authorized. Do not merge PRs unless explicitly requested.

## Task system
- Locations: `docs/tasks/README.md` (execution conventions), `docs/tasks/BACKLOG.md` (tracked work + checkboxes), `docs/tasks/GRAPH.md` (dependency graph, path ownership, loop/round log), `docs/research/*` (spike/audit notes). Epic plans live in `~/.opencode/plan/`.
- Task IDs: `T*` (original plan), `UX-*` (user-facing gaps), `AN-*` (analysis/review), `F*` (future), `B*` (loop batches), `S*`/`UI-001` (epics + subtasks), `STY-*`/`REL-*`/`REV-*` (follow-ups). Statuses: Proposed → Ready → In progress → In review → Done, plus Blocked with an explicit cause/owner.
- Checkbox ticks only after the coordinator verifies acceptance (gates green); agents report results, never tick.
- Autonomous loop: a task is Ready when deps are Done AND its `Owns` paths touch no other running task. Rounds run all Ready tasks in parallel, then the coordinator verifies combined (`npm test`, `npm run typecheck`, `npm run build`, `npm run smoke` for user-visible changes), commits if green, updates GRAPH.md, and starts the next round. Stop at user-gated items (needs-device, needs-decision, plan wording).
- Migration discipline: preserve every control `id`, `data-*` hook, and class that smoke/CSS/tests depend on — audit before finishing. Behavior-neutral rounds stay behavior-neutral; missing shared helpers become named follow-ups, never drive-by edits to shared files. Concurrent agents never share a file.
- Provenance: third-party ideas/patterns are free; verbatim-adapted lines keep their upstream notice + SHA + `THIRD-PARTY-NOTICE.md` entry. Default to clean-room.
- `docs/PROJECT_PLAN.md` wording is coordinator-owned; agents never edit it.
