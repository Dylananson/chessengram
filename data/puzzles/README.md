# Puzzle data

`lichess-900-1099-v1/` contains the bounded source snapshot, provenance,
100-puzzle starter pack, manifest, and validation report for T02.
See `../../tools/puzzles/README.md` for reproduction and field semantics,
and `../../docs/research/puzzle-content-sources.md` for research and limitations.

`lichess-bands-v1/` contains the F02 rating-band collections: 2,500 puzzles in
five 500-puzzle bands (0–999, 1000–1499, 1500–1999, 2000–2499, 2500+), each
theme-balanced so no single puzzle type dominates. `bands.json` records the
stable collection ids and membership; `pack.jsonl` is the interleaved library
payload. The 307 MB source archive is not vendored (only its SHA256 is
recorded), so `verify` needs the same archive. See
`../../docs/research/puzzle-content-sources.md` and
`../../tools/puzzles/README.md`.

Puzzle content is from the Lichess open database, released under CC0-1.0:
https://database.lichess.org/#puzzles
