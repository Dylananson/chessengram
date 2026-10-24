"""Contract and determinism checks for the content-manifest builder.

``pack-manifest.py`` keeps a hyphenated name (it mirrors the shipped CLI), so it
is loaded through ``importlib`` rather than ``import``. The tool only uses the
standard library, so these tests run without the puzzle venv.
"""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

_MODULE_PATH = Path(__file__).resolve().parent / "pack-manifest.py"
_spec = importlib.util.spec_from_file_location("pack_manifest", _MODULE_PATH)
pack_manifest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pack_manifest)

PUZZLES = Path(__file__).resolve().parents[2] / "data/puzzles"
STARTER = "lichess-900-1099-v1"
BANDS = "lichess-bands-v1"
CUSTOM = "lichess-custom-v1"
BASE = "https://cdn.example.invalid/chessengram/packs"

# Recorded pack hashes (regression guard against accidental content drift).
STARTER_SHA256 = "5f26a52606c60c11c92b4d3a61e25eee66b1845bc7a09d9310042e3671da1e7f"
BANDS_SHA256 = "f83302975558f072d14daa50c00a73f55aea056aca25c5f9f2b968b60323930c"
BAND_IDS = [
    "lichess-bands-v1-0000-0999",
    "lichess-bands-v1-1000-1499",
    "lichess-bands-v1-1500-1999",
    "lichess-bands-v1-2000-2499",
    "lichess-bands-v1-2500-plus",
]


def write_pack(directory, pack_id, rows, bands=None):
    pack_dir = directory / pack_id
    pack_dir.mkdir()
    pack = b"".join(
        json.dumps(row, sort_keys=True, separators=(",", ":")).encode() + b"\n" for row in rows
    )
    (pack_dir / "pack.jsonl").write_bytes(pack)
    if bands is not None:
        (pack_dir / "bands.json").write_bytes(json.dumps({"schema_version": 1, "bands": bands}).encode())
    return pack_dir


class PackManifestTests(unittest.TestCase):
    def test_manifest_describes_the_real_packs(self):
        manifest = pack_manifest.build_manifest(PUZZLES, BASE)
        packs = {pack["packId"]: pack for pack in manifest["packs"]}

        # Sorted by packId and exactly the shipped packs.
        self.assertEqual([pack["packId"] for pack in manifest["packs"]], [STARTER, BANDS, CUSTOM])

        starter = packs[STARTER]
        self.assertEqual(starter["sha256"], STARTER_SHA256)
        self.assertEqual(starter["version"], STARTER_SHA256[:16])
        self.assertEqual(starter["bytes"], (PUZZLES / STARTER / "pack.jsonl").stat().st_size)
        self.assertEqual(starter["puzzleCount"], 100)
        self.assertEqual(starter["license"], "CC0-1.0")
        self.assertEqual(
            starter["url"], f"{BASE}/{STARTER}/{starter['version']}/pack.jsonl"
        )
        self.assertNotIn("bands", starter)

        bands = packs[BANDS]
        self.assertEqual(bands["sha256"], BANDS_SHA256)
        self.assertEqual(bands["version"], BANDS_SHA256[:16])
        self.assertEqual(bands["puzzleCount"], 2500)
        self.assertEqual([band["id"] for band in bands["bands"]], BAND_IDS)
        self.assertEqual([band["puzzleCount"] for band in bands["bands"]], [500] * 5)

        custom = packs[CUSTOM]
        self.assertEqual(custom["puzzleCount"], 10584)
        self.assertEqual(custom["sha256"], "a792a0c02ba92310f7cb7613f2fb13dc85bfe49096d62b0801f9856bf8569498")

    def test_version_changes_when_a_pack_byte_changes(self):
        with tempfile.TemporaryDirectory(prefix="chessengram-manifest-") as tmp:
            directory = Path(tmp)
            pack_file = write_pack(directory, "pack-a", [{"id": "aaa"}, {"id": "bbb"}]) / "pack.jsonl"
            before = pack_manifest.build_manifest(directory, BASE)["packs"][0]

            pack_file.write_bytes(pack_file.read_bytes() + b"\n")
            after = pack_manifest.build_manifest(directory, BASE)["packs"][0]

            self.assertNotEqual(before["version"], after["version"])
            self.assertNotEqual(before["sha256"], after["sha256"])
            # An appended blank line is not a puzzle.
            self.assertEqual(before["puzzleCount"], after["puzzleCount"])

    def test_repeated_runs_are_byte_identical(self):
        first = pack_manifest.encode_manifest(pack_manifest.build_manifest(PUZZLES, BASE))
        second = pack_manifest.encode_manifest(pack_manifest.build_manifest(PUZZLES, BASE))
        self.assertEqual(first, second)
        self.assertTrue(first.endswith(b"\n"))

        with tempfile.TemporaryDirectory(prefix="chessengram-manifest-") as tmp:
            output = Path(tmp) / "content-manifest.json"
            pack_manifest.write_manifest(output, first)
            self.assertEqual(output.read_bytes(), first)

    def test_refuses_to_overwrite_without_force(self):
        with tempfile.TemporaryDirectory(prefix="chessengram-manifest-") as tmp:
            output = Path(tmp) / "content-manifest.json"
            output.write_bytes(b"existing")
            with self.assertRaises(FileExistsError):
                pack_manifest.write_manifest(output, b"new")
            self.assertEqual(output.read_bytes(), b"existing")

            pack_manifest.write_manifest(output, b"new", force=True)
            self.assertEqual(output.read_bytes(), b"new")

    def test_missing_pack_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="chessengram-manifest-") as tmp:
            directory = Path(tmp)
            (directory / "pack-a").mkdir()  # no pack.jsonl
            with self.assertRaisesRegex(ValueError, "pack.jsonl not found"):
                pack_manifest.build_manifest(directory, BASE)

    def test_empty_pack_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="chessengram-manifest-") as tmp:
            directory = Path(tmp)
            pack_dir = directory / "pack-a"
            pack_dir.mkdir()
            (pack_dir / "pack.jsonl").write_bytes(b"")
            with self.assertRaisesRegex(ValueError, "empty"):
                pack_manifest.build_manifest(directory, BASE)

    def test_base_url_is_parameterized_and_normalized(self):
        with tempfile.TemporaryDirectory(prefix="chessengram-manifest-") as tmp:
            directory = Path(tmp)
            write_pack(directory, "pack-a", [{"id": "aaa"}])
            pack = pack_manifest.build_manifest(directory, "https://my.cdn.example/packs/")["packs"][0]
            self.assertEqual(pack["url"], f"https://my.cdn.example/packs/pack-a/{pack['version']}/pack.jsonl")

            # The default placeholder is a reserved, non-routable host.
            default = pack_manifest.build_manifest(directory)["packs"][0]
            self.assertIn(".invalid/", default["url"])
            self.assertIn(pack_manifest.DEFAULT_BASE_URL, default["url"])

    def test_main_writes_output_and_honors_force(self):
        with tempfile.TemporaryDirectory(prefix="chessengram-manifest-") as tmp:
            output = Path(tmp) / "content-manifest.json"
            argv = ["--puzzles", str(PUZZLES), "--base-url", BASE, str(output)]
            pack_manifest.main(argv)
            written = output.read_bytes()
            self.assertEqual(written, pack_manifest.encode_manifest(pack_manifest.build_manifest(PUZZLES, BASE)))

            with self.assertRaises(FileExistsError):
                pack_manifest.main(argv)
            pack_manifest.main(["--force", *argv])
            self.assertEqual(output.read_bytes(), written)


if __name__ == "__main__":
    unittest.main()
