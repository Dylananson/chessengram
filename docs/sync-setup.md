# Sync setup (operator checklist)

ChessEngram is **local-only by default**: with no sync configuration the app makes
**zero network calls** and trains entirely from IndexedDB. Everything below is
only needed to turn on the optional, end-to-end-encrypted cross-device sync.

> This checklist needs real cloud accounts; it is intentionally not something the
> repo can perform. Nothing here is hard-coded: unconfigured ⇒ the Sync panel
> reports `local-only` + "not configured".

## 0. Prerequisites

- A deployed web build (`npm run build` → `apps/web/dist/`).
- The sync worker workspace (`services/sync-worker/`) and a `SyncApiClient`
  implementation wired into `apps/web/src/app.ts` as the `createSyncApi` seam.
  Without a client the app deliberately stays local-only even if the env vars
  below are present.
- **HTTPS everywhere.** The service worker only manages `https://` origins (plus
  `localhost` for development), and sync requests carry an `HttpOnly; Secure`
  session cookie. Mixed content (`http://` API from an `https://` app) is blocked
  by the browser.
- **The app must call the API same-origin.** The session cookie is
  `SameSite=Lax`, so a browser **does not send it** on a cross-site `fetch` — and
  `*.pages.dev` and `*.workers.dev` are different *sites*. Deploying the app with
  an absolute `apiBase` therefore signs in fine (that call uses a Bearer token)
  and then fails with **401 on the next session-authenticated call** (e.g.
  `POST /devices`). Two supported answers:
  1. **Same-origin proxy (what the deploy script does).** `apps/web/functions/api/`
     proxies `/api/*` to the Worker and Terraform sets the Pages project's
     `SYNC_API_ORIGIN` env var, so the client's `apiBase` is the relative `/api`
     and the cookie is first-party. `wrangler pages deploy` must be run **from
     `apps/web`** for wrangler to pick up the `functions/` directory; the deploy
     script does this and verifies `/api/health` answers with the Worker's JSON.
  2. **A custom domain** (`app_custom_domain` + `api_custom_domain` under one
     zone, e.g. `chessengram.example.com` + `api.chessengram.example.com`): same
     registrable domain ⇒ same-site, so no proxy is needed and the absolute
     `apiBase` works. The proxy keeps working either way; drop `apiBase: /api`
     from the generated config if you prefer the direct URL.

## 1. Cloudflare Worker + D1

> **Preferred path:** the sync service and its D1 database are created by
> `infra/` (Terraform) and published by `bash infra/deploy.sh` — see
> `infra/README.md`. Turn to the manual Wrangler steps below only when you are
> deliberately running the Worker outside Terraform (e.g. `wrangler dev` on a
> laptop). Do not do both for the same Worker name: they will fight over the
> script, its bindings and its `workers.dev` route.

1. Create a Cloudflare account and install/login Wrangler:
   ```bash
   npm i -D wrangler        # or use npx wrangler
   npx wrangler login
   ```
2. Create the database and copy the printed `database_id`:
   ```bash
   npx wrangler d1 create chessreps-sync
   ```
3. Put the id into `services/sync-worker/wrangler.toml` under the
   `[[d1_databases]]` block (`binding = "SYNC_DB"`). Storage tables are created
   automatically (`CREATE … IF NOT EXISTS`), so there is no separate migration.
4. Set the worker configuration:
   ```bash
   npx wrangler secret put COGNITO_REGION
   npx wrangler secret put COGNITO_USER_POOL_ID
   npx wrangler secret put COGNITO_CLIENT_ID
   # optional JWKS override:
   npx wrangler secret put COGNITO_JWKS_URL
   ```
   That is all of them — there is no key material and no Worker secret beyond the
   Cognito ids (ONL-020).
   and plain vars in `wrangler.toml` `[vars]`:
   ```toml
   ALLOWED_ORIGINS = "https://chessengram.example.com"
   MAX_BATCH = "200"
   MAX_PUSH_BYTES = "1000000"
   SESSION_TTL_SECONDS = "2592000"   # 30 days
   # never in production:
   SYNC_ALLOW_DEV_AUTH = "false"
   ```
   | Worker env | Meaning |
   |---|---|
   | `SYNC_DB` | D1 binding (absent ⇒ in-memory fallback, dev only) |
   | `COGNITO_REGION` / `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` | required together for token verification |
   | `COGNITO_JWKS_URL` | optional JWKS override |
   | `ALLOWED_ORIGINS` | comma-separated exact browser origins (absent ⇒ deny) |
   | `MAX_BATCH` | max envelopes per push (default 200) |
   | `MAX_PUSH_BYTES` | max request body bytes (default 1 000 000) |
   | `SESSION_TTL_SECONDS` | session cookie lifetime (default 30 days) |
   | `SYNC_ALLOW_DEV_AUTH` | local dev token only — **false in production** |
5. Deploy:
   ```bash
   cd services/sync-worker
   npx wrangler deploy
   ```
6. Verify the deployment:
   ```bash
   curl -s https://sync.example.com/health
   # -> { "ok": true, "configured": true, "auth": "cognito", "storage": "d1" }
   ```
   `auth` must be `cognito` (not `dev`/`unconfigured`) and `storage` must be
   `d1` (not `memory`) in production.

## 2. AWS Cognito (auth)

Sync uses Cognito **Essentials** with **Google only**; it is optional and only
exercised when the user enables sync.

