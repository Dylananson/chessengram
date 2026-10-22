# @chessengram/sync-worker

ChessEngram' sync backend: a **Cloudflare Worker shape** service that stores
per-device signed sync envelopes. Envelope payloads are **plaintext** in v2: the
server may read them, so the only integrity guarantee is the per-device P-256
ECDSA `sig` over the canonical envelope bytes. The worker routes, dedupes,
orders and authorizes; it never verifies anything but that signature. Local-first
training never touches this service — sync is an opt-in add-on.

> **Trade-off (read this).** Earlier versions wrapped the payload in a
> server-held master key. That key was removed deliberately: because the server
> could always decrypt, it only ever protected against a *database-only* leak
> (a server compromise exposed the key too). Dropping it means the database now
> stores payloads in the clear, so a database leak exposes synced records
> directly, and the server itself can read them. The envelope signature still
> stops tampering and forged writes, but it provides **no confidentiality**.

**Zero runtime dependencies.** Everything below runs with **no cloud account**:
tests use an injected in-memory store and a fixed-token dev verifier.

## Layout

| File | Purpose |
|---|---|
| `src/protocol.ts` | Mirror of the frozen envelope contract (`apps/web/src/sync/types.ts`) |
| `src/canonical.ts` | Canonical envelope bytes: stable JSON + payload hash (WebCrypto SHA-256) |
| `src/config.ts` | `loadConfig(env)` — validated config or `{ configured: false, reason }` |
| `src/content.ts` | `ContentSource` seam + `GET /content/manifest` (public pack manifest) |
| `src/auth.ts` | `TokenVerifier` seam + `DevVerifier` (ONL-006 owns real Cognito) |
| `src/store.ts` | `SyncStore` + `InMemorySyncStore` + thin `D1SyncStore` |
| `src/index.ts` | `createHandler(deps)` + Workers `fetch` default export |
| `tests/*.node.test.ts` | Node test runner suites (no network, no account) |

## HTTP surface

```
GET    /health          -> { ok, configured, auth, storage, content }
POST   /sync            { since, push: Envelope[] } -> { cursor, accepted, duplicates, changes }
DELETE /sync/account    -> wipe this user's envelopes + devices
GET    /content/manifest -> public pack manifest (no auth; Cache-Control: public)
OPTIONS *               -> CORS preflight (ALLOWED_ORIGINS)
```

- **Auth** is required on `/sync` and `/sync/account`. With no verifier
  configured (and no dev auth) every authenticated route answers `401`.
  `/health` and `/content/manifest` are public: the pack manifest keeps working
  while a user is signed out.
