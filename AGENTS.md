# AGENTS.md

## Project overview
ChessReps is a personal offline-first chess trainer. It reuses Lichess libraries (chessground, chessops) and CC0 Lichess puzzle content, owns its training-service boundary, and uses the extracted/local-adapter path (ADR-005).

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
