# Credentials come from the environment; nothing secret is committed.
#   Cloudflare: CLOUDFLARE_API_TOKEN  (Workers Scripts:Edit, D1:Edit,
#               Pages:Edit, R2:Edit, Zone:Read + DNS:Edit if manage_dns)
#   AWS:        AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or SSO profile)
provider "cloudflare" {}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}
