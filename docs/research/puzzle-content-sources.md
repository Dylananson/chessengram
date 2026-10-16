# T02 — Rated puzzle content sources and starter-pack handoff

Status: **Accepted for the POC** by coordinator on 2026-10-09. Selection tool,
real 100-puzzle pack, manifest, retained source snapshot and validation report
delivered. Coordinator reran all 8 tests and pack verification successfully.
Sampling limitations and proposed quality thresholds below remain explicit.

## Sources examined

1. [Official Lichess open database, puzzles](https://database.lichess.org/#puzzles),
   inspected in this task on 2026-10-09 (session date). The page reports
   **6,157,341** puzzles, last updated **2026-10-05**, and CC0 permission to use,
   modify and redistribute the exports. Its current schema is:
   `PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate`.
   No third-party mirror, scraped game reconstruction, or generated puzzle data
   was used.
2. [Official compressed CSV](https://database.lichess.org/lichess_db_puzzle.csv.zst),
   inspected with HEAD and bounded HTTP Range requests. Response reports total
   **307,234,795 bytes** (~293 MiB), ETag `"6abf70a1-125007eb"`, Last-Modified
   **2026-10-02 08:51:45 GMT**. Successful acquisition recorded local UTC time
   **2026-10-08T22:42:51.079054+00:00** and server Date **2026-10-08 22:42:48 GMT**.
   These are the observed clocks/headers; the page date, object modification date
   and session date are not treated as an immutable release tag. Exact content
   identity is the retained snapshot checksum.
3. Trusted rules implementation: [python-chess](https://python-chess.readthedocs.io/),
   installed as PyPI distribution `chess==1.11.2`; standard chess Board validation,
   legal-move membership, move application and checkmate detection. Decoding uses
   `zstandard==0.25.0`. No engine needed for legal-sequence verification.

The official page explicitly states: source FEN is **before the opponent's
move**; apply the first UCI move to obtain the solver position; the second source
move starts the solution. It also says solution player moves are only moves,
except mate-in-one where any checkmate is accepted. These upstream claims are
distinguished from our narrower legal-replay validation.

## Snapshot and selection

The working acquisition requests `Range: bytes=0-1048575`, requires HTTP 206,
and streams decoding of only that bounded prefix. It retains the first 5,000
complete rows, IDs `00008` through `039QA`, plus the CSV header. This is an
ID-ordered prefix in the observed data, **not a uniform sample of the database**.
Selection by seeded hash reduces dependence on within-prefix ordering but
cannot remove prefix bias, source sorting correlations, or theme imbalance.

Snapshot SHA256:
`e0c44102bc50a6a1f4c88bd1e623fb68d2759f441e0837744871aaee1e85120a`.

Compressed 1 MiB prefix SHA256:
`dc8043e631315c5219880b4082a9f4a79c9030f6187dbd6267cf7b759cec21ab`.

Tool-local quality defaults (proposals for this starter pack, **not newly
confirmed product requirements**):

- 900–1099 inclusive rating, rating deviation ≤100, popularity ≥80, plays ≥100.
- Exactly 100 puzzles; no theme quotas, color quotas or engine rescoring.
- Eligible rows ordered by SHA256(`chessreps-t02-v1:` + ID), then ID.
- Deduplicate solver positions using first four normalized FEN fields; discard
  clocks, preserve side/castling/legal en-passant. Keep first in hash order.
- Fail on illegal eligible content or insufficient unique candidates.

These thresholds give a modest confidence/popularity floor without treating
ratings or themes as ground truth. The source has 493 eligible candidates,
all legally validated, with zero duplicate candidate solver positions. Exact
policy and source headers/checksums are in the manifest. `original` in each pack
record preserves all CSV values, including IDs, original rating and theme order.

## Validation results

| Measure | Result |
|---|---:|
| Retained source rows | 5,000 |
| Eligible candidates legally replayed | 493 |
| Selected / unique IDs / unique solver positions | 100 / 100 / 100 |
| Legal setup plies | 100 |
| Legal solution plies (excluding setup) | 282 |
| Rating minimum / mean / maximum | 900 / 1002.1 / 1098 |
| Maximum rating deviation | 99 |
| Minimum popularity / plays | 80 / 116 |
| White / black solver | 55 / 45 |
| Mate-tagged lines ending in checkmate | 42 |
| Mate in one / two / three | 23 / 15 / 4 |

Eight regression/integrity tests passed in **0.595 s**. They include deliberately
corrupted source/pack data and illegal moves, not merely successful replay.
The CLI `verify` passed for both the delivered pack and an independent build in
`/tmp/opencode/chessreps-t02-rebuild`. Repeated selection produced identical
pack/report bytes; both builds produced pack SHA256:
`5f26a52606c60c11c92b4d3a61e25eee66b1845bc7a09d9310042e3671da1e7f`.

Commands actually run from repository root:

```sh
/tmp/opencode/chessreps-t02-venv/bin/python tools/puzzles/puzzles.py fetch data/puzzles/lichess-900-1099-v1
/tmp/opencode/chessreps-t02-venv/bin/python tools/puzzles/puzzles.py build data/puzzles/lichess-900-1099-v1 data/puzzles/lichess-900-1099-v1
/tmp/opencode/chessreps-t02-venv/bin/python -m unittest discover -s tools/puzzles -v
/tmp/opencode/chessreps-t02-venv/bin/python tools/puzzles/puzzles.py verify data/puzzles/lichess-900-1099-v1 data/puzzles/lichess-900-1099-v1
/tmp/opencode/chessreps-t02-venv/bin/python tools/puzzles/puzzles.py build data/puzzles/lichess-900-1099-v1 /tmp/opencode/chessreps-t02-rebuild
/tmp/opencode/chessreps-t02-venv/bin/python tools/puzzles/puzzles.py verify data/puzzles/lichess-900-1099-v1 /tmp/opencode/chessreps-t02-rebuild
```

## Environment, resource costs and reproduction limits

- Tested Linux x86-64 / Python 3.14.7 in `/tmp/opencode/chessreps-t02-venv`.
  Requirements are explicitly pinned; setup and fresh-directory reproduction
  commands are in `tools/puzzles/README.md`. Dependencies install only in the venv.
- Successful acquisition consumed **1,048,576 compressed bytes**, about **0.34%**
  of the advertised archive. Investigation included an initial bounded decoding
  failure and two bounded frame-inspection requests; no full dump was fetched.
  The initial window cap was too low and was corrected before successful fetch.
- The decoder encountered a leading skippable frame and an 8 MiB-window data
  frame. Current configured decoder window cap is 128 MiB, and CSV lines are
  capped at 16 KiB. Acquisition buffers at most the 1 MiB compressed prefix and
  5,001 retained lines plus decoder buffers; build loads just 5,000 rows.
- Retained CSV: **925,082 bytes**. Runtime JSONL: **66,702 bytes**. Report:
  **2,025 bytes**. Manifest: **2,892 bytes**. Source files are reproducibility
  inputs, not required phone payloads.
- Timed offline build: **0.214 s** including Python imports, using `runpy` and
  `time.perf_counter`. A separate `tracemalloc` run measured **10,420,217 bytes**
  peak traced Python allocations and **0.475 s** with tracing. This excludes
  native-library memory and is not a total-RSS measurement. The shell lacked
  `/usr/bin/time`; `resource.ru_maxrss` reported an inherited/high ~1 GiB mark,
  so it is not presented as a reliable standalone build-memory measurement.
- No immutable upstream snapshot URL/full archive SHA256 was established. The
  retained CSV provides offline repeatability; future fetches may differ. The
  compressed prefix checksum is locally computed, not upstream-signed. Because
  the archive is deliberately truncated, its end-of-frame checksum is unavailable.
- Legality does not prove best play, uniqueness, original-game history, pedagogic
  quality, or rating calibration. Theme labels are retained, not independently
  recomputed. The pack skews to endgames (61); it is not theme-balanced.
- Exact duplicate solver positions are removed; near-duplicates, transpositions
  encountered later in solutions and multiple positions from one game are not.

## Integration handoff and recommendations

Paths:

- `tools/puzzles/puzzles.py`, `requirements.txt`, `test_puzzles.py`, `README.md`.
- `data/puzzles/README.md` and `data/puzzles/lichess-900-1099-v1/`
  (`source.csv`, `source.json`, `pack.jsonl`, `manifest.json`, `validation.json`).
- This research note.

T04/T07/T10 can consume `pack.jsonl` and the manifest without fetching Lichess.
The content schema is an explicit interim format, not a unilateral application
contract decision. Use `solverFen` directly or animate `setupMove` from
`sourceFen`, never both. Solutions exclude setup but include automatic replies.
Ratings are acquisition snapshots; refreshing them should create a new pack
version rather than silently changing this collection.

Recommendations for coordinator review: accept these thresholds for this POC
only (Q10); retain IDs and source snapshot identity in the later domain schema;
handle alternative mate-in-one checkmates in the player; consider broader
sampling and theme quotas if future use needs representativeness. A globally
uniform reservoir sample requires scanning the full stream or a separately
verified indexed source; arbitrary middle byte ranges in a zstd stream cannot
be assumed independently decodable. No full scan is needed for this POC.

## F05a — Bundled rating-band collections (2026-10-16)

User request: "import all of Lichess puzzles … make puzzle sets for varying
difficulty levels based on rating ranges, ideally 500-sized collections …
cover a wider variety of the puzzle tags … at least 5 difficulty levels",
clarified to a **subset** of collections. The T02 prefix approach cannot do this
(prefix bias, only 493 eligible rows), so F05a scans the **complete** archive.

Archive observed 2026-10-16 via HEAD: **307,234,795 bytes**, ETag
`"6abf70a1-125007eb"`, Last-Modified `2026-10-02 08:51:45 GMT` — identical
headers/etag to the T02 observation on 2026-10-08, so this is the same dated
export. Local archive SHA256
`76335bfa7d7c4a7f93c1366d81549e53951ebb79dd43d34904cab8f22d962f8d`
(computed locally; not upstream-signed). The archive is **not vendored** (too
large to commit), so `verify` needs the same bytes.

`tools/puzzles/bands.py` streams the CSV twice (counts; then bounded keepers) and
selects five 500-puzzle bands: 0–999, 1000–1499, 1500–1999, 2000–2499, 2500+.
Quality filter matches T02 (RD ≤100, popularity ≥80, plays ≥100). Diversity rule:
each row is bucketed by its **rarest** theme (name breaks ties), then selection
round-robins themes rarest-first; within a theme, ascending
`SHA256("chessreps-bands-v1:" + band + ":" + id)`. This stops near-universal tags
such as `mate` from dominating a band merely because they co-occur with
everything. Bucketing by *all* themes was measured first and left `mate` at
58–62% of the lowest band; the rarest-theme rule drops every band's largest
primary type to **1.6%** (`maxPrimary=0.016`) while keeping 70–73 distinct tags.

Observed results (6,157,341 source rows; eligible rows by band 799,244 /
1,416,968 / 1,187,395 / 606,670 / 90,622):

| Band | Eligible | Selected | Tags (primary/available) | Max primary share | Rating min–max (mean) | Legal replay |
|---|---:|---:|---:|---:|---|---|
| 0–999 | 799,244 | 500 | 70/73 | 1.6% | 424–999 (857) | 500/500 |
| 1000–1499 | 1,416,968 | 500 | 71/73 | 1.6% | 1000–1499 (1270) | 500/500 |
| 1500–1999 | 1,187,395 | 500 | 71/73 | 1.6% | 1500–1998 (1722) | 500/500 |
| 2000–2499 | 606,670 | 500 | 71/73 | 1.6% | 2000–2497 (2184) | 500/500 |
| 2500+ | 90,622 | 500 | 69/71 | 1.6% | 2500–2964 (2634) | 500/500 |

Zero illegal lines and zero duplicate solver positions were hit during
selection (the validators exist and are exercised by tests). Pack SHA256:
`f83302975558f072d14daa50c00a73f55aea056aca25c5f9f2b968b60323930c`;
2,500 records, **1,779,705 bytes**. Bands are exactly 500 puzzles so a
Woodpecker set can be created directly from one.

Integration: additive and one-shot. At boot the app loads `bands.json`
alongside `pack.jsonl` and calls `seedBundledCollections`, which merges the
puzzles into the library **without touching any existing collection** and creates
the five band collections under stable ids (`lichess-bands-v1-<band>`). A plain
`meta` value (`META_BUNDLED_BANDS`) records the seeded pack id, so the step is a
no-op on later boots and a deliberately deleted band collection is not
recreated. Existing local data, the stored default collection id, the IndexedDB
db name and every schema version are unchanged; export/import already carries
the `meta` collection, so no export-version bump was needed. Because the seed is
additive, the starter collection keeps its original 100 puzzles; the library
grows to 2,600. Tests: `tools/puzzles/test_bands.py` (band boundaries, rarest-tag
primary, round-robin order, duplicate-position and fail-loud paths) and
`apps/web/tests/bundled-bands.node.test.ts` (additive membership, one-shot
idempotency, reload persistence).

Limitations: legality only (no engine optimality), tag labels are Lichess's (not
recomputed), and the mid-band rating spread is not explicitly stratified — only
the band bounds are enforced. Reviewer/coordinator follow-ups, not done here:
optional finer bands (e.g. splitting 2500+), per-theme drill collections, and a
UI affordance to jump straight from a band to a Woodpecker set (currently done
from the Collections card).