1. AWS Console → **Cognito** → create a user pool.
   - Choose the **Essentials** tier. **Do not** enable the Plus tier or advanced
     security features (the free tier covers this use case).
   - Sign-in option: **Federated / Google** (no username/password needed).
2. Add a **Google** social identity provider (from step 3): client id + secret.
3. Create an **app client**:
   - **Authorization code grant + PKCE**, no client secret for the SPA.
   - Callback / redirect URLs:
     - `https://chessengram.example.com/` (production)
     - `http://localhost:5173/` (local dev)
   - Allowed sign-out URLs: the same origins.
   - Scopes: `openid email profile`.
4. Copy the values into the client configuration (step 4):
   `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, the app-client id, and the hosted
   UI / token endpoint as `VITE_SYNC_AUTH_AUTHORITY`.

The Worker verifies the ID token via JWKS and maps `(issuer, subject)` to its own
canonical `userId` — the raw provider `sub` is never used or stored.

## 3. Google OAuth client

1. Google Cloud Console → **APIs & Services → Credentials** → create an
   **OAuth client ID** of type *Web application*.
2. Authorized JavaScript origins:
   - `https://chessengram.example.com`
   - `http://localhost:5173`
3. Authorized redirect URI: the Cognito hosted-UI callback
   (`https://<your-domain>.auth.<region>.amazoncognito.com/oauth2/idpresponse`).
4. Scopes: `openid email profile`.
5. Publish the consent screen (or add test users while it is in *Testing*).
6. Paste the client id/secret into the Cognito Google identity provider.

## 4. Client configuration

The app reads build-time `VITE_SYNC_*` values and optionally overrides/augments
them from **`/sync-config.json`** at runtime.

Build-time (`.env.production`, CI secrets, etc.):

```dotenv
VITE_SYNC_API_BASE=https://sync.example.com
VITE_SYNC_AUTH_AUTHORITY=https://auth.example.com
VITE_SYNC_AUTH_CLIENT_ID=your-cognito-app-client-id
VITE_SYNC_AUTH_REDIRECT_URI=https://chessengram.example.com/
```

Runtime override (deploy next to the app as `apps/web/public/sync-config.json`,
or serve it from the web host):

```json
{
  "apiBase": "https://sync.example.com",
  "authAuthority": "https://auth.example.com",
  "authClientId": "your-cognito-app-client-id",
  "authRedirectUri": "https://chessengram.example.com/"
}
```

Notes:

- The runtime file is **best-effort**: a missing/malformed file never breaks
  boot and values are never logged.
- To keep the "no network when unconfigured" promise, `/sync-config.json` is only
  fetched when at least one `VITE_SYNC_*` value is present in the build. Set the
  build-time values (or a placeholder) if you rely on the runtime file.
- `apiBase` may include a path prefix; the client calls `/auth/session`,
  `/devices`, `/sync` and `/sync/account` beneath it.

## 5. Verify end-to-end

1. **Worker health**
   ```bash
   curl -s https://sync.example.com/health
   curl -s -o /dev/null -w '%{http_code}\n' https://sync.example.com/sync
   # -> 401 without a session (expected)
   ```
2. **App** → **Settings → Sync**
   - Configured build: the panel offers **Enable sync** and, once enabled,
     **Sync now** / **Sign out** / **Disable sync** / **Delete server copy**.
   - Unconfigured build (the default): `data-sync-mode="local-only"`, "not
     configured", Enable disabled — and **no** network calls.
3. Enable sync: sign in → the client generates a **per-device P-256 signing
   keypair**, registers its public half, and adopts your existing local data.
   **There is no key, password or code to save or enter** (ONL-020): payloads are
   stored as plaintext records and each write is signed by the device that made
   it. A device whose storage was wiped simply registers a fresh keypair next
   time; nothing is lost but the ability to *prove* those old writes came from
   this device (the records themselves are unaffected).
4. Train offline, then reconnect: the queue drains on **Sync now**. A 401 (expired
   session) moves the panel to **Paused** and keeps every queued change.
5. **Disable sync / Sign out / Delete server copy** never delete local training
   data. Verify with a full local export from **Data safety** before/after.

## 6. Service worker / caching rules

The hand-written service worker (`apps/web/public/sw.js`) is offline-first, with
these sync-specific rules:

- **`/api/*` is network-only.** Same-origin requests under `/api/` are never
  cached and never served from cache; the browser always goes to the network.
- **`/sync-config.json` is network-first** with a cache fallback, so a new deploy
  is picked up while online and the last good config works offline.
- Bump `CACHE_VERSION` (`chessengram-shell-vN`) on any release that changes the
  shell or precache list; activation keeps exactly one versioned shell cache.
- Sync requires HTTPS: an `https://` app must call an `https://` API, otherwise
  the session cookie (`HttpOnly; Secure; SameSite=Lax`) is not sent.

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| Panel says "not configured" | `VITE_SYNC_API_BASE`, `..._AUTH_AUTHORITY`, `..._AUTH_CLIENT_ID` present at build, or a valid `/sync-config.json` |
| `/health` shows `auth: "unconfigured"` | all three `COGNITO_*` values set on the worker |
| `/health` shows `storage: "memory"` | the `SYNC_DB` D1 binding is missing |
| Pushes return `401` | Cognito session expired; re-enable/sign in (local queue is preserved) |
| Pushes return `403` | the browser origin is missing from `ALLOWED_ORIGINS` |
| Pushes return `422` | the device is not registered, or an envelope signature failed; the pointer stays queued and is retried |
| "Sign-in is not available in this build" | the `createSyncApi` / auth seam is not wired in the web build |
