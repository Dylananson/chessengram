#!/usr/bin/env bash
# Build and manually deploy a remote Git branch without changing the caller's
# checkout (which may contain uncommitted work).
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "error: run this script from inside the repository" >&2
  exit 1
}

usage() {
  echo "Usage: npm run deploy:branch -- <remote-branch> [pages-project]" >&2
  echo "Example: npm run deploy:branch -- feat/issue-2-custom-puzzle-packs" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

BRANCH="$1"

if ! git check-ref-format --branch "$BRANCH" >/dev/null; then
  echo "error: invalid branch name: $BRANCH" >&2
  exit 2
fi

command -v npm >/dev/null 2>&1 || { echo "error: npm is required" >&2; exit 1; }
command -v terraform >/dev/null 2>&1 || { echo "error: terraform is required to read the Pages project/config" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "error: node is required" >&2; exit 1; }

PAGES_PROJECT="${2:-${PAGES_PROJECT:-$(terraform -chdir="$ROOT/infra" output -raw pages_project 2>/dev/null || true)}}"
PAGES_PROJECT="${PAGES_PROJECT:-chessengram}"
SYNC_CONFIG="$(terraform -chdir="$ROOT/infra" output -raw sync_config_json 2>/dev/null || true)"
if [[ -z "$SYNC_CONFIG" || "$SYNC_CONFIG" == "null" ]]; then
  echo "error: Terraform output 'sync_config_json' is unavailable; initialize the configured backend and apply the infrastructure first" >&2
  exit 1
fi

echo "Fetching origin/$BRANCH..."
git -C "$ROOT" fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/chessengram-pages-deploy.XXXXXX")"
WORKTREE="$TEMP_ROOT/repo"

cleanup() {
  git -C "$ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  rmdir "$TEMP_ROOT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

git -C "$ROOT" worktree add --detach "$WORKTREE" "refs/remotes/origin/$BRANCH"

echo "Installing dependencies for origin/$BRANCH..."
(cd "$WORKTREE" && npm ci)

echo "Building origin/$BRANCH..."
(cd "$WORKTREE" && npm run build)

# Embed runtime configuration for this deployment. Pages Functions proxy /api
# to the Worker, so use same-origin /api to preserve the session cookie.
printf '%s' "$SYNC_CONFIG" | node -e '
let input = "";
process.stdin.on("data", (chunk) => input += chunk).on("end", () => {
  const config = JSON.parse(input);
  config.apiBase = "/api";
  process.stdout.write(JSON.stringify(config));
});' > "$WORKTREE/apps/web/dist/sync-config.json"

echo "Deploying branch preview to Pages project '$PAGES_PROJECT'..."
echo "Note: the configured Cognito callback is the production URL; preview sign-in may return to production."
(cd "$WORKTREE/apps/web" && npx --yes wrangler pages deploy dist \
  --project-name "$PAGES_PROJECT" \
  --branch "$BRANCH")
