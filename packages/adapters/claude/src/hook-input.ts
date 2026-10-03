/**
 * Claude Code hook input schemas — a tolerant Zod mirror of the SHAPES DOCUMENTED AT
 * https://code.claude.com/docs/en/hooks (verified 2026-10-03; see
 * docs/plan/mission-reports/mission-6.md §1 for the per-field citations).
 *
 * Every schema is a `looseObject`: Claude Code adds fields over time and the common input carries
 * version-dependent extras (`prompt_id`, `scratchpad_dir`, `effort`, `permission_mode`, …) that we
 * deliberately ignore. A payload that violates a field WE key on is rejected by `parseHookInput`
 * and becomes a *counted drop* in the translation — never a crash, never a coercion.
 *
 * Not inventing fields: only shapes that appear in the official hooks reference (or its per-tool
 * `tool_input` examples) are declared here. Undocumented extras are read defensively where used
 * (see `parseToolInputFor` callers) and never assumed.
 */

import { z } from 'zod';

/** The hook events onememory subscribes to (the settings.json scaffold installs exactly these). */
export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'SessionEnd',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
] as const;
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/**
 * SessionStart `source` (hooks reference: "SessionStart input" — the matcher table lists exactly
 * these values; before v2.1.214 forked sessions reported `resume`).
 */
export const SESSION_START_SOURCES = ['startup', 'resume', 'clear', 'compact', 'fork'] as const;
export type SessionStartSource = (typeof SESSION_START_SOURCES)[number];

/** SessionEnd `reason` (hooks reference: "SessionEnd" — reason table; `bypass_permissions_disabled` was removed in v2.1.234). */
export const SESSION_END_REASONS = ['clear', 'resume', 'logout', 'prompt_input_exit', 'other'] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/** File-edit tools we translate to `file.changed` (matcher `Edit|Write|NotebookEdit` in tools-reference). */
export const FILE_EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;
/** Command-execution tools we translate to `terminal.output` (matcher `Bash|PowerShell`). */
export const COMMAND_TOOLS = ['Bash', 'PowerShell'] as const;

const nonEmpty = z.string().min(1);

// ---------------------------------------------------------------------------
// Tool input/response shapes (tolerant — the hooks reference says the exact schema "depends on
// the tool"; every field below is one the reference documents or demonstrates).
// ---------------------------------------------------------------------------

/** Bash/PowerShell `tool_input` — `command` documented in the PreToolUse example. */
export const BashToolInputSchema = z.looseObject({
  command: nonEmpty,
  description: z.string().optional(),
  timeout: z.number().optional(),
  run_in_background: z.boolean().optional(),
});

/** Bash `tool_response` — `{stdout, stderr, interrupted, isImage}` per the PostToolUse output example. */
export const BashToolResponseSchema = z.looseObject({
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  interrupted: z.boolean().optional(),
  isImage: z.boolean().optional(),
});

/**
 * Edit `tool_input` — exact string replacement ("The Edit tool performs exact string replacement.
 * It takes an `old_string` and a `new_string`"), `file_path` always absolute for file tools.
 */
export const EditToolInputSchema = z.looseObject({
  file_path: nonEmpty,
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  replace_all: z.boolean().optional(),
});

/** Write `tool_input` — full-content create or overwrite; `file_path` always absolute. */
export const WriteToolInputSchema = z.looseObject({
  file_path: nonEmpty,
  content: z.string().optional(),
});

/** Write `tool_response` — `{filePath, type: "create"}` per the PostToolUse input example. */
export const WriteToolResponseSchema = z.looseObject({
  filePath: z.string().optional(),
  type: z.string().optional(),
});

/**
 * NotebookEdit `tool_input` — cell-level notebook editing. The path field is not named in the
 * hooks reference (NotebookEdit is not in the "file tools" list), so both well-known spellings
 * are accepted and neither is assumed.
 */
export const NotebookEditToolInputSchema = z
  .looseObject({
    notebook_path: z.string().optional(),
    file_path: z.string().optional(),
    cell_id: z.string().optional(),
    edit_mode: z.enum(['replace', 'insert', 'delete']).optional(),
    new_source: z.string().optional(),
    cell_type: z.string().optional(),
  })
  .check((ctx) => {
    if (ctx.value.notebook_path === undefined && ctx.value.file_path === undefined) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'NotebookEdit input carries neither notebook_path nor file_path',
        path: ['notebook_path'],
      });
    }
  });

// ---------------------------------------------------------------------------
// Per-event input schemas (common fields + event-specific ones, all tolerant)
// ---------------------------------------------------------------------------

const common = {
  session_id: nonEmpty.optional(),
  transcript_path: nonEmpty.optional(),
  cwd: nonEmpty.optional(),
  permission_mode: z.string().optional(),
} as const;

export const SessionStartInputSchema = z.looseObject({
  ...common,
  hook_event_name: z.literal('SessionStart'),
  /** Documented as always present ("SessionStart hooks receive `source` and optionally `model`"). */
  source: z.enum(SESSION_START_SOURCES),
  model: z.string().optional(),
  session_title: z.string().optional(),
});

export const SessionEndInputSchema = z.looseObject({
  ...common,
  hook_event_name: z.literal('SessionEnd'),
  /** Documented as always present ("SessionEnd hooks receive a `reason` field"). */
  reason: z.enum(SESSION_END_REASONS),
});

export const PostToolUseInputSchema = z.looseObject({
  ...common,
  hook_event_name: z.literal('PostToolUse'),
  tool_name: nonEmpty,
  tool_input: z.unknown(),
  tool_response: z.unknown(),
  tool_use_id: z.string().optional(),
  duration_ms: z.number().optional(),
});

export const PostToolUseFailureInputSchema = z.looseObject({
  ...common,
  hook_event_name: z.literal('PostToolUseFailure'),
  tool_name: nonEmpty,
  tool_input: z.unknown(),
  /** Documented: "String describing what went wrong... same text Claude receives". */
  error: nonEmpty,
  /** Documented: "True when the failure reached Claude Code as an abort rather than an error". */
  is_interrupt: z.boolean().optional(),
  duration_ms: z.number().optional(),
});

export const StopInputSchema = z.looseObject({
  ...common,
  hook_event_name: z.literal('Stop'),
  stop_hook_active: z.boolean().optional(),
  /** Documented: "contains the text content of Claude's final response". */
  last_assistant_message: z.string().optional(),
});

export const HookInputSchema = z.discriminatedUnion('hook_event_name', [
  SessionStartInputSchema,
  SessionEndInputSchema,
  PostToolUseInputSchema,
  PostToolUseFailureInputSchema,
  StopInputSchema,
]);
export type HookInput = z.infer<typeof HookInputSchema>;

export type ParseHookInputResult =
  | { ok: true; value: HookInput }
  | { ok: false; reason: string };

/** Parse a hook payload (already JSON-decoded). Unknown events and shape violations become stable reason codes. */
export function parseHookInput(input: unknown): ParseHookInputResult {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'invalid_input:not_an_object' };
  const eventName = (input as { hook_event_name?: unknown }).hook_event_name;
  if (typeof eventName !== 'string') return { ok: false, reason: 'invalid_input:missing_hook_event_name' };
  if (!(HOOK_EVENT_NAMES as readonly string[]).includes(eventName)) {
    return { ok: false, reason: `unhandled_hook_event:${eventName}` };
  }
  const parsed = HookInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `invalid_input:${issue?.path.map(String).join('.') ?? '(root)'}:${issue?.message ?? 'failed validation'}`,
    };
  }
  return { ok: true, value: parsed.data };
}