- **Dedupe / conflict rules**: `putEnvelope` is keyed by `(userId, dedupeKey)`.
  - *Immutable* types (`attempt`, `woodpecker`, `woodpeckerResult`) are
    **first write wins**: a replay is reported in `duplicates` and **never**
    overwrites the stored row or moves its `seq`.
  - *Mutable* types (`setting`, `collection`, `userPuzzle`) are
    **last-write-wins by `(updatedAt, rev, deviceId)`**: a strictly newer
    `updatedAt` replaces the row and is assigned a **new `seq`** so cursors
    older than it see the change in `changes`; on equal `updatedAt` a higher
    per-device `rev` wins; on equal `updatedAt` and `rev` the lexicographically
    larger `deviceId` wins, so two devices converge on the same stored row
    regardless of arrival order. A losing envelope is a `duplicate`. A
    replacement counts as `accepted` so the client acks its pointer.
  - `accepted` and `duplicates` contain the envelope **`dedupeKey`** (the
    server's uniqueness key). The client builds it as `SHA-256(scope)` hex;
    there is no salt any more (no key material to salt with).

  Both stores implement this in one step: the in-memory store directly, and the
  D1 adapter with a single atomic
  `INSERT OR REPLACE … SELECT … WHERE NOT EXISTS (… conflict test …) RETURNING seq`.
  An empty `RETURNING` result means the guard blocked the write (so the stored
  row is read back and reported `duplicate`); a returned `seq` means a real
  write. `INSERT OR REPLACE` is what gives a replacement a fresh monotonic `seq`.

  > **Ordering (ONL-016).** The wire `updatedAt` is the **exact** epoch-ms
  > change time (it is no longer hour-rounded), and every envelope carries a
  > signed monotonic per-device `rev`. `rev` is optional on the wire for older
  > clients and defaults to `0`, so a pre-`rev` client is still accepted. This
  > closes the old limitation where two edits to one record inside the same hour
  > (or, on a single device, the same millisecond) tied on `deviceId` and the
  > second was dropped as a `duplicate`.
- **Cursor**: `changes` are this user's envelopes with `seq > since`, ordered by
  `seq` and bounded by `MAX_BATCH`. `cursor` is the `seq` of the last returned
  change (or `since` when there is nothing new), so a bounded pull continues
  from where it stopped.
- **Device registry**: pushes are rejected `422` unless the envelope's
  `deviceId` is registered for the user. Registration itself is ONL-006's
  session flow; the store exposes `addDevice`/`listDevices`/`revokeDevice`.
- Codes: `400` bad body, `401` unauthenticated, `403` origin not allowed,
  `404`/`405` routing, `413` over `MAX_BATCH`/`MAX_PUSH_BYTES`, `422` invalid
  envelope, unregistered device or bad signature, `503 content_not_configured`
  when the content source is missing.

## Envelope v2 (plaintext) and the residual trade-off

The envelope is:

```ts
{ v: 2, type, recordId, dedupeKey, deviceId, payload, sig, updatedAt, rev, seq? }
```

- `payload` is the payload **object** (the shapes the encrypted wire used to
  carry). `iv`, `ciphertext` and `keyVersion` are gone; nothing is padded.
- Every push must be `v: 2`; a v1 envelope is rejected `422 invalid_envelope`.
- `sig` is a base64 P-256 ECDSA (raw `r‖s`) signature over the canonical bytes
  (mirror: `apps/web/src/sync/types.ts#canonicalEnvelopeBytes`):

  ```ts
  payloadHash = hex(sha256(utf8(stableJson(envelope.payload))))
  canonical   = JSON.stringify([v, type, recordId, dedupeKey, deviceId,
                                updatedAt, rev, payloadHash])
  ```

  where `stableJson` sorts object keys lexicographically at every level, omits
  `undefined` members and keeps array order.
- `/sync` verifies each `sig` against the payload **actually present**: a
  payload whose hash does not match the signature is rejected `422
  invalid_signature`, and a tampered batch stores nothing.
- The payload is stored as the **stable-normalized JSON text** that is also
  hashed, so a signature stays verifiable from storage without re-serializing.

**What this protects and what it does not.** The signature authenticates the
push (it proves a registered device produced the exact bytes and that the stored
payload was not altered in transit or at rest), and `dedupeKey`/`userId` keep
users and records separate. It provides **no confidentiality**: the server and
anyone with database access can read every payload. The removed server-held
master key would only have protected against a database-only leak, not against a
server compromise — the user chose to drop the long-lived key instead of keeping
it for that narrow benefit.

## Schema

`sync_envelopes` keeps its routing columns (`user_id`, `type`, `record_id`,
`dedupe_key`, `device_id`, `updated_at`, `rev`, `sig`) and stores the payload as
the stable JSON text described above. The v2 schema **drops** the old
`ciphertext`, `iv` and `key_version` columns.

The live database still has that old, empty table, and `CREATE TABLE IF NOT
EXISTS` cannot reshape it, so the store runs a lazy check before creating the
schema: if `sync_envelopes` has the legacy `ciphertext` column **and 0 rows** it
is dropped and recreated in the v2 shape; if it has any rows it **fails closed**
with a clear error instead of discarding data. Every other table (`_cf_KV`,
`auth_sessions`, `identities`, `sync_devices`, `identity_device_keys`) is left
untouched.

## Content distribution (public CC0 packs)

`GET /content/manifest` serves the small, cacheable manifest produced by
`tools/puzzles/pack-manifest.py`. The worker **never** streams `pack.jsonl`
bytes: those live on the CDN / R2 / Pages mirror, and clients fetch a pack from
its content-addressed URL `…/<packId>/<version>/pack.jsonl`, where `version` is
the first 16 hex of `sha256(pack.jsonl)`. A new pack revision therefore gets a
**new immutable URL**, so updates are additive and safely cacheable.

- Data comes from an injected `ContentSource` (`{ loadManifest(): Promise<unknown> }`).
  Tests use `InMemoryContentSource`; a `FileContentSource`/`R2ContentSource`
  reads `content-manifest.json` from a build artifact or a bucket (see the doc
  comment in `src/content.ts`).
- `CONTENT_BASE_URL` is applied to any pack that does not embed a `url`; a pack
  that already carries an absolute url is left untouched. Set it to your mirror.
- Without a source the route answers `503 content_not_configured` and `/health`
  reports `"content": "unconfigured"` (fail closed).

## Run the tests locally (no account)

```bash
# from the repo root, once (already done when the workspace was added):
npm install

# the service suite (Node's built-in runner, type-stripped TS, no network):
npm test --workspace @chessengram/sync-worker
# equivalent:
cd services/sync-worker && npm test

# typecheck just this workspace:
npm run typecheck --workspace @chessengram/sync-worker
```

## Run the worker locally (no account) — dev-auth mode

`wrangler dev` runs entirely on your machine (local D1 via Miniflare); no
Cloudflare login is required.

```bash
cd services/sync-worker
cp .dev.vars.example .dev.vars     # SYNC_ALLOW_DEV_AUTH=true
npx wrangler dev                   # local only; no Cloudflare login needed

# then, with the fixed dev token:
curl -s localhost:8787/health
curl -s -X POST localhost:8787/sync \
  -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  -d '{"since":0,"push":[]}'
```

If `wrangler dev` objects to the placeholder `database_id`, comment out the
`[[d1_databases]]` block: the worker then uses the in-memory fallback, which is
enough for local poking. Pushing a real envelope also requires a registered
device (ONL-006's session flow), so the empty-push above is the happy path
before then.

Without a `SYNC_DB` binding the worker falls back to an isolate-wide in-memory
store and `/health` reports `"storage": "memory"`. **Dev-auth is for local use
only** — never set `SYNC_ALLOW_DEV_AUTH=true` in production.

## Configuration (never hard-coded)

| Env | Meaning |
|---|---|
| `SYNC_DB` | D1 binding (optional; absent ⇒ memory fallback) |
| `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | Cognito (all three required together) |
| `COGNITO_JWKS_URL` | Optional JWKS override |
| `ALLOWED_ORIGINS` | Comma-separated exact origins (`*` allowed); absent ⇒ deny |
| `MAX_BATCH` | Max envelopes per push (default 200) |
| `MAX_PUSH_BYTES` | Max request body bytes (default 1000000) |
| `CONTENT_BASE_URL` | Public pack mirror base; builds pack urls the manifest omits |
| `CONTENT_MANIFEST_MAX_AGE` | `/content/manifest` `Cache-Control: max-age` (default 300) |
| `CONTENT_MANIFEST` | Optional build-time JSON string of the manifest (dev/Pages seam) |
| `SYNC_ALLOW_DEV_AUTH` | Enables the fixed dev token (local only); no other secret is needed |

`/health` reports `auth` as `cognito`, `dev` or `unconfigured`, `storage` as
`d1` or `memory`, and `content` as `configured` or `unconfigured`. Storage is
auto-created (`CREATE … IF NOT EXISTS` plus the v2 envelope migration described
above), so no separate migration step is required.

## Deploy checklist (the end — needs accounts)

> **The production instance is managed by `infra/` (Terraform):** the D1
> database, the script, its bindings and its `workers.dev` route are created
> there and published by `bash infra/deploy.sh` (`npm run deploy`). Use this
> checklist only for a *standalone* deployment — never `wrangler deploy` the
> same script name Terraform owns, or you will overwrite the Terraform-managed
> bindings (D1 `SYNC_DB`, the Cognito vars, `ALLOWED_ORIGINS`) with the
> placeholders in `wrangler.toml`.

1. `npm i -D wrangler` (or use `npx wrangler`).
2. `wrangler login` and `wrangler d1 create chessreps-sync`; copy the printed
   `database_id` into `wrangler.toml` (`SYNC_DB` binding).
3. Set the Cognito vars/secrets: `COGNITO_REGION`, `COGNITO_USER_POOL_ID`,
   `COGNITO_CLIENT_ID` (and optionally `COGNITO_JWKS_URL`) —
   `wrangler secret put <NAME>` or `[vars]`. No key-encryption secret is needed.
4. Set `ALLOWED_ORIGINS` to the production front-end origin(s); set
   `SYNC_ALLOW_DEV_AUTH` to `false`.
5. Publish the content packs and point the worker at the mirror — see
   **Deploying content** below.
6. Implement the Cognito verifier (**ONL-006**) — see below.
7. `wrangler deploy` (`npm run deploy`).

## Deploying content (no account required to build)

1. Generate the manifest with your mirror's base URL (it is parameterized —
   never hard-code an account or host):

   ```sh
   python3 tools/puzzles/pack-manifest.py data/puzzles/content-manifest.json \
     --base-url "https://<your-mirror>/chessengram/packs"
   ```

   Repeated runs are byte-identical; pass `--force` to replace an existing
   file. Each entry's `version` is the first 16 hex of `sha256(pack.jsonl)`.

2. Upload every `data/puzzles/<packId>/pack.jsonl` to the mirror **under its
   version**, i.e. `<your-mirror>/chessengram/packs/<packId>/<version>/pack.jsonl`
   (R2 bucket + custom domain, Pages, or any static host). The path is
   content-addressed, so uploading a new version never overwrites an old one.

3. Configure the worker with `CONTENT_BASE_URL=<your-mirror>/chessengram/packs`
   (`[vars]` or secret). For the build-time JSON seam you can instead set
   `CONTENT_MANIFEST` to the manifest JSON string (wired by
   `contentSourceFromEnv` in `src/content.ts`); for a bucket, wire an
   `R2ContentSource` in the same place.

4. Confirm `GET /health` reports `"content": "configured"` and
   `GET /content/manifest` returns the manifest with
   `Cache-Control: public, max-age=<CONTENT_MANIFEST_MAX_AGE>`.

Clients fetch packs from the `version`-bearing URL, so updates are additive:
a new pack revision is a new URL (safe to cache forever), and the manifest's
short `max-age` is the only thing that changes.

> **Nothing works until Cognito is configured (ONL-006).** With the `COGNITO_*`
> vars set but no verifier yet, `/health` reports `auth: "cognito"` and every
> authenticated route answers `401` until ONL-006 wires it up. The only working
> local mode before then is `SYNC_ALLOW_DEV_AUTH=true`.

## What ONL-006 must add

- A real `TokenVerifier` (JWKS fetch/cache + RS256 verification of Cognito ID
  tokens) selected from `config.cognito` in `selectVerifier()` (`src/index.ts`).
- `sub` → canonical `userId` mapping (never store the raw `sub`).
- Device registration + revoke endpoints (or BFF session flow) so pushes from
  unknown `deviceId`s stop being rejected, plus any session-cookie handling.
