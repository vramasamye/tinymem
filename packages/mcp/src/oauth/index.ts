/**
 * The OAuth 2.1 surface (backlog M5 issue 5 — "OAuth 2.1 for hosted deployments"; M5b AC 2):
 *
 * - CLIENT: the loopback authorization-code flow with PKCE + state, over the official MCP
 *   client SDK's `auth()` orchestrator — `onemem auth` drives this against any MCP-spec
 *   conformant authorization server (RFC 8252 loopback redirect, RFC 7636 PKCE S256,
 *   RFC 7591 dynamic registration, RFC 8414 discovery, RFC 9728 resource metadata).
 * - SERVER: the resource-server gate's verifier seam (JWT/JWKS via `jose`, or the static
 *   hashed-token registry for local server-mode deployments) plus the RFC 9728 discovery
 *   documents the SDK's `oauthMetadataResponse` serves.
 * - STORE: secure local persistence (0600, atomic) of the client identity + tokens.
 *
 * Local-first invariant: NONE of this is on by default. The embedded profile binds loopback
 * with no auth and makes zero network calls; OAuth exists only for explicit server-mode /
 * hosted deployments, and the only network it performs is against the operator-configured
 * issuer (verified by the network-guard integration test running the streamable session).
 */

export {
  OAuthCredentialStore,
  OAUTH_STORE_FILE_NAME,
  StoredClientSchema,
  StoredTokensSchema,
  type StoredClient,
  type StoredTokensFile,
  type OAuthCredentialStoreOptions,
  type StoredOAuthCredential,
  type SaveCredentialInput,
  type OAuthStoreFile,
} from './store';

export {
  runLoopbackOAuthFlow,
  refreshStoredOAuth,
  oauthStatus,
  DEFAULT_OAUTH_SCOPE,
  DEFAULT_CALLBACK_TIMEOUT_MS,
  type RunLoopbackOAuthOptions,
  type LoopbackOAuthResult,
  type OAuthStatus,
} from './client';

export {
  createJwtTokenVerifier,
  createStaticTokenVerifier,
  type JwtTokenVerifierOptions,
  type StaticTokenEntry,
  type StaticTokenVerifierOptions,
} from './verifier';

export {
  buildOnememoryProtectedResourceMetadata,
  onememoryOauthMetadataResponse,
  loadAuthorizationServerMetadata,
  ONEMEMORY_RESOURCE_NAME,
  type OnememoryProtectedResourceOptions,
  type LoadAuthorizationServerMetadataOptions,
  type OAuthMetadata,
} from './metadata';
