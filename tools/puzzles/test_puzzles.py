"""Content-integrity and regression checks using the real retained snapshot."""

import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import chess
import puzzles

SNAPSHOT = Path(__file__).resolve().parents[2] / "data/puzzles/lichess-900-1099-v1"


class PuzzleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = puzzles.parse_source((SNAPSHOT / "source.csv").read_bytes())
        cls.example = next(r for r in cls.rows if puzzles.eligible(r))

    def test_reproducible_bytes(self):
        first = puzzles.build_artifacts(SNAPSHOT)
        second = puzzles.build_artifacts(SNAPSHOT)
        self.assertEqual(first, second)
        for name in ("pack.jsonl", "validation.json"):
            self.assertEqual(first[name], (SNAPSHOT / name).read_bytes())

    def test_setup_is_not_first_solver_move(self):
        puzzle = puzzles.normalize(self.example)
        board = chess.Board(self.example["FEN"])
        original_turn = board.turn
        board.push_uci(puzzle["setupMove"])
        self.assertNotEqual(board.turn, original_turn)
        self.assertEqual(board.fen(), puzzle["solverFen"])
        self.assertEqual(puzzle["solution"], self.example["Moves"].split()[1:])
        self.assertEqual(puzzle["original"], self.example)

    def test_reject_illegal_setup_and_later_solution(self):
        for index in (0, 1, len(self.example["Moves"].split()) - 1):
            row = copy.deepcopy(self.example)
            moves = row["Moves"].split()
            moves[index] = "a1a1"
            row["Moves"] = " ".join(moves)
            with self.assertRaises(ValueError):
                puzzles.normalize(row)

    def test_reject_invalid_board(self):
        row = dict(self.example, FEN="8/8/8/8/8/8/8/8 w - - 0 1")
        with self.assertRaisesRegex(ValueError, "invalid starting board"):
            puzzles.normalize(row)

    def test_corrupted_source_fails_before_selection(self):
        with tempfile.TemporaryDirectory(prefix="chessreps-t02-") as tmp:
            directory = Path(tmp)
            (directory / "source.csv").write_bytes((SNAPSHOT / "source.csv").read_bytes() + b"\n")
            (directory / "source.json").write_bytes((SNAPSHOT / "source.json").read_bytes())
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                puzzles.build_artifacts(directory)

    def test_tampered_pack_is_rejected_by_verify(self):
        with tempfile.TemporaryDirectory(prefix="chessreps-t02-") as tmp:
            directory = Path(tmp)
            for name, data in puzzles.build_artifacts(SNAPSHOT).items():
                (directory / name).write_bytes(data)
            path = directory / "pack.jsonl"
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            rows[0]["solution"][0] = "a1a1"
            path.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
            with patch("sys.argv", ["puzzles.py", "verify", str(SNAPSHOT), str(directory)]):
                with self.assertRaisesRegex(ValueError, "pack.jsonl: mismatch"):
                    puzzles.main()

    def test_refuse_unbounded_http_response(self):
        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def read(self, *args):
                raise AssertionError("must not consume unbounded response")

        with tempfile.TemporaryDirectory(prefix="chessreps-t02-") as tmp:
            with patch("urllib.request.urlopen", return_value=Response()):
                with self.assertRaisesRegex(ValueError, "did not honor bounded Range"):
                    puzzles.fetch(Path(tmp))

    def test_real_promotions_replay(self):
        rows = [r for r in self.rows if puzzles.eligible(r) and any(len(m) == 5 for m in r["Moves"].split())]
        self.assertTrue(rows)
        for row in rows:
            puzzles.normalize(row)


if __name__ == "__main__":
    unittest.main()
