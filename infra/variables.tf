# ---------------------------------------------------------------------------
# Identity / account inputs. No account ids, pool ids, hostnames or secrets
# have defaults: fill them in `terraform.tfvars` at the end (see README).
# ---------------------------------------------------------------------------

variable "cloudflare_account_id" {
  description = "Cloudflare account id that owns the Worker, D1 database and Pages project."
  type        = string
}

variable "aws_region" {
  description = "AWS region for the Cognito user pool (identity data only; training data stays in Cloudflare)."
  type        = string
  default     = "ap-southeast-2" # Sydney
}

variable "project_name" {
  description = "Short project slug used to derive resource names."
  type        = string
  default     = "chessreps"
}

variable "pages_project_name" {
  description = "Cloudflare Pages project name. Kept separate because the deployed Pages project was renamed while Worker and D1 names remain unchanged."
  type        = string
  default     = "chessengram"
}

variable "environment" {
  description = "Deployment environment slug (prod, staging, ...)."
  type        = string
  default     = "prod"
}

# --- app / API endpoints ----------------------------------------------------

variable "app_url" {
  description = "Public URL of the installed PWA. Leave empty to derive it from the Cloudflare Pages project this config creates (https://<pages-subdomain>). Set it explicitly only when the app is hosted elsewhere or behind a custom domain. No trailing slash."
  type        = string
  default     = ""
}

variable "worker_script_path" {
  description = "Built Worker bundle. Build it first: npm run build --workspace @chessreps/sync-worker"
  type        = string
  default     = "../services/sync-worker/dist/worker.js"
}

variable "worker_compatibility_date" {
  description = "Workers runtime compatibility date."
  type        = string
  default     = "2026-10-01"
}

variable "api_custom_domain" {
  description = "Optional custom hostname for the Worker (e.g. api.example.com). Empty = use *.workers.dev."
  type        = string
  default     = ""
}

variable "workers_dev_subdomain" {
  description = <<-EOT
    Your account's workers.dev subdomain — the label shown in Workers & Pages ->
    "Your subdomain". Required when api_custom_domain is empty: a Worker's dev URL
    is <worker>.<account-subdomain>.workers.dev, so the API URL cannot be built
    from the account id alone. Discover it with:
      curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        "https://api.cloudflare.com/client/v4/accounts/<account_id>/workers/subdomain"
    (infra/deploy.sh does this for you when the value is unset.)
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.workers_dev_subdomain == "" || can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.workers_dev_subdomain))
    error_message = "workers_dev_subdomain must be a single DNS label: lowercase letters, digits and dashes (no dots)."
  }
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id. Required only when api_custom_domain, app_custom_domain, content_custom_domain or manage_dns is set."
  type        = string
  default     = ""
}

variable "manage_dns" {
  description = "Create the DNS records for the custom domains in the Cloudflare zone."
  type        = bool
  default     = false
}

variable "app_custom_domain" {
  description = "Optional custom hostname for the Pages app (e.g. chessreps.example.com). Empty = <project>.pages.dev."
  type        = string
  default     = ""
}

# --- Cognito ----------------------------------------------------------------

variable "cognito_domain_prefix" {
  description = "Cognito hosted-domain prefix. Leave empty to derive a stable, unique value from the Cloudflare account id (<project>-<env>-<6 hex>). Override only if that name is taken. NOTE: the prefix determines the passkey relying party id — changing it later invalidates every registered passkey."
  type        = string
  default     = ""
}

variable "google_client_id" {
  description = "Optional. Google OAuth 2.0 client id. Leave empty to use Cognito-managed sign-in only (passkeys + email one-time codes) — no third-party client needed."
  type        = string
  default     = ""
}

variable "google_client_secret" {
  description = "Optional Google OAuth 2.0 client secret (required only when google_client_id is set). Stored in Terraform state -> use an encrypted remote backend."
  type        = string
  default     = ""
  sensitive   = true
}

variable "allow_self_signup" {
  description = "Allow users to sign themselves up. Default false: the pool only accepts users an administrator creates (no public sign-up page, no account creation on first sign-in). Flip to true when you want open registration."
  type        = bool
  default     = false
}

variable "password_min_length" {
  description = "Minimum password length for the pool's (unused) password factor. Cognito's own default is 8; lower it further only if you care."
  type        = number
  default     = 12

  validation {
    condition     = var.password_min_length >= 6 && var.password_min_length <= 99
    error_message = "Cognito accepts a minimum length between 6 and 99."
  }
}

variable "password_require_symbols" {
  description = "Require a symbol in passwords. Off by default: the factor is unused, and symbols make a rare manual reset more annoying."
  type        = bool
  default     = false
}

variable "web_authn_user_verification" {
  description = "Passkey user-verification requirement: 'preferred' (accept devices without a biometric/PIN check) or 'required'."
  type        = string
  default     = "preferred"
}

variable "extra_allowed_origins" {
  description = "Additional browser origins allowed to call the sync API (CORS + CSRF). Defaults to the local dev server so you can test against the deployed Worker."
  type        = list(string)
  default     = ["http://localhost:5173"]
}

variable "extra_callback_urls" {
  description = "Extra OAuth callback URLs beyond app_url (e.g. http://localhost:5173 for local dev)."
  type        = list(string)
  default     = ["http://localhost:5173"]
}

variable "session_ttl_seconds" {
  description = "Lifetime of a sync session cookie in seconds."
  type        = number
  default     = 2592000 # 30 days
}

variable "deletion_protection" {
  description = "Cognito deletion protection (ACTIVE or INACTIVE). Keep ACTIVE for a real account."
  type        = string
  default     = "ACTIVE"
}

# --- sync limits ------------------------------------------------------------

variable "max_batch" {
  description = "Maximum envelopes accepted per push."
  type        = number
  default     = 200
}

variable "max_push_bytes" {
  description = "Maximum request body size for a push, in bytes."
  type        = number
  default     = 2097152 # 2 MiB
}

variable "jwks_cache_seconds" {
  description = "How long the Worker caches Cognito signing keys."
  type        = number
  default     = 3600
}

# --- content mirror (public CC0 packs; optional) ----------------------------

variable "enable_content_bucket" {
  description = "Create an R2 bucket for the public puzzle packs and expose it via the manifest."
  type        = bool
  default     = false
}

variable "d1_location_hint" {
  description = "D1 primary location hint (wnam, enam, weur, eeur, apac, oc). 'oc' is Oceania/Sydney."
  type        = string
  default     = "oc"
}

variable "r2_location" {
  description = "R2 bucket location hint (wnam, enam, weur, eeur, apac — R2 has no Oceania hint)."
  type        = string
  default     = "apac"
}

variable "content_base_url" {
  description = "Public base URL that serves <packId>/<version>/pack.jsonl. Set when using R2/Pages/another mirror; empty = content disabled."
  type        = string
  default     = ""
}

variable "content_custom_domain" {
  description = "Optional custom hostname for the content bucket (requires cloudflare_zone_id)."
  type        = string
  default     = ""
}

variable "content_manifest_max_age" {
  description = "Cache-Control max-age (seconds) for /content/manifest."
  type        = number
  default     = 300
}
