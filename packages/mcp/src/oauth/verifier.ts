/**
 * The resource-server token verifier (backlog M5 issue 5): turns presented access tokens into
 * the SDK's `AuthInfo` for the bearer gate (`../streamable-http/auth.ts`).
 *
 * Reuse, not invention: JWT verification rides `jose` 6.x (already pinned in the lockfile as
 * a dependency of `@modelcontextprotocol/client`, surfaced here as a direct dependency of
 * this package) — JWKS fetching/caching (`createRemoteJWKSet`), signature + claim validation
 * (`jwtVerify`). The 401/403 challenge SHAPES stay the SDK's (`requireBearerAuth` /
 * `bearerAuthChallengeResponse`); this module implements only the SDK's
 * `OAuthTokenVerifier.verifyAccessToken` port.
 *
 * Scope honesty: JWT access tokens with an AS-published JWKS are the verification path for
 * hosted deployments (the AS mints JWTs; the resource server verifies them LOCALLY, zero
 * per-request network). RFC 7662 introspection is the natural opaque-token follow-up for ASes
 * that do not sign JWTs — same port, different fetch strategy — and is NOT faked here.
 */

import { createHash } from 'node:crypto';

import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';

import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';

export interface JwtTokenVerifierOptions {
  /**
   * The expected `iss` claim (the configured issuer). Required — a verifier that accepts
   * tokens from any issuer would be a silent trust escalation.
   */
  issuer: string;
  /**
   * The JWKS URL. Default: derived from the issuer's OIDC discovery document at build time
   * (`.well-known/openid-configuration` → `jwks_uri`), fetched once — verification itself
   * then stays offline (jose caches the JWKS).
   */
  jwksUri?: string;
  /**
   * The expected `aud` claim (this server's RFC 8707 resource identifier). When set, tokens
   * minted for another resource are refused. Absent → audience check disabled.
   */
  audience?: string;
  /** Leeway for `exp`/`nbf` clock skew, in seconds (default 5). */
  clockToleranceSeconds?: number;
  /** Injectable fetch for the JWKS fetch (tests); default: `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/**
 * A JWT-verifying `OAuthTokenVerifier` for the `Authorization: Bearer <jwt>` the AS mints.
 * The verifier maps the JWT's claims onto the SDK's `AuthInfo` (clientId from `client_id` or
 * `sub`, scopes from `scope` split on spaces, `expiresAt` from `exp` — the SDK's bearer gate
 * REQUIRES `expiresAt`, so a token without `exp` is refused).
 */
export async function createJwtTokenVerifier(
  options: JwtTokenVerifierOptions,
): Promise<OAuthTokenVerifier> {
  const jwksUri =
    options.jwksUri ?? (await jwksUriFromDiscovery(options.issuer, options.fetch));
  const jwks = createRemoteJWKSet(new URL(jwksUri), {
    ...(options.fetch === undefined ? {} : { [customFetch]: options.fetch as typeof fetch }),
  });

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        const verified = await jwtVerify(token, jwks, {
          issuer: options.issuer,
          ...(options.audience === undefined ? {} : { audience: options.audience }),
          clockTolerance: options.clockToleranceSeconds ?? 5,
          algorithms: ['RS256', 'ES256'],
        });
        payload = verified.payload;
      } catch (error) {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          `access token rejected: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const clientId = typeof payload.client_id === 'string' ? payload.client_id : payload.sub;
      if (clientId === undefined) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'access token carries no client identity (client_id or sub)');
      }
      if (typeof payload.exp !== 'number') {
        // The SDK's bearer gate rejects unset expiries; refuse here with the clearer reason.
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'access token has no exp claim');
      }
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [];
      const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
      return {
        token,
        clientId,
        scopes,
        expiresAt: payload.exp,
        ...(typeof aud === 'string' && aud !== '' ? { resource: new URL(aud) } : {}),
      };
    },
  };
}

/**
 * A static-token verifier for local, non-hosted server-mode deployments where onememory
 * trusts a fixed set of pre-registered bearer tokens (the "client-registration surface" the
 * M5b brief asks to keep local-first): the tokens are SHA-256 hashes on disk, never
 * plaintext. Each entry maps to a client id and scopes. Deliberately simple — no expiry
 * machinery the operator did not write themselves; the SDK gate still refuses tokens past
 * `expiresAt`, so local tokens get a configurable lifetime.
 */
export interface StaticTokenEntry {
  /** SHA-256 hex digest of the bearer token (the file stores ONLY this). */
  sha256: string;
  clientId: string;
  scopes: string[];
  /** Expiry in seconds since epoch (the SDK gate refuses unset/past expiries). */
  expiresAt: number;
  /**
   * The RFC 8707 resource this token is bound to. Required when the gate sets
   * `expectedResource`: the SDK refuses tokens whose resource does not match.
   */
  resource?: string;
}

export interface StaticTokenVerifierOptions {
  entries: readonly StaticTokenEntry[];
  /** The issuer value recorded in returned `AuthInfo` bookkeeping (informational). */
  issuer: string;
}

export function createStaticTokenVerifier(options: StaticTokenVerifierOptions): OAuthTokenVerifier {
  const byHash = new Map(options.entries.map((entry) => [entry.sha256.toLowerCase(), entry]));
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const digest = createHash('sha256').update(token, 'utf8').digest('hex');
      const entry = byHash.get(digest);
      if (entry === undefined) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'access token rejected: unknown token');
      }
      return {
        token,
        clientId: entry.clientId,
        scopes: [...entry.scopes],
        expiresAt: entry.expiresAt,
        ...(entry.resource === undefined ? {} : { resource: new URL(entry.resource) }),
      };
    },
  };
}

/** Derive the JWKS URL from the issuer's OIDC discovery document (one fetch, at gate build). */
async function jwksUriFromDiscovery(issuer: string, fetchOption?: typeof fetch): Promise<string> {
  const issuerUrl = new URL(issuer);
  const discoveryUrl = new URL(`${issuerUrl.pathname.replace(/\/$/, '')}/.well-known/openid-configuration`, issuerUrl);
  const response = await (fetchOption ?? fetch)(discoveryUrl, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`cannot load the issuer's OIDC discovery document (${discoveryUrl.href}): status ${response.status}`);
  }
  const body = (await response.json()) as { jwks_uri?: unknown };
  if (typeof body.jwks_uri !== 'string' || body.jwks_uri === '') {
    throw new Error(`the issuer's OIDC discovery document carries no jwks_uri (${discoveryUrl.href})`);
  }
  return body.jwks_uri;
}

export type { AuthInfo };
