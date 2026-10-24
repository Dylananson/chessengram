# Infrastructure (Terraform)

Everything the online-sync feature needs, created from code:

| Resource | Provider | Why |
|---|---|---|
| **D1 database** `chessreps-<env>-sync` | Cloudflare | stores only encrypted sync envelopes |
| **Worker** `chessreps-<env>-sync` | Cloudflare | sync API (`/sync`, `/devices`, `/auth/session`, `/content/manifest`) |
| **Pages project** | Cloudflare | hosts the PWA (`apps/web/dist`) |
| **Cognito user pool** (Essentials) | AWS | identity only; **Google** is the only sign-in |
| **Cognito hosted domain + app client** | AWS | authorization-code + PKCE, no client secret, no password flows |
| **Google identity provider** | AWS (Cognito) | federates Google into the pool |
| **R2 bucket** *(optional)* | Cloudflare | public CC0 puzzle packs, content-addressed |
| **Custom domains + DNS** *(optional)* | Cloudflare | `api.`, app and pack hostnames |

What it deliberately does **not** create: the Google OAuth client itself (a
Google Cloud console step — see below) and the PWA bundle upload (a deploy
step, not a resource — `bash infra/deploy.sh` does it). Training data never
reaches AWS; Cloudflare stores only ciphertext.

## Prerequisites

- Terraform ≥ 1.6 (`terraform version`).
- A Cloudflare API token with: **Workers Scripts:Edit, D1:Edit, Pages:Edit,
  R2:Edit** (+ **Zone:Read, DNS:Edit** only if you use custom domains/DNS).
- AWS credentials for the target account (env vars or SSO profile).
- The Worker bundle built:
  ```sh
  npm run build --workspace @chessreps/sync-worker   # -> services/sync-worker/dist/worker.js
  ```

## First run

### Remote state setup (recommended before applying the main stack)

The main Terraform state contains sensitive values. Create the S3 backend bucket
first using the isolated bootstrap configuration, which keeps its own local
state:

```sh
terraform -chdir=infra/state-bootstrap init
terraform -chdir=infra/state-bootstrap plan
terraform -chdir=infra/state-bootstrap apply
terraform -chdir=infra/state-bootstrap output -raw bucket_name
```

Use the output bucket name in a local `infra/backend.tf` based on
`backend.tf.example` (set the bucket, key, and AWS region). Then migrate any
existing local main-stack state:

```sh
terraform -chdir=infra init -migrate-state
```

`infra/backend.tf` is git-ignored and must not contain credentials. Keep the
bootstrap state/configuration: it manages the state bucket, which must not be
destroyed while the main state uses it. The bucket has versioning, encryption,
public access blocking, and `prevent_destroy` enabled. S3 lockfiles require
Terraform 1.10 or newer.

```sh
cd infra
cp terraform.tfvars.example terraform.tfvars     # fill in the values
terraform init                                   # migrates local state if backend.tf is configured
terraform plan
terraform apply
```

Minimum values in `terraform.tfvars`:

| Variable | What |
|---|---|
| `cloudflare_account_id` | your Cloudflare account id — **the only required value** |
| `workers_dev_subdomain` | *optional* — your account's `<label>.workers.dev`. `infra/deploy.sh` discovers it from the API token; set it (or `api_custom_domain`) by hand if you apply without the script, otherwise `api_url` stays empty |
| `app_url` | *optional* — derived from the Pages project this config creates |
| `cognito_domain_prefix` | *optional* — derived from the account id (`<project>-<env>-<6 hex>`) |
| `google_client_id` / `google_client_secret` | *optional* — only to add "Sign in with Google" |

A Worker's dev URL is `<worker>.<account-subdomain>.workers.dev`, and the account
subdomain is not something Terraform can read — so it is an input. Without it
(and without `api_custom_domain`) the generated `sync_config_json` has an empty
`apiBase`, the app stays local-only, and a `check` block warns during plan/apply.

### Sign-in (nothing manual by default)

Sign-in is **Cognito managed login with passkeys + email one-time codes**, all
created by this config (`sign_in_policy`, `web_authn_configuration`,
`ALLOW_USER_AUTH`, and a managed-login branding style). Two consequences worth
knowing:

- The passkey **relying party id is left unset on purpose**: per the AWS docs,
  *"if you don't have a custom domain and don't specify otherwise, your user pool
  defaults to an RP ID of your prefix domain."* Passing the prefix FQDN
  explicitly is rejected (`RelyingPartyId cannot be reserved domain other than
  User Pool's prefix domain`), so only set it if you add a **custom domain** —
  and note that changing the RP ID **invalidates every registered passkey**.
- Email one-time codes use Cognito's built-in sender (a 50/day cap); switch to
  SES via `email_configuration` if you ever need more.
