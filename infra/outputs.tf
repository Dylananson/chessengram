output "api_url" {
  description = "Base URL of the sync API (feed the app's VITE_SYNC_API_BASE or /sync-config.json). Empty until workers_dev_subdomain or api_custom_domain is set."
  value       = local.api_url
}

output "worker_name" {
  value = cloudflare_workers_script.sync.script_name
}

output "worker_dev_url" {
  description = "The Worker's workers.dev URL (null when workers_dev_subdomain and api_custom_domain are both unset)."
  value       = local.workers_dev_host == "" ? null : "https://${local.workers_dev_host}"
}

output "cloudflare_account_id" {
  description = "Cloudflare account that owns these resources (for wrangler/API calls)."
  value       = var.cloudflare_account_id
}

output "workers_dev_subdomain" {
  description = "Effective workers.dev subdomain (empty when unset)."
  value       = var.workers_dev_subdomain
}

output "pages_production_branch" {
  description = "Branch Cloudflare Pages treats as production (used by `wrangler pages deploy --branch`)."
  value       = cloudflare_pages_project.app.production_branch
}

output "d1_database_id" {
  value = cloudflare_d1_database.sync.id
}

output "d1_database_name" {
  value = cloudflare_d1_database.sync.name
}

output "app_url" {
  description = "Address the PWA is served from (upload dist/ there)."
  value       = local.app_url
}

output "pages_project" {
  value = cloudflare_pages_project.app.name
}

output "aws_region" {
  description = "Region the Cognito user pool lives in (needed for aws CLI calls)."
  value       = var.aws_region
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.users.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.app.id
}

output "cognito_domain" {
  description = "Cognito hosted domain (OAuth authorize/logout endpoints)."
  value       = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "cognito_issuer" {
  value = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.users.id}"
}

output "cognito_jwks_url" {
  value = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.users.id}/.well-known/jwks.json"
}

output "content_bucket" {
  description = "R2 bucket for public packs (null when disabled). Upload with: wrangler r2 object put <bucket>/<packId>/<version>/pack.jsonl --file <file>."
  value       = var.enable_content_bucket ? cloudflare_r2_bucket.content[0].name : null
}

output "client_sync_config" {
  description = "Drop this in apps/web/public/sync-config.json (or use the VITE_* equivalents)."
  value = {
    apiBase         = local.api_url
    authAuthority   = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"
    authClientId    = aws_cognito_user_pool_client.app.id
    authRedirectUri = "${local.app_url}/"
    authScopes      = "openid email profile"
    contentBaseUrl  = var.content_base_url
  }
}

output "sync_config_json" {
  value = jsonencode({
    apiBase         = local.api_url
    authAuthority   = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"
    authClientId    = aws_cognito_user_pool_client.app.id
    authRedirectUri = "${local.app_url}/"
    authScopes      = "openid email profile"
    contentBaseUrl  = var.content_base_url
  })
}

output "next_steps" {
  value = <<-EOT
    Deploy everything with one command (build the Worker, apply, build the PWA,
    upload it, then verify):

       bash infra/deploy.sh

    Manual equivalent:
    1. npm run build:worker                                (Worker bundle for Terraform)
    2. terraform -chdir=infra apply
    3. npm run build, then write the runtime config and upload the PWA:
       terraform -chdir=infra output -raw sync_config_json > apps/web/dist/sync-config.json
       npx wrangler pages deploy apps/web/dist --project-name ${cloudflare_pages_project.app.name} --branch ${cloudflare_pages_project.app.production_branch}
    4. Verify: curl $(terraform -chdir=infra output -raw api_url)/health -> {"ok":true,"configured":true,"auth":"cognito","storage":"d1"}
    5. Settings -> Sync -> Enable sync. Done — the key is provisioned server-side
       and there is nothing to copy or store (design #6 revised).
  EOT
}
