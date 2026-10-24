#!/usr/bin/env python3
"""Build deterministic, filtered puzzle packs from the official Lichess CSV."""

import argparse
import hashlib
import heapq
import json
from pathlib import Path
import re
import sys

import bands
import puzzles

SEED = "chessengram-custom-packs-v1"


def matches(row, rating_min, rating_max, themes):
    """Themes are exact source tags; multiple requested tags mean AND."""
    rating = int(row["Rating"])
    return (rating_min <= rating <= rating_max
            and bands.eligible(row, rating)
            and set(themes).issubset(set(bands.row_themes(row))))


def select(rows, rating_min, rating_max, themes, count):
    """Select the lowest stable hashes, then validate and deduplicate positions."""
    candidates = []
    for row in rows:
        if not matches(row, rating_min, rating_max, themes):
            continue
        digest = hashlib.sha256(f"{SEED}:{rating_min}:{rating_max}:{','.join(themes)}:{row['PuzzleId']}".encode()).hexdigest()
        entry = (int(digest, 16), row["PuzzleId"], row)
        if len(candidates) < count:
            heapq.heappush(candidates, (-entry[0], entry[1], entry[2]))
        elif entry[0] < -candidates[0][0]:
            heapq.heapreplace(candidates, (-entry[0], entry[1], entry[2]))
    ordered = sorted(candidates, key=lambda item: (-item[0], item[1]))
    selected, ids, positions = [], set(), set()
    for _neg_hash, puzzle_id, row in ordered:
        if puzzle_id in ids:
            continue
        normalized = puzzles.normalize(row)
        position = " ".join(normalized["solverFen"].split()[:4])
        if position in positions:
            continue
        ids.add(puzzle_id)
        positions.add(position)
        selected.append(normalized)
    if len(selected) != count:
        raise ValueError(f"only {len(selected)} valid unique candidates in bounded deterministic selection; need {count}")
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, help="complete official lichess_db_puzzle.csv.zst archive")
    parser.add_argument("output", type=Path, help="existing, empty output directory")
    parser.add_argument("--rating-min", type=int, required=True)
    parser.add_argument("--rating-max", type=int, required=True)
    parser.add_argument("--theme", action="append", default=[], help="exact Lichess theme tag; repeat for AND")
    parser.add_argument("--count", type=int, required=True, help="pack size (100-1000)")
    args = parser.parse_args()
    if not args.archive.is_file() or not args.output.is_dir():
        raise ValueError("archive must exist and output must be an existing directory")
    if any(args.output.iterdir()):
        raise ValueError("output directory must be empty")
    if not 100 <= args.count <= 1000 or args.rating_min < 0 or args.rating_max < args.rating_min:
        raise ValueError("count must be 100-1000 and rating interval must be non-negative and ordered")
    if args.rating_max - args.rating_min >= 200:
        raise ValueError("rating interval must be narrower than 200 points (e.g. 500-699)")
    if any(not re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", theme) for theme in args.theme):
        raise ValueError("themes must be exact alphanumeric Lichess tags")

    archive_hash, archive_bytes = bands.sha256_file(args.archive)
    selected = select(bands.stream_rows(args.archive), args.rating_min, args.rating_max,
                      sorted(set(args.theme)), args.count)
    pack = b"".join((json.dumps(p, sort_keys=True, separators=(",", ":")) + "\n").encode() for p in selected)
    rules = {"rating_min": args.rating_min, "rating_max": args.rating_max,
             "themes_all_required": sorted(set(args.theme)), "quality": bands.QUALITY,
             "count": args.count, "seed": SEED,
             "ordering": "ascending SHA256(seed:rating_min:rating_max:sorted_themes:PuzzleId), then PuzzleId",
             "deduplication": "first in hash order per normalized solver FEN first four fields",
             "source_scope": "complete official CSV archive"}
    manifest = {"schema_version": 1, "license": "CC0-1.0",
                "source": {"url": bands.URL, "archive_sha256": archive_hash, "archive_bytes": archive_bytes,
                           "license_source": "https://database.lichess.org/#puzzles"},
                "selection": rules, "count": len(selected),
                "checksums_sha256": {"pack.jsonl": bands.sha(pack)},
                "not_checked": ["engine optimality", "alternative winning moves", "global representativeness"]}
    (args.output / "pack.jsonl").write_bytes(pack)
    (args.output / "manifest.json").write_bytes(bands.encoded(manifest))
    print(json.dumps({"count": len(selected), "pack_sha256": bands.sha(pack), "status": "pass"}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        sys.exit(f"error: {error}")
