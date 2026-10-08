# T01 — Lichess puzzle reuse and dependency audit

Status: **Accepted as research** by coordinator on 2026-10-09. Runtime verification remains downstream work. Original handoff references to review below describe the agent's submission state.

## 1. Executive finding

Substantial puzzle-player reuse is credible. Lila already implements legal board destinations, promotion, automatic replies, solution comparison, a navigable variation tree, feedback, and first-error failure followed by continued solving. These are worth preserving. It is not a standalone player package: its controller and views depend on Lila's browser globals, workspace libraries, generated translations, asset loader, preferences, page layout, and HTTP services.

The smallest useful intervention is **two boundaries**, not just replacing `xhr.ts`:

1. A training boundary for durable attempts, selection, scheduling and resume, injected into the controller/bootstrap.
2. A host/content boundary providing a FEN-rooted puzzle tree, browser services, locally available assets and startup data.

The first-error behavior is a close match to D06, but the existing result flag and session strip are not durable attempt history. The web bootstrap's game-PGN requirement is also incompatible with using the puzzle CSV directly. Prove both boundaries while retaining the existing UI before deciding full fork versus extraction at G1.

**Evidence level:** static source inspection and cross-checks only. No Lila clone/build, dependency install, server startup, endpoint exercise, automated test execution, browser rendering, device measurement or offline verification was performed. Recommendations below are proposals, not new confirmed project decisions.

## 2. Revision and source method

Inspected Lila revision: **`f5b261e3d8ece6f511484e398cb8d81e37735bea`**, author/committer date **2026-10-08T12:54:49Z**, merge message “Merge pull request #22003 … modules: scala code golf”. Resolved from GitHub's `commits/master` API on 2026-10-09, then inspected raw files using the full SHA. [Commit][revision].

Every Lila file link in this document is pinned to that revision. GitHub directory listings were also requested with `?ref=f5b261e3d8ece6f511484e398cb8d81e37735bea` to identify current entry points. In particular, the entry is `ui/puzzle/src/puzzle.ts`, not `src/main.ts`, and the stylesheet entry is `ui/puzzle/css/build/puzzle.scss`, not `css/puzzle.scss`; the two guessed legacy paths returned 404 and were corrected through listings.

The [onboarding wiki][onboarding] and [database documentation][database] are live supplementary sources, read 2026-10-09, **not covered by the Lila commit pin**. The wiki displayed last edit 2026-07-12. The database displayed puzzle export update 2026-10-05 and 6,157,341 puzzles. No export was downloaded or checksummed in T01; T02 owns content provenance.

## 3. Dependency map and reuse classification

Legend: **R** = reusable logic with its supporting types; **A** = adaptation/host boundary needed; **S** = server implementation to retain online or replace locally. These are source-based classifications, not standalone-build claims.

```text
app/controllers/Puzzle.scala                     [S]
  ├─ PuzzleSelector / PuzzleComplete / Finisher  [S: selection, rating, persistence]
  ├─ JsonView → GameJson → gameRepo/lightUserApi [S: bootstrap content]
  └─ PuzzleUi.show → PageModule("puzzle", opts)  [S/A: page + assets + translations]
                         │
ui/puzzle/src/puzzle.ts → PuzzleCtrl → view/main.ts
                         │             ├─ chessground / feedback / tree
                         │             └─ side / settings / engine / navigation
                         ├─ moveTest + moveTree → chessops + lib/tree  [R/A]
                         ├─ Chessground / PromotionCtrl              [R/A]
                         ├─ xhr → lib/xhr → /training/...            [A/S]
                         ├─ session → lib/storage                    [A]
                         └─ site / i18n / $ / pubsub / ceval / voice  [A]
```

### Concrete file inventory

