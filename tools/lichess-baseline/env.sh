# Local (non-system) toolchain for the T05 lila baseline, second attempt (2026-10-09).
# Everything installs under /tmp/opencode/lichess-baseline or the user's coursier/sbt
# caches in $HOME -- nothing system-wide.
# Usage: source tools/lichess-baseline/env.sh

export LILA_BASE="${LILA_BASE:-/tmp/opencode/lichess-baseline}"
export LILA="$LILA_BASE/lila"
export LILA_LOG="$LILA_BASE/logs"
export JAVA_HOME="${JAVA_HOME:-/home/dtans/.local/share/mise/installs/java/21.0.2}"
export PATH="$JAVA_HOME/bin:$LILA_BASE/bin:$LILA_BASE/npm-global/bin:/home/dtans/.local/share/mise/installs/node/25.9.0/bin:$PATH"

# versions (verified 2026-10-09)
#   java  21.0.2   (mise; 27/26 rejected because sbt 2.0.10 warns on them and Lila wants >=21)
#   sbt   2.0.10   (cs install sbt -> $LILA_BASE/bin/sbt), matches project/build.properties
#   coursier 2.1.26 (cs)
#   node  25.9.0   (mise; >=24 required, ui/build gate passed)
#   pnpm  12.9.0   (npm -g --prefix $LILA_BASE/npm-global), matches root packageManager
#   mongod 7.0.14  (official tarball, runs natively -- Docker daemon inaccessible without sudo/group)
#   redis  7.2.5   (built from source with gcc/make)