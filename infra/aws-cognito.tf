# ---------------------------------------------------------------------------
# AWS Cognito: the only identity store. Sign-in is Cognito-managed — passkeys
# plus email one-time codes (choice-based sign-in), so no third-party OAuth
# client has to be created by hand. Google federation is optional: set
# google_client_id/google_client_secret and it is wired in. The user pool
# (Essentials) includes managed login + passkeys for free up to 10k MAU.
#
# AWS never sees training data: it only holds the identity (email + subject)
# and issues ID tokens the Cloudflare Worker verifies against public JWKS.
# ---------------------------------------------------------------------------

resource "aws_cognito_user_pool" "users" {
  name = "${local.prefix}-users"

  # Essentials is the tier with managed login; do NOT use Plus (no free tier)
  # and do not enable advanced security features you do not need.
  user_pool_tier = "ESSENTIALS"

  # Social-only: no username/password sign-up surface.
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OFF" # passkeys/biometrics are the credential authority

  # Choice-based sign-in: passkeys (+ optional email one-time codes) are the
  # first factors. Both are managed by Cognito, so no third-party OAuth client
  # has to be created by hand. Requires the Essentials plan and a managed login
  # domain (both present here).
  # Choice-based sign-in. Cognito REQUIRES `PASSWORD` in this list ("the password
  # option is always available"); WEB_AUTHN/EMAIL_OTP are the additions. The
  # password factor is made unusable in practice by creating users with a random
  # permanent password that nobody knows and by not offering password recovery
  # (email OTP is the fallback), see the README.
  sign_in_policy {
    allowed_first_auth_factors = ["PASSWORD", "WEB_AUTHN", "EMAIL_OTP"]
  }

  # Passkey relying party. Per the AWS docs: "If you don't have a custom domain
  # and don't specify otherwise, your user pool defaults to an RP ID of your
  # prefix domain." We have a prefix domain only, so `relying_party_id` is
  # deliberately NOT set — passing the prefix FQDN explicitly is rejected
  # ("RelyingPartyId cannot be reserved domain other than User Pool's prefix
  # domain") because the domain is not attached yet when the pool is created.
  # Set it only if you later add a custom domain (the RP ID then defaults to
  # that custom domain). Changing the RP ID invalidates existing passkeys.
  web_authn_configuration {
    user_verification = var.web_authn_user_verification
  }

  # Cognito's built-in email sender is used for OTP codes (50/day cap); point
  # this at SES if you ever need more.
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  # Sign-ups are closed by default (allow_self_signup = false): managed login
  # shows no sign-up page and an unknown email cannot create an account. An
  # administrator creates each user once (see the README) and they then sign in
  # with an emailed one-time code and register a passkey.
  admin_create_user_config {
    allow_admin_create_user_only = !var.allow_self_signup
  }

  # Pool policy is required even though passwords are unused: the pool must
  # permit the PASSWORD factor (Cognito requires it), our app never uses it, and
  # the only password that ever exists is the random one discarded at user
  # creation. Kept tunable rather than hard-coded.
  password_policy {
    minimum_length                   = var.password_min_length
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = var.password_require_symbols
    require_uppercase                = true
    temporary_password_validity_days = 1
  }

  username_configuration {
    case_sensitive = false
  }

  # Recovery channel: email only. (Cognito's *default* when this block is
  # omitted is verified_email + verified_phone_number, so it is stated
  # explicitly here to drop the pointless phone option.)
  #
  # Note: the pool necessarily permits the PASSWORD first factor (Cognito
  # requires it), and passwordless pools let a signed-in user set a password via
  # the API — so this is not a "no passwords exist" guarantee, it is "our app
  # never uses passwords": sign-ups are closed and every user is created by the
  # owner. Managed login exposes no password-management UI.
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  deletion_protection = var.deletion_protection

  schema {
    name                     = "email"
    attribute_data_type      = "String"
    required                 = true
    mutable                  = true
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 5
      max_length = 254
    }
  }

  tags = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

# Cognito-hosted domain used by the managed login / OAuth redirect flow.
resource "aws_cognito_user_pool_domain" "main" {
  domain       = local.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.users.id
}

# Optional Google federation. Created only when a client id + secret are given;
# without it the pool still signs users in with passkeys / email OTP.
resource "aws_cognito_identity_provider" "google" {
  count = local.google_enabled ? 1 : 0

  user_pool_id  = aws_cognito_user_pool.users.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = var.google_client_id
    client_secret    = var.google_client_secret
    authorize_scopes = "openid email profile"
  }

  attribute_mapping = {
    email          = "email"
    email_verified = "email_verified"
    username       = "sub" # Cognito requires a stable subject for Google
    given_name     = "given_name"
    family_name    = "family_name"
    name           = "name"
  }
}

# Public SPA client: authorization-code + PKCE, no client secret.
# `COGNITO` means the pool's own directory (passkeys / email OTP); `Google` is
# added only when federation is configured.
resource "aws_cognito_user_pool_client" "app" {
  name         = "${local.prefix}-app"
  user_pool_id = aws_cognito_user_pool.users.id

  generate_secret = false

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]

  supported_identity_providers = local.google_enabled ? ["COGNITO", "Google"] : ["COGNITO"]

  callback_urls = distinct(concat(
    ["${local.app_url}/", "${local.app_url}/auth/callback"],
    var.extra_callback_urls,
  ))
  logout_urls = distinct(concat(["${local.app_url}/"], var.extra_callback_urls))

  # Choice-based sign-in: the managed login page offers the pool's first
  # factors (passkey / email code). No username+password flow is enabled.
  explicit_auth_flows           = ["ALLOW_USER_AUTH"]
  enable_token_revocation       = true
  prevent_user_existence_errors = "ENABLED"

  access_token_validity  = 60 # minutes
  id_token_validity      = 60 # minutes
  refresh_token_validity = 30 # days

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  depends_on = [aws_cognito_identity_provider.google]

  lifecycle {
    prevent_destroy = true
  }
}

# Managed login pages are not available for API-created app clients until a
# branding style is applied; the Cognito-provided one is enough.
resource "aws_cognito_managed_login_branding" "app" {
  user_pool_id                = aws_cognito_user_pool.users.id
  client_id                   = aws_cognito_user_pool_client.app.id
  use_cognito_provided_values = true
}
