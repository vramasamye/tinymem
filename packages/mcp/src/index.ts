/**
 * `@onememory/mcp` — the model-facing protocol surface (ADR-0010): the MCP server that exposes
 * onememory to AI coding agents. stdio primary; optional Streamable HTTP in BOTH forms —
 * stateless shared-server mode (`http.ts`, the daemon's `/mcp` mount) and the sessionful
 * server-mode transport (`streamable-http/`, `Mcp-Session-Id` + SSE + resumability); optional
 * OAuth 2.1 resource-server gating + client loopback flow (`oauth/`) for server mode /
 * hosted deployments. 8-tool default profile with progressive disclosure (search → ID-index,
 * get → full records), never-silent write outcomes, revision-checked updates, forget ≠ delete.
 *
 * Depends on: core (schemas, model, ports), storage (drivers + repositories), retrieval (the
 * Searcher port), security (redaction). Never the reverse — adapters (M6/M7) depend on THIS.
 */

// Version + the description/instructions artifact (ADR-0010: descriptions are maintained)
export { SERVER_NAME, SERVER_VERSION, MCP_STORE_PROMPT_VERSION, MCP_UPDATE_PROMPT_VERSION } from './version';
export {
  SERVER_INSTRUCTIONS,
  TOOL_ANNOTATIONS,
  TOOL_DESCRIPTIONS,
  TOOL_TITLES,
  MAX_TOOL_DESCRIPTION_CHARS,
  MAX_INSTRUCTIONS_CHARS,
} from './descriptions';

// Configuration (profile, storage mode, env resolution)
export {
  EmbeddedStorageConfigSchema,
  ServerStorageConfigSchema,
  StorageConfigSchema,
  OnememoryMcpConfigSchema,
  resolveMcpConfig,
  mcpConfigFromEnv,
  type EmbeddedStorageConfig,
  type ServerStorageConfig,
  type StorageConfig,
  type OnememoryMcpConfig,
  type OnememoryMcpConfigInput,
  type McpEnv,
} from './config';

// Context (storage + engine + redactor wiring)
export {
  createOnememoryMcpContext,
  type OnememoryMcpContext,
  type OnememoryMcpContextOptions,
} from './context';

// The tool wire contract (input/output schemas — what M6/M7/M13 consume)
export {
  DEFAULT_TOOLS,
  FULL11_EXTRA_TOOLS,
  TOOL_PROFILES,
  TOOL_SCHEMAS,
  SEARCH_KINDS,
  toolsForProfile,
  typesForKind,
  MemoryIndexEntrySchema,
  MemorySearchInputSchema,
  MemorySearchOutputSchema,
  MemoryGetInputSchema,
  MemoryGetOutputSchema,
  MemoryStoreInputSchema,
  MemoryStoreOutputSchema,
  MemoryUpdateInputSchema,
  MemoryUpdateOutputSchema,
  MemoryDeleteInputSchema,
  MemoryDeleteOutputSchema,
  MemoryForgetInputSchema,
  MemoryForgetOutputSchema,
  MemoryRelatedInputSchema,
  MemoryRelatedOutputSchema,
  MemoryProjectContextInputSchema,
  MemoryProjectContextOutputSchema,
  MemoryDecisionsInputSchema,
  MemoryDecisionsOutputSchema,
  MemoryFailuresInputSchema,
  MemoryFailuresOutputSchema,
  MemorySkillsInputSchema,
  MemorySkillsOutputSchema,
  ToolErrorPayloadSchema,
  type DefaultToolName,
  type Full11ExtraToolName,
  type ToolName,
  type ToolProfile,
  type SearchKind,
  type MemoryIndexEntry,
  type MemorySearchInput,
  type MemorySearchOutput,
  type MemoryGetInput,
  type MemoryGetOutput,
  type MemoryStoreInput,
  type MemoryStoreOutput,
  type MemoryUpdateInput,
  type MemoryUpdateOutput,
  type MemoryDeleteInput,
  type MemoryDeleteOutput,
  type MemoryForgetInput,
  type MemoryForgetOutput,
  type MemoryRelatedInput,
  type MemoryRelatedOutput,
  type MemoryProjectContextInput,
  type MemoryProjectContextOutput,
  type MemoryDecisionsInput,
  type MemoryDecisionsOutput,
  type MemoryFailuresInput,
  type MemoryFailuresOutput,
  type MemorySkillsInput,
  type MemorySkillsOutput,
  type ToolErrorPayload,
} from './schemas';

// Handlers + the result wrapper (the isError guarantee)
export {
  TOOL_HANDLERS,
  handleMemorySearch,
  handleMemoryGet,
  handleMemoryStore,
  handleMemoryUpdate,
  handleMemoryDelete,
  handleMemoryForget,
  handleMemoryRelated,
  handleMemoryProjectContext,
  handleMemoryDecisions,
  handleMemoryFailures,
  handleMemorySkills,
  type AnyToolHandler,
} from './handlers';
export { okResult, errorResult, makeToolCallback } from './results';
export { ToolError, asToolError, type ToolErrorCode } from './errors';

// Server factory + transports
export { buildOnememoryServer, type BuildServerOptions } from './server';
export {
  serveOnememoryStdio,
  type ServeStdioOptions,
  type OnememoryStdioHandle,
} from './stdio';
export {
  createOnememoryStreamableHttpHandler,
  createOnememoryHttpServer,
  type CreateStreamableHttpOptions,
} from './http';

// Sessionful Streamable HTTP (server mode — backlog M5.2 / M5b): sessions + resumability.
export {
  InMemoryResumabilityStore,
  DEFAULT_MAX_EVENTS_PER_STREAM,
  createStreamableHttpSessionManager,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_KEEP_ALIVE_MS,
  createBearerGate,
  createOnememoryStreamableHttpServer,
  type InMemoryResumabilityStoreOptions,
  type OnememorySessionManager,
  type CreateSessionManagerOptions,
  type SessionInfo,
  type McpAuthGateOptions,
  type BearerGate,
  type ServeStreamableHttpOptions,
  type StreamableHttpAuthOptions,
  type OnememoryStreamableHttpHandle,
} from './streamable-http';

// OAuth 2.1 (server mode / hosted deployments — backlog M5.5 / M5b)
export {
  OAuthCredentialStore,
  OAUTH_STORE_FILE_NAME,
  StoredClientSchema,
  StoredTokensSchema,
  runLoopbackOAuthFlow,
  refreshStoredOAuth,
  oauthStatus,
  DEFAULT_OAUTH_SCOPE,
  createJwtTokenVerifier,
  createStaticTokenVerifier,
  buildOnememoryProtectedResourceMetadata,
  onememoryOauthMetadataResponse,
  loadAuthorizationServerMetadata,
  type StoredClient,
  type StoredTokensFile,
  type OAuthCredentialStoreOptions,
  type StoredOAuthCredential,
  type SaveCredentialInput,
  type RunLoopbackOAuthOptions,
  type LoopbackOAuthResult,
  type OAuthStatus,
  type JwtTokenVerifierOptions,
  type StaticTokenEntry,
  type StaticTokenVerifierOptions,
  type OnememoryProtectedResourceOptions,
  type OAuthMetadata,
} from './oauth';
