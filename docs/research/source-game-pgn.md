# PZL-002a — Source-game PGN feasibility and provenance

Status: **research only**; recommendations below are not decisions. Read-only audit performed 2026-10-16. No source game was fetched, no code or tooling changed, and no tests were run.

## Sources and method

- Read the official [Lichess puzzle database documentation](https://database.lichess.org/#puzzles) live on 2026-10-16. The page identifies the current dump, documents its CSV schema and position/move convention, and links Lichess terms and CC0 information.
- Read the pinned Lila sources at [`f5b261e3d8ece6f511484e398cb8d81e37735bea`](https://github.com/lichess-org/lila/commit/f5b261e3d8ece6f511484e398cb8d81e37735bea): [`GameJson.scala`](https://raw.githubusercontent.com/lichess-org/lila/f5b261e3d8ece6f511484e398cb8d81e37735bea/modules/puzzle/src/main/GameJson.scala), [`JsonView.scala`](https://raw.githubusercontent.com/lichess-org/lila/f5b261e3d8ece6f511484e398cb8d81e37735bea/modules/puzzle/src/main/JsonView.scala), and [`Puzzle.scala`](https://raw.githubusercontent.com/lichess-org/lila/f5b261e3d8ece6f511484e398cb8d81e37735bea/app/controllers/Puzzle.scala). The raw URLs returned source successfully. This agrees with the earlier [`lichess-puzzle-dependencies.md`](lichess-puzzle-dependencies.md) audit, whose revision is the same SHA; that audit's `GameJson`, `JsonView`, and controller citations are likewise SHA-pinned. Those are live GitHub source URLs but resolve to a fixed revision, not current `master`.
- Read current [Lichess Terms of Service](https://lichess.org/terms-of-service), dated “Last Modified: Saturday 01 August 2026”. This is a mutable live policy, not pinned.
- Inspected `tools/puzzles/README.md`, `tools/puzzles/puzzles.py`, `tools/puzzles/test_puzzles.py`, and the checked-in `data/puzzles/lichess-900-1099-v1` fixture. No game PGNs or game-export sample are present in the fixture. Size measurements below use existing pack/source files only.

## Confirmed findings

### Official puzzle CSV schema and move convention

The official database page explicitly gives this exact header/order (11 fields):

```text
PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate
```

The official page says `Moves` are UCI; `FEN` is the position **before** the opponent's move; the position shown to the solver is after applying the first move; the second move begins the solution. The first move is therefore setup, and the solution starts at `Moves[1]`. The page also documents `GameUrl`, opening tags, and `DailyDate` as a Unix-millisecond timestamp when present. The checked-in tooling asserts the same 11 names/order and preserves all raw columns as strings in `original`.

Consequently, `GameUrl` is an identifier/link, not a PGN field. The CSV contains only a puzzle line, not the source game's full move history or PGN headers/branches.

### Lichess puzzle web route and original game context

At the pinned revision, `Puzzle.renderShow` calls `jsonView.analysis(...)` before rendering the HTML page. `JsonView.analysis` calls its regular `apply` path, which asks `GameJson` for the source game using `puzzle.gameId` and `puzzle.initialPly`. `GameJson.generate` loads that game via `gameRepo.gameFromSecondary(gameId)` and fails with `Missing puzzle game …!` if absent. It serializes the source game's SAN mainline prefix through `plies.value + 1`, i.e. through the setup move, as `game.pgn`; it also includes game/player/performance/rated metadata. This is not a request for a PGN file from the browser: the server's game repository supplies a partial SAN string in bootstrap JSON.

`JsonView.puzzleJsonBase` separately emits puzzle ID, rating, plays, solution UCI (`puzzle.line.tail`) and themes. Optional initial-position data is `puzzle.fenAfterInitialMove` plus `lastMove`; normal web puzzle data also includes `initialPly`. The UI controller's tree reconstruction consumes `data.game.pgn` as SAN from the ordinary start, then treats its last node (after setup) as the solver's initial node. Thus full source-game context and puzzle-solving context are related but distinct: the normal web bootstrap only sends the game prefix needed through setup, not necessarily the whole game.

The public single-puzzle API can return puzzle/FEN data with `withInitialPos = true`, but the ordinary web bootstrap still uses the game-backed route. The prior audit correctly flags that directly replacing its payload requires changing/adapting the bootstrap and tree root, rather than assuming the CSV is a drop-in.

### Current ChessReps pack/tooling and replay feasibility

- `tools/puzzles/puzzles.py` currently defines a deterministic **content-format-v1** JSONL pack. Each selected record has normalized `solverFen`, `sourceFen`, `setupMove`, solver color and solution UCI, plus `original` containing all 11 CSV fields (including `GameUrl` and original raw `Moves`). `GameUrl` is therefore already retained in the fixture payload, though no game is retrieved or embedded.
- The current pack record has no source PGN field and there is no established application pack-schema migration here. The pack manifest uses `schema_version: 1`; README explicitly labels this a tooling content format, “not the future app contract.” An optional PGN could fit structurally as an optional property, but that is not equivalent to application/content validation or export/import support.
- The fixture contains 100 selected puzzles. `pack.jsonl` is 66,702 bytes (about 65.1 KiB; `du` rounds to 68K), and retained `source.csv` is 925,082 bytes. Every selected fixture row has a nonempty `GameUrl`. No PGN sample exists to measure per-game size or validate source-game retrieval.
- Current tool validation replays `sourceFen` + first `Moves` UCI setup move, then every remaining UCI solution move with python-chess; derives `solverFen` after exactly one setup move and checks mate-tagged endings. Existing tests check the setup-vs-solution split and promotions. This supports puzzle-line correctness, not reconstruction/validation of the full source PGN.
- A full standard-start source PGN's SAN mainline through the setup ply can in principle recreate Lila's `game.pgn` prefix: replay from the initial position and stop at the CSV setup move / `GameUrl` ply. The puzzle's required solver position must equal the result. But the fixture does not include PGN, and no test proves that each selected `GameUrl` identifies an available standard chess game, that its exported PGN reproduces the CSV FEN/moves, or that any full-game variations should be retained. For a locally bundled game-prefix context, storing just the SAN prefix through setup may be smaller and sufficient for that tree behavior than a whole-game PGN. If product functionality needs post-puzzle game continuation, full game data is a different scope.

## License and provenance analysis

**Confirmed:** the official database page says “Database exports are released under the Creative Commons CC0 license” and expressly permits downloading, modifying, and redistributing those exports, including commercial use. That clearly covers the published puzzle CSV export. The same page lists separate puzzle and chess-game database exports, but this audit did not inspect a specific source game's record in the game export or establish that an individually retrieved source-game PGN/API response falls under the same CC0 grant in all distribution contexts.

**Important qualification:** Lichess Terms say submitted content (including PGN) remains the submitter's rights; submitters grant Lichess a worldwide, non-exclusive, royalty-free, sublicensable license for the uses described. The Terms say users may use services/content and game databases subject to applicable licensing, and direct users to do their own license due diligence. This does not, by itself, establish that every full game returned by a web/API endpoint may be redistributed by ChessReps as an embedded PGN. Nor does the puzzle CSV's CC0 status automatically prove the source game's separate provenance/rights. Public game visibility is not itself a license.

**Unknown requiring legal review (do not treat as cleared):** whether full source-game PGNs fetched from `GameUrl`/Lichess game export or API can be bundled and redistributed, and under which terms/attribution, particularly where uploaded games may contain third-party copyrighted annotations or other content. Review the exact game-database export license and relevant user-content terms for the intended acquisition/distribution path; seek Lichess clarification or counsel if uncertainty remains. A source-game link alone is lower-risk as metadata than copying the game, but can still raise product/link-policy questions. The policy is live and may change.

## Suggested data shape and validation (recommendation)

Keep normalized puzzle solving data independent of optional source-game context. A candidate optional shape for consideration (not an approved schema) is:

```json
"sourceGame": {
  "url": "https://lichess.org/<game-id>",
  "pgn": "...",
  "format": "pgn",
  "pliesIncluded": 34,
  "retrievedAt": "...",
  "sourceRevisionOrSnapshot": "...",
  "license": "..."
}
```

Prefer a minimized `sanPrefixThroughSetup` (or equivalent documented representation) if the only requirement is the existing web UI's root-to-puzzle context; reserve a full PGN for a demonstrated full-game feature and explicit license clearance. Avoid duplicating the CSV `GameUrl` as an independent contradictory URL; keep an original source link/ID as provenance.

Validation should parse the PGN, check variant/starting-position assumptions, replay to the declared setup ply, verify the resulting position against `solverFen` and source FEN after setup (accounting for explicitly documented FEN normalization), and verify the last replayed move matches `setupMove`. Reject malformed, non-standard, truncated-before-setup, mismatched, or unsupported variant records. Test PGN's move numbering/black-to-move and castling/promotion edge cases. Keep the existing UCI puzzle line as grading authority; PGN comments/variations must not silently become accepted solution alternatives. Offline behavior must use the bundled optional data or work without it—never fetch source games at runtime.

If adopted, define an optional field with clear absent/null semantics, content schema/version, validation limits, provenance metadata and checksums. Do not change a stored application schema/version silently. Export/import and migration policy/gates must be designed before adding persisted schema as required by project conventions; compatibility must preserve existing v1 packs and handle old imports without data loss.

## Rough size estimate and limitations

Measured baseline: 100-puzzle pack is 66.7 kB JSONL, with no source-game PGNs. The available fixture cannot yield a measured PGN delta. A rough planning allowance for **full** PGNs is on the order of a few hundred KB for 100 games (assuming ~2–5 kB/game plain text), before compression; this is an estimate only, and game length/headers/annotations can make it materially larger. A SAN prefix truncated at the puzzle setup move should generally be smaller, but likewise has no measurement here. JSON escaping adds some overhead if embedded inline; separate/deduplicated game records could avoid repeated data if puzzles share a game. The complete Lichess puzzle corpus is over six million records per the official page; embedding full games for every imported puzzle is a substantially different storage/download problem and could be many gigabytes uncompressed under the same rough per-game assumptions.

Limitations: no PGNs were downloaded or sampled, so byte estimates, game availability, format/variant distribution, duplicate games, replay-to-solverFen yield, and full-game rights are unverified. No online route was exercised. The pinned source establishes Lila behavior at that SHA only; live policy/database pages can change.

## Recommendation (not a decision)

1. Limit any first bundled-PGN experiment to a small, explicitly selected starter pack, and make context optional. Do not attach a fetched full PGN to every puzzle a user imports. Many imported puzzles need only the existing FEN/setup/solution for offline solving; optional provenance/context can remain a link when online.
2. First prove whether the actual user-visible requirement needs the game prefix through setup or the full game. If prefix suffices, prefer a compact, legally cleared prefix rather than full-game PGNs. Ship no source-game fetch-on-open/runtime fallback.
3. Before distributing any embedded game material, resolve the licensing/provenance question above. CC0 for the puzzle CSV is not enough evidence for treating every linked source game as CC0.
4. Only then define an optional field, content schema/version, validation and deterministic retrieval pipeline. Align it with the required export/import and migration gates before persisting or broadening imports.

This favors starter-pack scope as a bounded offline feasibility experiment while leaving arbitrary imports PGN-free unless separately licensed/provided. It is a scope recommendation, not a product or legal decision.
