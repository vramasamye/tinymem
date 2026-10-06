/**
 * The onememory OAuth 2.1 client: the loopback authorization-code flow with PKCE + state
 * (RFC 8252 native-app loopback redirect, RFC 7636 PKCE S256, RFC 6749 authorization code,
 * RFC 7591 dynamic client registration, RFC 8414 discovery, RFC 9728 resource metadata).
 *
 * Reuse, not invention (AGENTS.md rule 2 + the M5b brief): the FLOW is the official MCP
 * client SDK's — `auth()` from `@modelcontextprotocol/client` 2.3.0 orchestrates discovery →
 * dynamic registration → `startAuthorization` (PKCE via the SDK's `pkce-challenge`) →
 * redirect → token exchange → `saveTokens`, and refreshes through `refreshAuthorization`.
 * This module implements the SDK's `OAuthClientProvider` seam — the exact interface the SDK
 * defines for hosts — supplying the loopback redirect receiver, the state nonce, provider-
 * backed persistence, and the browser hand-off. PKCE mechanics, token exchange, scope
 * selection, and the issuer-binding checks (SEP-2352) are all the SDK's.
 *
 * An explicit `authorizationServerUrl` rides the SDK's `discoveryState` seam: the provider
 * pre-seeds the AS (its RFC 8414 metadata fetched once up front), which is precisely what
 * that seam exists for — `auth()` then skips protected-resource discovery and uses the
 * configured AS.
 *
 * Security properties (each pinned by a test in `../oauth.test.ts`):
 * - PKCE: S256 challenge on the wire; the verifier lives in process memory ONLY for the flow.
 * - State: a fresh cryptographic nonce per flow; the callback is rejected on mismatch before
 *   any code is accepted.
 * - The loopback receiver binds `127.0.0.1` with an ephemeral port (RFC 8252 §7.3), answers
 *   exactly one callback, and shuts down.
 * - Tokens persist via `OAuthCredentialStore` (0600, atomic) — never logged, never echoed.
 */

import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

