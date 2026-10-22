# How lichess and chess.com do analysis mode (and what we copied)

Owner request, 2026-10-19: *"the engine analysis should be like lichess or chess.com
where i can do a move, see the analysis bar etc, see what moves at different
positions are good — not just show the moves in the notation"*, then *"auto
analysis when in analysis mode … continuous analysis like chess.com and lichess do
it please, do your research"*.

Sources read: lichess's blog "Thousands of Stockfish analysers" and "Recent
improvements", the `fishnet` protocol doc, lichess forum threads on infinite
analysis / go-deeper / cloud eval, chess.com's help pages on the analysis board,
Game Analysis, Game Review, and their "New Analysis Tools" announcement (2024-07).

## What they actually do

| | lichess | chess.com |
|---|---|---|
| **Starts analysing** | On its own. In Analysis Board *"the engine is already running and analyzing after each move"* — no button press | On its own once the analysis tab is open; the eval bar *"will update for each move"* |
| **Shape of the search** | **One continuous search per position.** "Infinite analysis" is **not** UCI `go infinite`: it is a **depth cap raised to 99** (the UI shows `xx/99`), and the engine simply finishes there. Without it, the local search stops at a modest default and you press the little **+ / "go deeper"** to continue | Bounded by **engine max time** (an explicit setting; iOS exposes it *"to conserve power"*) and by engine strength tiers. Deep/Maximum are membership-gated |
| **What updates live** | Eval bar + numeric score + the lines, as depth climbs; the depth readout is visible | Eval bar + score + lines, "for each move" |
| **Arrows** | Best move drawn from the top line | **Suggestion arrow** (green, best move) — *"will only begin to show at engine depth 14, to make sure the first arrow is the most accurate move"*; optional threat arrows (red) |
| **Lines vs feedback** | Multi-line (configurable), plus cloud evals | **Either** engine lines **or** "Move Feedback" (a Game-Review-style classification of the move you just played) — mutually exclusive |
| **Free board** | Yes: both sides, any legal move, variations, undo | Yes: *"you can simply move pieces on the board as if playing a game"* |
| **Cost control** | Server analysis (fishnet, ~1M nodes/position) for whole games; the local engine for the board, with **cloud eval** reuse | Cloud analysis for whole games (Diamond); **local default is the NNUE-less "Lite" build** because the full net is 108 MB and *"can quickly drain your battery"* |

## What we implemented (and why it matches)

`AN-002` follows the lichess shape, with chess.com's arrow threshold:

- **Continuous, automatic, one search per position.** Entering the screen (or
  moving, or stepping) starts a search on the current position; the eval bar,
  score, depth and lines update from every improvement. Changing position
  **abandons** the old search rather than queueing it — a tap-happy user can never
  end up waiting behind stale searches.
- **Depth cap, not `go infinite`.** `ANALYSIS_CONTINUOUS_MAX_DEPTH = 40` for the
  ordinary pass and `ANALYSIS_DEEP_MAX_DEPTH = 99` behind **"Go deeper"** — the
  same escape hatch lichess offers, and the same reason: an uncapped search on a
  phone would never stop burning battery.
- **Arrows from depth 14 only** (`ANALYSIS_ARROW_MIN_DEPTH`), because chess.com's
  own rationale — don't show a wrong "best move" before the search can be trusted
  — is a good one.
- **Free board** for both sides, with ◀ ▶ navigation and a "Reset", so you can
  explore *"what moves at different positions are good"*.
- **A battery switch**: the engine can be turned off; leaving the screen stops it.
- **Phone-sized UI**: the eval bar is vertical on desktop and a horizontal strip
  under the board on narrow screens, and the board keeps the first screen.

## Deliberately not copied (yet)

- **Move Feedback / move classification** (chess.com's per-move Brilliant→Blunder
  verdict). It needs calibrated thresholds and — per the brand rules in
  `docs/research/chesscom-import.md` — **our own** taxonomy and glyphs, never
  chess.com's. Natural follow-on for `CC-001` (which needs the same machinery to
  find blunders in your own games).
- **Threat arrows** (chess.com draws the opponent's best reply in red). Cheap to
  add from the same top line; listed as a follow-up rather than smuggled in.
- **Cloud eval reuse** (lichess). We have the local equivalent — the per-FEN cache
  in `engine/analysis.ts` — and no server fleet to share with.
