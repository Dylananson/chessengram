"""Deterministic filter/selection tests using the retained CC0 source snapshot."""

from pathlib import Path
import unittest

import custom_packs
import puzzles

SNAPSHOT = Path(__file__).resolve().parents[2] / "data/puzzles/lichess-900-1099-v1"


class CustomPackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = puzzles.parse_source((SNAPSHOT / "source.csv").read_bytes())

    def test_exact_rating_and_theme_intersection(self):
        row = next(r for r in self.rows if puzzles.eligible(r) and "mate" in r["Themes"].split())
        rating = int(row["Rating"])
        self.assertTrue(custom_packs.matches(row, rating, rating, ["mate"]))
        self.assertFalse(custom_packs.matches(row, rating + 1, rating + 2, ["mate"]))
        self.assertFalse(custom_packs.matches(row, rating, rating, ["notARealTheme"]))

    def test_theme_combination_requires_every_source_tag(self):
        row = next(r for r in self.rows if len(r["Themes"].split()) >= 2)
        tags = row["Themes"].split()
        self.assertTrue(custom_packs.matches(row, int(row["Rating"]), int(row["Rating"]), tags[:2]))
        self.assertFalse(custom_packs.matches(row, int(row["Rating"]), int(row["Rating"]), tags[:1] + ["notARealTheme"]))

    def test_hash_selection_is_deterministic_and_respects_filters(self):
        row = next(r for r in self.rows if puzzles.eligible(r))
        rating = int(row["Rating"])
        selected_a = custom_packs.select([row], rating, rating, [], 1)
        selected_b = custom_packs.select([row], rating, rating, [], 1)
        self.assertEqual(selected_a, selected_b)
        self.assertEqual(selected_a[0]["id"], row["PuzzleId"])

    def test_too_few_matching_rows_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "need 2"):
            custom_packs.select([], 500, 501, [], 2)

    def test_site_catalog_has_variable_rating_band_sizes_and_theme_intersections(self):
        specs = custom_packs.site_collection_specs()
        rating = [spec for spec in specs if spec["kind"] == "rating"]
        self.assertEqual([(spec["rating_min"], spec["rating_max"]) for spec in rating],
                         [(start, start + 199) for start in range(500, 2500, 200)] + [(2500, 2500)])
        self.assertEqual([spec["count"] for spec in rating], list(range(100, 1001, 100)) + [100])
        themes = [spec for spec in specs if spec["kind"] == "theme"]
        self.assertIn("fork", [spec["themes"][0] for spec in themes])
        self.assertIn("pin", [spec["themes"][0] for spec in themes])
        combinations = [spec for spec in specs if spec["kind"] == "combination"]
        self.assertTrue(all(len(spec["themes"]) == 2 and spec["count"] >= 100 for spec in combinations))


if __name__ == "__main__":
    unittest.main()