| Exact file(s) | Responsibility and dependency evidence | Treatment |
|---|---|---|
| [`ui/puzzle/src/ctrl.ts`][ctrl] | Owns play/try/view state, tree, board configuration, result submission, reply timers, promotion, hints, engine and session. Imports chessops, Chessground utility/draw types, `keyboard-move`, `voice`, many `lib/*` modules and local helpers. | **A**; retain interaction, inject training and host capabilities. |
| [`ui/puzzle/src/moveTest.ts`][move-test] | Compares played solution prefix with UCI line; castle aliases; accepts checkmate; returns next automatic move. | **R/A**; separate controller-shaped inputs from grading policy if practical. |
| [`ui/puzzle/src/moveTree.ts`][move-tree] | `pgnToTree`, `mergeSolution`, `nextCorrectMove`; standard-start chessops position, SAN and UCI conversions, `completeNode`. | **R/A**; add validated FEN-root creation. |
| [`ui/lib/src/tree/tree.ts`][tree] | Mutable wrapper, path traversal, node insertion, mainline/variation ordering, comments and eval state. | **R** with `path`, `ops`, `node`, `types` dependency closure; persist domain events rather than live wrapper. |
| [`ui/puzzle/src/interfaces.ts`][interfaces] | `PuzzleOpts`, `PuzzleData`, `PuzzleResult`, preferences and replay/streak types. Uses global `Uci`, `Color`, `FEN`, `I18n` and tree/engine types. | **A**; presentation DTOs are useful, not complete training schemas. |
| [`ui/puzzle/src/puzzle.ts`][entry] | `initModule`, pieces-loader wait, Snabbdom mount, controller creation, optional NVUI load, menu hover. | **A**; explicit bootstrap injection and lifecycle required. |
| [`ui/puzzle/src/view/main.ts`][view], [`view/chessground.ts`][ground] | Layout, board lifecycle, resize, wheel/pointer interaction, menu, move list, engine panels and session navigation. | **R/A**; retain board behavior; replace host/site assumptions. |
| [`ui/puzzle/src/view/tree.ts`][tree-view], [`view/feedback.ts`][feedback], [`view/side.ts`][side] | SAN/variation rendering and puzzle glyphs; hints/failure UI; player metadata, sign-up, rating, difficulty forms and training links. | **R/A**; replace rating/account/session framing with collection/attempt framing. |
| [`ui/puzzle/src/xhr.ts`][xhr], [`ui/lib/src/xhr.ts`][lib-xhr] | Completion, voting, theme votes and report transport; relative fetch, special Accept/XHR headers, form serialization. | **A/S**; narrow transport seam, insufficient alone for local operation. |
| [`ui/puzzle/src/session.ts`][session] | Browser session strip, up to 100 puzzle results, one-hour age window, keyed by user/anonymous identity. | **A**; not the durable history/session model. |
| [`ui/puzzle/css/build/puzzle.scss`][css] | Imports shared plugin/theme, uniboard layout, board menu/resize, controls, promotion, tree, engine and gauge styles, then local puzzle styles. | **A**; stylesheet dependency closure must accompany views. |
| [`app/controllers/Puzzle.scala`][server-controller] | HTML/API dispatch, preferences/performance, auth guards, rate limits, render isolation headers, completion and batch endpoints. | **S**; retain for fork baseline; application API should own ChessReps state. |
| [`modules/puzzle/src/main/ui/PuzzleUi.scala`][server-ui] | Page CSS, translations, module options, preload markup, CSP and optional keyboard/voice/NVUI assets. | **S/A**; replace with local shell equivalent for offline. |
| [`modules/puzzle/src/main/JsonView.scala`][json], [`GameJson.scala`][game-json] | Puzzle/round DTO generation and original-game SAN/player metadata loading. | **S/A**; derive normalized pack payload without mandatory game lookup. |
| [`modules/puzzle/src/main/PuzzleComplete.scala`][complete], [`PuzzleFinisher.scala`][finisher], [`PuzzleSelector.scala`][selector], [`Env.scala`][env] | Completion orchestration, Glicko/round writes, path selection, Mongo and service wiring. | **S**; these do not implement spaced repetition. |

## 4. Controller, move tests and tree behavior

### Existing behavior that matches the project

`PuzzleCtrl.initiate` reconstructs the game tree from `data.game.pgn.split(' ')`; the last mainline node is the solver's initial node. It initially shows the preceding node except in blind mode, then jumps to the initial path after a short setup animation. Solver color derives from initial node ply. It resets mode to `play` and `resultSent` to false.

The ordinary first-wrong-move path is concrete:

1. `sendMoveAt` normalizes the move, obtains SAN and the resulting position, then inserts a completed tree node.
2. `addNode` calls `moveTest` and `applyProgress`.
3. Failure sets feedback, reverts the board after 300 ms (immediately in blind mode), changes **`play → try`**, and invokes **`sendResult(false)`**.
4. The learner remains on the puzzle. Further correct moves and automatic opponent replies still work.
5. Finishing in `try` changes to `view`, but **does not call `sendResult(true)`**. This preserves the previously reported failure for that live controller.

Streak is a different path: failure enters view, ends the streak and reveals the solution. Do not select streak as the starting program for D06.

`makeCgOpts` gets legal destinations from chessops; `view/chessground.ts` sets `movable.free: false`, controls drag/select preferences, enables premoves in the appropriate reply phase, and delegates move events to promotion-aware controller methods. Ordinary illegal board drops therefore differ from a legal but incorrect solution move. **Do not assume all programmatic/keyboard inputs are protected by the board:** `sendMoveAt` itself is not a durable validation boundary and the application should validate imported sequences and move commands.

### What “moveTest” means here

[`moveTest.ts`][move-test] is production move-correctness logic, **not an automated test suite**. Its inspected behavior:

