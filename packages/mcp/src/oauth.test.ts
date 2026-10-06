/**
 * The OAuth 2.1 client + verifier tests (M5b AC 2): the loopback authorization-code flow
 * with PKCE + state, run END-TO-END against a FAKE OIDC server over real sockets — RFC 8414
 * discovery, RFC 7591 dynamic registration, the PKCE S256 challenge on the authorize wire,
 * the RFC 9207 `iss` binding, the loopback redirect receiver on 127.0.0.1, the token
 * exchange (whose PKCE verifier the fake AS re-derives and checks), refresh-token rotation,
 * and the 0600 credential store. Plus the JWT/JWKS verifier leg (`createJwtTokenVerifier`)
 * the sessionful gate tests reference.
 *
 * Everything hard is the official SDK's (AGENTS.md rule 2): the flow is `auth()` from
 * `@modelcontextprotocol/client` 2.3.0; onememory owns only the `OAuthClientProvider` seam.
 * The fake AS deliberately VALIDATES what the spec requires (PKCE S256, redirect_uri
 * binding, single-use codes) instead of rubber-stamping — the test proves the wire contract,
 * not a happy path.
 *
 * Security properties pinned here (the set `./oauth/client.ts`'s header promises):
 * - PKCE S256: the token request's verifier hashes to the authorize request's challenge.
 * - State: a tampered callback state is refused BEFORE any code is exchanged.
 * - The loopback receiver binds 127.0.0.1, answers one callback, then shuts down.
 * - Tokens persist 0600, atomically; the PKCE verifier is NEVER persisted.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';

import { SignJWT, exportJWK } from 'jose';
import { OAuthError } from '@modelcontextprotocol/server';
import type { StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client';

import {
  DEFAULT_OAUTH_SCOPE,
  OAuthCredentialStore,
  createJwtTokenVerifier,
  oauthStatus,
  refreshStoredOAuth,
  runLoopbackOAuthFlow,
} from './oauth';
import { OAUTH_STORE_FILE_NAME } from './oauth/store';

// ---------------------------------------------------------------------------
// The fake OIDC world: an authorization server + a protected resource, real sockets
// ---------------------------------------------------------------------------

interface AuthorizeCapture {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource: string | undefined;
}

interface TokenExchangeCapture {
  grantType: string;
  code: string | undefined;
  codeVerifier: string | undefined;
  refreshToken: string | undefined;
  redirectUri: string | undefined;
  resource: string | undefined;
}

interface FakeOidcWorld {
  /** The AS's root URL (its RFC 8414 issuer). */
  asUrl: string;
  /** The protected resource URL (the MCP server). */
  resourceUrl: string;
  /** The DCR request body the AS received. */
  registration: Record<string, unknown> | undefined;
  /** The authorize request the AS received (the latest one). */
  authorize: AuthorizeCapture | undefined;
  /** Every token request the AS received, in order. */
  tokenExchanges: TokenExchangeCapture[];
  /** Valid refresh tokens the AS has issued. */
  refreshTokens: string[];
  close(): Promise<void>;
}

interface FakeOidcOptions {
  /** Return the redirect Location for /authorize (default: the captured redirect_uri with code+state+iss). */
  authorizeRedirect?: (capture: AuthorizeCapture, code: string) => string;
}

/** The JWK set the fake AS serves at /jwks (the public key of the JWT signing pair). */
const jwksWorld = {
  keys: [] as Array<Record<string, unknown>>,
};

