# Install ChessReps on your phone (offline play) — APP-001

ChessReps is a Progressive Web App: it installs to the home screen and then runs
with **no network at all** — the app shell *and* all bundled puzzles are saved on
the device on the first visit. Training data lives only in that browser.

## What you get

- Home-screen icon, standalone window (no browser chrome).
- Full offline play: shell, icons, styles, both puzzle packs (starter 100 +
  five 500-puzzle rating bands) are precached at install time.
- Progress/schedules survive updates (IndexedDB is never touched by the service
  worker). Backups are available under **Settings → Data safety → Export**.

## Requirements

A **secure context** is required for service workers and installability:
`https://` (or `http://localhost` on the same machine). Plain `http://` over your
LAN will open in a tab but will **not** install or work offline.

## Option A — host the built app (recommended)

```sh
npm run build            # from the repo root -> apps/web/dist
```

Upload the contents of `apps/web/dist` to any static host with HTTPS:

- **Cloudflare Pages / Netlify** (drag-and-drop the `dist` folder) — served at a
  domain root, which matches the manifest (`start_url`/`scope` are `/`).
- GitHub Pages works only at a sub-path; the manifest would need a base path
  change, so prefer a root deployment.

Then open the URL on the phone and install (next section).

## Option B — your own machine over HTTPS (LAN / quick test)

```sh
npm run build

# Trusted local certificate (install mkcert once: https://github.com/FiloSottile/mkcert)
mkcert -install
mkcert -cert-file /tmp/chessreps-cert.pem -key-file /tmp/chessreps-key.pem \
  localhost 127.0.0.1 "$(hostname -I | awk '{print $1}')"

# Serve dist over HTTPS (any static server that takes a cert works)
npx http-server apps/web/dist -p 4173 --ssl --cert /tmp/chessreps-cert.pem --key /tmp/chessreps-key.pem
```

On the phone, open `https://<your-machine-ip>:4173`. The certificate comes from
your own mkcert CA — trust it on the device (or accept the warning) and the app
becomes installable. A quick alternative that needs no local cert:

```sh
npx cloudflared tunnel --url http://localhost:4173   # gives a temporary https URL
```

## Install steps

- **Android (Chrome/Edge):** menu ⋮ → **Install app** (or the in-app banner), or
  **Settings → App & offline → Install app**.
- **iPhone/iPad (Safari):** **Share → Add to Home Screen**. iOS has no install
  prompt, so the Settings panel shows this instruction instead of a button.

## Verify it is truly offline-ready

1. Open the app online once and wait a moment for the download to finish.
2. Go to **Settings → App & offline**: it should read
   **“Offline ready — the app and all bundled puzzles are saved on this device.”**
   and show the storage used (about 5 MB for the library + cache).
3. Turn on airplane mode, close the app, and open it from the home screen.
   Training, puzzles, history and statistics all work offline.

If it still says "Not ready offline yet", open the app once more while online —
a single missing asset is retried by the service worker on the next load.

## Updates

A new release installs itself on the next launch while online: the previous
shell cache is deleted on activation (only one `chessreps-shell-*` cache ever
exists), and an "update available — reload" toast appears in long-lived tabs.
Training data is untouched. See `docs/research/pwa-update-policy.md`.

## Caveats

- **Storage eviction:** the app asks the browser for persistent storage on boot,
  but the OS can still evict unused sites (iOS is the most aggressive). Export a
  backup from Settings before clearing site data or switching devices.
- Everything is local to the device/browser profile; there is no sync yet (F04).
