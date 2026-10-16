#!/usr/bin/env python3
"""Rating-band, theme-diverse collection builder from the full Lichess puzzle DB.

Unlike ``puzzles.py`` (a bounded 1 MiB / 5,000-row sample), this tool streams the
**complete** official archive. It selects five rating bands of 500 puzzles each,
deliberately spreading membership across puzzle themes so a band is a varied
"sparse" collection rather than one puzzle type.

Selection is deterministic and versioned in ``RULES``:

1. Quality filter (rating deviation, popularity, plays) mirrors ``puzzles.py``.
2. A candidate is a "keeper" for each of its themes; per (band, theme) only the
   ``keeper_per_theme`` candidates with the smallest
   ``SHA256(seed:band:PuzzleId)`` are retained. Memory stays bounded.
3. Selection round-robins over a band's themes, rarest theme first, so rare tags
   are represented instead of being drowned out by ``mate``/``short``.
4. Every selected puzzle is replayed with python-chess; illegal lines and
   duplicate solver positions are skipped in favour of the next candidate.

The 307 MB compressed archive is **not vendored** (the pack is derived from it
and its SHA256 is recorded), so ``verify`` needs the same archive present.
"""

import argparse
from collections import Counter
import csv
import hashlib
import heapq
import io
import json
from pathlib import Path
import platform
import re
import sys
from datetime import datetime, timezone

import chess
import zstandard

import puzzles  # same directory: reuse the validated normalize()/field contract

