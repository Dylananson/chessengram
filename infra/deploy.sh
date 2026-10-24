#!/usr/bin/env bash
#
# One-command deploy: build -> apply -> publish -> verify.
#
#   bash infra/deploy.sh                 # plan, ask, apply, upload, verify
#   bash infra/deploy.sh --yes           # no prompt (CI)
#   bash infra/deploy.sh --plan-only     # terraform plan, stop before changes
#   bash infra/deploy.sh --skip-infra    # upload the current build only
#   bash infra/deploy.sh --skip-web      # infra only (no PWA build/upload)
#
# Auth (nothing secret is committed):
#   Cloudflare  CLOUDFLARE_API_TOKEN   (Workers Scripts:Edit, D1:Edit, Pages:Edit;
#                                      + R2:Edit and Zone:Read/DNS:Edit if enabled)
#               ...or an interactive `npx wrangler login`, which is enough for the
#               Pages upload but NOT for `terraform apply`.
#   AWS         credentials for the Cognito resources (env vars or an SSO profile).
#
# Steps, in order:
#   1. build the Worker bundle Terraform uploads (`content_file`)
#   2. discover the account's workers.dev subdomain when the API has no custom
#      domain, so api_url is a hostname that actually resolves
#   3. terraform init + plan + apply
#   4. write the public sync settings to the ignored production env file,
#      build the PWA, then upload dist/ to Pages (production branch)
#   5. verify the app URL and the API /health over HTTP

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA="$ROOT/infra"
WEB="$ROOT/apps/web"

ASSUME_YES=false
PLAN_ONLY=false
SKIP_INFRA=false
SKIP_WEB=false

for arg in "$@"; do
  case "$arg" in
    --yes|-y)       ASSUME_YES=true ;;
    --plan-only)    PLAN_ONLY=true ;;
    --skip-infra)   SKIP_INFRA=true ;;
    --skip-web)     SKIP_WEB=true ;;
    -h|--help)
      awk 'NR==1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed (needed: $2)"; }

tf() { terraform -chdir="$INFRA" "$@"; }
tf_output() { tf output -raw "$1" 2>/dev/null || true; }

