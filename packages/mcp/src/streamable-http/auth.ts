/**
 * The MCP-server OAuth 2.0 gate (backlog M5 issue 5, "OAuth 2.1 for hosted deployments"):
 * onememory acting as an OAuth 2.0 Resource Server (RFC 6750 + the MCP authorization spec).
 *
 * Reuse, not reinvention (AGENTS.md rule 2): the gate composes the official SDK's
 * `requireBearerAuth` / `getOAuthProtectedResourceMetadataUrl` from
 * `@modelcontextprotocol/server` 2.3.0 — header parsing, scope enforcement, expiry checks,
 * and the 401/403 + `WWW-Authenticate` challenge shapes are ALL the SDK's. This module only
 * supplies what the SDK deliberately leaves to the deployer: the token → `AuthInfo` verifier
 * (see `../oauth/verifier.ts`) and the routing glue.
 *
 * Local-first invariant (AGENTS.md rule 4): NO gate is the default. A gate exists only when an
 * operator explicitly configures an authorization-server issuer (server mode / hosted
 * deployments). Loopback binds without auth — the embedded profile never configures this.
 */

import {
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type AuthInfo,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';

/** What the serving entries need to turn bearer tokens into verified `AuthInfo`. */
export interface McpAuthGateOptions {
  /** The AS that minted the tokens (only used for metadata URL derivation here). */
  authorizationServerMetadata: OAuthMetadata;
  /** The token verifier (JWT/JWKS or introspection — see `../oauth/verifier.ts`). */
  verifier: OAuthTokenVerifier;
  /** Scopes every request must carry (the token may carry more). */
  requiredScopes?: string[];
  /**
   * The RFC 8707 resource indicator this server answers for (its own URL). Tokens minted for
   * another resource are refused. Absent → resource check disabled.
   */
  expectedResource?: URL;
  /** The public URL of this MCP server (the protected resource). */
  resourceServerUrl: URL;
}

export type BearerGate = (request: Request) => Promise<AuthInfo | Response>;

/**
 * Build the request gate. Composes the SDK's `requireBearerAuth` with the RFC 9728
 * protected-resource metadata URL so 401/403 challenges carry `resource_metadata` — clients
 * then discover the authorization server with zero out-of-band knowledge.
 */
export function createBearerGate(options: McpAuthGateOptions): BearerGate {
  const gate = requireBearerAuth({
    verifier: options.verifier,
    ...(options.requiredScopes === undefined ? {} : { requiredScopes: options.requiredScopes }),
    ...(options.expectedResource === undefined ? {} : { expectedResource: options.expectedResource }),
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(options.resourceServerUrl),
  });
  return (request) => gate(request);
}
