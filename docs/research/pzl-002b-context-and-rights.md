# PZL-002b research — source-game context, rights path, and schema impact

Status: **research only; recommendations are not product or legal decisions**. Read 2026-10-16. No source-game record or bulk archive was downloaded; no code, schema, or stored data was changed.

**Superseded scope note (2026-10-16):** the user initially preferred the full source game when available. The current direction is narrower: **for now, show only the immediately preceding/setup move**. Full-game context is deferred, not rejected. Earlier full-game rights and archive research remains useful if the scope is reopened.

**Bounded feasibility check (2026-10-16):** starter-pack puzzle `01q5Z` links to game `iNMEkbgy` at `https://lichess.org/iNMEkbgy/black#66`. Its public game page identifies the date as 2024-02-22, so the candidate official archive is `lichess_db_standard_rated_2024-02.pgn.zst`. The official archive server reports that file as **29,762,409,631 bytes**. No archive or game PGN was downloaded, and an exact match/replay could not be established within this bounded check. The individual-game export endpoint returned an anti-bot HTML page, which was discarded and is not evidence of source content or licensing. This selected-game join remains an explicit feasibility blocker; do not infer that `GameUrl` alone is a confirmed join to the monthly dump.

## Findings

### How much game context is needed?

The current Train move list is ChessReps attempt history. Lichess's pinned puzzle bootstrap audit (`docs/research/lichess-puzzle-dependencies.md`, Lila `f5b261e3d8ece6f511484e398cb8d81e37735bea`) shows that its initial game tree is reconstructed from the source game's SAN mainline **only through the puzzle setup move**. The client treats the resulting node as the puzzle's starting position. That is the minimum prefix needed to reproduce Lichess's context, but the user's preference is to show the whole source game when the complete game is available.

For the preferred full-game experience, store/display the source game's **mainline move sequence for the entire game**, with the puzzle's solver-start ply marked. PGN headers/comments/clocks/evaluations/variations are not necessary to show the full game moves. Storing UCI plies rather than SAN is preferable for a normalized content contract: UCI is locale-independent, can be validated by replay, and can be converted to SAN for display with the existing chess library. Keep the source game visually distinct from the learner's attempt and never use its later moves as grading evidence. If only a rights-cleared prefix through setup is available, it can still provide the minimum Lichess-style prelude; if neither is available, omit optional context and retain normal FEN-based solving.

Candidate optional content shape for discussion (not approved):

```ts
sourceGameContext?: {
  // Full source-game mainline when available; prefix through setup is acceptable
  // only as a reduced-context fallback. Standard initial position for Lichess.
  mainlineUci: string[];
  // Number of plies from the start (array offset) at the solver position,
  // immediately after the setup move; replay to this offset must equal solverFen.
  solverStartPly: number;
  // Provenance points to originalFields.GameUrl for Lichess CSV records.
  source: 'lichess-open-database' | 'user-provided';
  sourceSnapshot?: string;
}
```

The field should be absent when unavailable. `setupMove` remains the canonical setup field and must match the final context ply; current `solverFen` must equal replay's resulting position. Avoid storing a second, potentially divergent URL: the existing raw source fields already retain `GameUrl`. Only include a start FEN if support for non-standard starts/variants is intentionally added; otherwise reject them rather than silently mis-replay.

### What rights are supported by current official sources?

