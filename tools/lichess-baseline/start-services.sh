#!/usr/bin/env bash
# Starts mongod + redis for the lila baseline (idempotent), data under $LILA_BASE.
# Usage: tools/lichess-baseline/start-services.sh
set -euo pipefail
source "$(dirname "$0")/env.sh"
mkdir -p "$LILA_BASE/mongo" "$LILA_BASE/redis-data" "$LILA_LOG"
if ! (${LILA_BASE}/mongodb/bin/mongod --version >/dev/null 2>&1); then
  echo "mongod missing; run tools/lichess-baseline/install-toolchain.sh first" >&2; exit 1
fi
if ! ss -tlnp 2>/dev/null | grep -q ':27017'; then
  "$LILA_BASE/mongodb/bin/mongod" \
    --dbpath "$LILA_BASE/mongo" \
    --logpath "$LILA_LOG/mongod.log" \
    --bind_ip 127.0.0.1 --port 27017 --fork
  echo "mongod forked (log: $LILA_LOG/mongod.log)"
else
  echo "mongod already running on :27017"
fi
if ! ss -tlnp 2>/dev/null | grep -q ':6379'; then
  "$LILA_BASE/redis-src/src/redis-server" \
    --dir "$LILA_BASE/redis-data" --daemonize yes \
    --logfile "$LILA_LOG/redis.log" --port 6379
  echo "redis forked (log: $LILA_LOG/redis.log)"
else
  echo "redis already running on :6379"
fi
"$LILA_BASE/redis-src/src/redis-cli" ping