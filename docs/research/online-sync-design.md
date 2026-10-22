# Online mode + offline sync (ONL) — frozen design

Approved 2026-10-19 (decisions below). This note plus `apps/web/src/sync/types.ts`
are the **source of truth** for the ONL tasks: the interfaces are frozen, agents
own disjoint files, and nothing requires a cloud account until the final wiring.

## Goal / non-goals

Train fully offline with **no account by default**. Sync is an **opt-in add-on**
that makes progress follow you across devices. Server-side scheduling, realtime
collaboration, social features and Lichess-hosted storage are out of scope.

## Locked decisions

| # | Decision |
|---|---|
| 1 | Device-authoritative sync; the server stores sync payloads **in plaintext** and can read them (revised 2026-10-19, see #6) |
| 2 | **Cloudflare** Workers + D1 (local dev with no account); R2/CDN for packs later |
| 3 | Auth is **optional** — default is `Local only`: no account, no server, no egress |
| 4 | **AWS Cognito** (Essentials, **Google only**) used *only* when sync is enabled |
| 5 | Our own canonical `userId` in D1; never the raw Cognito `sub` (per-provider!) |
| 6 | **Revised twice, 2026-10-19 (user decisions).** (a) *"thats bad ux i dont want this … if they login they can get the data"* → the recovery code was dropped and the server held the master key. (b) *"why do we need this key in the first place?"* → with the server able to decrypt, the key only protected against a **database-only** leak, so it was removed entirely: **there is no master key, no KEK, no `/keys` endpoint and no `keyVersion`**. Payloads are plaintext; integrity is the per-device ECDSA signature (#7). Accepted trade-off, unchanged by (b): anyone with read access to D1 (or a live session) can read training data — including no longer needing the KEK. Per-record HKDF keys, padding and the recovery code are all gone with it |
| 7 | Per-device **ECDSA P-256 signing keys** — integrity even with a stolen session |
| 8 | **Exact** plaintext `updatedAt` (revised 2026-10-19 — exact cross-device ordering) and a per-device monotonic `rev`; the fixed 4 KB padding was dropped with the encryption (ONL-020); debounced batches (10 s) |
| 9 | Public packs plaintext via CDN; user puzzles are user-authored content synced like any other record |
| 10 | Cycle conflicts: **first write wins** via `unique(dedupeKey = SHA-256(scope))` (the salt went with the key model) |
| 11 | Enabling sync **adopts existing local data**; sign-out/disable never deletes local data |

## Envelope (wire format)

```jsonc
{
  "v": 2,                 // v2 = plaintext payloads (ONL-020)
  "type": "attempt" | "setting" | "collection" | "woodpecker" | "woodpeckerResult" | "userPuzzle",
  "recordId": "…",        // local stable id (attemptId, collectionId, puzzleId, …)
  "dedupeKey": "…",       // hex SHA-256(scope) — the server's unique key
  "deviceId": "…",
  "payload": { … },       // PLAINTEXT payload (the `Sync*Payload` shapes)
  "sig": "base64",        // device ECDSA signature over the canonical bytes below
  "updatedAt": 1697…,     // exact epoch ms; the server uses it for ordering/LWW
  "rev": 7,               // monotonic per-device counter (signed, ordering tie-break)
  "seq": 42               // server-assigned on ack; absent in push payloads
}
```

Canonical signed bytes (identical on both sides, pinned by fixed test vectors):

```
stableJson(payload)   // object keys sorted lexicographically at every level
payloadHash           = hex SHA-256(stableJson(payload))
canonicalEnvelopeBytes = JSON.stringify([v, type, recordId, dedupeKey, deviceId,
                                         updatedAt, rev, payloadHash])
```

The payload is therefore tamper-evident even though it is readable. Unknown
`type`/`v`, a missing/non-object payload or a malformed field must fail closed
(treated as corrupt, never partially applied).

## Dedupe keys and conflict rules

| Entity | `recordId` | `dedupeKey` | Rule |
|---|---|---|---|
| attempt | attemptId | `SHA-256(scope)` | dedupe (idempotent push) |
| setting | field group | `SHA-256(scope)` | LWW by `(updatedAt, rev, deviceId)` |
| collection | collectionId | `SHA-256(scope)` | LWW for name; membership is a set (+tombstones) |
| woodpecker set/cycle | setId/cycleId | `SHA-256(scope)` | append-only / create-if-absent |
| woodpecker result | — | `SHA-256(cycleId‖puzzleId)` | **first write wins** (`unique`) |
| userPuzzle | puzzleId | `SHA-256(scope)` | LWW by `updatedAt` |

There is no salt any more (ONL-020): the payload is plaintext, so salting the
hash input protected nothing, and a deterministic key is what lets two devices
agree on the same record.

## Local queue model

The queue holds **pointers, not payloads**: `{type, recordId, changedAt}`.
The pusher reads the current local record at push time, encrypts it, sends it,
and drops the pointer on ack. This keeps local storage lean and lets a later
edit supersede an unsent change. A record edited while a push is in flight is
re-enqueued (compare `changedAt`).

## States (Settings → Sync)

| State | Meaning | Training |
|---|---|---|
| `local-only` (default) | no account, no MK, no queue | ✅ |
| `syncing` | signed in + MK unlocked | ✅ (offline too) |
| `paused` | offline / signed out / key not fetched on this device yet — the next round fetches it from the server | ✅ |
| `paused` | session expired or offline; queue accumulates | ✅ |

Enable sync: sign in → this device's P-256 signing keypair is generated and its
public half registered → existing local data enqueued (adoption) → first push.
A device whose local state was wiped simply generates and registers a fresh
keypair on the next sync round; there is no key or code to enter, ever. Sign out / disable: keep
local data, drop queue/session. `delete-server-copy` is a separate explicit
action and never touches local data.

## HTTP surface (own API; no Lila or broker endpoints)

```
GET    /health                      -> { ok, configured, auth }
POST   /sync                        { since, push: Envelope[] } -> { cursor, accepted, duplicates, changes: Envelope[] }
DELETE /sync/account                -> wipe this user's stored records
```

Auth: `Authorization: Bearer <Cognito ID token>`; the Worker verifies via JWKS,
maps `sub` → canonical `userId`, and enforces that every envelope's `deviceId`
is a registered device of that user. Envelopes whose `sig` does not verify are
rejected (422). Batch and body size caps are configuration, not constants.

## Config parameterization (fill in at the end)

Nothing may be hard-coded; unconfigured ⇒ sync unavailable and reported as such.

Worker (`services/sync-worker/wrangler.toml` + secrets):
`SYNC_DB` (D1 binding), `COGNITO_REGION`, `COGNITO_USER_POOL_ID`,
`COGNITO_CLIENT_ID`, `COGNITO_JWKS_URL` (optional override), `ALLOWED_ORIGINS`,
`MAX_PUSH_BYTES`, `MAX_BATCH`. There is no key material and no Worker secret
(ONL-020).

Client (build-time `VITE_*` with runtime override via `/sync-config.json`):
`VITE_SYNC_API_BASE`, `VITE_SYNC_AUTH_AUTHORITY`, `VITE_SYNC_AUTH_CLIENT_ID`,
`VITE_SYNC_AUTH_REDIRECT_URI`. Absent ⇒ the Sync panel shows `local-only` plus
"not configured"; **no network calls are made**.

## Ownership map (agents never share a file)

| Task | Owns |
|---|---|
| ONL-001 | `apps/web/src/storage/local-store.ts`, `apps/web/src/storage/data-port.ts`, `apps/web/tests/data-port.node.test.ts` |
| ONL-002 | `apps/web/src/sync/queue.ts`, `apps/web/src/sync/device.ts`, `apps/web/src/sync/signing.ts`, `apps/web/tests/sync-queue.node.test.ts`, `apps/web/tests/sync-device.node.test.ts` |
| ONL-003 | `apps/web/src/settings-view.ts`, `apps/web/src/i18n.ts` (`sync.*`), `apps/web/src/design-system.scss` (`.sync-*`), `apps/web/scripts/smoke.mjs` |
| ONL-004 | `apps/web/src/sync/envelope.ts`, `apps/web/tests/sync-envelope.node.test.ts` (the crypto module `keys.ts` was deleted in ONL-020) |
| ONL-005 | `services/sync-worker/**` (+ the `services/*` workspace entry) |
| ONL-006 | `services/sync-worker/src/auth.ts`, `services/sync-worker/src/config.ts` (after ONL-005) |
| ONL-007 | `apps/web/src/sync/collections.ts`, `apps/web/src/sync/woodpecker.ts` + tests |
| ONL-008 | `services/sync-worker/src/content.ts`, `tools/puzzles/pack-manifest.py`, pack CDN docs |
| ONL-009 | `apps/web/public/sw.js`, `apps/web/index.html`, docs |

Frozen shared contracts (created with this note, **do not edit without the
coordinator**): `apps/web/src/sync/types.ts`.

## Gates and test list

Every task: `npm test`, `npm run typecheck`, `npm run build` green; user-visible
changes also `npm run smoke`. No commits unless asked.

Required tests across the feature: envelope round-trip + rejection of a
tampered payload (the signature covers it); canonical-bytes test vectors shared
with the service;
queue enqueue/coalesce/ack/retry; adoption of existing local data; convergence
of two clients; per-device signature enforcement (a tampered payload and a
v1 envelope are both rejected); first-write-wins on duplicate cycle results;
`1.2.0 → 1.3.0` export/import round-trip including a non-empty queue.

## Owner setup checklist (final step, needs accounts)

1. Cloudflare account → `wrangler login`, create D1, set `SYNC_DB` binding.
2. AWS account → Cognito user pool (Essentials) + Google social IdP + app client
   (authorization code + PKCE) with callback/redirect URLs; **10k MAU free**.
   Do **not** enable the Plus tier or advanced security features.
3. Google Cloud OAuth client (scopes `openid email profile`; publish consent).
4. Set the `VITE_SYNC_*` values (or `/sync-config.json`) and deploy the worker.