- Ignores evaluation in `view`, outside the initial-path subtree, and immediately after a move by the non-solver color.
- Slices the played nodes after the initial path and compares their UCI prefix against `puzzle.solution`.
- Permits king-to-rook castle encodings `e1a1/e1h1/e8a8/e8h8` to match `e1c1/e1g1/e8c8/e8g8` when SAN marks castling.
- Returns win for a checkmating node before comparing that node's UCI. This supports an alternative immediate mate along an otherwise accepted prefix.
- Otherwise requires the supplied line, returns fail for a mismatch, win when the solution is exhausted, or a `{move, fen, path}` reply to schedule automatically.
- Does **not** run an engine to accept arbitrary similarly winning alternatives, search transpositions, or interpret PGN explanatory branches as accepted solutions. The view's `retry` glyph/type is not evidence that this function returns an engine-based “good alternative” result.

The database's “only moves” convention and exception for multiple mates-in-one agree with this design. Q08 still needs an explicit policy for imported branching solutions and alternative wins; keeping line equality plus immediate mate initially is a recommendation, not a resolved product rule.

### Durable state gaps and timer hazards

- `resultSent` is set **before awaiting HTTP**. If completion rejects, the flag remains true and `next` may remain unresolved. In-memory duplicate suppression is not retry-safe or reload-safe idempotency.
- The local session strip is updated before the server acknowledgment. Its `complete` upserts by **puzzle ID**, overwrites previous results for that ID, expires by age, and drops old rows. It cannot preserve distinct scheduled attempts or correction events.
- A “win” feedback after correction means eventual solution completion, not a successful scored attempt. The adapted UI needs a separate immutable scored outcome and correction-complete status.
- `viewSolution` calls `sendResult(false)` and merges the line. Hints mark `hintHasBeenShown`, making the completion unrated, but do not implement our assistance policy or preserve assistance history.
- Automatic replies, initial setup and revert operations use timers. Resume/unmount/adapter switching need stale-callback protection and explicit teardown. The controller registers document/pubsub handlers; entry-point reuse should not accidentally create multiple active controllers.
- There is no active-solving/correction timing model in the inspected completion flow. Visibility handling redraws the board; it is not an implementation of Q06 timing semantics.

### Tree compatibility trap

`pgnToTree` assumes `Chess.default()`, root ply zero and a space-separated SAN sequence without PGN headers or variations. `makeTree` stores children by compact path IDs; insertion can return an existing node, and `nodeAtPath` falls back to the last matching ancestor rather than always throwing. Resume should validate paths against content versions, not silently accept any stale serialized path.

The view supports variations, but the solution contract is still a single `Uci[]`. A new FEN-rooted tree must preserve actual absolute ply and solver color while using relative path depth. In particular, `userJumpPlyDelta` currently computes bounds from `mainline.length - 1` and slices by ply, which assumes a zero-ply root. Audit that navigation when starting at a midgame FEN. Also supply the actual initial FEN to engine configuration instead of preserving the current `initialFen: undefined // always standard starting position` assumption.

## 5. Bootstrap, content and shared browser services

### Server-to-browser bootstrap

`Puzzle.renderShow` requests `jsonView.analysis`, user settings and preference JSON. `PuzzleUi.show` selects puzzle CSS, optional keyboard/voice/NVUI CSS/JS, puzzle/puzzleTheme translations, a CSP and a `PageModule("puzzle", {...})`. Module options contain `data`, `pref`, `showRatings`, `settings`, `externalEngineEndpoint`, and authenticated theme metadata. The page uses preload markup and sets zoom/zen flags; `renderShow` applies cross-site-isolation headers.

The client `initModule` waits for `site.asset.loadPieces`, finds **`main.puzzle`**, creates `PuzzleCtrl`, optionally dynamically loads `puzzle.nvui`, and patches through Snabbdom class/attribute modules. A standalone page needs both the mount element and the runtime services; a fetched JSON response cannot replace this setup.

### CSV / web / public API contracts are different

| Source shape | Position convention | Integration consequence |
|---|---|---|
| Database CSV | FEN **before** opponent's setup move; `Moves[0]` is setup; `Moves[1:]` is solution. Current documented columns also include `DailyDate`. | Apply setup exactly once; preserve raw source and actual solver FEN. Do not rigidly assume an old column count. |
| Current web `PuzzleData` | `game.pgn` contains SAN from the normal starting position **through setup**; `solution` is `puzzle.line.tail`. | Controller obtains position from PGN, not a `fen` field. CSV cannot directly fill this contract. |
| `JsonView` public single-puzzle path with `withInitialPos = true` | Adds `puzzle.fen` after setup and `lastMove`; no selected angle when called with `none`. | Useful normalized content, but not identical to `PuzzleOpts.data`: web `angle` is required and TypeScript `Puzzle` does not declare these FEN fields. |
| Legacy `bc` JSON | Numeric IDs, `realId`, branch/lines shape, different initial-ply treatment. | Do not mix it with modern web fixtures; no reason to adopt the compatibility branch for ChessReps. |

