locals {
  prefix             = "${var.project_name}-${var.environment}"
  worker             = "${local.prefix}-sync"
  pages_project_name = var.pages_project_name

  tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  # Cognito hosted-domain prefix: derived from the account id when not given, so
  # there is nothing to invent by hand. Deterministic, therefore stable across
  # applies; override the variable if the name is already taken globally.
  cognito_domain_prefix = var.cognito_domain_prefix != "" ? var.cognito_domain_prefix : "${local.prefix}-${substr(sha256(var.cloudflare_account_id), 0, 6)}"

  cognito_domain = "https://${local.cognito_domain_prefix}.auth.${var.aws_region}.amazoncognito.com"

  # Google federation is optional: passkeys + email OTP are managed by Cognito.
  google_enabled = var.google_client_id != "" && var.google_client_secret != ""

  # The stable Pages hostname is derived from the infra prefix. This deployment
  # retains that hostname even though the Pages project itself was renamed to
  # `chessengram`. Derive it without a resource reference so Pages build settings
  # can consume the Cognito client id without a Terraform dependency cycle. Set
  # app_url explicitly for a custom hostname.
  app_url = var.app_url != "" ? var.app_url : "https://${local.prefix}.pages.dev"

  # Origins allowed to call the sync API (CORS + Cognito callbacks).
  allowed_origins = join(",", distinct(concat([local.app_url], var.extra_allowed_origins)))

  # A Worker's dev URL is <worker>.<account-subdomain>.workers.dev. The account
  # subdomain is an account setting the provider cannot read, so it is an input;
  # when it is unknown, api_url stays empty rather than printing a hostname that
  # cannot resolve (see the `api_url_is_known` check in cloudflare.tf).
  workers_dev_host = var.workers_dev_subdomain == "" ? "" : "${local.worker}.${var.workers_dev_subdomain}.workers.dev"

  api_hostname = var.api_custom_domain != "" ? var.api_custom_domain : local.workers_dev_host

  api_url = local.api_hostname == "" ? "" : "https://${local.api_hostname}"

  needs_zone = var.manage_dns || var.api_custom_domain != "" || var.app_custom_domain != "" || var.content_custom_domain != ""
}
