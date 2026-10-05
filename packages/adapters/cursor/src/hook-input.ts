/**
 * Cursor hook input schemas — a tolerant Zod mirror of the SHAPES DOCUMENTED AT
 * https://cursor.com/docs/hooks (fetched 2026-10-05; the "Hook events" reference section).
 *
 * Every schema is a `looseObject`: Cursor adds fields over time, and every agent hook carries the
 * common block (`conversation_id`, `generation_id`, `model`, `model_id`, `model_params`,
 * `cursor_version`, `workspace_roots`, `user_email`, `transcript_path`) that onememory reads only
 * where it is documented and needed. A payload that violates a field WE key on is rejected by
 * `parseHookInput` and becomes a *counted drop* in the translation — never a crash, never a
 * coercion.
 *
 * Subscribed events (the `.cursor/hooks.json` scaffold installs exactly these):
 *   sessionStart, sessionEnd, beforeSubmitPrompt, afterAgentResponse,
 *   postToolUse, postToolUseFailure, afterFileEdit, stop
 *
 * Deliberately NOT subscribed, with the reason (see the README "Hook coverage" table):
 * - `preToolUse` / `beforeShellExecution` / `beforeMCPExecution` / `beforeReadFile`: permission
 *   hooks. onememory has no permission opinion; subscribing would spend a process spawn per tool
 *   call and return an `allow` the user did not ask for.
 * - `afterShellExecution`: `postToolUse` already carries the command + exit code for Shell; the
 *   two would double-report the same execution.
 * - `afterMCPExecution` / `beforeMCPExecution`: MCP tool traffic is not captured by the Claude
 *   adapter's hook path either (conformance parity); see the README gap table.
 * - Tab hooks (`beforeTabFileRead`, `afterTabFileEdit`) and `workspaceOpen`: outside the agent
 *   session, and no memory event corresponds to them.
 */

import { z } from 'zod';

/** The Cursor hook events onememory subscribes to (the hooks.json scaffold installs exactly these). */
export const HOOK_EVENT_NAMES = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'afterAgentResponse',
  'postToolUse',
  'postToolUseFailure',
  'afterFileEdit',
  'stop',
] as const;
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/**
 * `sessionEnd` `reason` (hooks reference: "sessionEnd" — "How the session ended: 'completed',
 * 'aborted', 'error', 'window_close', or 'user_close'"). Kept as a plain string: Cursor documents
 * the set but has added values before, and a new reason must not become a counted drop.
 */
export const SESSION_END_REASONS = ['completed', 'aborted', 'error', 'window_close', 'user_close'] as const;

/** `stop` `status` (hooks reference: "stop" — `"completed" | "aborted" | "error"`). */
export const STOP_STATUSES = ['completed', 'aborted', 'error'] as const;

/** `postToolUseFailure` `failure_type` (hooks reference: "postToolUseFailure"). */
export const FAILURE_TYPES = ['error', 'timeout', 'permission_denied'] as const;

/** `postToolUse` / `postToolUseFailure` tool names we translate (hooks reference: "Shell"). */
export const SHELL_TOOL_NAMES = ['Shell'] as const;

/**
 * Tool names Cursor routes through `afterFileEdit` instead of `postToolUse`. Cursor fires
 * `afterFileEdit` for every agent file edit; mapping the same edit again from `postToolUse` would
 * emit a duplicate `file.changed`, so the post-tool path drops these with a counted reason.
 */
export const FILE_EDIT_TOOL_NAMES = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

const nonEmpty = z.string().min(1);

/** `attachments` entry shared by `beforeSubmitPrompt` and `beforeReadFile`. */
export const AttachmentSchema = z.looseObject({
  type: z.enum(['file', 'rule']),
  file_path: z.string(),
});

/** The documented common block every agent hook carries (only the fields onememory reads). */
const common = {
  conversation_id: z.string().optional(),
  generation_id: z.string().optional(),
  hook_event_name: z.string(),
  cursor_version: z.string().optional(),
  workspace_roots: z.array(z.string()).optional(),
  user_email: z.string().nullable().optional(),
  transcript_path: z.string().nullable().optional(),
} as const;

