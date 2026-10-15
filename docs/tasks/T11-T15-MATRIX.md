# T11 / T15 Real-Device Verification Matrix

Covers BACKLOG.md "T11/T15 — Real-device verification matrix" (release-readiness,
proposed entry criteria for T16). Headless service-worker boot is already
verified by `npm run smoke` (page controlled, shell + hashed bundle cached,
offline boot); this matrix is the **remaining hardware pass** that headless
Chromium cannot cover. Close T11/T15 only with recorded evidence per row.

How to record evidence: for each item fill in Date, Device/OS/Browser, Build,
Result (pass/fail), and Evidence location (photo, video, or notes path).

| # | Item | What to do | Pass criteria | Date / Device / Build | Result | Evidence location |
|---|------|------------|---------------|-----------------------|--------|-------------------|
| 1 | Touch input | Complete a full puzzle on a touchscreen (tap-tap + drag if supported) | Moves register reliably; no mis-taps blocking completion | | | |
| 2 | Promotion picker | Solve a promotion puzzle (e.g. `7k/1P6/8/8/8/8/8/K7 w - - 0 1` → `b7b8q`) on touch | Picker opens, chosen piece applies, solution accepted | | | |
| 3 | Phone layout | Train session on a small viewport (~360px wide) | Board + controls usable, no clipped buttons, nav reachable | | | |
| 4 | Desktop layout | Train session on desktop viewport | Full layout renders; board and queue panels legible | | | |
| 5 | Backgrounding / pause | Background the tab/app mid-attempt, return after 1+ min | Attempt state intact; timer/UX sane; no spurious fail | | | |
| 6 | Multi-puzzle session | Solve ≥5 puzzles in one session across new/due/review | Queue advances each time; no dead-end while work remains | | | |
| 7 | Failure + resume across reload | Fail a puzzle, reload mid-review, continue training | Schedule records the failure; queue still advances after reload | | | |
| 8 | PWA install | Install to home screen / desktop from browser menu | App installs, launches standalone, icon present | | | |
| 9 | Offline reload (network disabled) | With PWA installed or SW warm: disable network, reload, train | App boots and a puzzle is solvable fully offline | | | |

Notes:
- Items 8–9 overlap the PWA update policy (`docs/research/pwa-update-policy.md`);
  on a real device additionally confirm a version bump activates without data loss.
- Headless coverage (already green, do not re-record here): SW active, page
  controlled, single versioned shell cache, offline boot — see `apps/web/scripts/smoke.mjs`.
