# T05 — Runnable Lichess baseline: feasibility report

**Status update (2026-10-09, second attempt):** ✅ **DONE** — full unchanged Lila stack brought up
and the puzzle interaction verified end-to-end in a headless browser. See the
[second-attempt report](#second-attempt--2026-10-09-verified) below. The original first-attempt
report (status "Partial / Blocked") is preserved verbatim starting at §1.

**Original status line (first attempt):** Partial / Blocked (setup feasibility only)
**Date:** 2026-10-09
**Task:** T05 (depends on T01)
**Pinned revision:** `f5b261e3d8ece6f511484e398cb8d81e37735bea`

---

# Second attempt — 2026-10-09 (verified)

Installed the missing toolchain and services locally (no system-wide changes), compiled and ran the
UNCHANGED Lila at the pinned SHA, seeded one puzzle + its original game by hand, and drove the real
puzzle page headlessly: wrong move → failure feedback → board revert → continued solving →
solution → `win=true` completion → "Continue training" → next puzzle round. Verbatim evidence below.

Everything lives under `/tmp/opencode/lichess-baseline/**` and the repo
`tools/lichess-baseline/**`. No `apps/**`, `packages/**`, `docs/PROJECT_PLAN.md` or `data/**` were
touched, and nothing was git-committed.

## A. Key deviation from plan: no Docker

`docker` daemon was unreachable (`permission denied while trying to connect ... /var/run/docker.sock`;
user not in `docker` group; `sudo` requires a password). This was the one thing that "could not be
installed as planned", so Mongo and Redis were installed **natively instead**, fully inside the
allowed base dir (no system packages, no service units):

| Needed | Planned | Actual (verified) |
|---|---|---|
| JVM build toolchain | coursier→sbt | `cs` 2.1.26 + sbt 2.0.10 in `/tmp/opencode/lichess-baseline/bin` (sbt 2.0.10 exactly matches `project/build.properties`) |
| MongoDB | Docker `mongo:7` | official tarball, mongod **7.0.14**, dbpath `.../mongo`, log `.../logs/mongod.log`, port 27017, `--fork` |
| Redis | Docker `redis:7` | source-built redis-server **7.2.5**, dir `.../redis-data`, log `.../logs/redis.log`, port 6379, daemonized |
| pnpm | corepack/npx | **12.9.0** via `npm install -g pnpm@12.9.0 --prefix .../npm-global` (matches root `packageManager`) |
| JDK | — | mise Java **21.0.2** (`JAVA_HOME` set for sbt; JDK 27/26 warn on sbt and Lila wants ≥21) |

Exact install commands (run inside `/tmp/opencode/lichess-baseline`):

```
curl -fsSL -o bin/cs.gz https://github.com/coursier/coursier/releases/latest/download/cs-x86_64-pc-linux.gz
cd bin && gunzip -f cs.gz && chmod +x cs && ./cs version        # 2.1.26
JAVA_HOME=~/.local/share/mise/installs/java/21.0.2 PATH=... cs install sbt --install-dir .../bin && sbt --version   # 2.0.10
curl -fsSL -o mongo.tar.gz https://fastdl.mongodb.org/linux/mongodb-linux-x86_64-ubuntu2204-7.0.14.tgz && tar xzf mongo.tar.gz && mv mongodb-linux-x86_64-ubuntu2204-7.0.14 mongodb
curl -fsSL -o redis.tar.gz https://download.redis.io/releases/redis-7.2.5.tar.gz && tar xzf redis.tar.gz && mv redis-7.2.5 redis-src && make -C redis-src -j12
curl -fsSL -o mongosh.tgz https://downloads.mongodb.com/compass/mongosh-2.3.9-linux-x64.tgz && tar xzf mongosh.tgz
npm install -g pnpm@12.9.0 --prefix .../npm-global
```

Helper scripts (reproducible, idempotent):

- `tools/lichess-baseline/env.sh` — exports `JAVA_HOME`/`PATH` + documented versions.
- `tools/lichess-baseline/start-services.sh` — starts mongod + redis (data under the base dir).
- `tools/lichess-baseline/seed-baseline.sh` — imports the source game, seeds puzzle + path docs.
- `tools/lichess-baseline/verify-puzzle.mjs` — the headless interaction driver.
- `tools/lichess-baseline/stop-services.sh` — graceful shutdown (see §K).

## B. Verified execution steps (each ran, in order)

```
# 1. start services
./mongodb/bin/mongod --dbpath .../mongo --logpath .../logs/mongod.log --bind_ip 127.0.0.1 --port 27017 --fork
./redis-src/src/redis-server --dir .../redis-data --daemonize yes --logfile .../logs/redis.log --port 6379

# 2. DB indexes (onboarding step). 85 collections created, exit 0.
./mongosh-2.3.9-linux-x64/bin/mongosh --quiet mongodb://127.0.0.1:27017/lichess < lila/bin/mongodb/indexes.js   # log logs/indexes.log

# 3. client assets — one-shot build (onboarding `ui/build`)
cd lila && ui/build          # log logs/ui-build.log — finished in ~14 s (install was fast/cached)

# 4. backend compile (onboarding: `./lila.sh` then `compile`)
./lila.sh compile            # log logs/sbt-compile.log — [success] elapsed time: 169 s (Scala 3.8.4), 0 errors

# 5. run (onboarding: `./lila.sh` then `run`)
./lila.sh run                # log logs/lila-run.log — "Listening for HTTP on ...:9663"

# 6. seed one puzzle + its source game (see §G for the exact documents)
# 7. drive the page (see §H)
tools/lichess-baseline/verify-puzzle.mjs
```

`lila.sh` copied `.sbtopts.default`→`.sbtopts` (-Xmx8g) and `conf/application.conf.default`→
`conf/application.conf` on first run; no config was edited.

## C. Versions verified on the running stack

`java 21.0.2` / `sbt 2.0.10` / `cs 2.1.26` / `node v25.9.0` / `pnpm 12.9.0` / `mongod 7.0.14` /
`redis-server 7.2.5` / `mongosh 2.3.9` / `chromium 152.0.7977.82` / `playwright-core 1.63.0` /
Scala **3.8.4** (compile log). Lila UI build produced `public/compiled` assets + manifest
(`manifest.json` df3bf04b).

## D. Sizes and disk (all under `/tmp`, which is tmpfs 7.8 G)

| Item | Size |
|---|---|
| `lila/` tree total | 1.3 G (clone alone was 183 M) |
| `lila/target/` (compiled classes incl. bg-jobs) | 438 M |
| `lila/node_modules/` (pnpm workspace) | 459 M |
| `lila/public/` (built hashed assets) | 164 M |
| mongo data dir (`.../mongo`) | 305 M |
| mongodb/ + mongosh/ + redis-src/ binaries | ~750 M |
| coursier cache (in $HOME) | 449 M |
| sbt boot (`~/.sbt`) | 165 M |
| freed tarballs (deleted after extract) | ~90 M |

`/tmp` usage peaked at ~33% (2.6/7.8 G). Disk on / was untouched except $HOME caches (~600 M).

## E. What started vs. not

- **Started and verified:** mongod, redis-server, sbt server, forked Play app (HTTP :9663), and the
  UI asset pipeline. Redis had **37 connected clients** (Lila actively uses it).
- **Not started:** `lila-ws` (websocket server on :9664). Consequence: the browser logged
  `WebSocket ... ws://localhost:9664/socket/v5 ... ERR_CONNECTION_REFUSED` and auto-reconnects.
  **Fully non-fatal for this route** — all puzzle interaction + completion went over HTTP
  (see §H); this partially answers T01's open question "are Redis/ws avoidable".
- **Not started:** fishnet, lila-fishnet, search, lila-db-seed — all optional per onboarding.

## F. Resource usage (12 cores, ~15 GB RAM)

- First compile: **169 s wall** (parallel module compiles), 0 errors. UI build ~14 s.
- Peak RAM while `run` was live: ~9.8 GB used (`sbt` server RSS ~3.1 GB within -Xmx8g; play fork +
  mongo + node). Swap untouched. After shutdown, 9.7 GB became available again.

## G. Seeding one puzzle + its original game (bug-documented exactness)

The unchanged web bootstrap needs both the **puzzle row** and the **original game** (`GameJson`
fails with "Missing puzzle game …!" otherwise — confirmed in source, matching T01 §5). The game was created the
safe way: through Lila's own anonymous `/import` endpoint (uses Lila's Huffman move encoding, so no
binary BSON hand-crafting):

