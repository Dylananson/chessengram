# Stockfish/WASM for CC-001b: which engine, bundled or not, and where it runs

Scope: the two open decisions behind **CC-001** (`docs/tasks/BACKLOG.md`) —
(1) **which engine and whether it is bundled**, and (2) **where analysis runs**
(client or server) — sized so the owner can decide with real numbers rather than
guesses. The engine work itself is the deferred task **AN-001b** ("lazy-loaded
full single-threaded build, review-mode only"); CC-001b needs the same engine to
evaluate *hundreds of games* and flag the player's mistakes.

This note is an evaluation, not an implementation. Nothing here is a decision
until the coordinator records it.

Project name: the app is being renamed to **ChessEngram** (`REN-001`, name
decision still pending); older notes call it ChessReps. "The app" below means
either.

Everything that follows was measured on **this machine** (2026-10-19) in a
scratch directory outside the repo (`/tmp/opencode/stockfish-spike/`). Nothing in
the repository was modified except this file.

## Sources and method

| Source | Used for |
|---|---|
| `npm view <pkg> …` / `npm pack --dry-run --json` (registry, 2026-10-19) | identity, version, licence, unpacked size, file count, tarball size, integrity, payload per file |
| Installed packages under `/tmp/opencode/stockfish-spike/pkgs/**` | exact file list and byte sizes, licence headers/`Copying.txt`, worker protocol, wasm-locating logic |
| Headless **Chromium** (`/usr/bin/chromium`, puppeteer-core 25.13.0) with the engine in a **Web Worker** | the only throughput numbers that matter: real browser V8, the exact deployment shape |
| Node 25.9.0 child-process UCI | cross-check of the same wasm build outside the browser |
| Engines served with and without `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` | whether a build needs cross-origin isolation |
| Minimal Vite 8.3.4 build (repo's installed vite) + preview + Chromium | whether the app's Vite setup can serve the wasm without extra config |
| [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (updated 2026-10-12) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) (updated 2026-10-02) | server-side CPU/size/memory limits and cost |

Machine: **Intel Core i5-10600 @ 3.30 GHz**, 12 threads, 15 GiB RAM, Linux,
Chromium headless. **A phone CPU is not this machine** — see the extrapolation
below, which is explicitly an assumption, not a measurement.

## Verdict in one paragraph

Bundle the **single-threaded "lite" build of Stockfish 19 from the `stockfish`
npm package (nmrugg/stockfish.js) v19.0.1** — two files,
`stockfish-19-lite-single.js` (28 KB) + `stockfish-19-lite-single.wasm`
(1.76 MiB), ~**1.16 MiB gzip** — vendored into `apps/web/public/` from the pinned
release and lazy-loaded on first use inside a **classic Web Worker**. It needs no
`SharedArrayBuffer`, no COOP/COEP headers, no `eval`, and it runs in the browser
exactly as tested. Analysis should run **client-side** (it is free, offline,
private, and fast enough: ~7 min of laptop CPU for 100 games at depth 14, tens of
minutes on a phone with a tiered depth strategy). Server-side analysis is
*technically feasible* on Workers Paid but is unnecessary here and costs
chunking machinery, an upload of the games, and offline support.

---

## Candidates

Sizes are bytes on disk as installed; gzip is `gzip -9` of that file. "Usable
payload" is what a browser actually downloads for the smallest variant that
works.

| # | Build (identity) | Version | Licence | Smallest usable payload | Variants | Threads | COOP/COEP? | Verdict |
|---|---|---|---|---|---|---|---|---|
| A | **`stockfish` (nmrugg/stockfish.js)** — Stockfish 19 | 19.0.1 (2026-10-10) | GPL-3.0 | `stockfish-19-lite-single.js` 28,230 B + `.wasm` 1,845,971 B = **1.79 MiB** (1.16 MiB gz) | full, full-single, lite, lite-single, asm.js | single or multi | **no** (single) / yes (multi) | **recommended** |
| B | `stockfish` @19 full-single | 19.0.1 | GPL-3.0 | `.js` 28,130 B + `.wasm` 99,169,054 B = **94.6 MiB** (73.8 MiB gz) | — | single | no | rejected: 94 MB lazy load |
| C | `stockfish` @19 lite (threaded) | 19.0.1 | GPL-3.0 | `.js` 33,426 + `.wasm` 1,697,617 = 1.65 MiB | — | multi | **yes** | rejected: COOP/COEP for ~2× at shallow depth |
| D | `lila-stockfish-web` — lichess's build | 0.0.11 (2025-04-22) | AGPL-3.0-or-later (package) / GPLv3 text shipped | `sf171-79.js` 27,679 + `.wasm` 528,890 = 543 KB **+ external NNUE net 2.75 MB (small) or 58.8 MB (big)** | sf171-79, sf16-7, fsf14 | multi | **yes** (pthreads; `SharedArrayBuffer` present) | rejected: needs a separate NNUE fetch + `setNnueBuffer`, module-worker only |
| E | `stockfish.js` (niklasf) | 10.0.2 (2022-05-18) | GPL-3.0 | `stockfish.wasm.js` 96,597 + `stockfish.wasm` 558,861 = **639 KB** (+1.5 MB asm.js fallback) | wasm, asm.js | single | no | rejected: 2019 engine, classical eval |
| F | `stockfish.wasm` (niklasf) | 0.10.0 (2022-05-18) | GPL-3.0 | `stockfish.js` 30,540 + `stockfish.wasm` 347,350 = **369 KB** | — | multi | **yes** | rejected: COOP/COEP; SF-classical, superseded by NNUE |
| G | `stockfish-nnue.wasm` | 1.0.0-1946a675.smolnet (2022) | GPL-3.0 | `stockfish.wasm` **12.8 MB** (net embedded) or 781 KB without | — | single | no | rejected: 12.8 MB; 2022 build |
| H | `stockfish-web` | 0.1.0 | AGPL-3.0-or-later | — | — | — | — | **not a real candidate**: package `files` list is empty and the description is a stray HTML fragment; same author as D |
| I | *no engine* | — | — | 0 | — | — | — | cannot meet CC-001b (see §"No-engine fallback") |

Notes on identity:
- **A–C** are all in one npm package, `stockfish@19.0.1` (`repository
  git://github.com/nmrugg/stockfish.js`, released 2026-10-10). The README's own
  recommendation is *"most likely, you should use the `lite single-threaded`
  engine because it is fast and does not require any complicated setup"*.
- **D** is lichess's production web build; the wasm export names
  (`nn-1c0000000000.nnue`, `nn-37f18f62d772.nnue`) are the *option defaults*, not
  embedded weights: the wasm is 516 KB, and running it without calling
  `setNnueBuffer` produces `NNUE network contributions … 0.00` and nonsense play
  (verified: `eval` on the Italian Game returned all-zero buckets and the search
  answered `b2b4`). The nets are a separate download — 2,876,624 B (small) or
  61,698,882 B (big), measured with a ranged `GET` against
  `tests.stockfishchess.org/api/nn/…`.
- **A's** lite build uses a small net by `sscg13` (`nn-61e7af4bb97d`), embedded in
  the wasm — it is self-contained.

## Licence: what bundling GPL-3.0 into an AGPL-3.0-or-later app actually requires

Verified from the installed artifacts, not from memory:

- `apps/web/public/…stockfish-19-lite-single.js` header:
  `Stockfish.js 19 (c) 2026, Chess.com, LLC … License: GPLv3`, "Based on
  Stockfish (c) T. Romstad, M. Costalba, J. Kiiski, G. Linscott and other
  contributors", "Nets by Chris Bao (sscg13)".
- The package ships `Copying.txt` = the **GNU GPL v3** text; the npm `license`
  field is `GPL-3.0`.
- The package's own `index.js` (the *Node CLI loader*) is MIT — it is not used in
  the browser and would not ship, so it adds no obligation.
- **D** declares `AGPL-3.0-or-later` in `package.json` but ships the **GPLv3**
  text; the wrapper is lichess's own and the engine inside is Stockfish (GPL).
  Both are compatible with this app (already AGPL-3.0-or-later), but the
  discrepancy is worth knowing if D were ever adopted.

**Combining GPLv3 code with AGPLv3 code is permitted** (AGPLv3 §13 expressly
allows linking with GPLv3; the combined work is conveyed under the AGPLv3, so
this app's existing AGPL-3.0-or-later outbound licence is unchanged). Bill the
GPL part's own obligations separately; in practice, for shipping a verbatim
upstream wasm inside the PWA:

1. **Notice** — add an entry to `apps/web/THIRD-PARTY-NOTICE.md` (which today
   lists chessground and chessops as GPL-3.0 but has **no Stockfish entry**):
   name, version (stockfish.js 19 / stockfish@19.0.1), source URL
   (`https://github.com/nmrugg/stockfish.js`), licence GPL-3.0, purpose
   ("local chess analysis in the CC-001 mistake finder"), and that the wasm is an
   **unmodified upstream build** (so nothing is "modified" for a §5 notice).
2. **Licence text** — include the GPLv3 text (the package's `Copying.txt`) with
   the shipped app; a link to `https://www.gnu.org/licenses/gpl-3.0.txt` alone is
   customary but shipping the file is safest.
3. **Corresponding source** — GPLv3 requires offering the *Corresponding Source*
   of the object code you convey. Because the wasm is generated by emscripten
   from Stockfish plus nmrugg's `build.js`, the accepted practice for an
   unmodified build is to point at the pinned upstream release/tag **and** its
   build instructions (repo + tag `v19.0.1` + the emscripten version the build
   pins). If the app later patches the engine, that patch must be published.
4. **No extra restrictions**, keep the notices intact, and note that the app's
   own AGPL §13 network-source obligation already exists independently of this.
5. Pin the artifact: record the SHA256 of the two files you vendor (below) so the
   notice can name an exact build.

Practical shortcut: **do not add `stockfish` as a runtime dependency.** The
published tarball is **161,366,858 B (161 MB)** and unpacks to **205,116,933 B
(205 MB)** because it carries four more flavours including two ~99 MB wasm files;
`npm ci` would pull all of it. Vendor the two files from the pinned GitHub
release assets (`https://github.com/nmrugg/stockfish.js/releases/download/v19.0.1/…`,
both verified `200`) into `apps/web/public/`. If dependency tracking is preferred,
add it as a **devDependency** and copy the pair during build.

SHA256 of the recommended pair (v19.0.1 release assets):

```
ccb130d7ff29408531c47d859a49f91d59d4f482d05a53eb1a3231a4f624c91a  stockfish-19-lite-single.js
ee4f115bdb2d32cadf96cada104a05b5ec257d7ad6f57582190b49bc71f096de  stockfish-19-lite-single.wasm
```

## Runtime requirements that affect us (verified)

For candidate **A (lite-single)**, checking the shipped `.js`:

| Requirement | Result |
|---|---|
| `SharedArrayBuffer` / COOP+COEP | **not needed** — 0 occurrences of `SharedArrayBuffer`; ran fine on a page with `crossOriginIsolated === false` |
| `eval` / `new Function` | **none** (0 occurrences) — so a CSP with `script-src 'self'` is fine |
| Cross-origin isolation with the *threaded* variants | **required** — `stockfish-19-lite.js` never reached `uciok` within a 60 s timeout without COOP/COEP; with them it starts (uciok at 235 ms) |
| Web Worker | **yes** — the documented browser API is `new Worker(url)` + `postMessage` UCI strings; every measurement below ran it in a Worker, so the UI thread never janks |
| How it finds its wasm | it derives the url from its own script URL: `pathname.replace(/\.js$/i, ".wasm")` (with a `locateFile("stockfish.wasm")` fallback). **The `.js` and `.wasm` must sit side by side with the same basename and must not be renamed independently.** |
| `import.meta.url` / ESM | not used by A (uses `document.currentScript?.src`, with a worker-scope fallback) → **classic worker**, not a module worker. **D** *does* use `import.meta.url`, so it must be loaded as an ES-module worker. |
| CSP (if one is ever added) | Chromium requires `'wasm-unsafe-eval'` (or `'unsafe-eval'`) in `script-src` to compile wasm, and `worker-src`/`script-src` must allow the worker URL. **The app currently ships no CSP at all** (verified: no `Content-Security-Policy` in `apps/web/index.html`, no `_headers`), so there is nothing to change today. |
| Browser floor | wasm + SIMD; README states Chrome/Edge/Firefox/Opera/Safari on Windows 10+/macOS 11+/**iOS 16+**/Linux/Android, and Node 14+. An older-iOS fallback would need the asm.js flavour (3.0 MB, very slow). |
| Hash/memory | ran with `Hash 32` comfortably; the engine is fine at 16–64 MB. |

**Vite is not a problem** (verified end to end, not reasoned about): in a minimal
project built with the repo's own Vite 8.3.4, putting the pair in `public/` and
calling `new Worker('/stockfish-19-lite-single.js')` produced a `dist/` containing
both files verbatim (unhashed, same basenames), and the built site served by a
static server in Chromium returned `bestmove e2e4`. The app's `vite.config.ts`
only adds a path alias and a dev proxy, so it should behave identically. What
would *break* it is letting Vite process the `.js` (e.g. `?worker` / `new
URL(..., import.meta.url)`) or a hashing step that renames the wasm away from the
`.js`: keep both in `public/` and load by plain URL.

## Throughput measurements

Method: engine in a headless-Chromium Web Worker, UCI over `postMessage`,
`uci` → `setoption Threads 1` / `Hash 32` → `isready` → per position
`position fen …` + `go depth D` (or `go nodes N`), timing from the `go` to
`bestmove`; the "batch" numbers reuse **one** worker for 40 FENs so they include
steady-state JIT/warm-up effects. FENs come from a real game (Kasparov–Topalov,
Wijk aan Zee 1999) replayed with the app's own chessops (87 plies): "first 40
plies" is opening-heavy, the "middlegame slice" (plies 11–30) is the more
representative half.

### Single position (middlegame, White to move, ~35 legal moves)

| Engine | Limit | wall | nodes | nps |
|---|---|---|---|---|
| A lite-single | depth 12 | 131 ms | 61,397 | 469k |
| A lite-single | depth 14 | 114 ms | 65,111 | 576k |
| A lite-single | depth 16 | 293 ms | 179,347 | 612k |
| A lite-single | depth 16, **MultiPV 2** | 412 ms | 261,691 | 635k |
| A lite-single | `go nodes 200000` | 341 ms | 179k* | 588k |
| A lite (threaded) | depth 12, COOP/COEP, 1 thread | 109 ms | 61,397 | 563k |
| A lite (threaded) | depth 12, COOP/COEP, **4 threads** | 47 ms | 89,731 | 1.99M |
| A lite (threaded) | depth 12, **no** COOP/COEP | **never started** (60 s timeout) | — | — |
| E (niklasf 2019) | depth 12 | not run in the single-position harness (needs `Hash 16`; see below) | — | — |
| A lite-single (Node, cross-check) | depth 12 | 111 ms | 61,397 | 558k |
| B full-single (Node, cross-check) | depth 12 | 96 ms | 26,688 | 284k |

\* engine stops at its own depth boundary; treat 200k as "≈340 ms".

Engine initialisation to `uciok` on localhost: **~110 ms** for A (1.76 MB wasm),
~235–620 ms for the threaded variant (pthread pool), ~54 ms for E (559 KB wasm).
These include fetch+compile+instantiate but no real network latency; over a
cold mobile link add the download of ~1.16 MiB gz.

The full-NNUE **B** searches *fewer* nodes for the same depth (better pruning) at
lower nps — at depth 12 the two are within noise of each other in wall time. So
"lite" costs nothing meaningful in analysis speed; it only gives up playing
strength that is irrelevant to flagging mistakes.

### Batch of 40 positions (one warm worker)

| Engine / limit | total | mean | median | max | nodes | aggregate nps |
|---|---|---|---|---|---|---|
| A lite-single, first-40 plies, d14 | 4.29 s | 104 ms | — | 226 ms | 2.75 M | 662k |
| A lite-single, first-40 plies, d16 | 9.83 s | 243 ms | — | 720 ms | 6.39 M | 659k |
| A lite-single, first-40 plies, d16 MultiPV 2 | 22.29 s | 554 ms | — | 1,171 ms | 14.4 M | 651k |
| A lite threaded (COOP/COEP, 4 threads), first-40, d16 | 9.75 s | 228 ms | — | 501 ms | 25.4 M | 2.78M |
| A lite-single, **middlegame** slice, d12 | 1.83 s | 43 ms | 25 ms | 207 ms | 1.25 M | 732k |
| A lite-single, middlegame, d14 | 4.35 s | 105 ms | 89 ms | 537 ms | 2.14 M | 508k |
| A lite-single, middlegame, d16 | 9.51 s | 235 ms | 159 ms | 976 ms | 6.63 M | 706k |
| A lite-single, middlegame, d16 MultiPV 2 | 22.70 s | 564 ms | 487 ms | 1,686 ms | 15.3 M | 679k |
| E niklasf 2019, first-40, d14 | 9.58 s | 238 ms | — | 917 ms | 10.09 M | 1.06M |
| E niklasf 2019, first-40, d16 | 24.18 s | 603 ms | — | 2,298 ms | 28.60 M | 1.19M |

Two things worth reading off this table:

- **A is ~2.3× faster in wall time than the 2019 niklasf build at equal depth**
  (4.29 s vs 9.58 s at d14) even though E has *higher* nps — E (classical eval)
  needs far more nodes for the same depth. A is also six years newer.
- **4 threads barely helped at fixed shallow depth** (9.75 s vs 9.83 s at d16)
  while doing 4× the work (25.4 M nodes vs 6.39 M). Cross-origin isolation buys
  little here; it is only worth it at long/movetime searches. (In the single
  position case it looked like 2.3×; at batch scale it disappears. Either way it
  does not pay for the COOP/COEP tax.)

### What hundreds of games would plausibly cost

Assumptions: **40 positions per game**, **100 games = 4,000 positions**, one
position per ply, single thread, depth-limited (`go depth`), reported means from
the middlegame slice. Scale linearly for other game counts.

| Strategy | laptop (measured) | phone, ×2 slower | phone, ×6 slower |
|---|---|---|---|
| depth 12, everything | 2.9 min | 5.8 min | 17 min |
| depth 14, everything | 7.0 min | 14 min | 42 min |
| depth 16, everything | 15.8 min | 32 min | 95 min |
| depth 16 + MultiPV 2, everything | 37.8 min | 1.3 h | 3.8 h |

The MultiPV-2 column is the honest worst case for "is there a unique best move",
because fairness checks want the top two lines. A cheaper, and recommended,
shape is **tiered**: screen every position at depth 12 (2.9 min/100 games) and
run depth 16 + MultiPV 2 only on positions whose shallow swing already exceeds
the threshold (typically a small minority) — roughly the depth-12 cost plus a
few minutes.

**The phone factor is an assumption, not a measurement.** I attempted to emulate
a slow device with Chromium's CDP `Emulation.setCPUThrottlingRate` and it had
**no effect on the Web Worker** (1×, 4× and 8× throttling produced identical wall
times: 42.7 / 41.0 / 46.7 ms mean at d12), so those runs are discarded. Modern
flagship phone cores are within ~1–2× of this desktop for single-threaded work,
while mid-range/older phones and thermally-throttled sustained runs are several
times slower — hence the ×2–×6 bracket. Real device numbers remain unverified
(see §"What I could not verify").

Cross-check: the same build in **Node** (child process, same machine) matched the
browser within a few percent at depth 12 (558k vs 469k nps), so the browser
number is not a headless artifact.

## Server-side: what Cloudflare actually allows

From the Workers limits and pricing pages (dated 2026-10-12 and 2026-10-02):

| Limit | Workers Free | Workers Paid |
|---|---|---|
| CPU time per HTTP invocation | **10 ms** | 30 s default, configurable to **5 min** |
| CPU time per Cron/Queue invocation | 10 ms | 30 s (<1 h interval) / **15 min** (≥1 h) |
| Memory per isolate | 128 MB | 128 MB |
| Worker bundle (uncompressed) | 64 MiB | 64 MiB |
| HTTP wall time | no limit while the client stays connected (`waitUntil` +30 s) | same |
| Included usage | — | 10 M requests + **30 M CPU-ms** per month, $5/mo; extra CPU $0.02/M ms |
| Containers | not available | 25 GiB-h + 375 vCPU-min/mo included, then $0.000020/vCPU-s |

Reading that against the measurements:

- **Free plan is a non-starter.** 10 ms CPU per invocation cannot even finish one
  middlegame position at depth 12 (median 25 ms, mean 43–130 ms).
- **Paid plan is feasible.** One 40-position game at depth 14 ≈ 4.3 s of CPU, so
  100 games ≈ 430 CPU-s ≈ 0.43 M CPU-ms — about **1.4 % of the included monthly
  CPU allowance**. Even at 3–10× slower than this laptop it stays inside the
  free-of-charge allotment; the realistic incremental cost is **~$0** on top of
  the $5/mo Workers Paid plan. (The existing sync Worker may already be on that
  plan.)
- **The engine fits the platform.** 1.8 MB wasm is trivial against the 64 MiB
  bundle limit and 128 MB memory (use `Hash ≤ 64`). Only the **single-threaded**
  build can be used — there is no `SharedArrayBuffer` in Workers.
- **The shape is chunked, not one call.** A single HTTP invocation can burn at
  most 5 min of CPU (≈70 games at d14); longer batches need a **Queue consumer**
  (15 min CPU / 15 min wall) or a Workflow, with progress written somewhere the
  UI can poll and cancellation respected. That is real machinery: a second
  engine integration, a job model, a resume story, and tests.
- **It requires uploading the games.** Sync payloads are plaintext on the server
  (`ONL-020`), so imported chess.com games and derived positions would sit
  readable in D1 — already true for training data and accepted, but CC-001 notes
  it as a fresh consideration for chess.com content. It also breaks the
  offline-first promise: no network, no analysis.
- **Containers** (native Stockfish, 5–10× faster) are available on the paid plan
  and would make a server pass quick, but they are a bigger operational surface
  than this personal app needs.

## The three integration shapes

### Shape A — bundled single-thread engine in a Worker (client-side) ✅ recommended

Bundle A into `public/`, lazy-load on first use, run in a Worker, drive batches
from the app.

- **Pros:** zero marginal cost; works offline (once cached) and on a phone with
  no account; no data leaves the device (also the cleanest read of the chess.com
  ToS analysis in `docs/research/chesscom-import.md`); no COOP/COEP, no CSP
  change, no `eval`; one engine serves both AN-001b (review mode) and CC-001b
  (batch); Vite serves it with **no config change** (verified); ~7 min/100 games
  at depth 14 on a laptop.
- **Cons:** the phone does the work — a 100-game pass is tens of minutes and must
  stay in the foreground (mobile browsers freeze backgrounded tabs; the PWA
  cannot be relied on to grind in the background); 1.16 MiB gz added to the
  lazy-load (not to first paint, if loaded on demand); the GPLv3 notice/source
  obligations above; iOS below 16 unsupported.
- **Cost:** ~$0 (static hosting only). Development cost = one engine wrapper +
  batch driver (AN-001b + CC-001b).

### Shape B — server-side (Workers Paid, or a container)

Worker (or Queue + Worker) runs the same wasm; the client uploads games and polls.

- **Pros:** the phone can be slow and cheap — the analysis finishes on
  Cloudflare's CPU; the client can close the tab.
- **Cons:** Free plan is impossible (10 ms); needs Paid plus a Queue/Workflow and
  a job/progress/resume model; the games must be uploaded (plaintext D1); no
  offline analysis; a second engine integration to keep in step with AN-001b;
  uploads of hundreds of games must themselves be chunked.
- **Cost:** ~$5/mo (already the plan) + ~$0 CPU for this workload; a container
  path would be a few cents/month for 100 games but adds a deployment surface.
- **Verdict:** feasible but a lot of machinery for a personal app whose client
  can already do the job.

### Shape C — no engine

Ship the importer and derive "mistakes" without an engine (heuristics, "you lost
material" rules), or call a third-party evaluation service.

- **Pros:** nothing to bundle, no licence question.
- **Cons:** cannot meet CC-001b. "Fair puzzle" needs a real evaluation: a
  threshold on evaluation swing, a unique-best-move check (MultiPV ≥ 2), "not
  already lost", and not-a-forced-recapture. Material heuristics misfire on
  sacrifices, and chess.com exposes no Game-Review evals (`BACKLOG.md`, CC-001b),
  while third-party cloud-eval services are rate-limited, not built for bulk
  chess.com game corpora, and would add a network dependency and another licence
  question. Keep this only as a future "no-download" mode, not as the plan.

## Recommendation

**Decision 1 — engine and bundling:** bundle **Stockfish.js 19 `lite-single`**
(`stockfish-19-lite-single.js` + `.wasm`, GPL-3.0, SHA256 above) in
`apps/web/public/`, lazy-loaded on first analysis, in a classic Web Worker. Do not
bundle the full-NNUE build (94 MB), do not require COOP/COEP for threads, and do
not add the 161 MB npm package as a runtime dependency. Rejected alternatives and
why: lila-stockfish-web (needs a separate 2.75–58.8 MB NNUE net and a module
worker), niklasf `stockfish.js@10` / `stockfish.wasm@0.10` (2019/2020 vintage,
and the latter needs COOP/COEP), `stockfish-nnue.wasm` (12.8 MB). Add the GPLv3
notice + licence text + source-offer entry to `apps/web/THIRD-PARTY-NOTICE.md`.

**Decision 2 — where it runs:** **client-side in the PWA**, with a cancellable
batch driver and a tiered depth strategy (shallow screen for all positions, deeper
+ MultiPV 2 only for candidates). It is free, offline, private, and fast enough
(≈7 min of laptop CPU for 100 games at depth 14; ≈15–45 min on a phone with the
tiered plan). Keep the engine behind the single-position API described below so
that a server-side (or desktop-run) batch remains a swap of the *driver*, not of
the engine. Server-side is documented as feasible on Workers Paid if a future
workload (thousands of games, or a shared library) makes the client cost painful,
but it is not warranted today.

## What AN-001b would own vs what CC-001b owns

Consistent with the `BACKLOG.md`/`GRAPH.md` note that AN-001b is "engine only:
lazy-loaded single-threaded build, one-position evaluation API, review-mode UI on
top of the engine-free `ReviewNavigator`/`buildReviewLine`":

| | AN-001b owns | CC-001b owns |
|---|---|---|
| Assets | the `public/` pair, the THIRD-PARTY-NOTICE entry, lazy-load + cache policy, the `#analyze-btn` wiring | nothing engine-specific |
| API | `evaluatePosition(request) → Promise<Evaluation>`: `{ fen, limit: { depth \| nodes \| movetime }, multipv }` → `{ bestMove, lines: [{ pv: string[], score: { cp? , mate? } }], depth, nodes, nps, timeMs }`, plus `cancel()`/`dispose()` and a worker-lifecycle state (`idle`/`loading`/`ready`) | consumes the API only |
| Concurrency | one worker queue; a single in-flight search, `stop` on cancel | sequential batch driver over games (never more than N workers) |
| UI | the existing review-mode analysis panel | progress + cancel + error surface for a long batch |
| Domain | UCI ↔ typed request, worker messaging, abort | game replay (chessops) → position list; mistake classification (swing threshold, unique-best via MultiPV 2, "already lost" gate, forced-recapture exclusion); persisting generated puzzles as `content` records; provenance |
| Not owned | batch orchestration, thresholds, puzzle shapes | the engine, the wasm, UCI, worker plumbing |

The shared surface is only the `Evaluation` request/response type — CC-001b must
never see UCI. To classify a played move, the driver needs two calls per ply
(the position, and the position after the played move), which is why
`evaluatePosition` takes a FEN rather than a game context. AN-001b can be built
and tested with a fake engine implementing the same type, so CC-001b is not
blocked on real wasm.

## What I could not verify

- **Real phone performance.** CDP CPU throttling did not affect the Web Worker, so
  the ×2–×6 phone bracket is an assumption. The owner's own phone is the only
  honest source.
- **PWA background/foreground behaviour during a long batch** (tab frozen when
  backgrounded, wake-lock availability, battery) — untested.
- **iOS/Safari at all** — untested; the build documents an iOS 16+ floor and
  needs the asm.js flavour below that.
- **The app's own build.** I verified a *minimal* Vite 8.3.4 project with the
  repo's vite binary (public/ assets copied verbatim, worker + wasm resolved,
  `bestmove e2e4` in Chromium), but I could not touch `apps/web/**` (another agent
  owns it) to re-run its build, and I deliberately did not modify it. The app's
  config adds only an alias + proxy, so the risk is low but unproven.
- **CSP interactions** — there is no CSP anywhere in the repo today, so nothing
  to verify. If one is added later it needs `'wasm-unsafe-eval'` (and a
  `worker-src`/`script-src` entry for the worker); the pinned load-time headers
  are worth a smoke assertion at that point.
- **Cloudflare Worker throughput for the same batch** — I did not deploy an
  engine to Workers; the server-side figures are CPU-second arithmetic on the
  laptop measurements against Cloudflare's documented CPU accounting.
- **`lila-stockfish-web` end-to-end** — I confirmed it starts, needs COOP/COEP,
  and produces meaningless output without an externally supplied NNUE net, but I
  did not wire up the net and re-measure it.
- **`stockfish.js@10` (E) was measured in the browser but only after working
  around a 32 MB memory build**: it answers `uciok`/`readyok` but hangs if you set
  `Hash 32` (its option range is `min 16 max 16`) and its `Threads` option is
  fixed at 1. Its numbers are therefore "engine as configured", not best case.
- **Whether `lite` NNUE is strong (and stable) enough to be the fairness oracle.**
  It is far above human strength and its depth-12 best move matched the full
  build, but the thresholds and the quality gate are CC-001e's job; I ran no
  classification study.
- **Legal precision.** "Offer corresponding source, ship the licence, add the
  notice" is the accepted practice for an unmodified GPL wasm; I am not a lawyer
  and this is not legal advice.

## Reproduce it

Scratch work lives in `/tmp/opencode/stockfish-spike/`:

```
npm install stockfish@19.0.1 stockfish.js@10.0.2 stockfish.wasm@0.10.0 \
            lila-stockfish-web@0.0.11 stockfish-nnue.wasm@1.0.0-1946a675.smolnet   # in pkgs/<name>/
node server.mjs                 # :8123 plain, :8124 with COOP+COEP, serving web/
node browser-bench.mjs          # single-position table (Chromium + Worker)
node batch-bench.mjs            # first-40-plies batch + timing
node batch3.mjs                 # middlegame batch
node genfens.mjs                # 87 FENs from a real game via chessops
node lila-bench.mjs             # lila-stockfish-web: starts, needs a net, needs COOP/COEP

# minimal Vite check (uses the repo's installed vite 8.3.4, no repo changes)
cd vite-test && node /home/dtans/code/chessreps/node_modules/vite/bin/vite.js build
node serve.mjs & node vite-verify.mjs     # serves dist/ and asserts a real bestmove
```

---

## How chess.com and lichess actually do it (checked 2026-10-19)

Worth recording because it answers "why is this hard on a phone" and it **calibrates
our node budgets**. Sources: lichess's "Thousands of Stockfish analysers" blog and
the `fishnet` protocol doc, lichess's analysis feature docs, and chess.com's
help-centre pages "How do the chess engines on Chess.com work?" / "What is Cloud
Analysis?" / "Use the latest Stockfish".

| | Batch analysis (a whole game) | Interactive position analysis |
|---|---|---|
| **lichess** | **Server-side.** "Request computer analysis" queues the game on their servers; historically 220+ donated CPUs, today the volunteer `fishnet` network (work item = one game + a node limit + `skipPositions`). Budget is a **fixed ~1,000,000 nodes per position** (5M for broadcasts); ~30–90 s per game. Results (per-ply eval, move classifications, accuracy) are stored and shared with everyone | **Client-side** wasm Stockfish in the browser, single-threaded — for the analysis board, explorer, studies. Its output is **cached and shared**: `GET /api/cloud-eval?fen=…` returns a stored eval (used for the first ~15 plies), and the browser shows a CLOUD tag instead of recomputing |
| **chess.com** | **Server-side**, always full-NNUE Stockfish 18: "Game Review and Cloud Analysis run on Chess.com's cloud servers". Made fast by **standardising the node count per move** (Fast/Standard/Deep/Maximum tiers) — a full report in a couple of seconds | **On device**, and the default is deliberately **"Lite" — handcrafted evaluation, no NNUE**, "because the full NNUE is 108 MB, which we cannot force-download onto every user's machine", and because NNUE "can quickly drain your battery if you're using a mobile device". Members can opt into the bigger net; iOS exposes an "engine max time" setting purely to conserve power |

**What that tells us**

1. **Nobody runs the batch on the phone.** Both platforms put whole-game analysis
   on servers and keep only single-position interaction local. That is the honest
   reason our client-side plan needs care.
2. **The quality bar is a node budget, not a depth.** lichess's server analysis is
   1M nodes/position on *native multi-threaded* hardware. At our measured wasm
   throughput (~470k nps on a laptop, single-threaded) that would be ~2 s/position
   ≈ 85 s/game ≈ **~2.5 h per 100 games on a laptop**, and something like 10 h on a
   phone — i.e. lichess-grade per-move analysis is out of reach on-device, and we
   do not need it: we are looking for *large* eval swings (blunders), not
   classifying every move.
3. **HCE-only is the mobile default for a reason** — and it is what we already
   chose (`lite-single` has no NNUE). Chess.com's own default confirms 1.16 MiB and
   no NNUE is the right mobile configuration; blunder detection tolerates the
   weaker eval far better than a 0.1-pawn comparison would.
4. **Repeated positions are the cheap win.** lichess's cloud eval exists because
   the same FENs recur; a single user's games repeat opening positions heavily. An
   **FEN-keyed local eval cache** removes a large fraction of the work for free.
5. **Battery/foreground is a first-class constraint**, acknowledged by both
   (chess.com added a time cap for it). A long batch must be chunked and resumable,
   never a 40-minute foreground job.

### Consequent phone budget for `CC-001b` (supersedes the spike's single estimate)

| Stage | Budget | Why |
|---|---|---|
| Screen every position | **~20–50k nodes** | catches material/no-capture blunders in tens of ms; ~1/20th of lichess's per-position budget |
| Re-scan candidates | **~300k nodes, MultiPV 2** | enough to confirm "a tactic was there" and capture the alternative line |
| Skip | any FEN already in the local cache | free reuse of openings and transpositions |
| Shape | **chunked + resumable**, per-game progress markers, foreground-only, optional Wake Lock | mobile tabs are frozen/throttled in the background; the job must survive a close |

The engine choice is unchanged; what changes is that the batch strategy must be
built phone-first, and a **laptop-assisted heavy pass** (same engine, Node, results
synced as `userPuzzle`s) remains the cheap escape hatch if the on-device pass ever
feels too slow — which is another reason to keep AN-001b's single-position API
separate from CC-001b's driver.

### Why they can afford it (and why that does not transfer to us)

The "big server" is mostly **not theirs**:

- **lichess** is a registered **French non-profit** whose income is **>95% donations**
  (patrons via Stripe/PayPal, Benevity, bank transfers; no ads, no tracking, no
  paywalls). It publishes `lichess.org/costs` — servers, salaries, moderation,
  prizes — and its accounts. Crucially, the analysis fleet is largely **donated
  CPU**: volunteers run the `fishnet` client (a forum answer cites ~4 lichess
  machines plus ~150 users donating CPU in a week, and lichess's own dev notes
  that volunteer machines are *more efficient than their OVH instances* — because
  the volunteer pays the electricity). On top of that, an analysis is computed
  **once and shared with everyone**, and `cloud-eval` caches positions, so the
  marginal cost per user is close to zero.
- **chess.com** runs its own full-NNUE fleet and charges for it: Game Review's
  deeper tiers and **Cloud Analysis are membership-gated** (Diamond), i.e. the
  monetisation boundary sits exactly at "run this on our servers".

We have neither a donor fleet nor a subscription base, which is why the honest
design for this app is lichess's *other* half — client-side evaluation — plus our
own private little cloud-eval: an FEN-keyed local cache. If the on-device pass ever
became painful, a laptop running the same engine **is** a one-person fishnet
client, and that remains the cheapest escape hatch.
