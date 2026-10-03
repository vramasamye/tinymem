/**
 * The server factory (ADR-0010): ONE `buildOnememoryServer(context)` builds the McpServer for
 * BOTH transports and BOTH protocol eras — the SDK's `serveStdio` pins one instance per
 * connection and serves 2025-era and 2026-07-28 openings through the same factory, and the
 * stateless HTTP handler builds a fresh server per request against the SAME shared context.
 *
 * No Roots/Sampling/Logging dependencies (deprecated per SEP-2577): the workspace hint comes
 * from CLAUDE_PROJECT_DIR at context build time, consolidation never runs through Sampling
 * (onememory's own worker owns it), and logs go to stderr — NEVER stdout (stdio is the wire).
 */

import { McpServer, type McpServerOptions } from '@modelcontextprotocol/server';

import type { OnememoryMcpContext } from './context';
import { SERVER_INSTRUCTIONS, TOOL_ANNOTATIONS, TOOL_DESCRIPTIONS, TOOL_TITLES } from './descriptions';
import { TOOL_HANDLERS } from './handlers';
import { makeToolCallback } from './results';
import { TOOL_SCHEMAS, toolsForProfile } from './schemas';

export interface BuildServerOptions {
  /** Tool exposure profile override (default: the context's configured profile). */
  profile?: 'default8' | 'full11';
}

/** The server factory — registers every profile tool with the SDK's v2 API. */
export function buildOnememoryServer(context: OnememoryMcpContext, options: BuildServerOptions = {}): McpServer {
  const profile = options.profile ?? context.config.profile;
  const server = new McpServer(context.serverInfo, {
    capabilities: { tools: { listChanged: false } },
    instructions: context.config.instructions ?? SERVER_INSTRUCTIONS,
  } satisfies McpServerOptions);

  // Deterministic registration order (tools spec recommendation — clients list in this order).
  for (const name of toolsForProfile(profile)) {
    const schema = TOOL_SCHEMAS[name];
    server.registerTool(
      name,
      {
        title: TOOL_TITLES[name],
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: schema.input,
        outputSchema: schema.output,
        annotations: TOOL_ANNOTATIONS[name],
      },
      makeToolCallback(context, TOOL_HANDLERS[name], name),
    );
  }
  return server;
}
