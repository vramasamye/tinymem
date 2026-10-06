/**
 * The OAuth credential store: secure local persistence for the machine's onememory OAuth
 * client identity + tokens (the `OAuthClientProvider` persistence seam the MCP SDK defines).
 *
 * Shape (one file per config dir, keyed by issuer — the SDK stamps every credential with the
 * AS's `issuer`, and client ids/tokens are unique to the AS that minted them):
 * `.onememory/oauth.json`, mode 0600, atomic writes (temp + rename). The file NEVER holds the
 * PKCE code verifier (that stays in process memory for the duration of one flow — a persisted
 * verifier would outlive its single-use code) and its values are never logged or echoed.
 *
 * `client` and `tokens` are saved as separate flow steps (registration first, exchange
 * second — the SDK's `saveClientInformation` / `saveTokens` ordering), so the file carries
 * whichever parts exist and `save` MERGES into the previous file instead of clobbering.
 *
 * Zod validates every read (the file is external input — AGENTS.md: schemas at every external
 * boundary). The SDK re-validates every exchange server-side anyway; this validation is the
 * load-time contract, not the wire contract.
 */

import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthMetadata,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';

/** The store file name inside the config dir (`.onememory/oauth.json`). */
export const OAUTH_STORE_FILE_NAME = 'oauth.json';

/** The RFC 7591 registration response fields we persist (a subset of `StoredOAuthClientInformation`). */
export const StoredClientSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  client_name: z.string().optional(),
  redirect_uris: z.array(z.string().url()).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().optional(),
  /** The AS the client is registered with (the SDK's issuer stamp — RFC 6749 §2.2). */
  issuer: z.string().optional(),
});
export type StoredClient = z.infer<typeof StoredClientSchema>;

/** Mirrors the SDK's `StoredOAuthTokens` (RFC 6749 §5.1 + the SDK's issuer stamp). */
export const StoredTokensSchema = z.object({
  access_token: z.string().min(1),
  id_token: z.string().optional(),
  token_type: z.string(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  refresh_token: z.string().optional(),
  /** The AS that minted these tokens (the SDK's issuer stamp). */
  issuer: z.string().optional(),
});
export type StoredTokensFile = z.infer<typeof StoredTokensSchema>;

const OAuthStoreFileSchema = z.object({
  version: z.literal(1),
  /** The AS issuer this file's credentials belong to. */
  issuer: z.string().min(1),
  /** The MCP resource URL the tokens were minted for (RFC 8707), when known. */
  resource: z.string().optional(),
  saved_at: z.string(),
  client: StoredClientSchema.optional(),
  tokens: StoredTokensSchema.optional(),
});
export type OAuthStoreFile = z.infer<typeof OAuthStoreFileSchema>;

export interface OAuthCredentialStoreOptions {
  /** The onememory config dir (`.onememory`); the store lives directly inside it. */
  configDir: string;
  /** Injectable clock (tests). */
  now?: () => Date;
}

/** What `load()` returns: whichever credential parts the file holds. */
export interface StoredOAuthCredential {
  readonly issuer: string;
  readonly resource: string | undefined;
  readonly savedAt: string;
  readonly client: StoredClient | undefined;
  readonly tokens: StoredTokensFile | undefined;
}

export interface SaveCredentialInput {
  issuer: string;
  resource?: string;
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
}

/**
 * File-backed credential store. One instance per config dir; deliberately not a class
 * hierarchy — the surface is load/save/clear plus the status view the CLI prints.
 */
export class OAuthCredentialStore {
  readonly filePath: string;
  private readonly configDir: string;
  private readonly now: () => Date;

  constructor(options: OAuthCredentialStoreOptions) {
    this.configDir = options.configDir;
    this.filePath = join(options.configDir, OAUTH_STORE_FILE_NAME);
    this.now = options.now ?? (() => new Date());
  }

  /** Load the persisted credential; `undefined` when absent, unreadable, or corrupt. */
  async load(): Promise<StoredOAuthCredential | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const file = OAuthStoreFileSchema.safeParse(parsed);
    if (!file.success) return undefined;
    return {
      issuer: file.data.issuer,
      resource: file.data.resource,
      savedAt: file.data.saved_at,
      client: file.data.client,
      tokens: file.data.tokens,
    };
  }

  /**
   * Merge-save one credential step (client registration or tokens) atomically at mode 0600.
   * The previous file's untouched parts survive; the issuer must not change on a merge (a
   * credential from another AS is a different file's content — refuse rather than alias).
   */
  async save(input: SaveCredentialInput): Promise<void> {
    const previous = await this.load();
    if (previous !== undefined && previous.issuer !== input.issuer) {
      throw new Error(
        `refusing to overwrite the OAuth credential for issuer ${previous.issuer} with one for ${input.issuer} — clear it first (onemem auth --logout)`,
      );
    }
    const file: OAuthStoreFile = {
      version: 1,
      issuer: input.issuer,
      resource: input.resource ?? previous?.resource,
      saved_at: this.now().toISOString(),
      client: input.client === undefined ? previous?.client : clientToFile(input.client),
      tokens: input.tokens === undefined ? previous?.tokens : tokensToFile(input.tokens),
    };
    await mkdir(this.configDir, { recursive: true });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rm(this.filePath, { force: true });
    await copyFile(tempPath, this.filePath);
    await rm(tempPath, { force: true });
  }

  /** Remove the credential file (logout / invalidation). Idempotent. */
  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }

  /** The store file's permission bits as an octal string (status display + the 0600 test). */
  async permissionMode(): Promise<string | undefined> {
    try {
      const info = await stat(this.filePath);
      return (info.mode & 0o777).toString(8);
    } catch {
      return undefined;
    }
  }
}

/**
 * Persist the registration the AS returned. `StoredOAuthClientInformation` is the SDK's union
 * (the RFC 7591 base response | the full echo) — the registration we care about echoes what we
 * registered, so read the full shape; the store's Zod schema keeps every field optional, so a
 * minimal registration (client_id only) persists as exactly that.
 */
function clientToFile(client: StoredOAuthClientInformation): StoredClient {
  const full = client as OAuthClientInformationFull & StoredOAuthClientInformation;
  return {
    client_id: full.client_id,
    ...(full.client_secret === undefined ? {} : { client_secret: full.client_secret }),
    ...(full.client_name === undefined ? {} : { client_name: full.client_name }),
    ...(full.redirect_uris === undefined ? {} : { redirect_uris: full.redirect_uris }),
    ...(full.grant_types === undefined ? {} : { grant_types: full.grant_types }),
    ...(full.response_types === undefined ? {} : { response_types: full.response_types }),
    ...(full.token_endpoint_auth_method === undefined
      ? {}
      : { token_endpoint_auth_method: full.token_endpoint_auth_method }),
    ...(full.scope === undefined ? {} : { scope: full.scope }),
    ...(full.issuer === undefined ? {} : { issuer: full.issuer }),
  };
}

function tokensToFile(tokens: StoredOAuthTokens): StoredTokensFile {
  return {
    access_token: tokens.access_token,
    ...(tokens.id_token === undefined ? {} : { id_token: tokens.id_token }),
    token_type: tokens.token_type,
    ...(tokens.expires_in === undefined ? {} : { expires_in: tokens.expires_in }),
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    ...(tokens.refresh_token === undefined ? {} : { refresh_token: tokens.refresh_token }),
    ...(tokens.issuer === undefined ? {} : { issuer: tokens.issuer }),
  };
}

export type { OAuthClientMetadata, OAuthMetadata, StoredOAuthClientInformation, StoredOAuthTokens };