`GameJson.generate` queries the original game and fails with **“Missing puzzle game …!”** when unavailable. It emits SAN through `plies + 1`. Therefore seeding puzzle documents alone is insufficient for an unchanged web route; seed their source games too, or adapt bootstrap to FEN data. A small pack must not depend on fetching full games when the learner opens it offline.

Recommended normalized content seam: `sourceId`, dated rating/themes/source metadata, `solverFen`, optional `setupFen/setupUci`, `solutionUci`, and optional original-game context. Build a tree from these fields, with setup animation only when setup is present. Keep this domain schema separate from a temporary Lila-compatible presentation envelope.

### Shared runtime closure

| Dependency | Observed usage | Minimal spike treatment |
|---|---|---|
| `site.asset` | Piece readiness, dynamic NVUI/novelty modules, theme images; server-generated CSS/module infrastructure. | Local manifest/asset loader or retain full host online. Cache all chosen assets before claiming offline. |
| `site.sound` | Field initialization loads puzzle sounds; SAN speech, normal moves, success/failure sounds. | Inject sound capability; select cleared local sounds or explicit silent implementation. Hiding streak alone does not remove controller sound loading. |
| `i18n` | Strings, functions, `.asArray`, theme keys; optional category loading in feedback. | Bundle needed generated categories or a compatible narrow translation interface; plain string dictionary is not always equivalent. |
| `$`, DOM, location/history | Body classes, zen toggle, coordinates, route language detection, menu hover and relative navigation. | Host methods and application routes; audit body attributes/classes and lifecycle. |
| `lib/storage`, `pubsub` | Auto-next/rated/blindfold preferences, session strip, cross-tab streak/engine events. | Preferences can remain local; durable attempts must use separately versioned transactional storage. Namespace reused keys. |
| `lib/tree`, promotion, pointer, resize, view helpers | Core display and mobile input behavior. | Preserve dependencies coherently; extracting a single controller file is insufficient. |
| `keyboard-move`, `voice`, NVUI | Static imports plus preference-driven activation/dynamic assets. | Declare spike capability scope. Disabled UI preferences alone do not prove removal from bundle/import graph. |
| `CevalCtrl` and engine views | Controller always constructs ceval; actual search is allowed only in view. Engine controller has storage, visibility, worker lifecycle and engine selection. | Gate construction/views or provide an explicit disabled capability for initial spike; post-solve engine is optional to line validation. |

The [ceval controller][ceval] constructs `Engines`, registers listeners, and creates a worker when starting work. Bundled engine support would require a further audit of worker/WASM/NNUE assets, loading paths, browser support, memory and isolation headers. Its presence is **not evidence that fishnet is required to solve a puzzle**, nor that engine assets are already offline-ready. External engine endpoints are separately configured in puzzle options. No claim is made here about every transitive engine network request.

## 6. HTTP/API and server dependencies

### Inspected request sites

| Trigger | Request/shape | Local/online consequence |
|---|---|---|
| First wrong move, successful solve, reveal | `POST /training/complete/{theme}/{id}`; FormData `win`, `rated`, optional `replayDays`, `streakId`, `streakScore`, `color`. | No attempt ID, move trace, timing, schedule version or collection identity. Replace/extend under application ownership. |
| Completion response | `PuzzleResult`: optional `round {win,ratingDiff,themes}`, `next: PuzzleData`, `replayComplete`. | Useful temporary response envelope; selection and persistence must be separate internally. Explicit queue-end/error states are needed. |
| Puzzle vote / theme vote | `POST /training/{id}/vote`; `POST /training/{id}/vote/{theme}`. Theme removal may have no body. | Authenticated Lila features; omit or provide app-specific capability. |
| Report | `POST /training/{id}/report`, reason truncated to 2,000 characters. | Authenticated server action routes to reporting service; optional for local training. |
| Difficulty change | Native form `POST /training/difficulty/{angle}` from `view/side.ts`. | Bypasses puzzle `xhr.ts`; replace with settings service. |
| Color, history strip, puzzle/source-game links | Relative training, game, signup and dashboard URLs; controller `history.replaceState`/redirects. | Rewrite application navigation; otherwise offline clicks leave the working shell. |

`lib/xhr` uses `credentials: same-origin`, `cache: no-cache`, `Accept: application/web.lichess+json` and `X-Requested-With: XMLHttpRequest`. These are internal web requests, not an assurance that a different-origin application can call lichess.org directly. Use the application's own online adapter/API. Public single/next/batch/activity APIs are separate controller paths with their own auth/scopes/rate limits; source availability does not make the internal training endpoint a supported external scheduling API.