URL = puzzles.URL
FIELDS = puzzles.FIELDS
PACK_ID = "lichess-bands-v1"
SEED = "chessreps-bands-v1"
COUNT_PER_BAND = 500
KEEPER_PER_THEME = 60
# (band_id, label, rating_min, rating_max); rating_max None means open-ended.
BANDS = [
    ("0000-0999", "0\u2013999", 0, 999),
    ("1000-1499", "1000\u20131499", 1000, 1499),
    ("1500-1999", "1500\u20131999", 1500, 1999),
    ("2000-2499", "2000\u20132499", 2000, 2499),
    ("2500-plus", "2500+", 2500, None),
]
QUALITY = {"rating_deviation_max": 100, "popularity_min": 80, "plays_min": 100}
RULES = {
    "quality": QUALITY,
    "count_per_band": COUNT_PER_BAND,
    "keeper_per_theme": KEEPER_PER_THEME,
    "bands": [{"id": b, "label": l, "rating_min": lo, "rating_max": hi} for b, l, lo, hi in BANDS],
    "seed": SEED,
    "ordering": (
        "per band, round-robin over themes ordered by ascending eligible frequency "
        "then theme name; within a theme ascending SHA256(UTF-8(seed:band_id:PuzzleId))"
    ),
    "deduplication": (
        "first in selection order per band per normalized solver position "
        "(FEN first four fields, legal en passant); clocks ignored"
    ),
    "scope": "complete official CSV; every eligible row is considered",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode()


def write_new(path, data):
    with path.open("xb") as stream:
        stream.write(data)


def sha256_file(path):
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            total += len(chunk)
    return digest.hexdigest(), total


def stream_rows(archive):
    """Yield parsed CSV rows from the compressed archive, header checked."""
    with archive.open("rb") as raw:
        decompressor = zstandard.ZstdDecompressor(max_window_size=128 * 1024 * 1024)
        with decompressor.stream_reader(raw) as reader:
            with io.TextIOWrapper(reader, encoding="utf-8", newline="") as text:
                parsed = csv.DictReader(text)
                require(parsed.fieldnames == FIELDS, f"unexpected CSV schema: {parsed.fieldnames}")
                for row in parsed:
                    yield row


def band_of(rating):
    for band_id, _label, low, high in BANDS:
        if rating >= low and (high is None or rating <= high):
            return band_id
    return None


def eligible(row, rating):
    return (0 <= int(row["RatingDeviation"]) <= QUALITY["rating_deviation_max"]
            and QUALITY["popularity_min"] <= int(row["Popularity"]) <= 100
            and int(row["NbPlays"]) >= QUALITY["plays_min"])


def row_themes(row):
    return row["Themes"].split()


def primary_theme(row, band_id, theme_counts):
    """The rarest theme a row carries (name breaks ties).

    Bucketing candidates by one primary theme — rather than every theme they
    carry — stops near-universal tags like ``mate`` from dominating a band just
    because they co-occur with almost everything else.
    """
    themes = row_themes(row)
    if not themes:
        return None
    return min(themes, key=lambda theme: (theme_counts[band_id].get(theme, 0), theme))


def candidate_hash(band_id, puzzle_id):
    return sha(f"{SEED}:{band_id}:{puzzle_id}".encode())


def count_bands(archive):
    """Pass 1: total rows, eligible rows per band, and theme frequencies."""
    theme_counts = {band_id: Counter() for band_id, *_ in BANDS}
    eligible_rows = {band_id: 0 for band_id, *_ in BANDS}
    total = 0
    for row in stream_rows(archive):
        total += 1
        require(re.fullmatch(r"[A-Za-z0-9]{5}", row["PuzzleId"]), "invalid puzzle ID")
        rating = int(row["Rating"])
        band_id = band_of(rating)
        if band_id is None or not eligible(row, rating):
            continue
        eligible_rows[band_id] += 1
        for theme in set(row_themes(row)):
            theme_counts[band_id][theme] += 1
    return total, eligible_rows, theme_counts


def probe(archive):
    """Pass 1 only: per-band counts and theme frequencies, for rule sizing."""
    total, eligible_rows, theme_counts = count_bands(archive)
    return {
        "rows": total,
        "bands": [
            {
                "id": band_id, "label": label, "eligible": eligible_rows[band_id],
                "themes": len(theme_counts[band_id]),
                "rarest": theme_counts[band_id].most_common()[-5:],
                "most_common": theme_counts[band_id].most_common(5),
            }
            for band_id, label, *_ in BANDS
        ],
    }


def keep_candidates(archive, theme_counts):
    """Pass 2: bounded per-(band, primary theme) keepers, smallest hash wins."""
    keepers = {}
    for row in stream_rows(archive):
        rating = int(row["Rating"])
        band_id = band_of(rating)
        if band_id is None or not eligible(row, rating):
            continue
        theme = primary_theme(row, band_id, theme_counts)
        if theme is None:
            continue
        key_hash = int(candidate_hash(band_id, row["PuzzleId"]), 16)
        bucket = keepers.setdefault((band_id, theme), [])
        entry = (-key_hash, row["PuzzleId"], row)
        if len(bucket) < KEEPER_PER_THEME:
            heapq.heappush(bucket, entry)
        elif entry > bucket[0]:
            # bucket[0] is the largest hash kept (negated); drop it.
            heapq.heapreplace(bucket, entry)
    # Ascending hash order within each theme.
    return {key: sorted(bucket, key=lambda e: (-e[0], e[1])) for key, bucket in keepers.items()}


def select_band(band_id, label, keepers, theme_counts):
    """Round-robin over themes (rarest first) until the band is full."""
    themes = [theme for theme in theme_counts[band_id] if (band_id, theme) in keepers]
    themes.sort(key=lambda theme: (theme_counts[band_id][theme], theme))
    pointers = {theme: 0 for theme in themes}
    used_ids, positions = set(), set()
    selected, rejected_invalid, rejected_duplicate = [], 0, 0
    while len(selected) < COUNT_PER_BAND:
        progressed = False
        for theme in themes:
            if len(selected) >= COUNT_PER_BAND:
                break
            bucket = keepers[(band_id, theme)]
            index = pointers[theme]
            while index < len(bucket):
                _neg, puzzle_id, row = bucket[index]
                index += 1
                if puzzle_id in used_ids:
                    continue
                try:
                    puzzle = puzzles.normalize(row)
                except ValueError:
                    rejected_invalid += 1
                    continue
                position = " ".join(puzzle["solverFen"].split()[:4])
                if position in positions:
                    rejected_duplicate += 1
                    continue
                used_ids.add(puzzle_id)
                positions.add(position)
                selected.append(puzzle)
                progressed = True
                break
            pointers[theme] = index
        if not progressed:
            break
    require(
        len(selected) == COUNT_PER_BAND,
        f"{band_id}: only {len(selected)} diverse/legal puzzles; adjust quality or band rules",
    )
    return selected, rejected_invalid, rejected_duplicate


def rating_stats(puzzles):
    ratings = [p["rating"] for p in puzzles]
    return {
        "rating_min": min(ratings), "rating_max": max(ratings),
        "rating_mean": sum(ratings) / len(ratings),
    }


def build_artifacts(archive, source):
    """Return the pack, band membership, manifest and validation records.

    `source` is the recorded acquisition metadata (provenance): it is an input,
    not a derived artifact, so a timestamped rebuild never enters the checks.
    """
    rows_total, eligible_rows, theme_counts = count_bands(archive)
    keepers = keep_candidates(archive, theme_counts)

    band_results, report_bands, bands_json = [], [], []
    for band_id, label, low, high in BANDS:
        selected, rejected_invalid, rejected_duplicate = select_band(
            band_id, label, keepers, theme_counts,
        )
        selected_themes = Counter(theme for puzzle in selected for theme in set(puzzle["themes"]))
        primary_counts = Counter(primary_theme(p["original"], band_id, theme_counts) for p in selected)
        present = [t for t in theme_counts[band_id] if theme_counts[band_id][t] > 0]
        report_bands.append({
            "id": band_id, "label": label, "rating_min_bound": low, "rating_max_bound": high,
            "eligible": eligible_rows[band_id],
            "themes_available": len(present),
            "themes_selected": len(selected_themes),
            "primary_themes_selected": len(primary_counts),
            "max_primary_theme_share": max(primary_counts.values()) / len(selected),
            "max_membership_theme_share": max(selected_themes.values()) / len(selected),
            "primary_theme_counts": dict(sorted(primary_counts.items())),
            "theme_membership": dict(sorted(selected_themes.items())),
            "selected_count": len(selected),
            "rejected_invalid_lines": rejected_invalid,
            "rejected_duplicate_positions": rejected_duplicate,
            "legal_setup_plies": len(selected),
            "legal_solution_plies": sum(len(p["solution"]) for p in selected),
            "solver_colors": dict(Counter(p["solverColor"] for p in selected)),
            "rating_deviation_max": max(p["ratingDeviation"] for p in selected),
            "popularity_min": min(int(p["original"]["Popularity"]) for p in selected),
            "plays_min": min(int(p["original"]["NbPlays"]) for p in selected),
            **rating_stats(selected),
        })
        band_results.append((band_id, label, low, high, selected))
        bands_json.append({
            "id": f"{PACK_ID}-{band_id}",
            "name": f"Lichess {label}",
            "label": label,
            "ratingMin": low,
            "ratingMax": high,
            "puzzleIds": [p["id"] for p in selected],
        })

    # Interleave bands so the library presentation order mixes difficulties.
    ordered = []
    index = 0
    while any(index < len(selected) for *_, selected in band_results):
        for _band_id, _label, _low, _high, selected in band_results:
            if index < len(selected):
                ordered.append(selected[index])
        index += 1

    pack = b"".join(
        (json.dumps(puzzle, sort_keys=True, separators=(",", ":")) + "\n").encode()
        for puzzle in ordered
    )
    report = {
        "status": "pass",
        "source_rows": rows_total,
        "pack_id": PACK_ID,
        "count_per_band": COUNT_PER_BAND,
        "total_selected": len(ordered),
        "unique_ids": len({p["id"] for p in ordered}),
        "bands": report_bands,
        "checks": [
            "unique selected ids per band and globally",
            "legal FEN before and after every ply",
            "legal setup and every solution ply",
            "solver start derived after setup",
            "mate-tagged lines end in checkmate",
            "unique normalized solver positions within each band",
            "original CSV fields retained",
            "theme round-robin removes single-theme domination",
        ],
        "not_checked": [
            "engine optimality",
            "alternative winning moves",
            "global representativeness of the retained archive",
        ],
        "validator": {"library": "python-chess (distribution: chess)", "version": chess.__version__},
    }
    bands_doc = {
        "schema_version": 1,
        "pack_id": PACK_ID,
        "license": "CC0-1.0",
        "bands": bands_json,
    }
    manifest = {
        "schema_version": 1, "pack_id": PACK_ID, "license": "CC0-1.0",
        "source_snapshot": source, "selection": RULES, "count": len(ordered),
        "convention": (
            "sourceFen/original.FEN is BEFORE setupMove; solverFen is AFTER setupMove; "
            "solution excludes setup and includes alternating solver/opponent plies"
        ),
        "serialization": "UTF-8, LF; JSONL sorted keys compact separators; JSON sorted keys indent=2 trailing LF",
        "checksums_sha256": {"pack.jsonl": sha(pack)},
        "tool_sha256": sha(Path(__file__).read_bytes()),
        "environment": {
            "python": platform.python_version(), "chess": chess.__version__,
            "zstandard": zstandard.__version__,
        },
    }
    return {
        "pack.jsonl": pack,
        "bands.json": encoded(bands_doc),
        "validation.json": encoded(report),
        "manifest.json": encoded(manifest),
    }


def make_source(archive_hash, archive_bytes):
    """Record acquisition provenance. Never part of a deterministic rebuild."""
    return {
        "schema_version": 1, "url": URL, "final_url": URL,
        "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
        "license": "CC0-1.0", "license_source": "https://database.lichess.org/#puzzles",
        "archive_bytes": archive_bytes, "archive_sha256": archive_hash,
        "archive_vendored": False,
        "limitations": (
            "the 307 MB compressed archive is not retained; verify needs the same archive "
            "(checked by archive_sha256). The URL is mutable, so a fresh download need not reproduce it."
        ),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("probe", "build", "verify"):
        p = sub.add_parser(command)
        p.add_argument("archive", type=Path)
        if command != "probe":
            p.add_argument("output", type=Path)
    args = parser.parse_args()
    require(args.archive.is_file(), "archive not found")
    if args.command == "probe":
        print(json.dumps(probe(args.archive), indent=2))
        return
    if args.command == "build":
        archive_hash, archive_bytes = sha256_file(args.archive)
        source = make_source(archive_hash, archive_bytes)
        artifacts = dict(build_artifacts(args.archive, source), **{"source.json": encoded(source)})
    else:
        recorded = json.loads((args.output / "source.json").read_bytes())
        archive_hash, archive_bytes = sha256_file(args.archive)
        require(
            recorded["archive_sha256"] == archive_hash and recorded["archive_bytes"] == archive_bytes,
            "archive does not match the recorded snapshot (verify needs the same compressed bytes)",
        )
        artifacts = build_artifacts(args.archive, recorded)
    require(args.output.is_dir(), "output directory must already exist")
    if args.command == "build":
        require(not any((args.output / name).exists() for name in artifacts), "output artifacts already exist")
        for name, data in artifacts.items():
            write_new(args.output / name, data)
    else:
        for name, data in artifacts.items():
            actual = (args.output / name).read_bytes()
            if name == "manifest.json":
                expected_json, actual_json = json.loads(data), json.loads(actual)
                expected_json["environment"]["python"] = actual_json["environment"]["python"]
                require(expected_json == actual_json, "manifest mismatch")
            else:
                require(actual == data, f"{name}: mismatch against deterministic rebuild")
    print(json.dumps({
        "command": args.command, "pack_sha256": sha(artifacts["pack.jsonl"]),
        "count": json.loads(artifacts["validation.json"])["total_selected"], "status": "pass",
    }))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, zstandard.ZstdError) as error:
        sys.exit(f"error: {error}")
