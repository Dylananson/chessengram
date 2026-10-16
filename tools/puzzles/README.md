# Reproducible Lichess puzzle starter pack (T02)

Run commands from the repository root. Tested on Linux x86-64, Python **3.14.7**,
`chess==1.11.2` (the python-chess implementation), `zstandard==0.25.0`.
Use a local virtual environment; nothing needs a global installation.

```sh
ls /tmp/opencode
python3 -m venv /tmp/opencode/chessreps-t02-venv
/tmp/opencode/chessreps-t02-venv/bin/python -m pip install -r tools/puzzles/requirements.txt
```

## Verify the delivered pack offline

```sh
/tmp/opencode/chessreps-t02-venv/bin/python tools/puzzles/puzzles.py verify data/puzzles/lichess-900-1099-v1 data/puzzles/lichess-900-1099-v1
/tmp/opencode/chessreps-t02-venv/bin/python -m unittest discover -s tools/puzzles -v
```

Verification rebuilds from the checksummed snapshot, replays all 493 eligible
candidates with python-chess, and compares the complete pack/report bytes and
manifest contents. It detects edited solutions, derived fields, source rows,
selection order and stale reports. Python patch-version differences are allowed
in manifest verification; tool and library versions must match. These hashes are
integrity/reproducibility checks, not a cryptographic signature from Lichess.

## Rebuild in a fresh directory

Use a new output directory each time; existing artifacts are never overwritten.

```sh
ls /tmp/opencode
mkdir /tmp/opencode/chessreps-t02-reproduction
/tmp/opencode/chessreps-t02-venv/bin/python tools/puzzles/puzzles.py build data/puzzles/lichess-900-1099-v1 /tmp/opencode/chessreps-t02-reproduction
/tmp/opencode/chessreps-t02-venv/bin/python tools/puzzles/puzzles.py verify data/puzzles/lichess-900-1099-v1 /tmp/opencode/chessreps-t02-reproduction
```

Expected pack SHA256:
`5f26a52606c60c11c92b4d3a61e25eee66b1845bc7a09d9310042e3671da1e7f`.

## Acquire a new snapshot (network required)

```sh
ls /tmp/opencode
mkdir /tmp/opencode/chessreps-t02-new-source
/tmp/opencode/chessreps-t02-venv/bin/python tools/puzzles/puzzles.py fetch /tmp/opencode/chessreps-t02-new-source
/tmp/opencode/chessreps-t02-venv/bin/python tools/puzzles/puzzles.py build /tmp/opencode/chessreps-t02-new-source /tmp/opencode/chessreps-t02-new-source
```

`fetch` requests only compressed bytes **0–1048575**, requires HTTP 206 and the
exact Content-Range, reads at most 1 MiB, then closes the response. It streams
zstd decoding and retains the header and first **5,000 complete CSV records**.
The upstream format currently uses one physical line per record; schema and
record count are checked. A future multiline/schema change fails rather than
silently changing the sampling boundary. Lines are capped at 16 KiB; decoder
window is capped at 128 MiB. No full dump is downloaded. If a future prefix has
too few rows or eligible puzzles, acquisition/build fails: revise and version
the rules deliberately rather than silently downloading more or weakening filters.

The URL is mutable. A fresh fetch need not reproduce today's snapshot. Exact
offline reproduction uses the retained `source.csv` and `source.json`.
The compressed prefix itself is not retained; its SHA256 and HTTP headers are.
The incomplete zstd frame's terminal checksum and the full database checksum
cannot be verified. To compare a later acquisition, compare its CSV SHA256 and
compressed-prefix SHA256 to `source.json`; acquisition timestamps will differ.

## Output contract (content format v1, not the future app contract)

`pack.jsonl` contains one JSON object per puzzle:

- `id`, `rating`, `ratingDeviation`, `themes`: preserved source identity and
  rating/tag snapshot. `original` retains **all 11 CSV columns** as strings,
  including FEN, full Moves, popularity, play count, URL, openings and DailyDate.