export const SessionStartInputSchema = z.looseObject({
  ...common,
  hook_event_name: z.literal('sessionStart'),
  /** Documented: "Unique identifier for this session (same as conversation_id)". */
  session_id: nonEmpty.optional(),
  is_background_agent: z.boolean().optional(),
  composer_mode: z.string().optional(),
});

export const SessionEndInputSchema = z.looseObject({
  ...common,
  hook_event_name: z.literal('sessionEnd'),
  session_id: nonEmpty.optional(),
  reason: z.string().optional(),
  duration_ms: z.number().optional(),
  is_background_agent: z.boolean().optional(),
  final_status: z.string().optional(),
  error_message: z.string().optional(),
});

export const BeforeSubmitPromptInputSchema = z.looseObject({
  ...common,
  hook_event_name: z.literal('beforeSubmitPrompt'),
  /** Documented: "prompt" — the user prompt text about to be submitted. */
  prompt: z.string(),
  attachments: z.array(AttachmentSchema).optional(),
});

export const AfterAgentResponseInputSchema = z.looseObject({
  ...common,
  hook_event_name: z.literal('afterAgentResponse'),
  /** Documented: "<assistant final text>". */
  text: z.string(),
});

/** `postToolUse` tool_input for the Shell tool (hooks reference example: `{"command": …}`). */
export const ShellToolInputSchema = z.looseObject({
  command: nonEmpty,
  working_directory: z.string().optional(),
});

/**
 * `postToolUse` tool_output is documented as "JSON-stringified result payload from the tool (not
 * raw terminal text)". The reference example for Shell shows `{"exitCode":0,"stdout":"…"}`, so
 * the Shell result is read from that JSON — never from raw text, which would misattribute output.
 */
export const ShellToolOutputSchema = z.looseObject({
  exitCode: z.number().optional(),
  exit_code: z.number().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});

export const PostToolUseInputSchema = z.looseObject({
  ...common,
  hook_event_name: z.literal('postToolUse'),
  tool_name: nonEmpty,
  tool_input: z.unknown(),
  /** JSON-stringified tool result (documented). */
  tool_output: z.string().optional(),
  tool_use_id: z.string().optional(),
  cwd: z.string().optional(),
  duration: z.number().optional(),
});

export const PostToolUseFailureInputSchema = z.looseObject({
  ...common,
  hook_event_name: z.literal('postToolUseFailure'),
  tool_name: nonEmpty,
  tool_input: z.unknown(),
  tool_use_id: z.string().optional(),
  cwd: z.string().optional(),
  /** Documented: "Description of the failure". */
  error_message: nonEmpty,
  failure_type: z.enum(FAILURE_TYPES).optional(),
  duration: z.number().optional(),
  /** Documented: "Whether this failure was caused by a user interrupt/cancellation". */
  is_interrupt: z.boolean().optional(),
});

/** One `afterFileEdit` edit: the replaced text and its replacement (hooks reference example). */
export const FileEditSchema = z.looseObject({
  old_string: z.string().optional(),
  new_string: z.string().optional(),
});

export const AfterFileEditInputSchema = z.looseObject({
  ...common,
  hook_event_name: z.literal('afterFileEdit'),
  /** Documented: "<absolute path>". */
  file_path: nonEmpty,
  edits: z.array(FileEditSchema).optional(),
});

export const StopInputSchema = z.looseObject({
  ...common,
  hook_event_name: z.literal('stop'),
  status: z.string().optional(),
  loop_count: z.number().optional(),
});

export const HookInputSchema = z.discriminatedUnion('hook_event_name', [
  SessionStartInputSchema,
  SessionEndInputSchema,
  BeforeSubmitPromptInputSchema,
  AfterAgentResponseInputSchema,
  PostToolUseInputSchema,
  PostToolUseFailureInputSchema,
  AfterFileEditInputSchema,
  StopInputSchema,
]);
export type HookInput = z.infer<typeof HookInputSchema>;

export type ParseHookInputResult = { ok: true; value: HookInput } | { ok: false; reason: string };

/** Parse a Cursor hook payload (already JSON-decoded). Unknown events and shape violations become stable reason codes. */
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