1. The live [Lichess Open Database](https://database.lichess.org/) states that **database exports** are CC0 and explicitly permits downloading, modifying, and redistributing them, including commercially. It lists a distinct standard-game PGN export (monthly files) as well as the puzzle CSV export. Its puzzle section documents 11 CSV columns, UCI moves, `GameUrl`, and the setup-move convention; it says puzzles were generated from analyzed games, but does not describe a direct join from a puzzle ID to a specific monthly game archive. An exact standard-game record obtained from the official game-database export has an express CC0 basis.
2. Lichess's [Terms of Service](https://lichess.org/terms-of-service) (shown as last modified 2026-08-01 when read) separately say submitted content retains its submitter's rights, and grant Lichess a broad license to use submitted content. The terms permit use of Lichess services in third-party projects subject to each service's applicable licenses and ask users to do their own due diligence. They do **not** independently say that any arbitrary individual-game API response is CC0 or grant every API consumer the same sublicensing rights Lichess has.
3. The [official API specification](https://github.com/lichess-org/api/blob/master/doc/specs/tags/games/game-export-gameId.yaml) documents `GET /game/export/{gameId}` as a public single-game PGN/JSON export. That endpoint is a retrieval mechanism, not itself a rights statement. Do not treat visibility or API availability as the license.
4. The database project's [exporter source](https://github.com/lichess-org/database/blob/master/src/main/scala/Games.scala) shows the bulk exporter produces PGN from stored rated games and may append analysis via `Annotator`. For ChessReps, retain only validated mainline moves through setup; discard player metadata, annotations, evaluations and the remaining game. The exporter source code is AGPL-3.0-or-later, but the code license is distinct from the database data license; do not copy exporter code into the CC0 content bundle.

**Caveat / legal-review boundary:** the CC0 statement expressly covers the database exports, so the cleanest defensible acquisition route is to source matching games from those official exports and preserve the dump identity, relevant URL/ID and CC0 provenance in the build manifest. Directly using `/game/export/{gameId}` instead relies on a separate API/user-content path whose exact redistribution grant is not explicit in the endpoint specification. If the exact source game cannot be found in the CC0 game dump, omit its prelude or obtain clarification/rights; do not silently fall back to an API fetch and label it CC0. This research is not legal advice.

### Feasibility / cost distinction

- The puzzle CSV's `GameUrl` supplies a game identifier and ply fragment, but not the game moves. A full game still has to be joined to a source game and replayed; the CSV alone cannot reconstruct the moves before or after the puzzle position.
- Official standard-game dumps are month-partitioned and extremely large (the database page reports billions of standard rated games). A one-off scan of all history is not a sensible starter-pack build step. A practical first experiment needs to establish the puzzle game's month/availability and identifier match, then use a bounded month/archive index or a separately obtained CC0 snapshot. Do not fetch the full game corpus merely to add context to 100 puzzles.
- The individual-game API is operationally convenient but is not the substantiated CC0 path. A reproducible builder should fail/omit context when a source record cannot be resolved from a pinned, licensed input; it must not make runtime requests.
- Existing starter-pack JSONL is only 66,702 bytes for 100 puzzles, and carries `GameUrl` in raw `original` fields but no mainline. No PGN bytes or join yield has been measured. Storing full-game moves (rather than full PGN syntax/metadata) may be compact, especially if source games are deduplicated by game ID; actual delta, overlap/deduplication and source match rate remain unknown until a permitted sample is examined.

## Content and migration impact (current repository)

- `NormalizedPuzzle` has `contentSchemaVersion: "1.0.0"`; `originalFields` already retains arbitrary raw source values. `tools/puzzles` has a separate content-format-v1 JSONL pack explicitly **not** the application contract.
- Local content is persisted as versioned envelopes in the `content` logical collection. `LocalStore` expects content schema `1.0.0`; an unknown record envelope is treated as absent. The IndexedDB database has one `kv` store, so no object-store bump is intrinsically required, but content records and export/import still need compatibility handling.
- Export/import is currently format `1.1.0`, accepts `1.0.0` and `1.1.0`, and has a sequential `1.0.0 → 1.1.0` migration. It preserves raw envelopes and backs up current data before import. This is a useful safety foundation, not a migration for a new content record shape.

**Recommended migration gate before persistence changes:** version the application content shape explicitly (for example, add a new content schema version and optional context field), maintain reads for existing 1.0.0 puzzles as “context absent,” and write a tested, lossless migration path for local content and import/export. If export format changes, append—not rewrite—a `1.1.0 → 1.2.0` migration. Old packs and user imports must remain valid with no context. Do not change the IndexedDB database name or silently reinterpret old envelopes. The exact version numbers and migration mechanics need coordinator approval; they are recommendations here.

## Recommendation (not a decision)

1. Honor the user's preference: **prefer the full source-game mainline when available**, marked at the puzzle's solver-start ply. Full PGN text, annotations and variations are not required unless requested separately. The setup-through-ply prefix is the minimum fallback, not the default target.
2. Use only source records located in the official CC0 game-database export for the first bundled sample. Build-time ingestion can normalize to UCI mainline moves and deduplicate by game ID; preserve CC0 dataset URL/snapshot checksums and per-puzzle source game identity in the pack manifest/provenance. No API fallback and no runtime network.
3. Before coding the joiner, perform a bounded feasibility spike using one selected puzzle/game: prove the full game is in a specific official dump, its PGN `Site`/game identity joins to `GameUrl`, full replay marks the indicated setup ply and matches `solverFen`, and capture actual full-move payload size. If only the prefix can be found, test and measure the prefix fallback. If no exact official CC0 source match can be demonstrated, ship no embedded game context for that puzzle.
4. Keep arbitrary user imports context-free unless the user supplies the game/context or another explicit license/source permits bundling. In all cases the existing FEN/setup/solution path stays fully functional offline.
5. Do not add the optional persisted content field until the local content and export/import migration plan is approved and tested.

## Sources checked

- [Lichess Open Database](https://database.lichess.org/#puzzles) — live page, read 2026-10-16; CC0 statement, standard game monthly PGN archives, puzzle CSV schema/convention, and generation note. The page provides no explicit puzzle-to-archive join recipe.
- [Lichess Terms of Service](https://lichess.org/terms-of-service) — live page, last modified 2026-08-01 as displayed on access; user-submitted-content clause and licenses section.
- [Lichess API: export one game](https://github.com/lichess-org/api/blob/master/doc/specs/tags/games/game-export-gameId.yaml) — mutable `master` specification; endpoint contract only, no independent rights grant found there.
- [Lichess database exporter](https://github.com/lichess-org/database/blob/master/src/main/scala/Games.scala) — mutable `master` source; bulk PGN generation and analysis annotation behavior.
- Local inspection: `packages/contracts/src/types.ts`, `apps/web/src/storage/local-store.ts`, `apps/web/src/storage/data-port.ts`, `tools/puzzles/README.md`, `tools/puzzles/puzzles.py`, and `docs/research/lichess-puzzle-dependencies.md`.
