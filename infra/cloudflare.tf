# ---------------------------------------------------------------------------
# Cloudflare: D1 (ciphertext store), the sync Worker, the Pages project that
# hosts the PWA, and an optional R2 bucket for the public CC0 puzzle packs.
# ---------------------------------------------------------------------------

resource "cloudflare_d1_database" "sync" {
  account_id = var.cloudflare_account_id
  name       = "${local.prefix}-sync"

  # Keep data in the EU unless you deliberately choose otherwise.
  primary_location_hint = var.d1_location_hint
}
# Plain-text vars only. Nothing secret is required by the Worker: it verifies
# Cognito ID tokens against public JWKS and stores ciphertext it cannot read.
locals {
  worker_vars = {
    COGNITO_REGION           = var.aws_region
    COGNITO_USER_POOL_ID     = aws_cognito_user_pool.users.id
    COGNITO_CLIENT_ID        = aws_cognito_user_pool_client.app.id
    ALLOWED_ORIGINS          = local.allowed_origins
    MAX_BATCH                = tostring(var.max_batch)
    MAX_PUSH_BYTES           = tostring(var.max_push_bytes)
    SESSION_TTL_SECONDS      = tostring(var.session_ttl_seconds)
    JWKS_CACHE_SECONDS       = tostring(var.jwks_cache_seconds)
    CONTENT_MANIFEST_MAX_AGE = tostring(var.content_manifest_max_age)
  }
}

resource "cloudflare_workers_script" "sync" {
  account_id     = var.cloudflare_account_id
  script_name    = local.worker
  content_file   = var.worker_script_path
  content_sha256 = filesha256(var.worker_script_path)
  main_module    = "worker.js"

  compatibility_date = var.worker_compatibility_date

  bindings = concat(
    [{
      type = "d1"
      name = "SYNC_DB"
      id   = cloudflare_d1_database.sync.id
    }],
    [
      for name, value in local.worker_vars : {
        type = "plain_text"
        name = name
        text = value
      }
    ],
    var.content_base_url == "" ? [] : [{
      type = "plain_text"
      name = "CONTENT_BASE_URL"
      text = var.content_base_url
    }],
  )
}

# Publish the Worker on <worker>.<account-subdomain>.workers.dev. Creating the
# script is not enough: without this route the Worker has no address at all
# (the edge answers `error code: 1042`) and the only reachable hostname would be
# the optional custom domain.
resource "cloudflare_workers_script_subdomain" "sync" {
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.sync.script_name
  enabled          = true
  previews_enabled = false
}

# Optional custom hostname for the API.
resource "cloudflare_workers_custom_domain" "sync" {
  count = var.api_custom_domain == "" ? 0 : 1

  account_id = var.cloudflare_account_id
  hostname   = var.api_custom_domain
  service    = cloudflare_workers_script.sync.script_name
  zone_id    = var.cloudflare_zone_id
}

# The PWA itself (upload the built dist/ with `wrangler pages deploy`).
resource "cloudflare_pages_project" "app" {
  account_id        = var.cloudflare_account_id
  name              = local.pages_project_name
  production_branch = "main"

  # The deployed app calls its own origin (`/api/…`) and the Pages Function in
  # apps/web/functions/api/ forwards that to the Worker, so the BFF session
  # cookie stays first-party. Without the proxy the app (`*.pages.dev`) and the
  # API (`*.workers.dev`) are different *sites*, and a browser withholds a
  # `SameSite=Lax` cookie on those fetches — which showed up as a 401 on
  # `POST /devices` after a successful sign-in.
  deployment_configs = {
    production = {
      env_vars = {
        SYNC_API_ORIGIN = { type = "plain_text", value = local.api_url }
        # These are public client settings consumed by the Pages build. Vite
        # embeds VITE_* values in the browser bundle; never put credentials here.
        VITE_SYNC_API_BASE       = { type = "plain_text", value = "/api" }
        VITE_SYNC_AUTH_AUTHORITY = { type = "plain_text", value = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com" }
        VITE_SYNC_AUTH_CLIENT_ID = { type = "plain_text", value = aws_cognito_user_pool_client.app.id }
        # Avoid local.app_url here: it depends on the Pages project resource,
        # while this project's OAuth client also depends on that project URL.
        VITE_SYNC_AUTH_REDIRECT_URI = { type = "plain_text", value = "${var.app_url != "" ? var.app_url : "https://${local.prefix}.pages.dev"}/" }
      }
    }
    preview = {
      env_vars = {
        SYNC_API_ORIGIN = { type = "plain_text", value = local.api_url }
      }
    }
  }

  # Keep the existing GitHub integration under Terraform management. Omitting
  # this block after importing the Pages project makes Terraform plan to clear
  # its source configuration and disconnect automatic Git deployments.
  source = {
    type = "github"
    config = {
      owner                          = "Dylananson"
      owner_id                       = "13480673"
      path_includes                  = ["*"]
      pr_comments_enabled            = true
      preview_deployment_setting     = "none"
      production_branch              = "main"
      production_deployments_enabled = true
      repo_id                        = "1430263889"
      repo_name                      = "chessengram"
    }
  }
}

resource "cloudflare_pages_domain" "app" {
  count = var.app_custom_domain == "" ? 0 : 1

  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.app.name
  name         = var.app_custom_domain
}

# Public CC0 pack mirror (plaintext, content-addressed; no user data).
resource "cloudflare_r2_bucket" "content" {
  count = var.enable_content_bucket ? 1 : 0

  account_id = var.cloudflare_account_id
  name       = "${local.prefix}-content"
  location   = var.r2_location
}

resource "cloudflare_r2_custom_domain" "content" {
  count = var.enable_content_bucket && var.content_custom_domain != "" ? 1 : 0

  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.content[0].name
  domain      = var.content_custom_domain
  zone_id     = var.cloudflare_zone_id
  enabled     = true
}

# --- optional DNS -----------------------------------------------------------

resource "cloudflare_dns_record" "api" {
  # NOTE: cloudflare_workers_custom_domain above routes the hostname to the
  # Worker; this record only pins the CNAME target explicitly. Keep it in sync
  # with the Worker's real dev hostname — a CNAME to "<worker>.workers.dev"
  # (without the account subdomain) does not resolve.
  count = var.manage_dns && var.api_custom_domain != "" && local.workers_dev_host != "" ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = var.api_custom_domain
  type    = "CNAME"
  content = local.workers_dev_host
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "app" {
  count = var.manage_dns && var.app_custom_domain != "" ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = var.app_custom_domain
  type    = "CNAME"
  content = cloudflare_pages_project.app.subdomain
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "content" {
  count = var.manage_dns && var.enable_content_bucket && var.content_custom_domain != "" ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = var.content_custom_domain
  type    = "CNAME"
  content = "${local.prefix}-content.r2.cloudflarestorage.com"
  proxied = true
  ttl     = 1
}

# --- sanity checks ----------------------------------------------------------

# Warn (do not fail) when the API has no address yet, because that silently
# breaks every generated client config: `apps/web/public/sync-config.json` would
# carry an empty apiBase and the app would stay local-only.
check "api_url_is_known" {
  assert {
    condition     = local.api_hostname != ""
    error_message = "api_url is empty. Set `workers_dev_subdomain` (Workers & Pages -> \"Your subdomain\", e.g. TF_VAR_workers_dev_subdomain=myaccount) or `api_custom_domain`: a Worker's dev URL is <worker>.<account-subdomain>.workers.dev and cannot be derived from the account id. `bash infra/deploy.sh` discovers the subdomain automatically from CLOUDFLARE_API_TOKEN."
  }
}