### Completion is coupled to selection and rating

`PuzzleComplete.onComplete` dispatches streak, authenticated replay/normal, and anonymous cases. Normal authenticated completion invokes `PuzzleFinisher`, updates the puzzle session, then selects/serializes the next puzzle. Anonymous completion increments plays and selects a next puzzle; it does not create a durable personal schedule. Replay may return `replayComplete` without a next puzzle. The current browser deferred-next logic depends heavily on those shapes, so queue exhaustion needs a deliberate app result rather than relying on redirects to Lila theme pages.

`PuzzleFinisher` stores rounds identified by **user + puzzle**, uses previous rounds, computes Glicko for first rated results, writes performance/history and increments puzzle plays. This is a rating/history system, not an append-only attempt log or SRS queue. Do not overload it as the scheduler's source of truth. `PuzzleSelector` follows stored puzzle paths, checks existing rounds/color, and retries or changes tiers; it does not select items by SRS due time.

`Env` explicitly needs Mongo, cache/mongo-cache APIs, user/light-user services, history, game repository, external-engine metadata, actor/stream infrastructure and translation. It creates puzzle/round/path collections and schedules tagger/path-health work. The full application host can initialize additional modules beyond this graph: the graph is a puzzle-route audit, not proof of a surgically minimal Lila server.

## 7. Minimum setup versus optional services

### Full-fork baseline for T05

The live onboarding guide prescribes Linux/macOS, 64-bit CPU, at least 8 GB RAM, JDK **>=21**, coursier **>=2**/sbt, Node **>=24**, pnpm, MongoDB **6–8.x**, Redis and a separate **lila-ws** process. Its workflow includes recursive clone, Mongo indexes, `ui/build`, then `./lila.sh` with `compile` and `run`; HTTP development port is 9663. These are documented requirements, **not commands executed in this audit**.

Pinned manifests refine the UI requirements: root and build packages specify **pnpm 12.9.0**, Node >=24/pnpm >=12; root lists Chessground `^10.4.2`, chessops `^0.15.1`, Snabbdom **3.5.1** deliberately pinned; build package lists TypeScript **7.0.2**, esbuild **0.28.2**, sasso and lightningcss. These are declarations, not a verified resolved dependency graph. Retain the pinned lockfile when implementing and record actual installed versions. The wiki's formatting advice is older than the root manifest's oxfmt/oxlint scripts; prefer revision-local scripts for checks.

For an unchanged seed route, additionally provide a puzzle plus its original game, suitable indexes/configuration, and selection data if testing normal Next. Explicit-ID rendering can narrow the seed requirement, but does not prove ordinary selection works. Authenticated selection depends on path data; anonymous selection is a distinct implementation and must be verified separately. Obtain and pin seed tooling before using it; the wiki's seed repository was not audited here.

| Component | Full Lila baseline | Focused local player |
|---|---|---|
| JVM/Scala/Play + UI build | Required host/build stack. | UI toolchain at build time; no JVM at solve time if extraction succeeds. |
| MongoDB | Puzzle/round/path and game/user persistence. | Browser content/progress storage instead. |
| Redis + lila-ws | Include documented baseline to preserve host behavior. Puzzle move checking itself is client-side. Whether these can be stopped for the isolated route remains a T05 experiment. | No inherent need in line-solving core; remove host socket dependency. |
| Source game database | Required by unchanged `GameJson`. | Optional metadata after FEN bootstrap adaptation. |
| Fishnet analysis worker | Explicitly optional in onboarding; server analysis feature. | Not required for prescribed solution replay. |
| lila-fishnet + client | Optional “play with computer”. | Not required. |
| Search service | Optional onboarding feature. | Not required. |
| Browser engine | Optional post-solve analysis; controller currently coupled to its wrapper. | Disable initially, or separately bundle and measure. |
| Accounts/email/reporting/payments/streaming/CDN | Host or production features, not the core solver's algorithm. | No need for personal local training; local shell must avoid accidental requests. |

Do not turn “not used by moveTest” into “safe to remove from full application startup.” T05 should record services actually started, console errors and route behavior before claiming a reduced baseline.

## 8. Proposed adapter seams for T04/T07/T08/T10

The following operations describe responsibilities, **not approved signatures**:

