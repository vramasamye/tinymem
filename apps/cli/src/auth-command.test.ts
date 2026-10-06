/**
 * `onemem auth` CLI surface: dispatch, config-dir resolution, io rendering, exit codes.
 *
 * The OAuth protocol legs (discovery, DCR, PKCE S256, state, RFC 9207 iss, token exchange,
 * refresh) are pinned in `packages/mcp/src/oauth.test.ts`. This file pins the OPERATOR surface
 * ADR-0012 documents — `onemem auth login|status|logout` — end to end through `main()`:
 * a real loopback login against a fake authorization server, then status, then logout.
 *
 * ADR-0012 §"Local (default)": nothing is guessed and no browser is force-opened; the
 * authorization URL is printed and the loopback receiver captures the redirect.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from './bin';

interface Captured {
  out: string;
  err: string;
  exitCode: number;
}

/**
 * Run `main()` capturing both streams, and follow the printed authorization URL the moment it
 * appears — the operator leg (`open this URL in a browser`) performed by the test.
 */
async function authCli(argv: string[]): Promise<Captured> {
  let out = '';
  let err = '';
  let followed: Promise<Response> | undefined;
  const exitCode = await main(argv, {
    interactive: false,
    env: {},
    write: (text) => {
      out += text;
      const match = /https?:\/\/127\.0\.0\.1:\d+\/authorize\?[^\s]+/.exec(out);
      if (match !== null && followed === undefined) followed = fetch(match[0]);
    },
    writeErr: (text) => {
      err += text;
    },
  });
  if (followed !== undefined) await followed;
  return { out, err, exitCode };
}

/**
 * A minimal fake authorization server + protected resource (RFC 8414 / 9728 / 7591 / 7636).
 * Mirrors the metadata shape the MCP client SDK validates; no JWT signing (the client flow
 * never verifies tokens — that is the resource server's job, tested in `oauth.test.ts`).
 */
interface FakeAuthorizationServer {
  asUrl: string;
  resourceUrl: string;
  close(): Promise<void>;
}

async function startFakeAuthorizationServer(): Promise<FakeAuthorizationServer> {
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

      if (request.method === 'POST' && url.pathname === '/register') {
        const body = (await request.json()) as Record<string, unknown>;
        return Response.json({
          client_id: 'onemem-cli-test-client',
          client_name: 'onememory',
          redirect_uris: body['redirect_uris'],
          grant_types: body['grant_types'],
          response_types: body['response_types'],
          token_endpoint_auth_method: 'none',
          scope: body['scope'],
        });
      }

      if (request.method === 'GET' && url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        const state = url.searchParams.get('state') ?? '';
        // The AS refuses what the spec requires before issuing anything (PKCE S256 only).
        if (url.searchParams.get('code_challenge_method') !== 'S256') {
          return new Response('PKCE S256 required', { status: 400 });
        }
        if (!redirectUri.startsWith('http://127.0.0.1:')) {
          return new Response('redirect_uri must be loopback', { status: 400 });
        }
        const code = `code-${randomUUID()}`;
        liveCode = code;
        // RFC 9207: `iss` is echoed so the client can detect a mix-up.
        return new Response(null, {
          status: 302,
          headers: {
            location: `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(
              state,
            )}&iss=${encodeURIComponent(asUrl)}`,
          },
        });
      }

      if (request.method === 'POST' && url.pathname === '/token') {
        const body = new URLSearchParams(await request.text());
        if (body.get('code') === undefined || body.get('code') !== liveCode) {
          return Response.json({ error: 'invalid_grant', error_description: 'unknown code' }, { status: 400 });
        }
        liveCode = undefined; // single-use
        return Response.json({
          access_token: `at-${randomUUID()}`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'onememory:read onememory:write',
          refresh_token: `rt-${randomUUID()}`,
        });
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
    async close(): Promise<void> {
      await asServer.stop(true);
      await resourceServer.stop(true);
    },
  };
}

const roots: string[] = [];

function freshProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onemem-auth-cli-'));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('onemem auth status', () => {
  test('an unconfigured credential reports it and points at the login command', async () => {
    const cwd = freshProjectDir();
    const result = await authCli(['auth', 'status', '--cwd', cwd]);

    expect(result.exitCode).toBe(1);
    expect(result.out).toContain('no OAuth credential configured');
    expect(result.out).toContain('onemem auth login --server-url');
  });

  test('bare `onemem auth` defaults to status (never runs a flow the operator did not ask for)', async () => {
    const cwd = freshProjectDir();
    const result = await authCli(['auth', '--json', '--cwd', cwd]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ configured: false, hasRefreshToken: false });
  });
});

describe('onemem auth login', () => {
  let as: FakeAuthorizationServer;

  beforeAll(async () => {
    as = await startFakeAuthorizationServer();
  });

  afterAll(async () => {
    await as.close();
  });

  test('discovery → PKCE → loopback redirect → persisted 0600 credential', async () => {
    const cwd = freshProjectDir();
    const result = await authCli(['auth', 'login', '--server-url', as.resourceUrl, '--cwd', cwd]);

    expect(result.exitCode).toBe(0);
    expect(result.out).toContain('open this URL in a browser');
    expect(result.out).toContain(`authorized against ${as.asUrl}`);

    const storePath = join(cwd, '.onememory', 'oauth.json');
    const credential = JSON.parse(readFileSync(storePath, 'utf8')) as {
      issuer: string;
      tokens: { access_token: string; refresh_token?: string };
    };
    expect(credential.issuer).toBe(as.asUrl);
    expect(credential.tokens.access_token).toBeString();
    expect(credential.tokens.refresh_token).toBeString();
    // The credential is written 0600 — never group/world readable.
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
  });

  test('status then reports the live credential, and logout removes it', async () => {
    const cwd = freshProjectDir();
    await authCli(['auth', 'login', '--server-url', as.resourceUrl, '--cwd', cwd]);

    const status = await authCli(['auth', 'status', '--json', '--cwd', cwd]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject({
      configured: true,
      issuer: as.asUrl,
      hasRefreshToken: true,
      hasClientRegistration: true,
    });

    const logout = await authCli(['auth', 'logout', '--cwd', cwd]);
    expect(logout.exitCode).toBe(0);
    expect(logout.out).toContain('removed the OAuth credential');

    const after = await authCli(['auth', 'status', '--cwd', cwd]);
    expect(after.exitCode).toBe(1);
    expect(after.out).toContain('no OAuth credential configured');
  });

  test('logout is idempotent — removing nothing is still success', async () => {
    const cwd = freshProjectDir();
    const result = await authCli(['auth', 'logout', '--cwd', cwd]);
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain('removed the OAuth credential');
  });

  test('login without a target fails closed with the two accepted flags', async () => {
    const cwd = freshProjectDir();
    const result = await authCli(['auth', 'login', '--cwd', cwd]);
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('onemem auth login needs a target');
    expect(result.err).toContain('--server-url');
    expect(result.err).toContain('--issuer');
  });
});
