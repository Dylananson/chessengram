/**
 * Authentication seam (minimal).
 *
 * ONL-006 owns the full Cognito implementation: JWKS fetching/verification,
 * `sub` → canonical `userId` mapping, signed BFF session cookies and device
 * registration. This file only defines the interface the HTTP layer depends on
 * plus a fixed-token dev verifier so everything is testable with **no cloud
 * account**.
 */

export interface TokenVerifier {
  /**
   * Verify an `Authorization` header value. Returns the canonical ChessEngram
   * `userId` (never the raw provider `sub`) or `undefined` when the header is
   * missing/invalid.
   */
  verify(authorization: string | null): Promise<{ userId: string } | undefined>;
}

/** Fixed bearer token accepted by {@link DevVerifier}. Not a secret. */
export const DEV_BEARER_TOKEN = 'dev-token';
/** Canonical user id that {@link DevVerifier} maps the dev token to. */
export const DEV_USER_ID = 'dev-user';

/** Extract the token from a `Bearer <token>` header (case-insensitive scheme). */
export function bearerToken(authorization: string | null): string | undefined {
  if (authorization === null) return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

export interface DevVerifierOptions {
  /**
   * Gate. When false the verifier rejects everything — mirroring the
   * `SYNC_ALLOW_DEV_AUTH` switch so the dev path can never be enabled by
   * accident.
   */
  allow: boolean;
  token?: string;
  userId?: string;
}

/**
 * Maps one fixed bearer token to one fixed dev user. Enabled only when
 * `SYNC_ALLOW_DEV_AUTH` is truthy (see `config.ts`). No network, no secrets.
 */
export class DevVerifier implements TokenVerifier {
  #allow: boolean;
  #token: string;
  #userId: string;

  constructor(options: DevVerifierOptions) {
    this.#allow = options.allow;
    this.#token = options.token ?? DEV_BEARER_TOKEN;
    this.#userId = options.userId ?? DEV_USER_ID;
  }

  async verify(authorization: string | null): Promise<{ userId: string } | undefined> {
    if (!this.#allow) return undefined;
    const token = bearerToken(authorization);
    if (token === undefined || token !== this.#token) return undefined;
    return { userId: this.#userId };
  }
}