| Seam | Online implementation | Bundled local implementation |
|---|---|---|
| `startOrResumeSession(collection, program)` | Application API returns queue/current attempt + content version. | Browser transaction reads or creates the same session state. |
| `loadPuzzle(contentRef)` | Application content store/pack, rendered into shared DTO. | Installed validated pack; no game/network fallback. |
| `recordAttemptEvent(attemptId, sequence, event)` | Durable deduplicated event or command handling. | Transactional event storage and current-attempt projection. |
| `commitScoredOutcome(attemptId, outcome, timing, assistance)` | Idempotent scheduling update and receipt. | Same logical transaction/invariants with local scheduling core. |
| `finishCorrection(attemptId, trace)` | Record eventual completion without changing failure. | Same; distinct from a new scheduled retry. |
| `selectNext(sessionId, priorReceipt)` | Queue selection separate from scoring. | Local due/new/relearning selection under same contract. |
| Host settings/navigation/assets/sound | Lila-host bridge or application shell. | Bundled shell and capabilities. |

Inject the service through the entry/constructor; replace `sendResult`'s direct static transport import, and make initiation/resume consume persisted attempt state. A compatibility adapter may return `PuzzleResult.next` initially to reduce UI churn, but do not require early next selection merely to save the first failure. Queue-end, pending-save and retryable-error states need explicit UI behavior.

Persist the first failure before treating the attempt as safely recorded; correction completion is a separate fact. Stable attempt IDs, event/command deduplication and atomic schedule updates must survive lost acknowledgments, reload and repeated submissions. Root puzzle ID alone cannot identify a later review. T04 also needs collection-sharing policy Q09, schema/content versions and scheduling authority Q02. Raw moves, assistance, active solving time and correction time should outlive scheduler versions.

Service-worker HTTP interception remains a viable compatibility experiment, but cannot by itself supply the initial server-rendered `PuzzleOpts`, DOM and assets, nor intercept native navigation into missing pages reliably as an application design. Prefer an explicit service boundary first; use shell caching to prove startup later. A local server on the developer's laptop is not independent phone offline operation.

## 9. Licensing and asset provenance

Pinned [`COPYING.md`][copying] states default **AGPL-3.0-or-later** for Lila files unless excepted. Extracting/adapting the controller/views does not avoid their license. A full fork and substantial extraction both need corresponding-source/notices handling appropriate to distribution and remote use of modified software. Preserve upstream notices and record modifications/source revision; final application license remains Q11 for T12.

The dataset is separately **CC0**, as are the listed `translation/source/puzzleTheme.xml` theme translations. CC0 puzzle data does not relicense player code or artwork.

Concrete asset findings from `COPYING.md`:

- Lichess logos/favicon/apple-touch icon are restricted to referring to lichess.org: provide ChessReps branding.
- Puzzle-theme icons are attributed to game-icons.net under **CC BY 3.0**.
- The puzzle controller explicitly loads `lisp/PuzzleStormGood` and `lisp/PuzzleStormEnd`; the lisp sound family is listed **CC BY-NC-SA 4.0**. Decide intentionally whether to retain under its terms, replace or mute; do not call the whole sound directory AGPL.
- Many piece sets, including horsey/california and several sadsnake1 sets, have **CC BY-NC-SA** terms. Others have distinct terms: `rhosgfx` **CC0**, `chessnut` **Apache-2.0**, fantasy/spatial/celtic **MIT**, cburnett/merida **GPLv2+**.
- Icon fonts have mixed listed terms; the chess font is **GPLv2+**, Noto Sans/Roboto are listed **Apache-2.0**, and some other artwork/sounds have restricted or unclear terms.

Recommendation: whitelist one cleared piece set and board style, minimal fonts/icons, locally licensed sounds or silence, and new branding. Maintain an asset manifest with upstream path, author, license, source revision and notices. Shipping all `public/` unnecessarily expands the provenance work.

Third-party npm packages have their own licenses. This audit inspected Lila dependency declarations, **not every resolved package's license file**; verify exact Chessground, chessops, Snabbdom, sound/engine and transitive package licenses from the lockfile/source before redistribution. Do not infer their terms from Lila's default notice. Engine binaries and NNUE assets require their own inventory if enabled.

## 10. Fair full-fork versus extraction comparison

| Dimension | Full Lila fork | Extract/adapt puzzle frontend |
|---|---|---|
| Initial interaction fidelity | Best starting point: established controller, complete host, preferences, styling and accessibility integration. | Same core reusable, but host reconstruction can cause subtle rendering/input regressions. |
| Online baseline effort | Large documented stack, but no need to rediscover host contracts before first render. | Smaller eventual server, but the private workspace player is not a publishable standalone package. |
| Training changes | New attempt/schedule API can coexist with original rating APIs; easier baseline comparison. | Easier to make training domain primary; must replace rating/account UI and preserve interaction carefully. |
| Offline work | Still needs an alternate bootstrap and local persistence path. Retaining server code does not eliminate a bundled client shell. | Natural fit once globals, assets, tree roots and runtime services are bounded; extraction cost is real. |
| Upstream maintenance | Context and surrounding changes available; custom patches can remain localized. Broad dependency/security updates and merge work continue. | Smaller owned surface; selected upstream fixes require deliberate porting and dependency tracking. |
| Feature preservation | Analysis, voice/NVUI, preferences and source-game links easier to retain online. | Can select capabilities deliberately, but omitted features must be recognized and added back where required. |
| Operational footprint | JVM, Mongo, Redis/ws baseline and seed/asset tooling. | Static client plus optional application API/storage; actual footprint unmeasured. |
| Licensing | AGPL plus broad asset inventory if shipped. | Same AGPL obligations for reused code, narrower asset inventory possible. |