- The **password policy is cosmetic**: Cognito *requires* the PASSWORD factor to
  be allowed, but this app never uses it — the only password that ever exists is
  the random one you discard at user creation. `password_min_length` (default 12)
  and `password_require_symbols` (default off) are there for completeness.

### Sign-ups are closed (create your own user once)

`allow_self_signup = false` is the default: managed login has **no sign-up page**,
and an unknown email cannot create an account (it fails rather than
auto-registering). Create yourself as the first user, with a verified email and
no password — you will sign in with an emailed one-time code and then register a
passkey:

```sh
POOL="$(terraform -chdir=infra output -raw cognito_user_pool_id)"
REGION="$(terraform -chdir=infra output -raw aws_region)"

aws cognito-idp admin-create-user \
  --user-pool-id "$POOL" --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS --region "$REGION"

# Cognito requires PASSWORD as a first factor, so give the account a random
# permanent password and throw it away: the user is CONFIRMED, but nobody can
# sign in with a password. They use an emailed one-time code, then register a
# passkey.
aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL" --username you@example.com \
  --password "$(openssl rand -base64 24)" --permanent --region "$REGION"
```

Use your email address as the username: managed login asks for a username, and
email one-time codes are sent to the `email` attribute. Because the pool always
lists a password option, the second command above is what keeps it unusable —
and there is no forgot-password flow, by design. Add more people the same
way, or set `allow_self_signup = true` later to open registration.

### Adding Google later (the only manual step, optional)

1. Google Cloud → **APIs & Services → Credentials → Create credentials →
   OAuth client ID → Web application**. Google's OAuth *client* cannot be
   provisioned by Terraform for this use: `google_iap_brand`/`google_iap_client`
   are deprecated, and `google_iam_oauth_client` targets Workforce Identity
   Federation rather than consumer sign-in.
2. Authorized redirect URI **must** be exactly:
   ```
   https://<cognito_domain_prefix>.auth.<aws_region>.amazoncognito.com/oauth2/idpresponse
   ```
   (the same value a successful `terraform apply` gives you in
   `terraform output cognito_domain`).
3. Put the client id/secret in `terraform.tfvars` and apply. Only scopes
   `openid email profile` are requested — no Google verification review needed.

## After apply (deploy steps)

One command does all of it — build the Worker, apply, build the PWA, upload it to
Pages, then verify both URLs over HTTP:

```sh
export CLOUDFLARE_API_TOKEN=...            # Workers Scripts:Edit, D1:Edit, Pages:Edit
export AWS_PROFILE=...                     # or AWS_ACCESS_KEY_ID/SECRET
npm run deploy                             # = bash infra/deploy.sh
npm run deploy:branch -- feat/my-feature  # build + manually deploy a remote branch preview

# variants
bash infra/deploy.sh --plan-only           # terraform plan, stop before changes
bash infra/deploy.sh --yes                 # no prompt (CI)
bash infra/deploy.sh --skip-infra --yes    # rebuild + re-upload the PWA only
bash infra/deploy.sh --skip-web            # infra only
```

`deploy:branch` fetches the named branch from `origin`, builds it in a temporary
Git worktree, then uploads it to Pages using that branch name. It leaves the
current checkout untouched and does not run Terraform. It reads the current
Terraform outputs for the Pages project and runtime sync config, so initialize
the configured backend and apply the infrastructure first. You can override
the project name with a second argument or `PAGES_PROJECT`. Manual Wrangler
uploads can still create a preview when automatic Git previews are disabled.

What it does, and why in that order:

| Step | Detail |
|---|---|
| 1 | `npm run build:worker` — Terraform uploads `services/sync-worker/dist/worker.js` (`content_file`), so the bundle must exist before `plan` |
| 2 | discovers the account's `workers.dev` subdomain (the `workers_dev_subdomain` input above) and passes it as `TF_VAR_workers_dev_subdomain` |
| 3 | `terraform init/plan/apply` — confirms the plan unless `--yes` |
| 4 | `write-env.sh deploy` → `apps/web/.env.production.local`, `npm run build`, then `dist/sync-config.json` from `terraform output -raw sync_config_json`, then `wrangler pages deploy --branch main` |
| 5 | `curl`s the app URL (expects `200`) and `<api_url>/health` (expects `"ok":true`) |

The manual equivalent, if you prefer to see every step:

```sh
npm run build:worker
terraform -chdir=infra apply
terraform -chdir=infra output -raw sync_config_json > /dev/null   # (inspect it)
bash infra/write-env.sh deploy
npm run build
terraform -chdir=infra output -raw sync_config_json > apps/web/dist/sync-config.json
npx wrangler pages deploy apps/web/dist --project-name chessreps-prod --branch main
curl "$(terraform -chdir=infra output -raw api_url)/health"
```

