"""Rule-level checks for the rating-band builder (no full archive required).

The archive itself (~307 MB) is not vendored, so these tests exercise the
deterministic selection rules against rows from the retained T02 snapshot.
"""

from collections import Counter
from pathlib import Path
import unittest
from unittest.mock import patch

import bands
import puzzles

SNAPSHOT = Path(__file__).resolve().parents[2] / "data/puzzles/lichess-900-1099-v1"


class BandRuleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rows = puzzles.parse_source((SNAPSHOT / "source.csv").read_bytes())
        cls.rows = [row for row in rows if puzzles.eligible(row)]

    def test_band_boundaries(self):
        self.assertEqual(bands.band_of(0), "0000-0999")
        self.assertEqual(bands.band_of(999), "0000-0999")
        self.assertEqual(bands.band_of(1000), "1000-1499")
        self.assertEqual(bands.band_of(2499), "2000-2499")
        self.assertEqual(bands.band_of(2500), "2500-plus")
        self.assertEqual(bands.band_of(9999), "2500-plus")
        self.assertIsNone(bands.band_of(-1))

    def test_primary_theme_prefers_rarest_tag(self):
        counts = {"0000-0999": Counter({"mate": 1000, "short": 500, "smotheredMate": 3})}
        self.assertEqual(
            bands.primary_theme({"Themes": "mate short smotheredMate"}, "0000-0999", counts),
            "smotheredMate",
        )

    def test_primary_theme_breaks_ties_by_name(self):
        counts = {"0000-0999": Counter({"pin": 5, "fork": 5})}
        self.assertEqual(bands.primary_theme({"Themes": "pin fork"}, "0000-0999", counts), "fork")

    def test_primary_theme_ignores_unthemed_rows(self):
        self.assertIsNone(bands.primary_theme({"Themes": ""}, "0000-0999", {"0000-0999": Counter()}))

    def test_candidate_hash_is_deterministic_and_band_scoped(self):
        self.assertEqual(
            bands.candidate_hash("0000-0999", "abcde"),
            bands.candidate_hash("0000-0999", "abcde"),
        )
        self.assertNotEqual(
            bands.candidate_hash("0000-0999", "abcde"),
            bands.candidate_hash("1000-1499", "abcde"),
        )

    @staticmethod
    def _entry(order, row):
        # Lexicographic -order first keeps the intended ascending pick order.
        return (-(10**6 - order), row["PuzzleId"], row)

    def test_selection_round_robins_themes_rarest_first(self):
        rows = self.rows[:4]
        theme_counts = {"b": Counter({"alpha": 100, "beta": 100})}
        keepers = {
            ("b", "alpha"): [self._entry(1, rows[0]), self._entry(2, rows[2])],
            ("b", "beta"): [self._entry(3, rows[1]), self._entry(4, rows[3])],
        }
        with patch.object(bands, "COUNT_PER_BAND", 3):
            selected, invalid, duplicate = bands.select_band("b", "b", keepers, theme_counts)

        self.assertEqual([p["id"] for p in selected], [rows[0]["PuzzleId"], rows[1]["PuzzleId"], rows[2]["PuzzleId"]])
        self.assertEqual((invalid, duplicate), (0, 0))

    def test_selection_skips_duplicate_solver_positions(self):
        rows = self.rows[:4]
        clone = dict(rows[0])
        clone["PuzzleId"] = "clone"
        theme_counts = {"b": Counter({"alpha": 100, "beta": 100})}
        keepers = {
            ("b", "alpha"): [self._entry(1, rows[0]), self._entry(2, clone)],
            ("b", "beta"): [self._entry(3, rows[1]), self._entry(4, rows[3])],
        }
        with patch.object(bands, "COUNT_PER_BAND", 3):
            selected, invalid, duplicate = bands.select_band("b", "b", keepers, theme_counts)

        self.assertNotIn("clone", {p["id"] for p in selected})
        self.assertEqual([p["id"] for p in selected], [rows[0]["PuzzleId"], rows[1]["PuzzleId"], rows[3]["PuzzleId"]])
        self.assertEqual((invalid, duplicate), (0, 1))

    def test_selection_fails_loudly_when_a_band_is_short(self):
        rows = self.rows[:1]
        theme_counts = {"b": Counter({"alpha": 1})}
        keepers = {("b", "alpha"): [self._entry(1, rows[0])]}
        with patch.object(bands, "COUNT_PER_BAND", 5):
            with self.assertRaises(ValueError):
                bands.select_band("b", "b", keepers, theme_counts)


if __name__ == "__main__":
    unittest.main()