Neither route is selected by this audit. A focused library-only player could reduce host coupling further, but would reimplement more interaction and is not automatically preferable to substantial reuse. The Flutter option is not audited here and cannot be fairly ranked from this TypeScript/Scala investigation.

**Recommendation:** use the full fork to establish T05's known interaction baseline, keep training changes at the same explicit seams an extracted host would need, and prove a small bundled local shell before expanding functionality. At G1 compare measured setup time, touched-file/dependency count, network traces, bundle/cache size, phone behavior, persistence recovery and upstream patch size. If full-host complexity persists without improving required behavior, extraction gains weight; if faithful extraction requires reproducing much of the host, a fork with a bounded offline shell may be cheaper.

## 11. Recommended minimum online/local spike and exit evidence

These are proposed work packages for the downstream tasks, not work performed in T01.

### A. T05 baseline and T07/T08 online slice

1. Check out the exact revision and pin auxiliary repositories/tooling. Follow revision-compatible onboarding; record all processes and actual resource use.
2. Seed one original puzzle **and source game** to render an unchanged explicit-ID route. Verify drag, click/tap, wrong move, reply, promotion and completion before customization. Separately prove Next with appropriate seed selection data.
3. Add the adapter injection, FEN-root bootstrap and application-owned attempt IDs. Use a few validated T02 items, including an around-1000 item; preserve the larger pack for subsequent session testing.
4. Start/resume an attempt through the application API. Persist first failure, continue correcting, finish, then explicitly select Next. Retain immutable failure and distinct correction completion. Explicit Next is a proposed spike setting, not a newly confirmed default.
5. Disable optional engines/streak/report/vote features through capabilities. Replace relative navigation and rating/account framing where necessary; retain promotion, pointer behavior and tree feedback.
6. Exercise duplicate submission/lost acknowledgment and reload after failure. Compare durable attempt and schedule records against the UI, not just a success toast.

### B. Early boundary check, then T10/T11 offline slice

1. Run the same adapted controller/view with local bootstrap and a local adapter over the identical content fixture. An in-memory adapter is useful for boundary discovery, but cannot satisfy persistence acceptance.
2. Add transactional browser persistence for content, attempts, schedule and session. Save events/score receipts using the same identity and deduplication rules as online.
3. Bundle the shell, translations, CSS, pieces and selected sounds. Eliminate source-game fetch requirements and classify each residual network request.
4. With network disabled, **reload**, solve multiple puzzles, make a first error then correct, close/reopen and resume, and inspect persisted records. Include a phone run and promotion/castling edge cases. Reload is essential: merely continuing an already-loaded page proves much less.
5. Record install/cache bytes, optional asset exclusions, network log, console errors, state snapshots and target-browser/device versions. Engine analysis can be a subsequent capability spike.

### Meaningful verification cases to add downstream

No automated suite was run or asserted complete in T01. Required regression cases include: setup move applied exactly once; black-to-move/midgame-root navigation; legal-wrong versus illegal-drop distinction; castle aliases; promotion/underpromotion and en passant; alternate immediate mate; failed-then-corrected attempt; hint/reveal assistance; stale reply timer after session change; duplicate/lost acknowledgment; reload in correction; same puzzle reviewed under a new attempt ID; queue exhaustion without hanging `next.promise`; and online/local contract equivalence. These target known boundary risks rather than mirroring implementation details.

## 12. Open questions and blockers

| Question / limitation | Owner or gate |
|---|---|
| Where is scheduling authoritative online, and how is identical local behavior maintained without conflicting updates? | T04 / Q02 |
| How much of `PuzzleData`/`PuzzleResult` should survive versus a normalized content and explicit queue result? | T04 / Q03 |
| Hints/reveals, alternate winning moves and accepted PGN branches need explicit grading policy. | T03/T08 / Q07–Q08 |
| Shared progress across collections, attempt identity, content versions, transactional resume and timer semantics remain unspecified. | T04 / Q06, Q09 |
| Can a pinned seed set cover puzzle, game and path selection without large imports? | T05; `GameJson`/selector source identifies the dependency, not a verified seed recipe. |
| Are Redis/ws avoidable for an isolated fork route without unrelated host failures? | T05 runtime observation required. |
| What is the smallest faithful host-service/CSS/type dependency closure? | T08/T11 build and browser evidence required. |
| Which exact dependency licenses and asset files will ship? | T12 / Q11; resolved-package and chosen-asset inventory outstanding. |
| Do chosen mobile browsers support the resulting bundle, storage and optional engine paths adequately? | T11/T15; build browserslist includes Safari/iOS >=16.2, but is not a device guarantee. |

