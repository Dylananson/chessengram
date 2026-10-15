## Backlog / To be done later

Tasks that are not yet scheduled to a specific phase, but have been identified as gaps or future enhancements. Agents may pick these up when phases are complete.

### Immediate UX gaps (release blockers, proposed priority order)
- [ ] **UX-001 (P0): Queue dead-ends** — Ensure `selectNext` always returns something sensible when the collection is non-empty (revisit candidate building and `selectNextDue` fallback). Sometimes state shows learned/new exist but "Nothing due now" appears. Acceptance (proposed): non-empty library never strands the user; `no-due-work` path shows earliest-due time or an explicit practice-ahead action; regression test covers new-cap-reached + all-future-due case.
- [ ] **UX-002/UX-003 (P1): Progress + History inspection (combined)** — Replace the `collections`/`history` stubs (`apps/web/src/screens.ts`) with a read-only view showing per-puzzle learning state, review counts/streaks, and raw attempt history (puzzle, outcome, timing, events, timestamps) per D09. Acceptance (proposed): history renders from persisted attempts without mutating schedule state; smoke covers Train→History round-trip.
- [ ] **UX-004 (P2): Queue fairness/ordering** — Make "next due" ordering stable and predictable when multiple puzzles become due simultaneously; avoid starving new or recently failed puzzles. Document the chosen tiebreaker. Acceptance (proposed): tiebreaker documented in code + test with simultaneous-due fixtures.
- [ ] **T13-followup: Real Collections screen** — NOTE: `PROJECT_PLAN.md` marks T13 Done for Puzzles-view import, but `collections` is still a stub. Scope (proposed, needs coordinator confirmation): multi-collection CRUD, collection→program scope (Q09), per-collection progress. Do not change stored program/collection IDs, DB name, or schema versions without approval.

### Release readiness (proposed entry criteria for T16)
- [ ] **T11/T15 — Real-device verification matrix** — Expand the vague "device pass" into a checklist with evidence location: touch, promotion picker, phone + desktop layout, backgrounding/pause, multi-puzzle session, failure + resume across reload, PWA install, offline reload with network disabled. Headless service-worker boot is already verified by smoke; this is the remaining hardware pass.
- [ ] **REL-001: PWA update/caching policy** — Define `sw.js` cache versioning and update flow so shipped users pick up new bundles without stale-shell or data loss. Acceptance (proposed): version bump documented + smoke asserts new bundle activates.
- [ ] **DOC-001: Pre-release docs sweep** — Fix stale `apps/web/src/screens.ts` header ("until build-out fills them in"); accept/reject or explicitly defer ADRs 001–004 (all still Proposed); confirm T13 status (Done vs partial) in `PROJECT_PLAN.md` (coordinator-only edit).
- [ ] **T16 — First usable release** — Entry (proposed): UX-001 + UX-002/003 closed or explicitly deferred, smoke + `npm test` + `npm run typecheck` + `npm run build` green, limitations documented, no blocking issues. Status/wording changes in `PROJECT_PLAN.md` need coordinator edit.

### Deferred technical tasks (from original plan — explicitly post-T16 unless reprioritized)
- [ ] **T07 — Remote adapter (online mode)** — Implement T04 TrainingService against a thin remote API (drop-in adapter). No Lila web endpoints as durable storage. Offline→online reconciliation with idempotency keys/revision guards.
- [ ] **T09 — Online POC integration** — Wire remote adapter to UI end-to-end with actual rated collection.
- [ ] **T11 — Real-device verification pass** — See Release-readiness matrix above; this entry tracks the original plan ID. Close only with recorded hardware evidence.
- [ ] **T15 — Phone/desktop/offline verification** — Expand verification matrix (covers T11+T15) and record evidence.
- [ ] **T16 — First usable release** — See Release-readiness entry criteria above. `PROJECT_PLAN.md` wording is coordinator-owned.

### Analysis and review (PB7 scope — proposed split)
- [ ] **AN-001a: Attempt review navigation (no engine, proposed P1)** — Review-mode only: step through own attempt moves with full-attempt navigation. Cheap, high training value; candidate before T16.
- [ ] **AN-001b: Stockfish integration (deferred, heavy)** — Lazy-loaded full single-threaded build, review-mode only. Keep post-T16 unless explicitly reprioritized. See PB7 in build-out table.

### Structural proposals (parked — needs architecture decision, EXCLUDED from autonomous loop)
- [ ] **RF-001 (PROPOSED, not decided): React + component library for UI consistency** — Motivation: consistent design/styling across screens. Note the app already builds with Vite (`apps/web`); this task is about adding React to that build plus a component library, not adopting Vite. Options (decision required before any work): (a) React + bundled public library (must be bundled, never CDN — offline-first PWA; weight and license to be assessed); (b) React + project-owned component set built from current screens; (c) no-React alternative (recommended first): vanilla design system — CSS tokens + shared TS view helpers — which addresses consistency without a rewrite. Hard constraints regardless of option: IndexedDB DB name, stored program/collection IDs and schema versions unchanged without approval; export/import + migration policy cover any persisted change; `chessground` is imperative — the board (`train-view.ts` + `puzzle-game.ts`) is the highest-risk migration surface and needs a React-binding strategy (refs/effects, no remount-per-move) proven before other screens move; `npm test` + `npm run typecheck` + `npm run build` + `npm run smoke` green throughout, preferably via screen-by-screen strangler with a bundle budget, not big-bang. Open questions: which library (if any), migration order, who owns the design tokens. Do NOT start until recorded as an accepted ADR; the loop must keep skipping this task.

### Future (F-series)
- [ ] **F01 Woodpecker**, **F02 Schedulers (FSRS)**, **F03 Openings**, **F04 Sync**, **F05 Content** — As listed in Future work.
