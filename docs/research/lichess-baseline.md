# T05 — Runnable Lichess baseline: feasibility report

**Status:** Partial / Blocked (setup feasibility only) — cannot run full Lila without build + DB stack
**Date:** 2026-10-09
**Task:** T05 (depends on T01)
**Pinned revision:** `f5b261e3d8ece6f511484e398cb8d81e37735bea`

This report records how far the unchanged Lichess puzzle route could be brought up in the
current environment, and the exact cost/blockers found. Nothing here is faked: the app was
**not** started and no puzzle route was verified. Partial evidence (tooling probes, pinned
clone, frontend toolchain) is recorded below.

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