# Read a string variable straight from terraform.tfvars. Outputs only exist in
# state after an apply, so on a fresh checkout they are not readable yet —
# terraform.tfvars is where the operator put them.
tfvar() { # name
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\([^\"]*\)\".*/\1/p" \
    "$INFRA/terraform.tfvars" 2>/dev/null | head -1
}

# Persist a string variable into terraform.tfvars (git-ignored, operator-owned)
# so a discovered value survives this run instead of being re-derived forever.
set_tfvar() { # name value
  local name="$1" value="$2" file="$INFRA/terraform.tfvars"
  [ -f "$file" ] || return 0
  if grep -qE "^[[:space:]]*${name}[[:space:]]*=" "$file"; then
    sed -i "s|^[[:space:]]*${name}[[:space:]]*=.*|${name} = \"${value}\"|" "$file"
  else
    printf '\n# Recorded by infra/deploy.sh (your <label>.workers.dev subdomain).\n%s = "%s"\n' \
      "$name" "$value" >>"$file"
  fi
}

# ---------------------------------------------------------------------------
# 0. Preflight
# ---------------------------------------------------------------------------
need_cmd npm "the build steps"
need_cmd curl "the verification step"

if [ "$SKIP_INFRA" = false ]; then
  need_cmd terraform "the infrastructure"
fi

wrangler() { npx --yes wrangler "$@"; }

set_env_value() { # file key value
  local file="$1" key="$2" value="$3"
  [ -f "$file" ] || return 0
  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

# Terraform needs a Cloudflare credential. If the operator has an interactive
# `wrangler login` session instead of a token, use it — but its OAuth access
# token expires after a few hours and `terraform` cannot refresh it, which shows
# up as a bare `Authentication error`. `wrangler whoami` *does* refresh it, so do
# that first and hand Terraform the fresh value. (In CI, set a long-lived
# CLOUDFLARE_API_TOKEN instead; nothing here is needed then.)
WRANGLER_CONFIG="$HOME/.config/.wrangler/config/default.toml"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -f "$WRANGLER_CONFIG" ]; then
  warn "no CLOUDFLARE_API_TOKEN: using the wrangler session for Terraform (refreshing it first)."
  wrangler whoami >/dev/null 2>&1 || true
  CLOUDFLARE_API_TOKEN="$(sed -n 's/^oauth_token = "\(.*\)"/\1/p' "$WRANGLER_CONFIG" | head -1)"
  export CLOUDFLARE_API_TOKEN
fi

if [ "$SKIP_WEB" = false ]; then
  wrangler --version >/dev/null 2>&1 || die "wrangler could not be run (needed for the Pages upload)"

  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ ! -f "$HOME/.config/.wrangler/config/default.toml" ]; then
    die "no Cloudflare credentials: set CLOUDFLARE_API_TOKEN or run 'npx wrangler login'"
  fi
fi

if [ "$SKIP_INFRA" = false ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  warn "CLOUDFLARE_API_TOKEN is unset; terraform will fail unless the provider can authenticate another way."
fi

# ---------------------------------------------------------------------------
# 1. Worker bundle (Terraform reads it as content_file at plan time)
# ---------------------------------------------------------------------------
if [ "$SKIP_INFRA" = false ]; then
  log "Building the sync Worker bundle"
  (cd "$ROOT" && npm run --silent build:worker)
  [ -f "$ROOT/services/sync-worker/dist/worker.js" ] || die "worker build produced no bundle"
fi

# ---------------------------------------------------------------------------
# 2. workers.dev subdomain (api_url cannot be built without it)
# ---------------------------------------------------------------------------
# A Worker's dev URL is <worker>.<account-subdomain>.workers.dev. The subdomain
# is an account setting that neither Terraform nor Wrangler exposes as config,
# but the API returns it — so look it up when the user has not supplied it and
# no custom domain is configured.
if [ "$SKIP_INFRA" = false ]; then
  # Durable sources only: the state *output* just echoes the variable from the
  # last run, so trusting it here is what let api_url silently empty out.
  SUBDOMAIN="${TF_VAR_workers_dev_subdomain:-}"
  : "${SUBDOMAIN:=$(tfvar workers_dev_subdomain)}"
  if [ -z "$SUBDOMAIN" ] && [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    ACCOUNT_ID="$(tf_output cloudflare_account_id)"
    : "${ACCOUNT_ID:=$(tfvar cloudflare_account_id)}"
    if [ -n "$ACCOUNT_ID" ]; then
      log "Discovering the account's workers.dev subdomain"
      SUBDOMAIN="$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.result?.subdomain??"")}catch(e){}})')"
    fi
    if [ -n "$SUBDOMAIN" ]; then
      export TF_VAR_workers_dev_subdomain="$SUBDOMAIN"
      # Persist it so later runs (and a manual `terraform apply`) stay correct
      # instead of silently producing an empty api_url.
      set_tfvar workers_dev_subdomain "$SUBDOMAIN"
      echo "    workers.dev subdomain: $SUBDOMAIN (recorded in infra/terraform.tfvars)"
    else
      warn "could not discover the workers.dev subdomain; set TF_VAR_workers_dev_subdomain or api_custom_domain."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 3. Terraform
# ---------------------------------------------------------------------------
if [ "$SKIP_INFRA" = false ]; then
  log "Terraform init"
  tf init -input=false

  log "Terraform plan"
  tf plan -input=false -out=deploy.tfplan

  if [ "$PLAN_ONLY" = true ]; then
    log "Plan only — stopping before apply"
    exit 0
  fi

  if [ "$ASSUME_YES" = false ]; then
    if [ ! -t 0 ]; then
      die "not a terminal: re-run with --yes to apply without a prompt"
    fi
    printf 'Apply these changes? [y/N] '
    read -r reply || reply=""
    case "$reply" in
      y|Y|yes|YES) ;;
      *) die "aborted by the operator" ;;
    esac
  fi

  log "Terraform apply"
  tf apply -input=false -auto-approve deploy.tfplan
  rm -f "$INFRA/deploy.tfplan"

  # Keep generated client settings out of source control. Vite embeds these
  # public values in the client bundle during the production build.
  log "Writing apps/web/.env.production.local from terraform outputs"
  bash "$INFRA/write-env.sh" deploy
  # This deployment is served by Pages *with* the same-origin proxy
  # (apps/web/functions/api + the SYNC_API_ORIGIN env var Terraform sets), so the
  # app must call its own origin: the absolute workers.dev URL is a different
  # site and the browser would withhold the SameSite=Lax session cookie.
  set_env_value "$WEB/.env.production.local" VITE_SYNC_API_BASE /api
fi

# ---------------------------------------------------------------------------
# 4. Build + upload the PWA
# ---------------------------------------------------------------------------
if [ "$SKIP_WEB" = false ]; then
  PAGES_PROJECT="$(tf_output pages_project)"
  PAGES_BRANCH="$(tf_output pages_production_branch)"
  APP_URL="$(tf_output app_url)"
  [ -n "$PAGES_PROJECT" ] && [ -n "$APP_URL" ] || die "terraform output is empty; run the infra step first (without --skip-infra)"
  : "${PAGES_BRANCH:=main}"

  log "Building the PWA"
  (cd "$ROOT" && npm run --silent build)

  log "Uploading apps/web/dist to Cloudflare Pages ($PAGES_PROJECT)"
  # Run from the app directory: wrangler resolves `functions/` (the same-origin
  # API proxy) relative to the working directory, so deploying from the repo root
  # silently ships without it — and then every /api call returns the SPA's HTML.
  (cd "$WEB" && wrangler pages deploy dist \
    --project-name "$PAGES_PROJECT" \
    --branch "$PAGES_BRANCH" \
    --commit-dirty=true)
fi

# ---------------------------------------------------------------------------
# 5. Verify
# ---------------------------------------------------------------------------
APP_URL="${APP_URL:-$(tf_output app_url)}"
API_URL="$(tf_output api_url)"

fail=0
if [ -n "$APP_URL" ]; then
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$APP_URL/" || echo 000)"
  printf 'app  %-45s %s\n' "$APP_URL/" "$code"
  [ "$code" = "200" ] || fail=1

  # The PWA calls its own origin (`/api/…`) and Pages proxies that to the Worker,
  # so the session cookie is first-party. If the Functions bundle was not
  # uploaded, /api/... falls through to the SPA and returns HTML — which looks
  # fine as a status code but breaks every API call, so check the shape.
  proxied="$(curl -sS --max-time 30 "$APP_URL/api/health" || true)"
  printf 'app  %-45s %s\n' "$APP_URL/api/health" "$proxied"
  case "$proxied" in
    *'"ok":true'*) ;;
    *) warn "the same-origin /api proxy is not answering (expected the Worker's /health JSON)."; fail=1 ;;
  esac
else
  warn "no app_url output"
  fail=1
fi

if [ -n "$API_URL" ]; then
  health="$(curl -sS --max-time 30 "$API_URL/health" || true)"
  printf 'api  %-45s %s\n' "$API_URL/health" "$health"
  case "$health" in
    *'"ok":true'*) ;;
    *) fail=1 ;;
  esac
else
  warn "api_url is empty: set workers_dev_subdomain or api_custom_domain"
  fail=1
fi

if [ "$fail" = 0 ]; then
  log "Deploy verified: $APP_URL (API: $API_URL)"
else
  warn "deployed, but at least one check failed — see above."
  exit 1
fi