```
curl -sD - -o /dev/null -H "Host: localhost:9663" -H "Origin: http://localhost:9663" \
  -H "Referer: http://localhost:9663/import" \
  -d 'pgn=1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0&analyse=' \
  http://localhost:9663/import
# → HTTP 303 Location: /aUSQLTrH   (game id "aUSQLTrH")
```

Two bugs found while seeding, both fixed by reading Lila config/handlers (not by modifying app code):

1. **Game land in `game5`, not `game`**: Lila splits games across `game`, `game2`, … `game5` by id;
   `gameRepo.gameFromSecondary` routes by id, so `game5` is correct and no action needed.
2. **Puzzle collection is `puzzle2_puzzle`** (`conf/base.conf`: `puzzle.collection.puzzle =
   puzzle2_puzzle`), despite `bin/mongodb/indexes.js` writing to plain `puzzle` names. Early
   `/training/abcde` returned 404 until the doc was inserted into `puzzle2_puzzle`.

Puzzle convention verified against `modules/puzzle/src/main/Puzzle.scala` + `GameJson.scala`:
`fen` is the position **before** the opponent's setup move, `line` starts with that setup move,
`solution = line.tail`, `initialPly = Fen.readPly(fen)`, and `GameJson` emits `sans.take(initialPly+1)`.

