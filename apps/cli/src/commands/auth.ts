/**
 * `onemem auth` — the OAuth 2.1 operator surface for SERVER MODE (backlog M5.5 / M5b,
 * posture in ADR-0012): `login` runs the authorization-code flow with PKCE + state against
 * the deployment's authorization server and persists the token securely
 * (`.onememory/oauth.json`, 0600); `status` reports it; `logout` removes it.
 *
 * Local-first invariant: auth is NEVER guessed. The default install has no authorization
 * server; `login` does nothing until the operator points it at one explicitly
 * (`--server-url <onemem-url>` → RFC 9728 discovery, or `--issuer <as-url>` directly).
 * No browser is force-opened either: the authorization URL is PRINTED (scripts and remote
 * sessions need exactly that), and the loopback receiver on 127.0.0.1 captures the redirect.
 *
 * The flow itself is the official MCP client SDK's `auth()` orchestrator driven by
 * `@onememory-ai/mcp`'s `runLoopbackOAuthFlow` — PKCE S256, the state nonce check, RFC 7591
 * dynamic client registration, and refresh are all the SDK's, not ours.
 */

import { loadConfig } from '@onememory-ai/config';
import { OAuthCredentialStore, oauthStatus, runLoopbackOAuthFlow } from '@onememory-ai/mcp';

import type { Io } from '../io';

/** Options every `onemem auth` leaf shares: where the project (and its store) is. */
export interface AuthCommonOptions {
  cwd?: string;
  configPath?: string | null;
}

export interface AuthLoginOptions extends AuthCommonOptions {
  /** The onememory MCP server URL — the protected resource (RFC 9728 discovery). */
  serverUrl?: string;
  /** The authorization server issuer, when known directly (skips resource discovery). */
  issuer?: string;
  /** Fixed loopback port (tests); default: ephemeral. */
  port?: number;
  /** Extra scopes beyond the default `onememory:read onememory:write`. */
  scope?: string;
  /** Wait for the authorization redirect (default 300000ms). */
  timeoutMs?: number;
}

/** Resolve the config dir for the credential store (auth works with or without a config file). */
async function resolveConfigDir(options: AuthCommonOptions): Promise<string> {
  const loaded = await loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    required: false,
  });
  return loaded.paths.config_dir;
}

/**
 * `onemem auth login` — the loopback flow. The URL is printed, never auto-opened; the receiver
 * on 127.0.0.1 captures the redirect and validates the state nonce before any code is accepted.
 */
export async function runAuthLogin(options: AuthLoginOptions, io: Io): Promise<number> {
  if (options.serverUrl === undefined && options.issuer === undefined) {
    throw new Error(
      'onemem auth login needs a target: --server-url <onemem-url> (RFC 9728 discovery) or --issuer <as-url>',
    );
  }

  const store = new OAuthCredentialStore({ configDir: await resolveConfigDir(options) });
  const result = await runLoopbackOAuthFlow({
    serverUrl: options.serverUrl ?? options.issuer!,
    ...(options.issuer === undefined ? {} : { authorizationServerUrl: options.issuer }),
    store,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    onAuthorizationUrl: (url) => {
      io.out('open this URL in a browser to authorize onememory:');
      io.out(`  ${url.href}`);
    },
  });

  const after = await oauthStatus(store);
  io.out(`authorized against ${result.issuer} (via ${result.via})`);
  if (result.tokenScope !== undefined) io.out(`  granted scopes: ${result.tokenScope}`);
  if (after.expiresAt !== undefined) io.out(`  access token expires: ${after.expiresAt}`);
  io.out(`  saved at ${store.filePath} (mode ${after.permissionMode ?? '?'}) — never logged, never echoed`);
  io.emit({
    issuer: result.issuer,
    scope: result.tokenScope,
    saved_at: result.savedAt,
    via: result.via,
    store_path: store.filePath,
    expires_at: after.expiresAt,
  });
  return 0;
}

/**
 * `onemem auth status` — report the stored credential. Exits 1 when none is configured, so a
 * script can branch on it; never runs a flow the operator did not name an authorization server
 * for.
 */
export async function runAuthStatus(options: AuthCommonOptions, io: Io): Promise<number> {
  const store = new OAuthCredentialStore({ configDir: await resolveConfigDir(options) });
  const status = await oauthStatus(store);

  if (!status.configured) {
    io.out(`no OAuth credential configured (${store.filePath})`);
    io.out('  authorize with: onemem auth login --server-url <onemem-url>   (or --issuer <as-url>)');
    io.emit({ ...status, store_path: store.filePath });
    return 1;
  }

  io.out(`OAuth credential configured for ${status.issuer}`);
  if (status.resource !== undefined) io.out(`  resource: ${status.resource}`);
  io.out(`  saved: ${status.savedAt ?? '-'} (file mode ${status.permissionMode ?? '?'})`);
  io.out(`  scopes: ${status.scope ?? '(none recorded)'}`);
  if (status.expiresAt !== undefined) io.out(`  access token expires: ${status.expiresAt}`);
  io.out(`  refresh token: ${status.hasRefreshToken ? 'present' : 'absent'}`);
  io.out(`  client registration: ${status.hasClientRegistration ? 'present' : 'absent'}`);
  io.emit({ ...status, store_path: store.filePath });
  return 0;
}

/** `onemem auth logout` — remove the stored credential. Idempotent: removing nothing succeeds. */
export async function runAuthLogout(options: AuthCommonOptions, io: Io): Promise<number> {
  const store = new OAuthCredentialStore({ configDir: await resolveConfigDir(options) });
  await store.clear();
  io.out(`removed the OAuth credential (${store.filePath})`);
  io.emit({ logout: true, store_path: store.filePath });
  return 0;
}