/** Stand up the fake AS + protected resource on ephemeral loopback sockets. */
async function startFakeOidc(options: FakeOidcOptions = {}): Promise<FakeOidcWorld> {
  const tokenExchanges: TokenExchangeCapture[] = [];
  let registration: Record<string, unknown> | undefined;
  let authorize: AuthorizeCapture | undefined;
  const refreshTokens: string[] = [];
  /** The currently valid, single-use authorization code (minted at /authorize). */
  let liveCode: string | undefined;

  const asServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const asUrl = `http://${request.headers.get('host')}`;

      if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer: asUrl,
          authorization_endpoint: `${asUrl}/authorize`,
          token_endpoint: `${asUrl}/token`,
          registration_endpoint: `${asUrl}/register`,
          response_types_supported: ['code'],
          response_modes_supported: ['query'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['onememory:read', 'onememory:write'],
          authorization_response_iss_parameter_supported: true,
        });
      }

      if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        return Response.json({ issuer: asUrl, jwks_uri: `${asUrl}/jwks` });
      }

      if (request.method === 'POST' && url.pathname === '/register') {
        registration = (await request.json()) as Record<string, unknown>;
        return Response.json({
          client_id: 'onememory-test-client',
          client_name: 'onememory',
          redirect_uris: registration['redirect_uris'],
          grant_types: registration['grant_types'],
          response_types: registration['response_types'],
          token_endpoint_auth_method: 'none',
          scope: registration['scope'],
        });
      }

      if (request.method === 'GET' && url.pathname === '/authorize') {
        const capture: AuthorizeCapture = {
          clientId: url.searchParams.get('client_id') ?? '(missing)',
          redirectUri: url.searchParams.get('redirect_uri') ?? '(missing)',
          state: url.searchParams.get('state') ?? '(missing)',
          codeChallenge: url.searchParams.get('code_challenge') ?? '(missing)',
          codeChallengeMethod: url.searchParams.get('code_challenge_method') ?? '(missing)',
          scope: url.searchParams.get('scope') ?? '(missing)',
          resource: url.searchParams.get('resource') ?? undefined,
        };
        // The AS validates what the spec requires before issuing anything.
        if (capture.clientId !== 'onememory-test-client') return new Response('unknown client', { status: 400 });
        if (url.searchParams.get('response_type') !== 'code') return new Response('response_type must be code', { status: 400 });
        if (!capture.redirectUri.startsWith('http://127.0.0.1:')) return new Response('redirect_uri must be loopback', { status: 400 });
        if (capture.codeChallengeMethod !== 'S256') return new Response('PKCE S256 required', { status: 400 });
        authorize = capture;
        const code = `code-${randomUUID()}`;
        liveCode = code;
        const location =
          options.authorizeRedirect === undefined
            ? `${capture.redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(capture.state)}&iss=${encodeURIComponent(asUrl)}`
            : options.authorizeRedirect(capture, code);
        return new Response(null, { status: 302, headers: { location } });
      }

      if (request.method === 'POST' && url.pathname === '/token') {
        const body = new URLSearchParams(await request.text());
        const grantType = body.get('grant_type') ?? '(missing)';
        const exchange: TokenExchangeCapture = {
          grantType,
          code: body.get('code') ?? undefined,
          codeVerifier: body.get('code_verifier') ?? undefined,
          refreshToken: body.get('refresh_token') ?? undefined,
          redirectUri: body.get('redirect_uri') ?? undefined,
          resource: body.get('resource') ?? undefined,
        };
        tokenExchanges.push(exchange);

        if (grantType === 'authorization_code') {
          if (authorize === undefined || exchange.code === undefined || exchange.code !== liveCode) {
            return Response.json({ error: 'invalid_grant', error_description: 'unknown or reused code' }, { status: 400 });
          }
          liveCode = undefined; // single-use, exactly like a real AS
          if (exchange.redirectUri !== authorize.redirectUri) {
            return Response.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, { status: 400 });
          }
          // PKCE S256, re-derived server-side: SHA-256(verifier) base64url === the challenge.
          const derived = s256(exchange.codeVerifier ?? '');
          if (derived !== authorize.codeChallenge) {
            return Response.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, { status: 400 });
          }
          const refreshToken = `om-rt-${randomUUID()}`;
          refreshTokens.push(refreshToken);
          return Response.json({
            access_token: `om-at-${randomUUID()}`,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: authorize.scope,
            refresh_token: refreshToken,
          });
        }

        if (grantType === 'refresh_token') {
          if (!refreshTokens.includes(exchange.refreshToken ?? '')) {
            return Response.json({ error: 'invalid_grant', error_description: 'unknown refresh token' }, { status: 400 });
          }
          const rotated = `om-rt-${randomUUID()}`;
          refreshTokens.push(rotated);
          return Response.json({
            access_token: `om-at-${randomUUID()}`,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: DEFAULT_OAUTH_SCOPE,
            refresh_token: rotated,
          });
        }

        return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
      }

      if (request.method === 'GET' && url.pathname === '/jwks') {
        return Response.json({ keys: jwksWorld.keys });
      }

      return new Response('not found', { status: 404 });
    },
  });
  const asUrl = `http://127.0.0.1:${asServer.port}`;

  const resourceServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request): Response {
      const url = new URL(request.url);
      const resourceOrigin = `http://${request.headers.get('host')}`;
      // RFC 9728: the path-inserted form for a non-root resource URL, and the root form.
      if (
        request.method === 'GET' &&
        (url.pathname === '/.well-known/oauth-protected-resource' ||
          url.pathname === '/.well-known/oauth-protected-resource/mcp')
      ) {
        return Response.json({
          resource: resourceOrigin,
          authorization_servers: [asUrl],
          scopes_supported: ['onememory:read', 'onememory:write'],
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    asUrl,
    resourceUrl: `http://127.0.0.1:${resourceServer.port}/mcp`,
    get registration() {
      return registration;
    },
    get authorize() {
      return authorize;
    },
    tokenExchanges,
    refreshTokens,
    async close(): Promise<void> {
      resourceServer.stop(true);
      asServer.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// The JWT signing pair for the verifier leg
// ---------------------------------------------------------------------------

const { privateKey: jwtPrivateKey, publicKey: jwtPublicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const JWT_KID = 'onememory-test-key-1';

beforeAll(async () => {
  const jwk = (await exportJWK(jwtPublicKey)) as Record<string, unknown>;
  jwksWorld.keys = [{ ...jwk, kid: JWT_KID, alg: 'RS256', use: 'sig' }];
});

const configDirs: string[] = [];
const worlds: FakeOidcWorld[] = [];

afterAll(async () => {
  for (const world of worlds.splice(0)) await world.close();
  for (const dir of configDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function freshConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'onemem-oauth-test-'));
  configDirs.push(dir);
  return dir;
}

/** b64url(SHA-256(verifier)) — the RFC 7636 S256 derivation the fake AS performs. */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

// ---------------------------------------------------------------------------
// The loopback flow, end-to-end against the fake OIDC server
// ---------------------------------------------------------------------------

describe('the loopback OAuth 2.1 flow — end-to-end against a fake OIDC server', () => {
  test('discovery → DCR → PKCE + state → redirect → exchange → 0600 persistence', async () => {
    const world = await startFakeOidc();
    worlds.push(world);
    const configDir = await freshConfigDir();
    const store = new OAuthCredentialStore({ configDir });

    let authorizeUrl: URL | undefined;
    const result = await runLoopbackOAuthFlow({
      serverUrl: world.resourceUrl,
      authorizationServerUrl: world.asUrl,
      store,
      onAuthorizationUrl: async (url) => {
        authorizeUrl = url;
        // The authorize wire contract, pinned before the AS leg runs:
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('client_id')).toBe('onememory-test-client'); // from RFC 7591 DCR
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/); // SHA-256 → 43 b64url chars
        expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        expect(url.searchParams.get('state')).toBeString();
        expect(url.searchParams.get('scope')).toBe(DEFAULT_OAUTH_SCOPE);
        expect(url.searchParams.get('resource')).toBe(new URL(world.resourceUrl).origin); // RFC 8707
        // The browser leg: drive the authorize URL — the fake AS 302s to the loopback receiver.
        const followed = await fetch(url);
        expect(followed.status).toBe(200); // the loopback receiver answered the redirect
        expect(await followed.text()).toContain('authorization complete');
      },
    });

    // The flow finished through the authorization-code leg and persisted.
    expect(result.via).toBe('authorization-code');
    expect(result.issuer).toBe(world.asUrl);
    expect(result.tokenScope).toBe(DEFAULT_OAUTH_SCOPE);
    expect(result.savedAt).toBeString();
    expect(authorizeUrl?.searchParams.get('state')).toBe(world.authorize?.state);

    // DCR saw the public-client metadata (PKCE, no secret).
    expect(world.registration).toMatchObject({
      client_name: 'onememory',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: DEFAULT_OAUTH_SCOPE,
    });

    // PKCE S256 verified END-TO-END: the token request's verifier hashes to the challenge.
    const exchange = world.tokenExchanges.find((e) => e.grantType === 'authorization_code');
    const authorizeCapture = world.authorize;
    if (exchange === undefined || authorizeCapture === undefined || exchange.codeVerifier === undefined) {
      throw new Error('the fake AS never saw the PKCE-honest token exchange');
    }
    expect(s256(exchange.codeVerifier)).toBe(authorizeCapture.codeChallenge);
    expect(exchange.redirectUri).toBe(authorizeCapture.redirectUri);
    expect(exchange.resource).toBe(new URL(world.resourceUrl).origin);

    // Persistence: 0600, atomic, client + tokens, NEVER the PKCE verifier.
    const info = await stat(join(configDir, OAUTH_STORE_FILE_NAME));
    expect(info.mode & 0o777).toBe(0o600);
    const raw = await readFile(join(configDir, OAUTH_STORE_FILE_NAME), 'utf8');
    const file = JSON.parse(raw) as {
      version: number;
      issuer: string;
      client?: { client_id: string };
      tokens?: { access_token: string; refresh_token: string; scope: string };
      code_verifier?: string;
    };
    expect(file.version).toBe(1);
    expect(file.issuer).toBe(world.asUrl);
    expect(file.client?.client_id).toBe('onememory-test-client');
    expect(file.tokens?.access_token).toBeString();
    expect(file.tokens?.refresh_token).toBeString();
    expect(file.tokens?.scope).toBe(DEFAULT_OAUTH_SCOPE);
    expect('code_verifier' in file).toBe(false);
    if (exchange?.codeVerifier !== undefined) {
      expect(raw.includes(exchange.codeVerifier)).toBe(false); // the verifier never touched disk
    }

    // The status surface never leaks token material but reports the real state.
    const status = await oauthStatus(store);
    expect(status.configured).toBe(true);
    expect(status.issuer).toBe(world.asUrl);
    expect(status.scope).toBe(DEFAULT_OAUTH_SCOPE);
    expect(status.hasRefreshToken).toBe(true);
    expect(status.hasClientRegistration).toBe(true);
    expect(status.permissionMode).toBe('600');
    expect(status.expiresAt).toBeString();
    expect(JSON.stringify(status)).not.toContain(file.tokens?.access_token ?? '(none)');
    expect(JSON.stringify(status)).not.toContain(file.tokens?.refresh_token ?? '(none)');

    // The loopback receiver answered its one callback and shut down (RFC 8252 receiver).
    const redirectUri = world.authorize?.redirectUri ?? '(missing)';
    await expect(fetch(redirectUri)).rejects.toThrow();
  }, 30_000);

  test('a tampered state on the callback is refused BEFORE any code is exchanged', async () => {
    const world = await startFakeOidc();
    worlds.push(world);
    const store = new OAuthCredentialStore({ configDir: await freshConfigDir() });

    const flow = runLoopbackOAuthFlow({
      serverUrl: world.resourceUrl,
      authorizationServerUrl: world.asUrl,
      store,
      onAuthorizationUrl: async (url) => {
        // The attacker's leg: a callback with a state THIS flow never issued. The loopback
        // receiver accepts the connection (it cannot know), but the flow must refuse it.
        const evil = new URL(url.searchParams.get('redirect_uri')!);
        evil.searchParams.set('code', 'attacker-code');
        evil.searchParams.set('state', 'attacker-state');
        await fetch(evil);
      },
    });
    await expect(flow).rejects.toThrow(/state mismatch/i);

    // No token exchange ever happened — the code was never accepted.
    expect(world.tokenExchanges).toEqual([]);
    const credential = await store.load();
    expect(credential?.tokens).toBeUndefined();
    // The DCR from leg 1 persists (registration precedes the redirect); tokens do not.
    expect(credential?.client?.client_id).toBe('onememory-test-client');
  }, 30_000);

  test('an AS error on the redirect surfaces loudly, not as tokens', async () => {
    const world = await startFakeOidc({
      authorizeRedirect: (capture) =>
        `${capture.redirectUri}?error=access_denied&error_description=operator+refused&state=${encodeURIComponent(capture.state)}`,
    });
    worlds.push(world);
    const store = new OAuthCredentialStore({ configDir: await freshConfigDir() });

    const flow = runLoopbackOAuthFlow({
      serverUrl: world.resourceUrl,
      authorizationServerUrl: world.asUrl,
      store,
      onAuthorizationUrl: async (url) => {
        await fetch(url);
      },
    });
    await expect(flow).rejects.toThrow(/access_denied.*operator refused/i);
    expect(world.tokenExchanges).toEqual([]);
    expect((await store.load())?.tokens).toBeUndefined();
  }, 30_000);

  test('refreshStoredOAuth rotates tokens with NO browser leg (grant_type=refresh_token)', async () => {
    const world = await startFakeOidc();
    worlds.push(world);
    const store = new OAuthCredentialStore({ configDir: await freshConfigDir() });

    const first = await runLoopbackOAuthFlow({
      serverUrl: world.resourceUrl,
      authorizationServerUrl: world.asUrl,
      store,
      onAuthorizationUrl: async (url) => {
        await fetch(url);
      },
    });
    expect(first.via).toBe('authorization-code');
    const firstToken = (await store.load())?.tokens?.access_token;

    const refreshed = await refreshStoredOAuth({ serverUrl: world.resourceUrl, store });
    expect(refreshed.via).toBe('refresh');
    expect(refreshed.issuer).toBe(world.asUrl);

    const refresh = world.tokenExchanges.find((e) => e.grantType === 'refresh_token');
    expect(refresh?.refreshToken).toBeString();
    const after = await store.load();
    expect(after?.tokens?.access_token).toBeString();
    expect(after?.tokens?.access_token).not.toBe(firstToken); // rotated
  }, 30_000);

  test('refreshStoredOAuth refuses loudly when nothing is stored', async () => {
    const world = await startFakeOidc();
    worlds.push(world);
    const store = new OAuthCredentialStore({ configDir: await freshConfigDir() });
    await expect(refreshStoredOAuth({ serverUrl: world.resourceUrl, store })).rejects.toThrow(
      /no stored OAuth credential/i,
    );
  });
});

// ---------------------------------------------------------------------------
// The credential store (the persistence seam)
// ---------------------------------------------------------------------------

describe('OAuthCredentialStore', () => {
  test('load returns undefined for a corrupt file; save merges by credential part; clear is idempotent', async () => {
    const configDir = await freshConfigDir();
    const store = new OAuthCredentialStore({ configDir, now: () => new Date('2026-10-06T00:00:00Z') });

    expect(await store.load()).toBeUndefined(); // absent
    await writeFile(join(configDir, OAUTH_STORE_FILE_NAME), '{not-json', 'utf8');
    expect(await store.load()).toBeUndefined(); // corrupt

    const issuer = 'https://as.example.test';
    const client: StoredOAuthClientInformation = { client_id: 'client-a', issuer };
    await store.save({ issuer, client });
    let credential = await store.load();
    expect(credential?.client?.client_id).toBe('client-a');
    expect(credential?.tokens).toBeUndefined();

    const tokens: StoredOAuthTokens = { access_token: 'at-1', token_type: 'Bearer', issuer };
    await store.save({ issuer, tokens });
    credential = await store.load();
    expect(credential?.client?.client_id).toBe('client-a'); // merge kept the client
    expect(credential?.tokens?.access_token).toBe('at-1');
    expect(credential?.savedAt).toBe('2026-10-06T00:00:00.000Z');

    await expect(
      store.save({ issuer: 'https://other-as.example.test', tokens: { access_token: 'x', token_type: 'Bearer' } }),
    ).rejects.toThrow(/refusing to overwrite/i);

    await store.clear();
    expect(await store.load()).toBeUndefined();
    await store.clear(); // idempotent
  });

  test('the unconfigured status surface', async () => {
    const store = new OAuthCredentialStore({ configDir: await freshConfigDir() });
    const status = await oauthStatus(store);
    expect(status).toMatchObject({
      configured: false,
      hasRefreshToken: false,
      hasClientRegistration: false,
      permissionMode: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// The JWT verifier leg (the resource-server token verification path)
// ---------------------------------------------------------------------------

describe('createJwtTokenVerifier (JWT + JWKS, jose under the hood)', () => {
  test('a real RS256 token against a served JWKS verifies to AuthInfo; wrong audience is refused', async () => {
    const world = await startFakeOidc();
    worlds.push(world);
    const resourceUrl = 'http://127.0.0.1:7901';

    // The verifier discovers the JWKS from the issuer's OIDC document (the production path:
    // `onemem-mcp` / the daemon build the verifier with just the issuer).
    const verifier = await createJwtTokenVerifier({ issuer: world.asUrl, audience: resourceUrl });

    const token = await new SignJWT({ client_id: 'my-client', scope: 'onememory:read onememory:write' })
      .setProtectedHeader({ alg: 'RS256', kid: JWT_KID })
      .setIssuer(world.asUrl)
      .setAudience(resourceUrl)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(jwtPrivateKey);

    const authInfo = await verifier.verifyAccessToken(token);
    expect(authInfo.clientId).toBe('my-client');
    expect(authInfo.scopes).toEqual(['onememory:read', 'onememory:write']);
    expect(authInfo.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(authInfo.resource?.href).toBe(`${resourceUrl}/`); // RFC 8707 audience binding

    // A token minted for ANOTHER resource → refused (the gate's 401 path).
    const wrongAudience = await new SignJWT({ client_id: 'my-client', scope: 'onememory:read' })
      .setProtectedHeader({ alg: 'RS256', kid: JWT_KID })
      .setIssuer(world.asUrl)
      .setAudience('https://some-other-resource.example.test/')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(jwtPrivateKey);
    await expect(verifier.verifyAccessToken(wrongAudience)).rejects.toBeInstanceOf(OAuthError);

    // No exp claim → refused (the SDK's bearer gate requires an expiry).
    const noExpiry = await new SignJWT({ client_id: 'my-client' })
      .setProtectedHeader({ alg: 'RS256', kid: JWT_KID })
      .setIssuer(world.asUrl)
      .setAudience(resourceUrl)
      .sign(jwtPrivateKey);
    await expect(verifier.verifyAccessToken(noExpiry)).rejects.toThrow(/no exp claim/i);

    // No client identity → refused.
    const noClient = await new SignJWT({ scope: 'onememory:read' })
      .setProtectedHeader({ alg: 'RS256', kid: JWT_KID })
      .setIssuer(world.asUrl)
      .setAudience(resourceUrl)
      .setExpirationTime('1h')
      .sign(jwtPrivateKey);
    await expect(verifier.verifyAccessToken(noClient)).rejects.toThrow(/no client identity/i);
  }, 30_000);
});
