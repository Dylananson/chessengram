# T08-lite: FEN-rooted Player Spike

## Overview

A minimal, runnable FEN-rooted local puzzle player spike built to prove the offline seam before committing to Q01 (full fork vs extraction). The app uses Lichess libraries (`chessground` for board UI, `chessops` for move legality/FEN/SAN) and loads puzzle content from the T02 pack.

## What was built

- **Vite + TypeScript app**: New app under `apps/player-spike/` using npm/vite vanilla-ts template
- **Dependencies**: `chessground@9.2.1`, `chessops@0.15.1` (Lichess libraries)
- **Pure grading module** (`src/grading.ts`): Unit-testable logic that grades moves against puzzle solution (UCI). Separates core logic from UI/browser concerns.
- **Training boundary** (`src/training-adapter.ts`): Uses the provided `InMemoryTrainingService` from `packages/contracts/src/reference-implementation.ts`. Preserves seam for plugging in real adapter/scheduler later.
- **Puzzle loading** (`src/pack-loader.ts`, data copied to `public/`): Loads puzzles from T02 pack at `data/puzzles/lichess-900-1099-v1/pack.jsonl` (copied verbatim; provenance recorded in manifest.json)
- **Board logic** (`src/main.ts`): 
  - Board initialized from `solverFen` (FEN-rooted seam)
  - If `setupMove` exists, plays it once from `sourceFen` to reach solver position
  - Solving loop: solver color controls whose moves are accepted
  - On wrong solution move: marks attempt failed but does NOT advance; user stays on same puzzle (correction continues)
  - On correct moves: advances through solution; after solver move, opponent's response is played automatically from solution sequence
  - Next button advances to next puzzle

## Key behaviors verified

1. **FEN-rooted**: Board initializes from `solverFen`. Setup move (if present) animates from `sourceFen` to reach solver position.
2. **Wrong move handling**: As specified (chess.com-like), wrong move marks failed state but does not advance - board reverts and user can continue solving.
3. **Solution completion**: Correctly tracks progress through solution array; completes when all moves done.
4. **TrainingService boundary**: Integrates with `InMemoryTrainingService` for attempt recording (success/failure/correction events).
5. **Pure grading**: Logic is browser-independent, tested in Node.

## Tests

Unit tests for pure grading module (Node test runner, experimental-strip-types):

### tests/grading.node.test.ts
- ✅ Correct next move advances solution index, not failed, not completed
- ✅ Wrong move marks failure without advancing solution index
- ✅ Completing solution marks as completed

### tests/setup-move.node.test.ts  
- ✅ Setup-move handling: grading from solverFen starts at solution[0] and completes correctly

Run: `cd apps/player-spike && node --test --experimental-strip-types tests/grading.node.test.ts tests/setup-move.node.test.ts`

All 4 tests pass (3 + 1).

## Build verification

Production build: `npm run build` (tsc + vite build)
- ✅ TypeScript compiles (with minor adjustments to contracts for linting)
- ✅ Vite builds successfully
- ✅ Output in `dist/` includes puzzle data, HTML, and JS bundles
- Bundle size: ~42KB (gzip ~14KB)

## Running the app

