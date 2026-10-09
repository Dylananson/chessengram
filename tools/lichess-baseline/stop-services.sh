#!/usr/bin/env bash
# Stops the lila baseline servers gracefully.
# - sbt shutdown (stops the sbt 2 x thin-client server and its forked `run`)
# - mongod --shutdown, redis-cli shutdown
# Usage: tools/lichess-baseline/stop-services.sh
set -uo pipefail
source "$(dirname "$0")/env.sh"

if ss -tlnp 2>/dev/null | grep -q ':9663'; then
  (cd "$LILA" && timeout 120 ./lila.sh shutdown) 2>&1 | tail -2 || true
fi
# any leftover forked Play JVM
for pid in $(pgrep -f "lila.app.Lila" 2>/dev/null); do kill "$pid" 2>/dev/null && echo "killed forked Play pid $pid"; done
for pid in $(pgrep -f "sbt-launch.jar" 2>/dev/null); do kill "$pid" 2>/dev/null && echo "killed sbt server pid $pid"; done

if ss -tlnp 2>/dev/null | grep -q ':27017'; then
  "$LILA_BASE/mongodb/bin/mongod" --dbpath "$LILA_BASE/mongo" --shutdown 2>&1 | tail -1 || true
fi
if ss -tlnp 2>/dev/null | grep -q ':6379'; then
  "$LILA_BASE/redis-src/src/redis-cli" -p 6379 shutdown nosave 2>/dev/null || true
fi
sleep 1
echo "ports now: $(ss -tlnp 2>/dev/null | grep -E ':9663|:27017|:6379' || echo none)"