`--branch main` matters: the Pages project's production branch is `main`, and a
deploy from any other branch (or no branch) creates a *preview* deployment —
the production `*.pages.dev` URL then keeps returning `error code: 522`.

`dist/sync-config.json` is public, un-versioned and generated (never commit it):
it carries the API URL, Cognito domain, client id and redirect URI. Runtime
values win per field over the `VITE_SYNC_*` values baked into the bundle, so the
API can be repointed by re-uploading `dist/` without rebuilding.

Then on the phone: install the PWA, **Settings → Sync → Enable sync**, sign in.
There is no code to copy or store — the master key is provisioned server-side and
handed to any authenticated session (design #6 revised).

### Public packs (optional, `enable_content_bucket = true`)

```sh
python3 tools/puzzles/pack-manifest.py data/puzzles/content-manifest.json \
  --base-url "$(terraform -chdir=infra output -raw content_base_url)"

# upload each pack under its content hash
#   wrangler r2 object put <bucket>/<packId>/<version>/pack.jsonl --file data/puzzles/<packId>/pack.jsonl
```

Clients fetch `version`-bearing URLs, so publishing a new pack is additive and
safe to cache; only the manifest's short `max-age` changes.

## Security / operations notes

- **State contains `google_client_secret`.** Use an encrypted remote backend
  before pointing this at a real account (`backend.tf.example`); never commit
  `terraform.tfvars` or state (both are git-ignored).
- **The Pages project proxies `/api/*` to the Worker.** `SYNC_API_ORIGIN`
  (a Pages env var set by this config, for both production and preview) points at
  the Worker, and `apps/web/functions/api/[[path]].js` forwards to it. This is
  what keeps the `SameSite=Lax` BFF session cookie **first-party**: the app runs
  on `*.pages.dev` and the API on `*.workers.dev`, which are different sites, so
  a direct cross-site call would sign in and then fail every
  session-authenticated request with 401. `apps/web/public/_routes.json` limits
  Function invocation to `/api/*` so static assets stay on the free static path.
  If you later add same-site custom domains, the proxy is unnecessary — but
  harmless.
- **No Worker secrets.** Sync payloads are stored **in plaintext** (ONL-020
  removed the key model — the server-trusted decision is recorded in
  `docs/research/online-sync-design.md` #1/#6), so there is nothing to wrap and
  nothing to rotate. The Worker still verifies Cognito ID tokens against public
  JWKS, verifies a per-device ECDSA signature on every envelope (a stolen session
  cannot forge another device's writes), and keeps session ids random + hashed in
  D1. Read access to D1 therefore means read access to training data — see the
  design note for that trade-off.
- **Cognito cost:** Essentials includes managed login and passkeys, **10,000
  MAU free** (never expires) for social sign-in. Do not switch to **Plus**
  (no free tier) or enable advanced security features — Google handles MFA.
- **Deletion protection:** the pool and app client have
  `prevent_destroy = true` so a stray `terraform destroy` cannot wipe
  identities. Deleting them later is a deliberate edit of this file; it never
  touches training data (that lives encrypted in D1 and on devices).
- **D1 schema:** the Worker creates its tables with `CREATE … IF NOT EXISTS` on
  first use, so there is no separate migration to run. Pack manifests and
  generated configs are build artifacts, not state.
- **CORS:** only `app_url` (plus anything you add) is allowed; `ALLOWED_ORIGINS`
  is derived automatically. The Worker rejects mutating cookie requests without
  a JSON content type and an allowed `Origin`.
- **Region:** the pool is in `aws_region` and D1 uses the `weur` hint; change
  both deliberately if you care about data residency.

## Recovering from a failed apply / changing region

If an apply fails part-way (for example after the pool was created in the wrong
region), clean up before re-applying:

```sh
terraform -chdir=infra state list            # see what already exists

# Drop the Cognito resources from state (adjust to what is listed)
terraform -chdir=infra state rm \
  aws_cognito_managed_login_branding.app \
  aws_cognito_user_pool_client.app \
  aws_cognito_identity_provider.google \
  aws_cognito_user_pool_domain.main \
  aws_cognito_user_pool.users

# Delete the orphaned pool (deletion protection must be lifted first)
aws cognito-idp update-user-pool --user-pool-id <OLD_POOL_ID> \
  --deletion-protection INACTIVE --region <OLD_REGION>
aws cognito-idp delete-user-pool --user-pool-id <OLD_POOL_ID> --region <OLD_REGION>

terraform -chdir=infra apply                  # recreates it in aws_region
```

Changing `d1_location_hint` after the database exists may make Terraform replace
it; the database is empty at this stage, so that is harmless.

## Verification status

`terraform validate` passes against the pinned providers
(`cloudflare ~> 5.0`, `aws ~> 6.0`) with no cloud account present.
`terraform plan/apply` have intentionally **not** been run — they need your
accounts. `terraform fmt -check` is clean.