Development: `cd apps/player-spike && npm run dev` (then open http://localhost:5173)
Production preview: `cd apps/player-spike && npm run preview`

The UI shows:
- Board (chessground with brown/cburnett styles)
- Puzzle info (ID, rating, themes, solver color)
- Status (with visual states: correct/wrong/failed-but-still-solving/completed)
- Solution preview
- Next button

## Third-party notices

`THIRD-PARTY-NOTICE.md` documents GPL-3.0 licenses for chessground/chessops and CC0 for puzzle data.

## FEN-rooted seam findings

The spike confirms the FEN-rooted seam works cleanly with the T02 data format:
- Pack provides `sourceFen`, optional `setupMove`, `solverFen`, `solverColor`, and `solution` (UCI array)
- This matches the convention described in T02 manifest: "sourceFen/original.FEN is BEFORE setupMove; solverFen is AFTER setupMove; solution excludes setup and includes alternating solver/opponent plies"
- Using solverFen as the starting position avoids PGN/game lookup coupling (addressing T01 concern about GameJson dependency)
- Setup move animation is cleanly separated from solving logic

This supports the architectural direction of a focused player using Lichess libraries rather than full fork extraction complexity, though the full Q01 decision still requires comparison as outlined in T01.

## Known gaps

Some of the gaps below were addressed by the maturation work documented later in
this file (see "Maturation: T09-lite + T10").

- Limited test coverage (only grading logic unit tested; no integration/e2e browser tests)
- ~~No persistence beyond in-memory training service~~ → addressed (IndexedDB)
- UI is minimal (no move list, no hints/reveals UI controls)
- ~~Promotion handling simplified~~ → addressed (explicit promotion picker)
- Opponent move timing is fixed (260ms) rather than adaptive
- ~~Uses subset of puzzles (loads first 10 from pack in UI)~~ → addressed (full pack cached)

## Commands & Results

```bash
# Install dependencies (already done)
npm install chessground chessops

# Run unit tests
cd apps/player-spike && node --test --experimental-strip-types tests/grading.node.test.ts tests/setup-move.node.test.ts
# Result: 4/4 tests pass

# Production build
cd apps/player-spike && npm run build
# Result: ✓ built successfully (tsc + vite build, 42ms)
```

## Maturation: T09-lite + T10

This section records the follow-up spike-maturation work: wiring the real
scheduler into the player, adding local persistence, and the phone/touch,
promotion and i18n polish. Storage decisions are recorded in
`docs/decisions/ADR-004-local-storage-and-selection.md` (Proposed) and the
storage design in `docs/research/local-persistence.md`.

### What changed

- **Real scheduler (T09-lite).** `InMemoryTrainingService` is no longer used by
  the app. `src/scheduler-service.ts` implements the T04 `TrainingService`
  interface over the real `@chessreps/scheduler` (`Scheduler`, `selectNextDue`).
  `src/training-adapter.ts` is a thin UI adapter that owns per-attempt
  bookkeeping (current attempt id, expected revision) and derives idempotency
  keys from the attempt id only. The first wrong move commits one immutable
  failure; correction completion is evidence and can never overwrite it.
- **Local persistence (T10).** `src/storage/` adds a `StorageBackend` seam, an
  IndexedDB backend, an in-memory backend, and a versioned `LocalStore`.
  Content, derived `SchedulerState`, raw `AttemptRecord` history, sessions and
  meta survive reload. Progress resumes from where it left off, including a
  failure that was mid-correction.
- **Correct board control.** Chessground 9.2.1 has no promotion support, no
  undo, and its move events fire for programmatic moves too. The authoritative
  board now lives in chessops (`src/puzzle-game.ts`), which supplies legal
  `movable.dests`, grades moves, auto-plays the opponent reply, and supports
  promotion. The UI only uses `movable.events.after` (user moves only) and
  mirrors chessops state by setting FEN.
- **Promotion.** `onUserMove` detects a pawn reaching the last rank, reverts the
  visual move, and shows a promotion picker (queen/rook/bishop/knight, colored
  for the side). The chosen role is validated against the solution; an
  under-promotion is graded wrong.
- **Phone/touch + layout.** Responsive flex layout, `aspect-ratio` board with a
  mobile-first max width, safe-area padding, larger touch targets, and chessground
  CSS bundled from `node_modules` (removed the unpkg CDN links) so the app is
  fully offline-capable.
- **Timing.** `src/timing.ts` separates active solving time from correction
  time, excludes hidden/backgrounded time, logs interruptions, and marks timing
  untrustworthy once an interruption occurs (the scheduler then uses a neutral
  factor).
- **i18n.** `src/i18n.ts` is a tiny dependency-free layer with English defaults,
  key fallback, interpolation, and locale detection via `?lang=` / `localStorage`
  / browser. `index.html` uses `data-i18n` attributes. Adding a locale is one
  `registerLocale(code, messages)` call.
- **Grading module removed.** The old `src/grading.ts` and its tests were
  superseded by `PuzzleGame`; tests now target the real game logic.

### Verification

- Tests: `cd apps/player-spike && npm test` → 26 tests pass (0 failures) across
  failure-flow, persistence, IndexedDB, selection, puzzle-game, timing, i18n.
- Build: `cd apps/player-spike && npm run build` → `tsc` clean, Vite builds
  (~91 KB JS / ~29 KB gzip, ~16 KB CSS).
- `@chessreps/scheduler` and `@chessreps/contracts` were **not** modified;
  `noUnusedLocals`/`noUnusedParameters` were relaxed in the spike `tsconfig.json`
  so the imported scheduler source lints cleanly under the spike build.

### Still open

- No browser/e2e automation; resume/reload is covered at the service level, not
  through a real IndexedDB browser run.
- No schema migration runner (see ADR-004).
- No multi-tab coordination (stale commits are rejected by the scheduler revision
  guard, but the UI does not yet prompt to refresh).

## Provenance

- Puzzle data copied verbatim from `data/puzzles/lichess-900-1099-v1/pack.jsonl` (CC0)
- Manifest and checksum information preserved in copied files
- Lichess libraries used as-is from npm (GPL-3.0)
