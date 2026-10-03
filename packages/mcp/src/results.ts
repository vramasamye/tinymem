/**
 * CallToolResult builders (ADR-0010 §3): every tool returns `structuredContent` (typed JSON,
 * validated against its outputSchema by the SDK) PLUS human-readable `content` for weaker
 * clients; every error is an `isError: true` result with a typed `structuredContent.error` —
 * a ToolError never escapes the handler boundary (§4).
 */

import type { CallToolResult, TextContent } from '@modelcontextprotocol/server';

import { asToolError, ToolError, type ToolErrorCode } from './errors';
import { TOOL_SCHEMAS, type ToolName } from './schemas';
import type { OnememoryMcpContext } from './context';
import type {
  MemoryDecisionsOutput,
  MemoryDeleteOutput,
  MemoryFailuresOutput,
  MemoryForgetOutput,
  MemoryGetOutput,
  MemoryProjectContextOutput,
  MemoryRelatedOutput,
  MemorySearchOutput,
  MemorySkillsOutput,
  MemoryStoreOutput,
  MemoryUpdateOutput,
} from './schemas';

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

function textBlock(text: string): TextContent[] {
  return [{ type: 'text', text }];
}

/**
 * Success result: structuredContent validated against the tool's own outputSchema (the SDK
 * re-validates — this early check keeps contract bugs out of server.test.ts's way and turns
 * them into loud internal errors instead of shipping invalid JSON).
 */