Documents inserted with `mongosh` (reproduced in `seed-baseline.sh`):

```
// puzzle2_puzzle
{ _id: "abcde", gameId: "aUSQLTrH",
  fen: "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3",
  line: "g8f6 h5f7", glicko: { r: 1500, d: 500, v: 0.09 }, plays: 100, vote: 1.0, themes: ["mate"] }
// puzzle2_path  (needed for anonymous "next" selection — see §H, was "{}"" without it)
{ _id: "mix|all|1500", min: "mix|all|0000", max: "mix|all|9999", ids: ["abcde"], gen: <ms>, t: <date> }
```

Game check: `game5.findOne({_id:"aUSQLTrH"})` → 289 B, keys `_id,is,p0,p1,s,t,ca,ua,so,pgni,hp,w`
(Lila's compact Huffman `s` field — good, it exercised the real encoding path).

## H. Verbatim interaction evidence (headless Chromium via playwright-core)

Driver: `tools/lichess-baseline/verify-puzzle.mjs` (output `tools/lichess-baseline/evidence/`:
`wrong-move.png/.html`, `win-advance.png/.html`, `clean-solve-advance.png`, `summary.json`).

Bootstrap JSON extracted from the page (server-rendered, from `GET /training/abcde`, HTTP 200,
title "Puzzles • lichess.dev"):

```json
{"data":{"game":{"id":"aUSQLTrH","perf":{"key":"correspondence","name":"Correspondence"},
 "pgn":"e4 e5 Qh5 Nc6 Bc4 Nf6"},
 "puzzle":{"id":"abcde","rating":1500,"plays":100,"solution":["h5f7"],"themes":[],"initialPly":5}
 ...
```

Step-by-step (machine-reported):

1. **Load**: queen on h5, feedback `Your turn / Find the best move for white.`
2. **Wrong move** (drag h5→h4): feedback `✗ That's not the move! Try something else.`,
   body stayed `playing`, board remained `manipulable`, and the client sent
   `POST /training/complete/mix/abcde` with `win=false` (`form-data: win=false, rated=true`).
3. **Continued solving after the failure**: dragged h5→f7; moves list showed the full solved line
   `1 e4 e5 2 Qh5 Nc6 3 Bc4 Nf6 4 Qxf7# ✓` and feedback `Success! Continue training`.
   As T01 predicted (§4), after a prior failure the corrected finish does **not** send a second
   completion — exactly one `win=false` POST was recorded (preserves the recorded failure).
4. **Clean first-try solve** (fresh load): `win=true` POST returned
   `HTTP 200 {"next":{...game.json...,"puzzle":{"id":"abcde","rating":1500,"plays":107,"solution":["h5f7"]}}}`
   — plays incremented live (100→107 across runs incl. the failed ones). Initially `next` was `{}`
   because `puzzle2_path` was empty; adding one path doc fixed selection (anonymous pool builds from
   `puzzle2_path` via `PuzzleAnon`, §T01 §5 confirms `PuzzleSelector`/anon needs stored path data).
5. **Advance**: clicked the `Continue training` button (auto-next is off by default); within ~1 s
   feedback returned to `Your turn / Find the best move for white.` — the next puzzle round loaded.

Only console error: the refused `:9664` websocket (no lila-ws). No page errors, no failed HTTP
requests from the puzzle page.

## I. Blockers and exact next commands

- None for this route. The only near-miss was Docker being unusable → native mongo/redis used (§A).
- **Watch /tmp**: it is an 8.8 G tmpfs; this stack uses ~2.6 G. For a larger seed/PGN set, plan
  for it or re-point `dbpath` and `target` elsewhere.
- Full re-run recipe (all verified):
  ```
  tools/lichess-baseline/start-services.sh
  cd /tmp/opencode/lichess-baseline/lila && ./lila.sh run        # background + poll logs/lila-run.log
  tools/lichess-baseline/seed-baseline.sh
  node tools/lichess-baseline/verify-puzzle.mjs
  ```

## J. Cleanup performed

- Deleted the downloaded tarballs after extraction (`mongo/redis/mongosh` tgz).
- Stopped everything before writing this report:
  `tools/lichess-baseline/stop-services.sh` → `./lila.sh shutdown` (sbt server), killed the forked
  Play JVM (pid), `mongod --dbpath ... --shutdown`, `redis-cli shutdown nosave`.
  Verified after: all of :9663/:27017/:6379 closed, no `sbt-launch|lila.app.Lila|mongod|redis-server`
  processes, RAM back to 9.7 GB available.
- Left in place as reusable evidence: binaries/data/logs under `/tmp/opencode/lichess-baseline`
  (note: it is tmpfs — wiped on reboot), and scripts/evidence under `tools/lichess-baseline/`.

## K. Documented vs verified

- **Documented only (not executed here):** the full onboarding (Bloop, lila-db-seed, fishnet,
  lila-ws, `sbt test`, Playwright's own test runner, phone runs). `lila-ws` specifically was
  deliberately not started; its absence was observed (§E).
- **Everything else in §A–§H was executed and captured** (compile logs, network requests, DOM
  snapshots, screenshots-as-files).

## L. Recommendation for Q01 / T07 / T08 (updated)

Q01 evidence is now **measured, not just inspected**. The unchanged Lila puzzle route works and the
whole interaction (wrong-move feedback, correction-continues, completion, next-round) runs on a
stock dev stack of **sbt + JVM + mongo + redis + pnpm** with no Docker, no `lila-ws`, and no
auth/account. This strengthens the "full-fork baseline" option as a low-surprise reference, but it
also cost ~2.6 G staging + a heavyweight JVM/server process just to serve a single puzzle page —
still poor as ChessReps' long-term runtime.

- **Q01**: use this running unchanged baseline as the **comparison reference** for any
  fork/extraction spike (known-good interaction outputs are now in `tools/lichess-baseline/evidence/`).
  It does **not** tilt the decision alone: the cost/pointlessness of hosting mongo+redis+sbt for one
  puzzle argues against making the full server a durable dependency, but the fidelity is real.
- **T07**: confirmed the internal completion API returns only `{next: PuzzleData}` and selection
  needs stored `puzzle2_path` data; there is no durable per-attempt state for anonymous users
  (no attempt ID, no move trace, no timing — `win/rated` only, as T01 predicted). Do **not** build
  ChessReps' scheduling API on it; keep T04-boundary adapter + own state. A thin adapter in front
  of this dev server remains a workable online slice if a fork is chosen.
- **T08**: the client interaction is fully usable as-is for the unchanged page; the two concrete
  seed-time gotchas are (1) games land in `gameN` and puzzles in `puzzle2_puzzle`/`puzzle2_path`
  (config-driven names — bundle a seed recipe, don't hardcode), and (2) FEN-rooted bootstrapping
  still requires replacing `GameJson`'s `gameFromSecondary`+PGN requirement for offline packs.
  Everything in T01/T05 about the FEN-rooted local seam and gating host services remains valid.
  Redis appears required at runtime (37 clients) while `lila-ws` is optional for this route.

## M. Bottom line

The unchanged Lichess puzzle baseline at `f5b261e3d8ece6f511484e398cb8d81e37735bea` is fully
**runnable and interaction-verified** on this machine without Docker, system packages, or lila-ws.
Total effort this attempt: one compile (169 s) + UI build (14 s) + seeding + a scripted headless
run. Hand-off state: statuses, paths, commands, evidence and cleanup above; helper scripts under
`tools/lichess-baseline/`; data/binaries/logs under `/tmp/opencode/lichess-baseline/`.

---

## 1. Environment probes (actual versions)

| Tool | Result |
|---|---|
| Platform | Linux |
| RAM / cores / free disk | ~15 GB / 12 / 182 GB |
| Java | OpenJDK 27+35 (27) |
| Node | v25.9.0 |
| npm | 11.12.1 |
| Docker | 29.7.2 (build a7dcaa6fdb) — **present** |
| podman | not found |
| pnpm | not global; usable via `npx pnpm@12.9.0` (matches Lila root manifest `pnpm>=12`) |
| corepack | shim misconfigured under mise (no global version set); avoided `corepack enable` |
| sbt | **not found** |
| coursier / cs | **not found** |
| mongod | **not found** |
| redis-server | **not found** |
| Python 3 | present |

## 2. Lila clone (pinned revision)

- URL: `https://github.com/lichess-org/lila.git`
- Command: `git clone --depth 1 --recurse-submodules ...` (repo is shallow; no submodules fetched)
- Local path: `/tmp/opencode/lichess-baseline/lila`
- Size: **~183 MB**
- Verified: `git rev-parse HEAD` → `f5b261e3d8ece6f511484e398cb8d81e37735bea` (matches T01)

## 3. Key files reviewed at the pinned revision

Confirmed the T01 inventory still holds at this SHA:

- `lila.sh` (root): dev launcher (Play server); no one-click compose for the whole app.
- `build.sbt`: multi-module Scala/Play app — requires **sbt** (and coursier) to compile.
- `ui/package.json`: pins `pnpm@12.9.0`, `node>=24`; pnpm workspace.
- `ui/puzzle/src/puzzle.ts` (entry), `ui/puzzle/src/ctrl.ts`, `ui/puzzle/src/moveTest.ts`,
  `ui/puzzle/src/xhr.ts`, `ui/puzzle/src/session.ts`.
- `modules/puzzle/src/main/JsonView.scala`, `modules/puzzle/src/main/GameJson.scala`
  — confirm the original-game-PGN/bootstrap coupling noted in T01.
- `app/controllers/Puzzle.scala`, `modules/puzzle/src/main/ui/PuzzleUi.scala`
  — server-side page/module bootstrap.

## 4. Attempted setup path (bounded to ~20–30 min)

A full "from scratch" bring-up requires all of the following:

1. **JVM build toolchain (blocker).** sbt + coursier are not installed. Compiling the
   multi-module Scala/Play backend without them is impractical. First compile is likely
   10–30+ min on top of install.
2. **Services (blocker).** MongoDB 6–8.x and Redis are not installed locally. Docker is
   available and could run them as reversible containers.
3. **UI build.** pnpm is reachable via `npx`; the frontend assets could likely build, but
   the app still needs the compiled backend.
4. **DB seed.** Mongo must be running, then the lila DB initialized/indexed per the onboarding wiki.
5. **Processes.** Running the app needs multiple processes (e.g. `lila-ws` + lila).

Because step 1 is missing and system-wide installs were out of scope for this bounded task,
the server was not started.

## 5. Partial evidence / what succeeded

- Shallow clone at the correct pinned SHA (183 MB).
- Environment probes complete (table in §1).
- Node/pnpm frontend toolchain reachable (`npx pnpm@12.9.0`).
- Docker present, so Mongo/Redis can be containerized without host installs.
- No servers were started or left running.

## 6. Blockers and exact next commands

**Primary blocker — Scala backend build:**
```
# install coursier + sbt (recommended by Lichess onboarding), then:
curl -fLo cs https://github.com/coursier/launchers/raw/master/cs-x86_64-pc-linux.gz
# ... (or use SDKMAN: curl -s https://get.sdkman.io | bash && sdk install sbt)
```
Then `./lila.sh compile` from the repo root. Expect a large first-time dependency download.

**Secondary blocker — services (reversible via Docker):**
```
docker run -d --name lila-mongo -p 27017:27017 -v /tmp/opencode/lichess-baseline/mongo:/data/db mongo:7
docker run -d --name lila-redis -p 6379:6379 redis:7
```
Then initialize/index the lila database per the onboarding wiki, and run `lila-ws` separately.

**Tertiary — frontend-only build (insufficient alone):**
```
npx pnpm@12.9.0 --dir /tmp/opencode/lichess-baseline/lila/ui install
npx pnpm@12.9.0 --dir /tmp/opencode/lichess-baseline/lila/ui run build
```
Frontend build may succeed, but running the app still requires the backend + DB.

## 7. Resource consumption

- Clone: 183 MB. A compile/install would add multiple GB (`target/`, `node_modules/`).
- Mongo/Redis data would grow with seeding. None of this was started.

## 8. Recommendation for T07 (online adapter) and T08 (player integration)

- **T07:** Do **not** depend on unchanged Lila HTTP endpoints as ChessReps' durable
  scheduling API — they are web-internal (auth, CSRF, shape assumptions). Define the
  ChessReps application boundary first (T04) and, if a baseline server is run later, put a
  thin adapter in front of it. Own attempt/schedule/selection state ourselves.
  The `GameJson` coupling also means full web bootstrap needs the original games.
- **T08:** Keep the UI/controller interaction (`ctrl`/`moveTest`/`tree`/`view`) as reuse,
  but inject via the T04 training boundary and host services (storage, i18n, asset loader,
  navigation). Do not expect to "run the lila page" offline without extracting the host
  boundary. For the local path, build the FEN-rooted content seam
  (`solverFen` + `setupUci` + `solutionUci`) to avoid game lookup. Gate ceval/sounds/NVUI
  and timers (resume/teardown) explicitly.

## 9. Status summary

- **Works:** pinned clone at correct SHA; full environment probe; frontend toolchain
  reachable; Docker available for services.
- **Does not work:** no sbt/coursier (cannot compile backend); no Mongo/Redis; no running
  server or puzzle route; no seeded content verified; no curl/screenshot evidence.
- **Verdict:** Full unchanged-Lila baseline is a **multi-step, heavyweight setup** in this
  environment. It is achievable by a human/system with the §6 commands, but is not a
  quick win. This strengthens the case for proving the FEN-rooted local seam (T08/T10/T11)
  rather than making the full server a hard dependency.
