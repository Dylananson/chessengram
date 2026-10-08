# ChessReps

Personal chess trainer in the research/POC-preparation stage. Reuse Lichess puzzle code, add interchangeable repetition methods, and target independent offline phone/desktop use. Online POC first; no runnable application yet.

## Working documents

- [Master plan, decisions, open issues, dependency graph and task board](docs/PROJECT_PLAN.md)
- [Agent ownership and handoff conventions](docs/tasks/README.md)
- [Decision record conventions](docs/decisions/README.md)
- [Lichess puzzle dependency audit](docs/research/lichess-puzzle-dependencies.md)
- [Scheduling behavior specification](docs/research/scheduling-behavior.md)
- [Content research and validation report](docs/research/puzzle-content-sources.md)

## Starter data

A validated 100-puzzle Lichess pack around rating 1000 is in `data/puzzles/lichess-900-1099-v1/`. It is a bounded-prefix POC sample, not a globally representative dataset.

See [puzzle tooling instructions](tools/puzzles/README.md) for dependencies, offline verification and deterministic rebuilding. The Python tooling prepares data only; it does not decide the application's runtime stack.
