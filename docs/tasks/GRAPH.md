## Wave B/C execution graph (autonomous loop)

Loop rules: a task is **ready** when all deps are Done and none of its
`Owns` paths are touched by another running task. Each round the coordinator
spawns all ready tasks in parallel, then verifies combined
(`npm test`, `npm run typecheck`, `npm run build`), commits if green, updates
this file, and starts the next round. Stop at user-gated items.
`PROJECT_PLAN.md` wording stays coordinator-owned; agents never edit it.
No pushes; commits only.

```mermaid
flowchart TD
  B1["B1 UX-004 fairness"] --> T16["T16 release (user sign-off)"]
  B2["B2 HIST-API + rows"] --> T16
  B3["B3 DOC-001 sweep"] --> T16
  B5["B5 AN-001a review"] --> T16
  B6["B6 update toast"] --> T16
  B4["B4 Collections (needs user scope)"] --> T16
  HW["T11/T15 hardware (needs device)"] --> T16
```

| ID | Task | Deps | Owns (exclusive) | Status |
|---|---|---|---|---|
| B1 | UX-004 queue tiebreaker: document + lock simultaneous-due order | UX-001 (done) | `packages/scheduler/src/selection.ts`, `packages/scheduler/tests/**` | Ready |
| B2 | HIST-API: read-only `listAttempts` + History per-attempt rows | History view (done) | `apps/web/src/scheduler-service.ts` (append-only method), `apps/web/src/history-view.ts`, `apps/web/src/i18n.ts` (`history.*` only), `apps/web/tests/history*` | Ready |
| B3 | DOC-001 sweep: `screens.ts` header, ADR 001–004 accept/defer note, T13 status note | — | `apps/web/src/screens.ts` (header comment only), `docs/research/adr-sweep.md` (new) | Ready |
| B5 | AN-001a attempt review (no engine): step through own attempt moves | UX-001 (done) | `apps/web/src/train-view.ts`, `apps/web/src/puzzle-game.ts`, `apps/web/src/training-adapter.ts`, `apps/web/src/i18n.ts` (`review.*` only), `apps/web/tests/review*` | Ready after R1 (shares `train-view.ts` history with UX-001 commit, now landed — actually free) |
| B6 | REL-001 remainder: in-app "update available" reload toast | REL-001 policy (done) | `apps/web/src/app.ts` (SW registration only), `apps/web/src/i18n.ts` (`app.update.*` only) | Ready after R1 |
| B4 | T13-followup real Collections screen — **USER DECISION 2026-10-15: per-collection separate progress; static sets with multi-membership; active-collection picker on Train. Overrides ADR-002 proposal (per-program). Schedule rekey to collection scope + schema bump/migration approved in principle; raw history preserved.** | B3, ~~user scope~~ decided | `packages/contracts` (ProgressKey scope), `apps/web/src/scheduler-service.ts`, `apps/web/src/collections-view.ts` (new), `apps/web/src/screens.ts` (collections entry), `apps/web/src/app.ts`, `apps/web/src/train-view.ts` (picker), `apps/web/src/i18n.ts` (`collections.*`), storage/migration | Ready (single owner: shared contracts change) |
| HW | T11/T15 hardware matrix execution | Matrix written (done) | real device | **Blocked: needs device** |
| RF-001 | React + component library (PROPOSED, see BACKLOG) | architecture decision (accepted ADR) | — | **Parked: loop must skip** |
| T16 | First usable release | B1 B2 B3 B5 B6 B4 HW | — | **Blocked: user sign-off** |

Round log:
- R1: B1 + B2 + B3 (disjoint paths) — Done 2026-10-15 (`a328313`). 111 tests green (7+35+69), typecheck + build clean. B1: behavior unchanged, tiebreaker locked by comment + 10 fairness tests. B2: `listAttempts` + per-attempt rows. B3: header fix + adr-sweep note (recommends accept 001/004 for local scope, defer 002/003; T13 reword proposed).
- R2 (planned): B5 + B6 (B6 barred from `i18n.ts` so both run parallel). B4 waits on user scope.
- R2: B5 + B6 — Done 2026-10-15 (`ce3f011`). 120 tests green (7+35+78), typecheck + build clean. B5: `ReviewNavigator` + TrainView stepping, review-only, no state mutation. B6: update toast + SKIP_WAITING; I18N-FOLLOWUP (`app.update.available/reload`) open.
- R3: B4 + practice-scope fix — Done 2026-10-15. 136 tests green (7+35+94), typecheck + build + smoke clean. Per-collection separate progress (user decision, overrides ADR-002); 3-part keys with legacy cross-scope read fallback; EXPORT_FORMAT_VERSION 1.0.0→1.1.0 with appended migration; collections in export/import; real Collections screen; active picker on Train. I18N-FOLLOWUP still open.
