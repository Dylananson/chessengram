## Backlog / To be done later

Tasks that are not yet scheduled to a specific phase, but have been identified as gaps or future enhancements. Agents may pick these up when phases are complete.

### Immediate UX gaps (from user feedback)
- [ ] **UX-001: Queue ordering prevents "nothing due" dead-ends** — Ensure `selectNext` always returns something sensible when the collection is non-empty (revisit candidate building and `selectNextDue` fallback). Sometimes state shows learned/new exist but "Nothing due now" appears.
- [ ] **UX-002: Progress visibility** — Add a Progress/History screen view (or extend Collections/Settings) to show per-puzzle learning state, review history counts, and streaks. The current `progress.summary` is minimal.
- [ ] **UX-003: History inspection** — Expose raw attempt history (read-only) in a structured list (puzzle, outcome, timing, events, timestamps) to match the constraint "raw attempt history kept separate from derived schedule state".
- [ ] **UX-004: Queue fairness/ordering** — Make "next due" ordering stable and predictable when multiple puzzles become due simultaneously; avoid starving new or recently failed puzzles. Document the chosen tiebreaker.

### Deferred technical tasks (from original plan)
- [ ] **T07 — Remote adapter (online mode)** — Implement T04 TrainingService against a thin remote API (drop-in adapter). No Lila web endpoints as durable storage. Offline→online reconciliation with idempotency keys/revision guards.
- [ ] **T09 — Online POC integration** — Wire remote adapter to UI end-to-end with actual rated collection.
- [ ] **T11 — Real-device verification pass** — Complete the remaining hardware pass (touch, promotion, backgrounding, multi-puzzle, failure, resume, PWA install) to close T11 fully.
- [ ] **T15 — Phone/desktop/offline verification** — Expand verification matrix (covers T11+T15) and record evidence.
- [ ] **T16 — First usable release** — Evidence, documented limitations, no blocking issues.

### Analysis and review (PB7 scope extensions)
- [ ] **AN-001: Stockfish integration (follow-up)** — As planned in PB7 (documented separately); implement after real-device verification if prioritized differently. See PB7 in build-out table.

### Future (F-series)
- [ ] **F01 Woodpecker**, **F02 Schedulers (FSRS)**, **F03 Openings**, **F04 Sync**, **F05 Content** — As listed in Future work.
