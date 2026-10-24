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
SITE_PACK_ID = "lichess-custom-v1"
SITE_THEME_COUNT = 500
SITE_COMBINATION_COUNT = 100
SITE_THEME_TAGS = ["fork", "pin", "skewer", "discoveredAttack", "sacrifice", "deflection", "attraction", "clearance"]
SITE_THEME_COMBINATIONS = [
    ["fork", "pin"], ["fork", "skewer"], ["fork", "discoveredAttack"],
    ["pin", "skewer"], ["pin", "discoveredAttack"], ["skewer", "discoveredAttack"],
    ["fork", "sacrifice"], ["pin", "sacrifice"], ["fork", "deflection"],
    ["pin", "clearance"],
]


def site_collection_specs():
    specs = []
    for index, rating_min in enumerate(range(500, 2500, 200)):
        rating_max = rating_min + 199
        specs.append({
            "id": f"{SITE_PACK_ID}-rating-{rating_min}-{rating_max}",
            "name": f"Rating {rating_min}–{rating_max}",
            "rating_min": rating_min,
            "rating_max": rating_max,
            "themes": [],
            "count": (index + 1) * 100,
            "kind": "rating",
        })
    specs.append({
        "id": f"{SITE_PACK_ID}-rating-2500",
        "name": "Rating 2500",
        "rating_min": 2500,
        "rating_max": 2500,
        "themes": [],
        "count": 100,
        "kind": "rating",
    })
    for theme in SITE_THEME_TAGS:
        specs.append({
            "id": f"{SITE_PACK_ID}-theme-{theme}",
            "name": f"Theme: {theme}",
            "rating_min": 500,
            "rating_max": 2500,
            "themes": [theme],
            "count": SITE_THEME_COUNT,
            "kind": "theme",
        })
    for themes in SITE_THEME_COMBINATIONS:
        tag_slug = "-and-".join(themes)
        specs.append({
            "id": f"{SITE_PACK_ID}-theme-{tag_slug}",
            "name": " + ".join(themes),
            "rating_min": 500,
            "rating_max": 2500,
            "themes": themes,
            "count": SITE_COMBINATION_COUNT,
            "kind": "combination",
        })
    return specs


def build_site_catalog(archive: Path, output: Path):
    """One-pass build of the actual offline site catalog and ready-made sets."""
    specs = site_collection_specs()
    heaps = {spec["id"]: [] for spec in specs}
    specs_by_theme = {}
    for spec in specs:
        for theme in spec["themes"]:
            specs_by_theme.setdefault(theme, []).append(spec)

    for row in bands.stream_rows(archive):
        rating = int(row["Rating"])
        if not bands.eligible(row, rating):
            continue
        tags = set(bands.row_themes(row))
        eligible_specs = {}
        if 500 <= rating <= 2500:
            band_index = (rating - 500) // 200
            rating_spec = specs[band_index]
            eligible_specs[rating_spec["id"]] = rating_spec
        for theme in tags:
            eligible_specs.update((spec["id"], spec) for spec in specs_by_theme.get(theme, ()))
        for spec in eligible_specs.values():
            if not spec["rating_min"] <= rating <= spec["rating_max"] or not set(spec["themes"]).issubset(tags):
                continue
            heap = heaps[spec["id"]]
            candidate_limit = spec["count"] * 3
            digest = hashlib.sha256(
                f"{SEED}:{spec['id']}:{row['PuzzleId']}".encode()
            ).hexdigest()
            entry = (int(digest, 16), row["PuzzleId"], row)
            if len(heap) < candidate_limit:
                heapq.heappush(heap, (-entry[0], entry[1], entry[2]))
            elif entry[0] < -heap[0][0]:
                heapq.heapreplace(heap, (-entry[0], entry[1], entry[2]))

    puzzle_by_id = {}
    collections = []
    for spec in specs:
        candidates = sorted(heaps[spec["id"]], key=lambda item: (-item[0], item[1]))
        selected_ids, positions = [], set()
        for _neg_hash, puzzle_id, row in candidates:
            normalized = puzzles.normalize(row)
            position = " ".join(normalized["solverFen"].split()[:4])
            if position in positions:
                continue
            positions.add(position)
            selected_ids.append(puzzle_id)
            puzzle_by_id[puzzle_id] = normalized
            if len(selected_ids) == spec["count"]:
                break
        if len(selected_ids) != spec["count"]:
            raise ValueError(
                f"{spec['id']}: only {len(selected_ids)} valid unique candidates; need {spec['count']}"
            )
        collections.append({
            "id": spec["id"], "name": spec["name"], "ratingMin": spec["rating_min"],
            "ratingMax": spec["rating_max"], "themes": spec["themes"],
            "puzzleIds": selected_ids,
        })

    pack = b"".join(
        (json.dumps(puzzle_by_id[puzzle_id], sort_keys=True, separators=(",", ":")) + "\n").encode()
        for puzzle_id in sorted(puzzle_by_id)
    )
    collection_bytes = bands.encoded({"schema_version": 1, "collections": collections})
    source_hash, source_bytes = bands.sha256_file(archive)
    manifest = {
        "schema_version": 1, "id": SITE_PACK_ID, "license": "CC0-1.0",
        "source": {"url": bands.URL, "archive_sha256": source_hash, "archive_bytes": source_bytes,
                   "license_source": "https://database.lichess.org/#puzzles"},
        "selection": {"seed": SEED, "quality": bands.QUALITY,
                       "rating_ranges": "inclusive 200-point bands from 500–699 through 2300–2499, plus the 2500 singleton",
                       "theme_semantics": "exact Lichess source tags; every required tag must match",
                       "deduplication": "per-collection normalized solver FEN first four fields",
                       "collections": [{"id": c["id"], "count": len(c["puzzleIds"]), "themes": c["themes"],
                                        "ratingMin": c["ratingMin"], "ratingMax": c["ratingMax"]} for c in collections]},
        "puzzle_count": len(puzzle_by_id), "collection_count": len(collections),
        "checksums_sha256": {"pack.jsonl": bands.sha(pack), "collections.json": bands.sha(collection_bytes)},
        "not_checked": ["engine optimality", "non-checkmating alternate solutions", "global representativeness"],
    }
    if not output.is_dir() or any(output.iterdir()):
        raise ValueError("output must be an existing, empty directory")
    (output / "pack.jsonl").write_bytes(pack)
    (output / "collections.json").write_bytes(collection_bytes)
    (output / "manifest.json").write_bytes(bands.encoded(manifest))
    return manifest


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
    parser.add_argument("--site-catalog", action="store_true", help="build the complete bundled site catalog and ready-made collections in one archive pass")
    parser.add_argument("--rating-min", type=int)
    parser.add_argument("--rating-max", type=int)
    parser.add_argument("--theme", action="append", default=[], help="exact Lichess theme tag; repeat for AND")
    parser.add_argument("--count", type=int, help="pack size (100-1000)")
    args = parser.parse_args()
    if not args.archive.is_file() or not args.output.is_dir():
        raise ValueError("archive must exist and output must be an existing directory")
    if any(args.output.iterdir()):
        raise ValueError("output directory must be empty")
    if args.site_catalog:
        manifest = build_site_catalog(args.archive, args.output)
        print(json.dumps({"puzzles": manifest["puzzle_count"], "collections": manifest["collection_count"],
                          "checksums_sha256": manifest["checksums_sha256"], "status": "pass"}))
        return
    if args.rating_min is None or args.rating_max is None or args.count is None:
        parser.error("single-pack mode requires --rating-min, --rating-max, and --count")
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
