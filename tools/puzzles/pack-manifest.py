#!/usr/bin/env python3
"""Deterministic content manifest for the public (CC0) puzzle packs.

Scans ``data/puzzles/*/`` and emits a single ``content-manifest.json`` that
describes every pack available for CDN distribution. The manifest is the only
thing the sync worker serves: it stays tiny and cacheable, and the large
``pack.jsonl`` bytes live on the mirror named by ``--base-url``.

Each pack entry records:

* ``packId``   — the pack directory name (stable distribution id),
* ``version``  — ``sha256(pack.jsonl)[:16]``; the URL includes it, so a new
  pack revision is a *new* immutable URL (additive, never overwriting),
* ``sha256``   — the full digest of ``pack.jsonl`` for integrity checks,
* ``bytes``    — ``pack.jsonl`` size in bytes,
* ``puzzleCount`` — non-empty JSONL rows,
* ``bands``    — when ``bands.json`` exists, band ids and membership counts,
* ``license``  — always ``CC0-1.0``,
* ``url``      — ``<base-url>/<packId>/<version>/pack.jsonl``.

The base URL is an argument (default: a reserved ``.invalid`` placeholder,
never a hard-coded account or host). Output ordering is sorted by ``packId``
and JSON is serialized with sorted keys, so repeated runs are byte-identical.
No third-party imports: this runs with the system Python.
"""

import argparse
import hashlib
import json
from pathlib import Path
import sys

SCHEMA_VERSION = 1
VERSION_LENGTH = 16
LICENSE = "CC0-1.0"
DEFAULT_BASE_URL = "https://cdn.example.invalid/chessengram/packs"
DEFAULT_PUZZLES_DIR = Path(__file__).resolve().parents[2] / "data" / "puzzles"
PACK_FILE = "pack.jsonl"
BANDS_FILE = "bands.json"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def normalize_base_url(base_url):
    base = base_url.strip().rstrip("/")
    require(len(base) > 0, "base URL must not be empty")
    return base


def pack_url(base_url, pack_id, version):
    return f"{base_url}/{pack_id}/{version}/{PACK_FILE}"


def read_bands(path):
    """``bands.json`` → sorted-free ``[{id, puzzleCount}, ...]`` summary."""
    document = json.loads(path.read_bytes())
    bands = document.get("bands")
    require(isinstance(bands, list), f"{path.name}: bands must be a list")
    summary = []
    for index, band in enumerate(bands):
        require(isinstance(band, dict), f"{path.name}: bands[{index}] must be an object")
        band_id = band.get("id")
        require(isinstance(band_id, str) and len(band_id) > 0, f"{path.name}: bands[{index}] has no id")
        puzzle_ids = band.get("puzzleIds", [])
        require(isinstance(puzzle_ids, list), f"{path.name}: bands[{index}] puzzleIds must be a list")
        summary.append({"id": band_id, "puzzleCount": len(puzzle_ids)})
    return summary


def describe_pack(pack_dir, base_url):
    """Read one ``data/puzzles/<packId>/`` directory into a manifest entry."""
    pack_file = pack_dir / PACK_FILE
    require(pack_file.is_file(), f"{pack_dir.name}: {PACK_FILE} not found")
    data = pack_file.read_bytes()
    require(len(data) > 0, f"{pack_dir.name}: {PACK_FILE} is empty")
    digest = hashlib.sha256(data).hexdigest()
    version = digest[:VERSION_LENGTH]
    puzzle_count = sum(1 for line in data.split(b"\n") if line.strip())
    require(puzzle_count > 0, f"{pack_dir.name}: {PACK_FILE} contains no puzzles")
    pack = {
        "packId": pack_dir.name,
        "version": version,
        "sha256": digest,
        "bytes": len(data),
        "puzzleCount": puzzle_count,
        "license": LICENSE,
        "url": pack_url(base_url, pack_dir.name, version),
    }
    bands_file = pack_dir / BANDS_FILE
    if bands_file.is_file():
        pack["bands"] = read_bands(bands_file)
    return pack


def build_manifest(puzzles_dir, base_url=DEFAULT_BASE_URL):
    """Deterministically describe every pack directory (sorted by packId)."""
    require(puzzles_dir.is_dir(), f"puzzles directory not found: {puzzles_dir}")
    base = normalize_base_url(base_url)
    packs = [
        describe_pack(entry, base)
        for entry in sorted(puzzles_dir.iterdir(), key=lambda path: path.name)
        if entry.is_dir()
    ]
    packs.sort(key=lambda pack: pack["packId"])
    return {"schema_version": SCHEMA_VERSION, "packs": packs}


def encode_manifest(manifest):
    """Stable bytes: sorted keys, 2-space indent, trailing LF."""
    return (json.dumps(manifest, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode()


def write_manifest(path, data, force=False):
    """Write ``data`` to ``path``; refuse to clobber unless ``force``."""
    if path.exists() and not force:
        raise FileExistsError(f"{path} already exists (pass --force to overwrite)")
    if force:
        path.write_bytes(data)
    else:
        with path.open("xb") as stream:
            stream.write(data)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="path to write content-manifest.json")
    parser.add_argument("--puzzles", type=Path, default=DEFAULT_PUZZLES_DIR, help="puzzle packs directory")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="CDN base URL for pack urls")
    parser.add_argument("--force", action="store_true", help="overwrite an existing output file")
    args = parser.parse_args(argv)

    manifest = build_manifest(args.puzzles, args.base_url)
    data = encode_manifest(manifest)
    write_manifest(args.output, data, force=args.force)
    print(json.dumps({
        "output": str(args.output),
        "packs": len(manifest["packs"]),
        "bytes": len(data),
        "status": "pass",
    }))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        sys.exit(f"error: {error}")
