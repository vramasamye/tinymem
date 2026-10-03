/**
 * Server identity (ADR-0010: the server name `onememory` is deliberately distinctive —
 * open question 9 in the research, revisited only with evidence).
 */

export const SERVER_NAME = 'onememory' as const;
export const SERVER_VERSION = '0.1.0' as const;

/** The extraction `prompt_version` stamped on MCP-written memories (provenance trail). */
export const MCP_STORE_PROMPT_VERSION = 'onememory/mcp-store/v1' as const;
export const MCP_UPDATE_PROMPT_VERSION = 'onememory/mcp-update/v1' as const;
