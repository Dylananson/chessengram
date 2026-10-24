terraform {
  required_version = ">= 1.10.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # CI supplies the S3 backend coordinates at init time; keep bucket names and
  # account-specific values out of the source. Local validation uses
  # `terraform init -backend=false` and requires no cloud credentials.
  backend "s3" {}
}
