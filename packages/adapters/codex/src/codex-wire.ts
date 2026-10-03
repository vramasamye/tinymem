/**
 * The verified Codex hook wire contract — Zod mirrors of the generated input schemas published in
 * the Codex repository (`codex-rs/hooks/schema/generated/*.command.input.schema.json`, read
 * 2026-10-03 from the `main` branch) and the Hooks documentation
 * (https://developers.openai.com/codex/hooks).
 *
 * These schemas are the adapter's ONLY authority for what Codex puts on a command hook's stdin.
 * `tool_input` / `tool_response` are free JSON values on the wire (`"type": true` in JSON
 * Schema); the translator interprets them per tool name and drops what it cannot map — nothing is
 * coerced from an unverified shape.
 *
 * Loose objects on purpose: Codex adds fields across versions, and every hook doc says the exact
 * input set may grow. Unknown fields pass through; the fields below are the ones the translation
 * relies on.
 */

import { z } from 'zod';

const nullableString = z.string().nullable();

/** Fields every command hook receives (the "Common input fields" table). */
const commonFields = {
  session_id: z.string(),
  transcript_path: nullableString,
  cwd: z.string(),
  hook_event_name: z.string(),
  model: z.string().optional(),
  /** Codex extension on turn-scoped events. */
  turn_id: z.string().optional(),
  permission_mode: z
    .enum(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'])
    .optional(),
};

export const SessionStartHookInputSchema = z
  .looseObject({
    ...commonFields,
    hook_event_name: z.literal('SessionStart'),
    source: z.enum(['startup', 'resume', 'clear', 'compact', 'fork']),
  })
  .check((ctx) => {
    if (ctx.value.model === undefined) {
      // `model` is required on this event per the generated schema; a missing value is a wire
      // mismatch worth dead-lettering rather than silently accepting.
      ctx.issues.push({ code: 'custom', input: ctx.value, message: 'model is required', path: ['model'] });
    }
  });
export type SessionStartHookInput = z.infer<typeof SessionStartHookInputSchema>;

export const SessionEndHookInputSchema = z.looseObject({
  ...commonFields,
  hook_event_name: z.literal('SessionEnd'),
  reason: z.literal('other'),
});
export type SessionEndHookInput = z.infer<typeof SessionEndHookInputSchema>;

export const UserPromptSubmitHookInputSchema = z
  .looseObject({
    ...commonFields,
    hook_event_name: z.literal('UserPromptSubmit'),
    prompt: z.string(),
  })
  .check((ctx) => {
    if (ctx.value.turn_id === undefined) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'turn_id is required',
        path: ['turn_id'],
      });
    }
  });
export type UserPromptSubmitHookInput = z.infer<typeof UserPromptSubmitHookInputSchema>;

export const PostToolUseHookInputSchema = z
  .looseObject({
    ...commonFields,
    hook_event_name: z.literal('PostToolUse'),
    tool_name: z.string(),
    tool_use_id: z.string(),
    tool_input: z.unknown(),
    tool_response: z.unknown(),
  })
  .check((ctx) => {
    if (ctx.value.turn_id === undefined) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'turn_id is required',
        path: ['turn_id'],
      });
    }
  });
export type PostToolUseHookInput = z.infer<typeof PostToolUseHookInputSchema>;

export const StopHookInputSchema = z.looseObject({
  ...commonFields,
  hook_event_name: z.literal('Stop'),
  stop_hook_active: z.boolean(),
  last_assistant_message: nullableString,
});
export type StopHookInput = z.infer<typeof StopHookInputSchema>;

export type CodexHookInput =
  | SessionStartHookInput
  | SessionEndHookInput
  | UserPromptSubmitHookInput
  | PostToolUseHookInput
  | StopHookInput;

/** The one output shape this adapter produces (SessionStart context injection). */
export interface SessionStartHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'SessionStart';
    additionalContext?: string;
  };
  systemMessage?: string;
}

/**
 * The Bash/unified-exec tool response is the model-facing text, which carries a header ending in
 * `Process exited with code <n>` when the command completed (verified:
 * `codex-rs/core/src/tools/context.rs` `ExecCommandToolOutput::response_header`). An ongoing PTY
 * session reports `Process running with session ID <pid>` and has no exit code yet.
 */
export const EXIT_CODE_LINE = /(?:^|\n)Process exited with code (-?\d+)(?:\n|$)/;
export const RUNNING_SESSION_LINE = /(?:^|\n)Process running with session ID (\d+)(?:\n|$)/;
