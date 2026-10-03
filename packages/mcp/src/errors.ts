/**
 * The tool error taxonomy (ADR-0010 §4: "Errors are `isError: true` results, never exceptions").
 *
 * Protocol-level errors (JSON-RPC) stay the SDK's business — input-schema violations are caught
 * by the SDK before a handler runs. Everything a handler discovers AFTER validation becomes a
 * `ToolError`, which the registerTool wrapper converts into an `isError: true` CallToolResult
 * with a typed `structuredContent.error = { code, message, … }`. A ToolError must never escape
 * the handler boundary.
 */

export type ToolErrorCode =
  | 'invalid_input' // handler-level Zod re-validation failed (defense in depth)
  | 'not_found' // unknown memory/project/session id
  | 'revision_conflict' // optimistic-concurrency check failed (retryable with the new revision)
  | 'provenance_required' // durable write without source + evidence (memory-model.md §6)
  | 'project_required' // the operation needs a project id and none is resolvable
  | 'no_change' // update supplied nothing to change
  | 'metadata_only_update_unsupported' // content-identical edit: no storage primitive yet
  | 'invalid_window' // valid_from/valid_until would be empty or backwards
  | 'invalid_transition' // the status machine rejects the transition (core InvalidTransitionError)
  | 'purge_unavailable' // hard purge awaits the storage primitive (coordinator follow-up)
  | 'internal'; // unexpected failure — message included, never a stack trace

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  /** Machine-readable retry context (e.g. { current_revision } for revision_conflict). */
  readonly details: Record<string, unknown>;

  constructor(code: ToolErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

/** Map any thrown value onto a ToolError (unknown failures become `internal`). */
export function asToolError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof Error) {
    // Storage's status-machine guard — surface the transition vocabulary, not a raw stack.
    if (error.name === 'InvalidTransitionError') {
      return new ToolError('invalid_transition', error.message);
    }
    // Handler-level boundary validation (defense in depth — the SDK validates first).
    if (error.name === 'ZodError' && 'issues' in error) {
      const issues = (error as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
      return new ToolError(
        'invalid_input',
        `invalid arguments: ${issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`).join('; ')}`,
      );
    }
    return new ToolError('internal', error.message);
  }
  return new ToolError('internal', String(error));
}
