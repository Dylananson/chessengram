#!/usr/bin/env python3
"""Bounded official Lichess acquisition and deterministic offline pack building."""

import argparse
from collections import Counter
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import platform
import re
import sys
import urllib.request

import chess
import zstandard

URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst"
FIELDS = "PuzzleId FEN Moves Rating RatingDeviation Popularity NbPlays Themes GameUrl OpeningTags DailyDate".split()
RULES = {
    "rating_min": 900, "rating_max": 1099, "rating_deviation_max": 100,
    "popularity_min": 80, "plays_min": 100, "count": 100,
    "seed": "chessreps-t02-v1",
    "ordering": "ascending SHA256(UTF-8(seed + ':' + PuzzleId)), then PuzzleId",
    "deduplication": "first in hash order per ID and solver FEN first four fields (legal en passant); ignore clocks",
    "scope": "first 5000 complete data rows of official CSV; not a global random sample",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode()


def write_new(path, data):
    # Deliberately refuse overwriting an existing snapshot or pack.
    with path.open("xb") as stream:
        stream.write(data)


def fetch(directory):
    require(directory.is_dir(), "output directory must already exist")
    require(not any((directory / n).exists() for n in ("source.csv", "source.json")), "snapshot already exists")
    limit = 1024 * 1024
    request = urllib.request.Request(URL, headers={
        "Range": f"bytes=0-{limit - 1}", "Accept-Encoding": "identity",
        "User-Agent": "ChessEngram-T02/1 (bounded puzzle research)",
    })
    with urllib.request.urlopen(request, timeout=60) as response:
        # Fail closed if the server ignores Range. Never consume the whole dump.
        require(response.status == 206, "server did not honor bounded Range (expected HTTP 206)")
        headers = dict(response.headers.items())
        content_range = response.headers.get("Content-Range", "")
        require(re.fullmatch(rf"bytes 0-{limit - 1}/[0-9]+", content_range), "unexpected Content-Range")
        compressed = response.read(limit)
        require(len(compressed) == limit, "short compressed prefix")
        final_url = response.url
    # A prefix is intentionally not a complete zstd frame. Only complete CSV
    # lines are retained; the zstd end-of-frame checksum cannot be checked.
    with zstandard.ZstdDecompressor(max_window_size=128 * 1024 * 1024).stream_reader(io.BytesIO(compressed)) as stream:
        with io.BufferedReader(stream) as buffered:
            lines = []
            for _ in range(5001):
                line = buffered.readline(16384)
                require(line.endswith(b"\n"), "prefix too short or CSV line exceeds 16 KiB")
                lines.append(line)
    source = b"".join(lines)
    rows = parse_source(source)
    require(len(rows) == 5000, "expected exactly 5000 data rows")
    metadata = {
        "schema_version": 1, "url": URL, "final_url": final_url,
        "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
        "license": "CC0-1.0", "license_source": "https://database.lichess.org/#puzzles",
        "http_status": 206, "response_headers": headers,
        "requested_range": f"bytes=0-{limit - 1}",
        "compressed_prefix_bytes": len(compressed), "compressed_prefix_sha256": sha(compressed),
        "source_csv_bytes": len(source), "source_csv_sha256": sha(source),
        "data_rows": len(rows), "first_id": rows[0]["PuzzleId"], "last_id": rows[-1]["PuzzleId"],
        "snapshot_identity": "retained source.csv SHA256; URL is mutable; HTTP dates are recorded, not inferred",
        "limitations": "bounded prefix, not a global sample; compressed frame incomplete, full archive checksum unavailable",
    }
    write_new(directory / "source.csv", source)
    write_new(directory / "source.json", encoded(metadata))
    print(json.dumps({"rows": len(rows), "download_bytes": len(compressed), "csv_bytes": len(source)}))


def parse_source(data):
    reader = csv.DictReader(io.StringIO(data.decode("utf-8"), newline=""))
    require(reader.fieldnames == FIELDS, f"unexpected CSV schema: {reader.fieldnames}")
    rows = list(reader)
    for row in rows:
        require(set(row) == set(FIELDS) and all(isinstance(v, str) for v in row.values()), "malformed CSV row")
        require(re.fullmatch(r"[A-Za-z0-9]{5}", row["PuzzleId"]), "invalid puzzle ID")
        for field in ("Rating", "RatingDeviation", "Popularity", "NbPlays"):
            int(row[field])
    require(len({row["PuzzleId"] for row in rows}) == len(rows), "duplicate source IDs")
    return rows


def eligible(row):
    return (RULES["rating_min"] <= int(row["Rating"]) <= RULES["rating_max"]
            and 0 <= int(row["RatingDeviation"]) <= RULES["rating_deviation_max"]
            and RULES["popularity_min"] <= int(row["Popularity"]) <= 100
            and int(row["NbPlays"]) >= RULES["plays_min"])


def normalize(row):
    """Replay setup AND entire solution with python-chess, failing on any illegal ply."""
    board = chess.Board(row["FEN"])
    require(board.is_valid(), f'{row["PuzzleId"]}: invalid starting board')
    moves = row["Moves"].split()
    require(len(moves) >= 2 and len(moves) % 2 == 0, f'{row["PuzzleId"]}: expected setup and line ending on solver ply')
    solver_fen = None
    for index, uci in enumerate(moves):
        require(re.fullmatch(r"[a-h][1-8][a-h][1-8][qrbn]?", uci), f"invalid UCI: {uci}")
        move = chess.Move.from_uci(uci)
        require(move in board.legal_moves, f'{row["PuzzleId"]}: illegal ply {index}: {uci}')
        board.push(move)
        require(board.is_valid(), f'{row["PuzzleId"]}: invalid board after ply {index}')
        if index == 0:
            solver_fen = board.fen(en_passant="legal")
    themes = row["Themes"].split()
    if "mate" in themes:
        require(board.is_checkmate(), f'{row["PuzzleId"]}: mate theme but line does not end in mate')
    return {
        "source": "lichess", "id": row["PuzzleId"], "rating": int(row["Rating"]),
        "ratingDeviation": int(row["RatingDeviation"]), "themes": themes,
        "sourceFen": row["FEN"], "setupMove": moves[0], "solverFen": solver_fen,
        "solverColor": "white" if solver_fen.split()[1] == "w" else "black",
        "solution": moves[1:], "original": row,
    }


def build_artifacts(source_dir):
    source = (source_dir / "source.csv").read_bytes()
    metadata_bytes = (source_dir / "source.json").read_bytes()
    metadata = json.loads(metadata_bytes)
    require(sha(source) == metadata["source_csv_sha256"], "source checksum mismatch")
    require(len(source) == metadata["source_csv_bytes"], "source size mismatch")
    rows = parse_source(source)
    require(len(rows) == metadata["data_rows"] == 5000, "source row count mismatch")
    candidates = [r for r in rows if eligible(r)]
    candidates.sort(key=lambda r: (sha((RULES["seed"] + ":" + r["PuzzleId"]).encode()), r["PuzzleId"]))
    selected, positions = [], set()
    duplicate_positions = 0
    # Validate all filtered candidates, including those beyond the selected 100.
    for row in candidates:
        puzzle = normalize(row)
        position = " ".join(puzzle["solverFen"].split()[:4])
        if position in positions:
            duplicate_positions += 1
            continue
        positions.add(position)
        if len(selected) < RULES["count"]:
            selected.append(puzzle)
    require(len(selected) == RULES["count"], f"only {len(selected)} eligible unique puzzles; need 100")
    pack = b"".join((json.dumps(p, sort_keys=True, separators=(",", ":")) + "\n").encode() for p in selected)
    ratings = [p["rating"] for p in selected]
    report = {
        "status": "pass", "source_rows": len(rows), "filtered_candidates": len(candidates),
        "validated_candidates": len(candidates), "duplicate_candidate_positions": duplicate_positions,
        "selected_count": len(selected), "unique_ids": len({p["id"] for p in selected}),
        "unique_solver_positions": len({" ".join(p["solverFen"].split()[:4]) for p in selected}),
        "legal_setup_plies": len(selected), "legal_solution_plies": sum(len(p["solution"]) for p in selected),
        "rating_min": min(ratings), "rating_max": max(ratings), "rating_mean": sum(ratings) / len(ratings),
        "rating_deviation_max": max(p["ratingDeviation"] for p in selected),
        "popularity_min": min(int(p["original"]["Popularity"]) for p in selected),
        "plays_min": min(int(p["original"]["NbPlays"]) for p in selected),
        "solver_colors": dict(Counter(p["solverColor"] for p in selected)),
        "themes": dict(sorted(Counter(t for p in selected for t in p["themes"]).items())),
        "checks": ["source SHA256 and schema", "unique source IDs", "quality filters", "valid FEN before and after every ply",
                   "legal setup and every solution ply", "solver start derived after setup", "mate-tagged lines end in checkmate",
                   "unique selected IDs and normalized solver positions", "original CSV fields retained"],
        "not_checked": ["engine optimality", "alternative winning moves", "global representativeness", "historical reachability of FEN"],
        "validator": {"library": "python-chess (distribution: chess)", "version": chess.__version__},
    }
    report_bytes = encoded(report)
    manifest = {
        "schema_version": 1, "pack_id": "lichess-900-1099-starter-v1", "license": "CC0-1.0",
        "source_snapshot": metadata, "selection": RULES, "count": len(selected),
        "convention": "sourceFen/original.FEN is BEFORE setupMove; solverFen is AFTER setupMove; solution excludes setup and includes alternating solver/opponent plies",
        "serialization": "UTF-8, LF; JSONL sorted keys compact separators; JSON sorted keys indent=2 trailing LF",
        "checksums_sha256": {"source.csv": sha(source), "source.json": sha(metadata_bytes),
                            "pack.jsonl": sha(pack), "validation.json": sha(report_bytes)},
        "tool_sha256": sha(Path(__file__).read_bytes()),
        "environment": {"python": platform.python_version(), "chess": chess.__version__, "zstandard": zstandard.__version__},
    }
    return {"pack.jsonl": pack, "validation.json": report_bytes, "manifest.json": encoded(manifest)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("fetch", help="download exactly 1 MiB compressed prefix; retain first 5000 rows")
    p.add_argument("directory", type=Path)
    for command in ("build", "verify"):
        p = sub.add_parser(command)
        p.add_argument("source", type=Path)
        p.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.command == "fetch":
        fetch(args.directory)
        return
    artifacts = build_artifacts(args.source)
    require(args.output.is_dir(), "output directory must already exist")
    if args.command == "build":
        require(not any((args.output / name).exists() for name in artifacts), "output artifacts already exist")
        for name, data in artifacts.items():
            write_new(args.output / name, data)
    else:
        for name, data in artifacts.items():
            actual = (args.output / name).read_bytes()
            if name == "manifest.json":
                # Python patch versions do not affect content. Verify everything
                # else, including exact tool/dependency versions and source metadata.
                expected_json, actual_json = json.loads(data), json.loads(actual)
                expected_json["environment"]["python"] = actual_json["environment"]["python"]
                require(expected_json == actual_json, "manifest mismatch")
            else:
                require(actual == data, f"{name}: mismatch against deterministic rebuild")
    print(json.dumps({"command": args.command, "count": 100, "pack_sha256": sha(artifacts["pack.jsonl"]), "status": "pass"}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, zstandard.ZstdError) as error:
        sys.exit(f"error: {error}")
