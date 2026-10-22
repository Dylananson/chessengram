# ChessEngram

Personal chess trainer: spaced-repetition puzzle practice on phone and desktop, designed to
work offline, with interchangeable training methods. It reuses Lichess libraries
(`chessground`, `chessops`) and CC0 Lichess puzzle content, and owns its training-service
layer so a remote/online adapter can be added later.

The app is runnable today: `apps/web` is an offline-capable local player backed by the
`@chessengram/scheduler` package.

## Repository layout

- `apps/web/` — the runnable Vite + TypeScript player (local training loop; content packs).
- `packages/contracts/` — `@chessengram/contracts`: the architecture-neutral `TrainingService`
  boundary, domain types and schemas.
- `packages/scheduler/` — `@chessengram/scheduler`: deterministic, clock-injectable scheduler.
- `tools/puzzles/` — Python tooling that builds and validates Lichess puzzle packs.
- `data/puzzles/` — retained, validated puzzle packs.
- `tools/lichess-baseline/` — evidence and scripts from the unchanged-Lila baseline check.
- `docs/` — working documents (see below).

## Commands

Run from the repository root (npm workspaces):

```bash
npm install          # install all workspaces
npm test             # run all package tests
npm run typecheck    # typecheck all workspaces
npm run build        # production build of apps/web
npm run dev          # dev server for apps/web
```

## Working documents

- [Master plan, decisions, open issues, dependency graph and task board](docs/PROJECT_PLAN.md)
- [Agent ownership and handoff conventions](docs/tasks/README.md)
- [Decision record conventions and ADR index](docs/decisions/README.md)
- [Architecture decision: extract/reuse, no Lila fork](docs/decisions/ADR-005-architecture-extraction-not-fork.md)
- [Lichess puzzle dependency audit](docs/research/lichess-puzzle-dependencies.md)
- [Install on your phone and play offline](docs/install-on-phone.md)
- [Scheduling behavior specification](docs/research/scheduling-behavior.md)
- [Content research and validation report](docs/research/puzzle-content-sources.md)

## Starter data

A validated 100-puzzle Lichess pack around rating 1000 is in `data/puzzles/lichess-900-1099-v1/`.
It is a bounded-prefix POC sample, not a globally representative dataset.

See [puzzle tooling instructions](tools/puzzles/README.md) for dependencies, offline
verification and deterministic rebuilding. The Python tooling prepares data only; it does not
decide the application's runtime stack.
