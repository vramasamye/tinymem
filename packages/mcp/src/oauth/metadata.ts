/**
 * RFC 9728 / RFC 8414 discovery plumbing for onememory as an OAuth 2.0 Resource Server —
 * a thin, cited wrapper over the official SDK's helpers (`buildOAuthProtectedResourceMetadata`,
 * `oauthMetadataResponse`, `discoverAuthorizationServerMetadata` from
 * `@modelcontextprotocol/client`): the wire documents are the SDK's; this module only
 * supplies onememory's naming and the startup metadata load.
 */

import {
  buildOAuthProtectedResourceMetadata,
  oauthMetadataResponse,
  type AuthMetadataOptions,
  type OAuthMetadata,
  type OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/server';

import { discoverAuthorizationServerMetadata } from '@modelcontextprotocol/client';

/** The AS metadata type, re-exported for hosts typing their own wiring. */
export type { OAuthMetadata, OAuthProtectedResourceMetadata };

export interface OnememoryProtectedResourceOptions {
  /** The public URL of this MCP server (the protected resource). */
  resourceServerUrl: URL;
  /** The authorization server's RFC 8414 metadata (from discovery or configuration). */
  authorizationServerMetadata: OAuthMetadata;
  /** Scopes this server understands, advertised as `scopes_supported`. */
  scopesSupported?: string[];
  /** Allow a non-HTTPS issuer (loopback/local testing only — never in production). */
  dangerouslyAllowInsecureIssuerUrl?: boolean;
}

/** The resource name advertised in the RFC 9728 document. */
export const ONEMEMORY_RESOURCE_NAME = 'onememory';

/**
 * Build the RFC 9728 Protected Resource Metadata document for this server. Fails loudly on a
 * misconfigured issuer (the SDK validates) — `oauthMetadataResponse` serves exactly this.
 */
export function buildOnememoryProtectedResourceMetadata(
  options: OnememoryProtectedResourceOptions,
): OAuthProtectedResourceMetadata {
  const metadataOptions: AuthMetadataOptions = {
    oauthMetadata: options.authorizationServerMetadata,
    resourceServerUrl: options.resourceServerUrl,
    resourceName: ONEMEMORY_RESOURCE_NAME,
    ...(options.scopesSupported === undefined ? {} : { scopesSupported: options.scopesSupported }),
    ...(options.dangerouslyAllowInsecureIssuerUrl === undefined
      ? {}
      : { dangerouslyAllowInsecureIssuerUrl: options.dangerouslyAllowInsecureIssuerUrl }),
  };
  return buildOAuthProtectedResourceMetadata(metadataOptions);
}

/**
 * Serve the two OAuth discovery documents from a fetch handler: RFC 9728
 * `/.well-known/oauth-protected-resource[/<path>]` and RFC 8414
 * `/.well-known/oauth-authorization-server` (the AS's own metadata, passed through verbatim).
 * Returns `undefined` for any other path — fall through to normal routing. These documents
 * are PUBLIC by design (that is how unauthorized clients find the AS), so hosts route them
 * AROUND the bearer gate.
 */
export function onememoryOauthMetadataResponse(
  request: Request,
  options: OnememoryProtectedResourceOptions,
): Response | undefined {
  return oauthMetadataResponse(request, {
    oauthMetadata: options.authorizationServerMetadata,
    resourceServerUrl: options.resourceServerUrl,
    resourceName: ONEMEMORY_RESOURCE_NAME,
    ...(options.scopesSupported === undefined ? {} : { scopesSupported: options.scopesSupported }),
    ...(options.dangerouslyAllowInsecureIssuerUrl === undefined
      ? {}
      : { dangerouslyAllowInsecureIssuerUrl: options.dangerouslyAllowInsecureIssuerUrl }),
  });
}

export interface LoadAuthorizationServerMetadataOptions {
  /** Injectable fetch (tests / the daemon's guarded fetch); default: `globalThis.fetch`. */
  fetch?: typeof fetch;
  /**
   * Skip the RFC 8414 §3.3 issuer-echo check. SECURITY-WEAKENING — for the loopback test
   * issuer only, never set by production paths.
   */
  skipIssuerValidation?: boolean;
}

/**
 * Load the authorization server's RFC 8414 metadata at startup (server mode with auth): one
 * explicit operator-opt-in call — the local-first default profile performs ZERO network calls
 * and never loads this. `buildOnememoryProtectedResourceMetadata` validates the issuer against
 * the resulting metadata, so a misconfigured issuer fails at boot, not on the first request.
 */
export async function loadAuthorizationServerMetadata(
  issuerUrl: string | URL,
  options: LoadAuthorizationServerMetadataOptions = {},
): Promise<OAuthMetadata> {
  const metadata = await discoverAuthorizationServerMetadata(issuerUrl, {
    ...(options.fetch === undefined ? {} : { fetchFn: options.fetch }),
    ...(options.skipIssuerValidation === undefined ? {} : { skipIssuerValidation: options.skipIssuerValidation }),
  });
  if (metadata === undefined) {
    throw new Error(`no authorization server metadata discovered at ${String(issuerUrl)}`);
  }
  return metadata;
}