- `sourceFen`: position **before** the opponent's move.
- `setupMove`: first original UCI move, legal from `sourceFen`.
- `solverFen`: position **after** setup; standard FEN with legal-only en-passant
  target normalization. `solverColor` is the side to move here.
- `solution`: original UCI moves **excluding setup**, alternating solver move,
  automatic opponent reply, solver move, etc. The last move is a solver move.

Initialize directly from `solverFen`, **or** initialize from `sourceFen` and
animate `setupMove` exactly once. Never apply setup again to `solverFen`.
Preserve promotion suffixes. Source FEN and source moves remain unchanged in
`original`; only the derived solver FEN is normalized.

Selection is versioned in `RULES` and the manifest: inclusive rating 900–1099,
rating deviation 0–100, popularity 80–100, at least 100 plays; no theme quota.
Sort eligible rows by SHA256 of UTF-8 `chessreps-t02-v1:<PuzzleId>`, tie-break by
ID. Keep the first occurrence of each normalized solver position (first four FEN
fields; clocks ignored), then take 100. Duplicate source IDs are rejected.
An illegal eligible candidate fails the build, never silently disappears.
The seed scrambles only the bounded prefix; it does **not** make it globally random.

## Files and checks

- `source.csv`: exact decompressed prefix, header + 5,000 rows, 925,082 bytes.
- `source.json`: acquisition record, URL, HTTP dates/ETag/range, prefix and CSV hashes.
- `pack.jsonl`: 100 puzzles, 66,702 bytes; the small runtime content payload.
- `manifest.json`: version, source snapshot, rules, count, environment, tool hash,
  SHA256 of source files, pack and report. No self-referential manifest hash.
- `validation.json`: legal-ply counts, rating/quality/color/theme statistics and
  explicit checks/limits. Source snapshot need not be shipped to a phone.

Eight tests cover byte reproducibility, setup semantics, invalid FEN, illegal
setup/later solution moves, real promotion lines, source corruption, pack
tampering, and refusal to consume an HTTP 200 full-dump response.

This validates chess legality and mate-tagged endings, not engine optimality or
all acceptable alternatives. In particular, Lichess permits **any checkmating
move** for mate-in-one puzzles; the stored principal line is not an exhaustive
answer set. See the research notes for integration recommendations and costs.

## Rating-band collections (`bands.py`)

`bands.py` builds the app's five bundled difficulty collections. Unlike the
bounded T02 sample, it streams the **complete** official archive (6,157,341
rows; 307,234,795 compressed bytes at pack build time) and needs the same
archive present for `verify` — it is too large to vendor, so the pack records
its SHA256 instead of retaining it.

```sh
/tmp/opencode/chessreps-t02-venv/bin/python tools/puzzles/bands.py probe /tmp/opencode/lichess-puzzles/lichess_db_puzzle.csv.zst
mkdir -p data/puzzles/lichess-bands-v1
/tmp/opencode/chessreps-t02-venv/bin/python tools/puzzles/bands.py build /tmp/opencode/lichess-puzzles/lichess_db_puzzle.csv.zst data/puzzles/lichess-bands-v1
/tmp/opencode/chessreps-t02-venv/bin/python tools/puzzles/bands.py verify /tmp/opencode/lichess-puzzles/lichess_db_puzzle.csv.zst data/puzzles/lichess-bands-v1
```

Bands are inclusive 500-point rating ranges (0–999, 1000–1499, 1500–1999,
2000–2499, 2500+) with 500 puzzles each. Each row is bucketed by its **rarest**
theme, then selection round-robins the themes (rarest first) so no single puzzle
type dominates a band; every band ends up covering 70–73 distinct tags with no
primary type above ~1.6%. Quality filters, keeper size, ordering and
deduplication are versioned in `RULES`.

Artifacts: `pack.jsonl` (2,500 puzzles, interleaved across bands),
`bands.json` (stable collection ids/names and per-band membership),
`manifest.json`, `validation.json` (per-band theme and rating statistics) and
`source.json` (archive URL, size, SHA256, license). `test_bands.py` covers the
band boundaries and the selection rules. Recorded pack SHA256:
`f83302975558f072d14daa50c00a73f55aea056aca25c5f9f2b968b60323930c`.