export function okResult(tool: ToolName, payload: unknown): CallToolResult {
  const check = TOOL_SCHEMAS[tool].output.safeParse(payload);
  if (!check.success) {
    // A payload that fails its own outputSchema is a bug in this package, never a wire event.
    throw new ToolError(
      'internal',
      `${tool} produced a payload that violates its own outputSchema: ${check.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return {
    content: textBlock(renderText(tool, payload)),
    structuredContent: payload as Record<string, unknown>,
  };
}

/** Error result: `isError: true`, typed error envelope, actionable message as text. */
export function errorResult(error: ToolError): CallToolResult {
  const structured = {
    error: {
      code: error.code,
      message: error.message,
      ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
    },
  };
  return {
    content: textBlock(`${error.code}: ${error.message}`),
    structuredContent: structured,
    isError: true,
  };
}

/**
 * Wrap a tool handler into an MCP callback: handler-level validation, payload wrapping, and the
 * isError guarantee (no exception ever escapes — unknown failures become `internal` results).
 *
 * Defense in depth: the SDK already validated the raw arguments against the tool's inputSchema
 * before dispatch; this parse re-asserts the same contract at the handler boundary.
 */
export function makeToolCallback<Args>(
  ctx: OnememoryMcpContext,
  handler: (ctx: OnememoryMcpContext, args: Args) => Promise<unknown>,
  tool: ToolName,
): (args: unknown) => Promise<CallToolResult> {
  return async (rawArgs: unknown): Promise<CallToolResult> => {
    try {
      const parsed = TOOL_SCHEMAS[tool].input.parse(rawArgs ?? {}) as Args;
      const payload = await handler(ctx, parsed);
      return okResult(tool, payload);
    } catch (error) {
      return errorResult(asToolError(error));
    }
  };
}

// ---------------------------------------------------------------------------
// Human-readable renderings (compact: this text is model context too)
// ---------------------------------------------------------------------------

export type { ToolErrorCode };

function shortId(id: string): string {
  return id.slice(0, 8);
}

function line(entry: {
  id: string;
  type: string;
  title?: string;
  summary: string;
  relevance?: number;
  token_estimate: number;
}): string {
  const label = entry.title && entry.title.trim() !== '' ? entry.title : entry.summary;
  return `[${shortId(entry.id)}] ${entry.type} · ${label} · ${entry.relevance !== undefined ? `rel ${entry.relevance.toFixed(2)} · ` : ''}~${entry.token_estimate} tok`;
}

function renderSearch(output: MemorySearchOutput): string {
  const parts: string[] = [];
  parts.push(
    `memory_search: ${output.results.length} result(s), ${output.tokens.used}/${output.tokens.budget} tokens (packing: ${output.tokens.packing})`,
  );
  for (const entry of output.results) parts.push(line(entry));
  if (output.warnings.length > 0) parts.push(`warnings: ${output.warnings.join('; ')}`);
  return parts.join('\n');
}

function renderGet(output: MemoryGetOutput): string {
  const memory = output.memory;
  const parts: string[] = [];
  parts.push(`memory ${memory.id} (${memory.type}${memory.subtype ? `/${memory.subtype}` : ''}, status: ${memory.status})`);
  if (memory.title !== undefined) parts.push(`title: ${memory.title}`);
  parts.push(`content: ${memory.content}`);
  parts.push(
    `window: valid ${memory.valid_from} → ${memory.valid_until ?? 'open'} · observed ${memory.observed_at} · importance ${memory.importance} · confidence ${memory.confidence}`,
  );
  parts.push(
    `provenance: source ${memory.provenance.source.kind}${memory.provenance.source.uri ? ` (${memory.provenance.source.uri})` : ''} · ${memory.provenance.evidence.length} evidence span(s) · extracted by ${memory.provenance.extraction.method}`,
  );
  if (memory.entities.length > 0) {
    parts.push(`entities: ${memory.entities.map((entity) => entity.name).join(', ')}`);
  }
  if (memory.tags.length > 0) parts.push(`tags: ${memory.tags.join(', ')}`);
  if (output.history !== undefined && output.history.length > 1) {
    parts.push('history (oldest first):');
    for (const revision of output.history) {
      parts.push(`  [${shortId(revision.id)}] ${revision.status} · ${revision.content}`);
    }
  }
  if (output.audit !== undefined) {
    parts.push('audit:');
    for (const entry of output.audit) {
      parts.push(`  ${entry.at} ${entry.action} by ${entry.actor}`);
    }
  }
  parts.push(`(token estimate: ${output.token_estimate})`);
  return parts.join('\n');
}

function renderStore(output: MemoryStoreOutput): string {
  const outcome =
    output.outcome === 'new'
      ? `stored new memory ${output.id}`
      : output.outcome === 'merged'
        ? `merged into existing memory ${output.existing_id} (identical content was already stored — nothing new written)`
        : `stored new memory ${output.id}, superseding ${output.superseded_id} (old revision kept as history)`;
  const parts = [outcome];
  if (output.redactions.length > 0) {
    parts.push(
      `redactions: ${output.redactions.length} secret(s) removed before persisting (${[...new Set(output.redactions.map((redaction) => redaction.kind))].join(', ')})`,
    );
  }
  if (output.warnings.length > 0) parts.push(`warnings: ${output.warnings.join('; ')}`);
  return parts.join('\n');
}

function renderUpdate(output: MemoryUpdateOutput): string {
  const parts = [`updated memory: new revision ${output.id} supersedes ${output.previous_id}`];
  parts.push(`next expected_revision: ${output.revision}`);
  if (output.redactions.length > 0) {
    parts.push(`redactions: ${output.redactions.length} secret(s) removed before persisting`);
  }
  if (output.warnings.length > 0) parts.push(`warnings: ${output.warnings.join('; ')}`);
  return parts.join('\n');
}

function renderForget(output: MemoryForgetOutput): string {
  return output.action === 'archived'
    ? `forgot memory ${output.id} (soft: status archived, audited, recoverable — call memory_forget again with recover: true to restore)`
    : `restored memory ${output.id} (status active again — the tombstone was undone, audited)`;
}

function renderRelated(output: MemoryRelatedOutput): string {
  if (output.related.length === 0) return `no related memories for ${output.id}`;
  const parts = [`${output.related.length} related memor(ies) for ${output.id}:`];
  for (const entry of output.related) {
    const label =
      entry.memory.title && entry.memory.title.trim() !== ''
        ? entry.memory.title
        : (entry.memory.content_summary ?? entry.memory.content);
    parts.push(`[${shortId(entry.memory.id)}] ${entry.direction} ${entry.relation} · ${label} (${entry.memory.status})`);
  }
  parts.push(`(token estimate: ${output.token_estimate})`);
  return parts.join('\n');
}

function renderProjectContext(output: MemoryProjectContextOutput): string {
  const parts = [`project context (${output.used}/${output.budget} tokens):`];
  if (output.warnings.length > 0) parts.push(`warnings: ${output.warnings.join('; ')}`);
  parts.push('');
  parts.push(output.text);
  return parts.join('\n');
}

function renderList(
  header: string,
  output: MemoryDecisionsOutput | MemoryFailuresOutput | MemorySkillsOutput,
): string {
  if (output.results.length === 0) return `${header}: none`;
  const parts = [`${header}: ${output.results.length} entr(ies)`];
  for (const entry of output.results) parts.push(line(entry));
  if (output.warnings.length > 0) parts.push(`warnings: ${output.warnings.join('; ')}`);
  return parts.join('\n');
}

function renderText(tool: ToolName, payload: unknown): string {
  switch (tool) {
    case 'memory_search':
      return renderSearch(payload as MemorySearchOutput);
    case 'memory_get':
      return renderGet(payload as MemoryGetOutput);
    case 'memory_store':
      return renderStore(payload as MemoryStoreOutput);
    case 'memory_update':
      return renderUpdate(payload as MemoryUpdateOutput);
    case 'memory_forget':
      return renderForget(payload as MemoryForgetOutput);
    case 'memory_related':
      return renderRelated(payload as MemoryRelatedOutput);
    case 'memory_project_context':
      return renderProjectContext(payload as MemoryProjectContextOutput);
    case 'memory_decisions':
      return renderList('accepted decisions', payload as MemoryDecisionsOutput);
    case 'memory_failures':
      return renderList('known failures', payload as MemoryFailuresOutput);
    case 'memory_skills':
      return renderList('skills', payload as MemorySkillsOutput);
    case 'memory_delete': {
      const purged = payload as MemoryDeleteOutput;
      return `purged memory ${purged.id} (hard delete — unrecoverable; audit row '${purged.audit.action}' recorded at ${purged.audit.at})`;
    }
  }
}