import {
  auth,
  discoverAuthorizationServerMetadata,
  type AuthorizationServerMetadata,
  type AuthResult,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';

import { OAuthCredentialStore, type StoredClient, type StoredTokensFile } from './store';

/** The default scope the flow requests (the MCP memory surface, split read/write). */
export const DEFAULT_OAUTH_SCOPE = 'onememory:read onememory:write';

/** Callback wait default (5 minutes — the human has to open a browser). */
export const DEFAULT_CALLBACK_TIMEOUT_MS = 300_000;

export interface RunLoopbackOAuthOptions {
  /**
   * The MCP server URL (the protected resource). Discovery (RFC 9728 → RFC 8414) resolves the
   * authorization server from it, unless `authorizationServerUrl` is given explicitly.
   */
  serverUrl: string | URL;
  /** Explicit authorization-server issuer (skips protected-resource discovery). */
  authorizationServerUrl?: string | URL;
  /** The credential store that persists client identity + tokens. */
  store: OAuthCredentialStore;
  /** Scopes to request (default `onememory:read onememory:write`). */
  scope?: string;
  /**
   * Called with the authorization URL the user agent must visit — the CLI prints it (no
   * auto-open); tests drive the callback programmatically. Fires BEFORE the loopback
   * receiver starts waiting, so a CLI can also open a browser from here.
   */
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  /** Fixed loopback port (tests / RFC 8252 port-specific configuration); default: ephemeral. */
  port?: number;
  /** Injectable fetch (tests, guarded environments). */
  fetch?: typeof fetch;
  /** Skip the RFC 8414 issuer-echo check (loopback test issuers only — never in production). */
  skipIssuerValidation?: boolean;
  /** Milliseconds to wait for the authorization redirect (default 300000). */
  timeoutMs?: number;
}

export interface LoopbackOAuthResult {
  readonly issuer: string;
  /** The scope granted on the token, when the AS echoes one. */
  readonly tokenScope: string | undefined;
  readonly savedAt: string;
  /** How the flow finished (refresh shortcut or full browser leg) — surfaced for UX + tests. */
  readonly via: 'authorization-code' | 'refresh';
}

/**
 * Everything the SDK's `OAuthClientProvider` seam requires, bound to one flow instance.
 * The provider is deliberately FRESH per flow: `clientInformation()`/`tokens()` read the
 * persistent store, while the flow-scoped state (nonce, verifier, discovery seed) is
 * process-memory only and dies with the flow.
 */
class LoopbackProvider implements OAuthClientProvider {
  private codeVerifierInFlight: string | undefined;
  private readonly nonce = randomBytes(32).toString('base64url');
  private discoveryStateInFlight: OAuthDiscoveryState | undefined;

  constructor(
    private readonly options: {
      redirectUrl: URL;
      scope: string;
      store: OAuthCredentialStore;
      onAuthorizationUrl?: (url: URL) => void | Promise<void>;
      seedAuthorizationServer?: { url: string; metadata: AuthorizationServerMetadata };
    },
  ) {}

  get redirectUrl(): string | URL {
    return this.options.redirectUrl;
  }

  get clientMetadata() {
    return {
      client_name: 'onememory',
      redirect_uris: [this.options.redirectUrl.toString()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client — OAuth 2.1 mandates PKCE, not secrets
      scope: this.options.scope,
    };
  }

  state(): string | Promise<string> {
    return this.nonce;
  }

  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    const credential = await this.options.store.load();
    return credential?.client as StoredOAuthClientInformation | undefined;
  }

  async saveClientInformation(clientInformation: StoredOAuthClientInformation): Promise<void> {
    const issuer = this.currentIssuer(clientInformation.issuer);
    await this.options.store.save({ issuer, client: clientInformation });
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    const credential = await this.options.store.load();
    return credential?.tokens as StoredOAuthTokens | undefined;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    const issuer = this.currentIssuer(tokens.issuer);
    await this.options.store.save({ issuer, tokens });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.options.onAuthorizationUrl?.(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void | Promise<void> {
    this.codeVerifierInFlight = codeVerifier; // process memory ONLY — never persisted
  }

  codeVerifier(): string | Promise<string> {
    if (this.codeVerifierInFlight === undefined) {
      return Promise.reject(new Error('no PKCE code verifier in flight'));
    }
    return this.codeVerifierInFlight;
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    if (this.discoveryStateInFlight !== undefined) return this.discoveryStateInFlight;
    if (this.options.seedAuthorizationServer !== undefined) {
      this.discoveryStateInFlight = {
        authorizationServerUrl: this.options.seedAuthorizationServer.url,
        resourceMetadataUrl: undefined,
        resourceMetadata: undefined,
        authorizationServerMetadata: this.options.seedAuthorizationServer.metadata,
      };
    }
    return this.discoveryStateInFlight;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.discoveryStateInFlight = state;
  }

  /** The issuer every save is keyed to: the SDK's issuer stamp, else the pre-seeded AS. */
  private currentIssuer(stamped: string | undefined): string {
    if (stamped !== undefined && stamped !== '') return stamped;
    if (this.discoveryStateInFlight?.authorizationServerUrl !== undefined) {
      return this.discoveryStateInFlight.authorizationServerUrl;
    }
    if (this.options.seedAuthorizationServer !== undefined) {
      return this.options.seedAuthorizationServer.url;
    }
    throw new Error('no authorization server resolved yet — the flow must run discovery first');
  }
}

/**
 * Run the loopback OAuth 2.1 flow end-to-end:
 * discovery → (re)registration → PKCE + state → browser redirect → loopback callback →
 * token exchange → secure persistence. Resolves when tokens are saved.
 *
 * The browser leg is the CALLER's: `onAuthorizationUrl` receives the authorize URL. When the
 * AS redirects the user agent back, the built-in loopback receiver validates `state` (the
 * nonce comparison happens here, in onememory, BEFORE the code is accepted), captures
 * `code` + `iss`, and the SDK exchanges the code with the PKCE verifier.
 */
export async function runLoopbackOAuthFlow(options: RunLoopbackOAuthOptions): Promise<LoopbackOAuthResult> {
  const {
    serverUrl,
    authorizationServerUrl,
    store,
    scope = DEFAULT_OAUTH_SCOPE,
    onAuthorizationUrl,
    port,
    fetch: fetchOption,
    skipIssuerValidation = false,
    timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS,
  } = options;

  // Pre-seed an explicitly configured AS (the SDK's discoveryState seam — one metadata fetch
  // up front; auth() then never consults protected-resource discovery).
  let seed: { url: string; metadata: AuthorizationServerMetadata } | undefined;
  if (authorizationServerUrl !== undefined) {
    const url = authorizationServerUrl instanceof URL ? authorizationServerUrl.href : authorizationServerUrl;
    const metadata = await discoverAuthorizationServerMetadata(url, {
      ...(fetchOption === undefined ? {} : { fetchFn: fetchOption }),
      ...(skipIssuerValidation ? { skipIssuerValidation: true } : {}),
    });
    if (metadata === undefined) throw new Error(`no authorization server metadata discovered at ${url}`);
    seed = { url, metadata };
  }

  // The loopback receiver exists BEFORE leg 1 so an AS that redirects instantly (a test or
  // an auto-approving IdP) cannot hit a closed port.
  const callback = await listenForCallback(port, timeoutMs);

  const provider = new LoopbackProvider({
    redirectUrl: new URL(`http://127.0.0.1:${callback.port}/callback`),
    scope,
    store,
    onAuthorizationUrl,
    ...(seed === undefined ? {} : { seedAuthorizationServer: seed }),
  });

  const authOptions = {
    serverUrl: serverUrl instanceof URL ? serverUrl.href : serverUrl,
    scope,
    ...(fetchOption === undefined ? {} : { fetchFn: fetchOption }),
    ...(skipIssuerValidation ? { skipIssuerMetadataValidation: true } : {}),
  };

  try {
    // Leg 1 — discovery, registration, PKCE, the redirect hand-off (fires onAuthorizationUrl).
    const first: AuthResult = await auth(provider, authOptions);
    if (first === 'AUTHORIZED') {
      // A usable stored refresh token refreshed straight away — no browser leg happened.
      return finish(store, 'refresh');
    }

    // Leg 2 — the loopback receiver got the redirect; validate the state nonce BEFORE the code
    // is accepted, then let the SDK exchange code + PKCE verifier for tokens.
    const expectedState = await provider.state();
    const receipt = await callback.promise;
    if (receipt.state !== expectedState) {
      throw new Error(
        `OAuth state mismatch: the callback carried ${JSON.stringify(receipt.state)} but this flow issued a different nonce — refusing the authorization code (possible CSRF/mix-up)`,
      );
    }
    if (receipt.error !== undefined) {
      throw new Error(
        `authorization server refused the request: ${receipt.error}${
          receipt.errorDescription === undefined ? '' : ` (${receipt.errorDescription})`
        }`,
      );
    }
    if (receipt.code === undefined) {
      throw new Error('the authorization redirect carried neither a code nor an error');
    }

    const second: AuthResult = await auth(provider, {
      ...authOptions,
      authorizationCode: receipt.code,
      ...(receipt.iss === undefined ? {} : { iss: receipt.iss }),
    });
    if (second !== 'AUTHORIZED') {
      throw new Error(`unexpected auth flow state after the code exchange: ${second}`);
    }
    return finish(store, 'authorization-code');
  } catch (error) {
    void error;
    throw error;
  } finally {
    await closeServer(callback.server);
  }
}

/** Stored-credential status for CLI display (never returns token values). */
export interface OAuthStatus {
  readonly configured: boolean;
  readonly issuer: string | undefined;
  readonly resource: string | undefined;
  readonly savedAt: string | undefined;
  readonly scope: string | undefined;
  readonly hasRefreshToken: boolean;
  readonly hasClientRegistration: boolean;
  readonly expiresAt: string | undefined;
  readonly permissionMode: string | undefined;
}

/** Read the stored credential's public status (safe to print — no token material). */
export async function oauthStatus(store: OAuthCredentialStore): Promise<OAuthStatus> {
  const credential = await store.load();
  const permissionMode = await store.permissionMode();
  if (credential === undefined) {
    return {
      configured: false,
      issuer: undefined,
      resource: undefined,
      savedAt: undefined,
      scope: undefined,
      hasRefreshToken: false,
      hasClientRegistration: false,
      expiresAt: undefined,
      permissionMode,
    };
  }
  const expiresIn = credential.tokens?.expires_in;
  const savedMs = Date.parse(credential.savedAt);
  const expiresAt =
    expiresIn === undefined || Number.isNaN(savedMs)
      ? undefined
      : new Date(savedMs + expiresIn * 1000).toISOString();
  return {
    configured: true,
    issuer: credential.issuer,
    resource: credential.resource,
    savedAt: credential.savedAt,
    scope: credential.tokens?.scope,
    hasRefreshToken: credential.tokens?.refresh_token !== undefined,
    hasClientRegistration: credential.client !== undefined,
    expiresAt,
    permissionMode,
  };
}

/**
 * Refresh the stored access token using the stored refresh token (the SDK's `auth()` refresh
 * branch — no browser leg). Throws when no credential or no refresh token is stored, or when
 * the AS refuses the refresh (the caller then re-runs the full loopback flow).
 */
export async function refreshStoredOAuth(options: {
  serverUrl: string | URL;
  store: OAuthCredentialStore;
  fetch?: typeof fetch;
  skipIssuerValidation?: boolean;
}): Promise<LoopbackOAuthResult> {
  const { serverUrl, store, fetch: fetchOption, skipIssuerValidation = false } = options;
  const credential = await store.load();
  if (credential === undefined) {
    throw new Error('no stored OAuth credential: run the loopback authorization flow first');
  }
  if (credential.tokens?.refresh_token === undefined) {
    throw new Error('the stored credential has no refresh token: re-authorize');
  }
  // A provider WITHOUT a redirectUrl is a non-interactive provider in the SDK's terms — a
  // refresh that cannot fall back to a browser redirect, which is exactly the contract here.
  const provider = new LoopbackProvider({
    redirectUrl: new URL('http://127.0.0.1:0/callback'),
    scope: credential.tokens.scope ?? DEFAULT_OAUTH_SCOPE,
    store,
  });
  const result = await auth(provider, {
    serverUrl: serverUrl instanceof URL ? serverUrl.href : serverUrl,
    ...(fetchOption === undefined ? {} : { fetchFn: fetchOption }),
    ...(skipIssuerValidation ? { skipIssuerMetadataValidation: true } : {}),
  });
  if (result !== 'AUTHORIZED') {
    throw new Error('the refresh fell back to a browser redirect — the refresh token was refused');
  }
  return finish(store, 'refresh');
}

// ---------------------------------------------------------------------------
// The loopback receiver (RFC 8252: a local HTTP redirect target, one callback, then closed)
// ---------------------------------------------------------------------------

interface CallbackReceipt {
  code: string | undefined;
  state: string | undefined;
  iss: string | undefined;
  error: string | undefined;
  errorDescription: string | undefined;
}

interface CallbackListener {
  server: Server;
  port: number;
  promise: Promise<CallbackReceipt>;
}

function listenForCallback(port: number | undefined, timeoutMs: number): Promise<CallbackListener> {
  return new Promise((resolveListener, rejectListener) => {
    let settled = false;
    let receiptResolve: ((receipt: CallbackReceipt) => void) | undefined;
    const promise = new Promise<CallbackReceipt>((resolve, reject) => {
      receiptResolve = resolve;
      // The listener's own timeout: a browser leg that never lands must not hang the CLI.
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`no authorization redirect arrived within ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref?.();
    });

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const params = url.searchParams;
      const receipt: CallbackReceipt = {
        code: params.get('code') ?? undefined,
        state: params.get('state') ?? undefined,
        iss: params.get('iss') ?? undefined,
        error: params.get('error') ?? undefined,
        errorDescription: params.get('error_description') ?? undefined,
      };
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        receipt.error === undefined
          ? '<!doctype html><title>onememory authorized</title><p>onememory: authorization complete — you can close this tab.</p>'
          : '<!doctype html><title>onememory refused</title><p>onememory: the authorization server reported an error — see the terminal.</p>',
      );
      if (!settled) {
        settled = true;
        receiptResolve?.(receipt);
      }
    });

    server.on('error', (error) => {
      rejectListener(new Error(`the loopback listener failed to bind: ${error.message}`));
    });

    server.listen(port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : 0;
      resolveListener({ server, port: bound, promise });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function finish(store: OAuthCredentialStore, via: 'authorization-code' | 'refresh'): Promise<LoopbackOAuthResult> {
  return store.load().then((credential) => {
    if (credential === undefined) {
      throw new Error('the flow completed but no credential was persisted');
    }
    return {
      issuer: credential.issuer,
      tokenScope: credential.tokens?.scope,
      savedAt: credential.savedAt,
      via,
    };
  });
}

export type { StoredClient, StoredTokensFile };
