# PWA Update Policy (REL-001 research note)

Short policy for `apps/web/public/sw.js`. No storage schemas, program/collection
IDs, or the IndexedDB DB name (`chessreps-player-spike`) are involved.

## Cache versioning rule

- One versioned cache, `CACHE_VERSION = 'chessreps-shell-v1'` in `sw.js`.
- **Bump the version on every release that changes the shell or hashed bundles.**
- `activate` deletes every cache whose key differs from the current version, so
  at most one `chessreps-shell-*` cache survives. No versioned asset URLs are
  reused across releases (Vite hashes JS/CSS), so a bump cannot serve a mixed
  old-shell/new-bundle combination.
- Fetch strategy is unchanged: navigations are network-first (fallback to cached
  `index.html` offline); same-origin GETs (hashed JS/CSS, pack JSONL, icons)
  are cache-first, filled from the network.

## Update UX (current behavior)

- `install` calls `skipWaiting()` and `activate` calls `clients.claim()`: a new
  worker takes over immediately on next navigation/reload when online.
- There is **no in-app "update available" prompt** — deliberately out of scope
  here because it would touch `apps/web/src/**` (forbidden for this track).
  Follow-up option: a reload toast driven by `registration.onupdatefound`
  (needs coordinator scoping).

## Rollback story

- Rollback = ship the previous `CACHE_VERSION` + previous bundles again. The
  activate cleanup deletes the bad version's cache the same way as a forward
  update.
- User training data is never at risk from update/rollback: attempts, schedules,
  and content live in IndexedDB, which the service worker never writes to or
  deletes. Worst case is a re-download of shell assets, never data loss.
- Export/import + migration policy already landed; updates must not regress it
  (smoke re-verifies export/import/restore every run).

## What smoke covers vs what needs a real device

- Smoke (`apps/web/scripts/smoke.mjs`, headless Chromium) covers: SW active,
  page controlled, cache holds shell + hashed bundle, **single versioned shell
  cache (no stale shell)**, offline boot with network disabled, and — since
  REL-001 — **cross-version activation**: it rewrites the served `sw.js` with a
  bumped `CACHE_VERSION` plus a changed shell marker, calls
  `registration.update()`, and asserts the new worker takes over the open page
  (`controllerchange`), that only the new `chessreps-shell-v2` cache survives,
  and that the reloaded page serves the new bundle. The rewritten files are
  restored afterwards; `dist/` is a build artifact.
- Smoke cannot cover: PWA install prompts, OS-level offline reload, or
  backgrounding on mobile. Those are rows 5, 8, 9 of
  `docs/tasks/T11-T15-MATRIX.md` — real-device only.
