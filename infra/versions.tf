terraform {
  required_version = ">= 1.6.0"

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

  # State contains the Google OAuth client secret, so do not keep it only on
  # one laptop. Copy backend.tf.example -> backend.tf for an encrypted remote
  # backend (S3 or an S3-compatible store such as R2), or use Terraform Cloud.
  # Left local by default so `terraform validate` works with no accounts.
}
