/**
 * stdio — the PRIMARY transport (ADR-0010 §1): supported by all five runtimes, zero network
 * surface, the launch directory arrives via CLAUDE_PROJECT_DIR. The SDK's `serveStdio` owns the
 * era decision (2025-era initialize handshake AND the 2026-07-28 stateless opening) and pins
 * ONE server instance per connection through our factory.
 *
 * stdio is the wire: any diagnostics MUST go to stderr (console.error), never stdout.
 */

import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import {
  createOnememoryMcpContext,
  type OnememoryMcpContext,
  type OnememoryMcpContextOptions,
} from './context';
import { buildOnememoryServer, type BuildServerOptions } from './server';

export interface ServeStdioOptions extends OnememoryMcpContextOptions, BuildServerOptions {
  /** Out-of-band error reporting (default: console.error — stderr, never stdout). */
  onError?: (error: Error) => void;
}

export interface OnememoryStdioHandle {
  /** The SDK's connection handle (close() tears the transport down; stdin EOF exits naturally). */
  readonly stdio: StdioServerHandle;
  readonly context: OnememoryMcpContext;
  /** Close storage + the connection (graceful shutdown path). */
  close(): Promise<void>;
}

/**
 * Build the context, then serve MCP over stdio until stdin reaches EOF or close() is called.
 * Storage is opened before the connection is served so boot failures are loud and early.
 */
export async function serveOnememoryStdio(options: ServeStdioOptions = {}): Promise<OnememoryStdioHandle> {
  const context = await createOnememoryMcpContext(options);
  const handle = serveStdio(() => buildOnememoryServer(context, options), {
    onerror: options.onError ?? ((error) => console.error('onememory-mcp: stdio error:', error)),
  });
  return {
    stdio: handle,
    context,
    close: async () => {
      await handle.close();
      await context.storage.close();
    },
  };
}