No source-access blocker remains for T01. The implementation gates are genuinely open: **runtime compatibility, reduced service requirements, final legal inventory and offline behavior have not been verified**. Keep the task in review until the coordinator accepts this evidence; do not infer completion of T05 or T11.

## 13. Acceptance evidence and handoff

| T01 criterion | Evidence produced / actual check result |
|---|---|
| Exact upstream revision and current paths | GitHub commit API resolved SHA/date; pinned raw-file fetches succeeded for linked inspected files. Directory listings corrected the two 404 path guesses. |
| Controller/move correctness/tree audit | Cross-read `ctrl.ts`, `moveTest.ts`, `moveTree.ts`, shared tree implementation and tree view. Verified source branches for first failure, correction, castle aliases and immediate-mate acceptance; identified FEN-root navigation risk. |
| Bootstrap/views/shared dependencies | Cross-read server render/UI/JSON, client entry, interfaces, board/main/side/feedback views and stylesheet imports. Recorded globals, preferences, generated translations, host navigation and optional engine coupling. |
| API/server dependence | Cross-read client transport with controller, completion, finisher, selector and environment wiring. Confirmed limited result payload, next-selection coupling, user+puzzle round identity and mandatory original-game lookup for unchanged bootstrap. |
| Setup versus optional services | Cross-checked live onboarding against pinned root/build/puzzle manifests and puzzle service graph. Marked service reductions as hypotheses, not verified instructions. |
| License/assets | Read pinned `COPYING.md`; cross-checked controller sound names and database CC0/setup-move notes. Recorded specific restricted assets and unresolved resolved-package audit. |
| Fair architecture comparison and recommendation | Sections 8–11 compare both routes and define online/local evidence gates without deciding Q01. |
| Scope | Only `docs/research/lichess-puzzle-dependencies.md` authored, using `apply_patch`. No app build, master-plan edit or further delegation. |

Verification method was `webfetch` over pinned raw GitHub URLs, GitHub commit/contents APIs and the two live supplementary documentation URLs; it was source cross-checking, **not a test command run**. Local task instructions were read from `docs/PROJECT_PLAN.md` and `docs/tasks/README.md`. This document is the complete T01 deliverable; the coordinator can use the tables above to verify acceptance and update the plan separately.

## Source links

[revision]: https://github.com/lichess-org/lila/commit/f5b261e3d8ece6f511484e398cb8d81e37735bea
[ctrl]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/puzzle/src/ctrl.ts
[move-test]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/puzzle/src/moveTest.ts
[move-tree]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/puzzle/src/moveTree.ts
[interfaces]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/puzzle/src/interfaces.ts
[entry]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/puzzle/src/puzzle.ts
[view]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/puzzle/src/view/main.ts
[ground]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/puzzle/src/view/chessground.ts
[tree-view]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/puzzle/src/view/tree.ts
[feedback]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/puzzle/src/view/feedback.ts
[side]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/puzzle/src/view/side.ts
[xhr]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/puzzle/src/xhr.ts
[session]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/puzzle/src/session.ts
[tree]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/lib/src/tree/tree.ts
[lib-xhr]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/lib/src/xhr.ts
[ceval]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/lib/src/ceval/ctrl.ts
[css]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/puzzle/css/build/puzzle.scss
[server-controller]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/app/controllers/Puzzle.scala
[server-ui]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/modules/puzzle/src/main/ui/PuzzleUi.scala
[json]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/modules/puzzle/src/main/JsonView.scala
[game-json]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/modules/puzzle/src/main/GameJson.scala
[complete]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/modules/puzzle/src/main/PuzzleComplete.scala
[finisher]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/modules/puzzle/src/main/PuzzleFinisher.scala
[selector]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/modules/puzzle/src/main/PuzzleSelector.scala
[env]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/modules/puzzle/src/main/Env.scala
[copying]: https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/COPYING.md
[onboarding]: https://github.com/lichess-org/lila/wiki/Lichess-Development-Onboarding
[database]: https://database.lichess.org/#puzzles

Additional inspected build manifests: [root package.json](https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/package.json), [UI build package](https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/.build/package.json), [puzzle package](https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/puzzle/package.json), [puzzle tsconfig](https://github.com/lichess-org/lila/blob/f5b261e3d8ece6f511484e398cb8d81e37735bea/ui/puzzle/tsconfig.json).
