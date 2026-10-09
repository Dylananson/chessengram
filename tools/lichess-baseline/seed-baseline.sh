#!/usr/bin/env bash
# One puzzle + source game + one path doc, seeded exactly as T05 did (idempotent).
# Produces /training/abcde (PuzzleId "abcde") backed by imported game "aUSQLTrH".
# See docs/research/lichess-baseline.md "Second attempt" for the derivation.
# Usage: tools/lichess-baseline/seed-baseline.sh   (requires running lila on :9663 + mongod)
set -euo pipefail
source "$(dirname "$0")/env.sh"
MONGOSH="$LILA_BASE/mongosh-2.3.9-linux-x64/bin/mongosh"

PGN='1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0'
echo "== import source game (returns game id) =="
LOCATION=$(curl -s -D - -o /dev/null \
  -H "Host: localhost:9663" -H "Origin: http://localhost:9663" -H "Referer: http://localhost:9663/import" \
  -d "pgn=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$PGN")&analyse=" \
  http://localhost:9663/import | tr -d '\r' | awk -F': ' '/^Location/{print $2}')
GID=${LOCATION#/}
echo "game id: $GID (from $LOCATION)"
# Lila dedupes by pgnImport hash; force a fresh id if it returns an existing hash.
# (We accept de-dup: the puzzle just references the existing game.)

echo "== insert puzzle2_puzzle doc (the active collection is puzzle2_puzzle) =="
GID="$GID" $MONGOSH --quiet "mongodb://127.0.0.1:27017/lichess" --eval '
const GID = process.env.GID;
db.puzzle2_puzzle.deleteMany({_id:"abcde"});
db.puzzle2_puzzle.insertOne({
  _id: "abcde",
  gameId: GID,
  fen: "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3",
  line: "g8f6 h5f7",
  glicko: { r: 1500, d: 500, v: 0.09 },
  plays: 100, vote: 1.0, themes: ["mate"]
});'
echo "using gameId: $GID"
$MONGOSH --quiet "mongodb://127.0.0.1:27017/lichess" --eval 'print(JSON.stringify(db.puzzle2_puzzle.findOne({_id:"abcde"}, {_id:1, gameId:1})))'

echo "== insert puzzle2_path doc so anonymous 'next' selection finds a puzzle =="
$MONGOSH --quiet "mongodb://127.0.0.1:27017/lichess" --eval '
db.puzzle2_path.deleteMany({_id:"mix|all|1500"});
db.puzzle2_path.insertOne({
  _id: "mix|all|1500", min: "mix|all|0000", max: "mix|all|9999",
  ids: ["abcde"], gen: Date.now(), t: new Date()
});'

echo "== verify route =="
curl -s -o /dev/null -w "/training/abcde -> HTTP %{http_code}\n" -H "Host: localhost:9663" "http://localhost:9663/training/abcde"