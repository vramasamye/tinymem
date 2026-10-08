/**
 * Zod mirrors of the Pi extension event payloads this adapter consumes at the `pi.on()` boundary.
 *
 * Every field here was read from Pi's own sources (verified 2026-10-06, mission 9):
 * - Event names, semantics, and payload shapes: the extension docs
 *   (https://pi.dev/docs/latest/extensions) and the canonical declarations in
 *   `packages/coding-agent/src/core/extensions/types.ts`
 *   (https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts):
 *   `SessionStartEvent { reason: "startup"|"reload"|"new"|"resume"|"fork" }`,
 *   `SessionShutdownEvent { reason: "quit"|"reload"|"new"|"resume"|"fork" }`,
 *   `BeforeAgentStartEvent { prompt, images? }`, `MessageEndEvent { message }`,
 *   `ToolResultEvent { toolCallId, parentToolCallId?, input, content, structuredContent?, isError }`.
 * - Tool input / structured-content shapes: the tool sources
 *   `src/core/tools/bash.ts` (`{command, timeout?}` in, `{output, truncated, full_output_path?,
 *   exit_code, wall_time_seconds}` out), `src/core/tools/edit.ts` (`{path, edits: [{oldText,
 *   newText}]}`), `src/core/tools/write.ts` (`{path, content}`, result "Successfully wrote to X",
 *   `details: undefined` — no create/overwrite signal).
 * - `AgentMessage` is pi-ai's `Message` union (`system|user|assistant|toolResult` roles, content
 *   arrays of text/image blocks) plus app custom messages; the schemas below are deliberately
 *   tolerant of both array and plain-string `content` because providers normalize differently.
 *
 * Loose objects throughout: Pi may add fields without breaking capture (the same tolerance the
 * engine's envelope validation applies). A payload that does not parse is a counted drop in the
 * translator, never a crash — an extension handler error is reported by Pi but must not break the
 * session.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Message content
// ---------------------------------------------------------------------------

export const PiTextContentSchema = z.looseObject({
  type: z.literal('text'),
  text: z.string(),
});
export type PiTextContent = z.infer<typeof PiTextContentSchema>;

/** `AgentMessage.content` as Pi delivers it: usually blocks, sometimes a plain string. */
export const PiMessageContentSchema = z.union([
  z.array(z.union([PiTextContentSchema, z.looseObject({ type: z.string() })])),
  z.string(),
]);
export type PiMessageContent = z.infer<typeof PiMessageContentSchema>;

/**
 * One entry of `message_end` / `before_agent_start`. Roles outside `user`/`assistant` (system,
 * toolResult, and app custom messages) parse fine — the translator drops them with a counted
 * reason so the schema stays an honest mirror of the wire instead of a whitelist.
 */
export const PiMessageSchema = z.looseObject({
  role: z.string().min(1),
  content: PiMessageContentSchema,
  timestamp: z.union([z.string(), z.number()]).optional(),
});
export type PiMessage = z.infer<typeof PiMessageSchema>;

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/** `session_start`: "Fired when a session is started, loaded, or reloaded." */
export const PiSessionStartEventSchema = z.looseObject({
  type: z.literal('session_start'),
  reason: z.enum(['startup', 'reload', 'new', 'resume', 'fork']),
  previousSessionFile: z.string().optional(),
});
export type PiSessionStartEvent = z.infer<typeof PiSessionStartEventSchema>;

/** `session_shutdown`: fired before the extension runtime tears down. */
export const PiSessionShutdownEventSchema = z.looseObject({
  type: z.literal('session_shutdown'),
  reason: z.enum(['quit', 'reload', 'new', 'resume', 'fork']),
  targetSessionFile: z.string().optional(),
});
export type PiSessionShutdownEvent = z.infer<typeof PiSessionShutdownEventSchema>;

/**
 * `before_agent_start`: the raw user prompt after expansion, before the agent loop, plus the
 * MUTABLE normalized `systemPromptOptions` — pi's sanctioned injection channel ("Mutable prompt
 * sections. Later handlers observe mutations made by earlier handlers"; the runner collects the
 * mutations into its combined result). Optional, because a pi without the surface must fail soft
 * in the extension. Verified live against the installed pi 1.0.4 (mission 23): the alternative —
 * `sendUserMessage` with `deliverAs: "steer"` — throws at this event ("Agent is already
 * processing a prompt"), because that call only queues while the agent is *streaming*.
 */
export const PiBeforeAgentStartEventSchema = z.looseObject({
  type: z.literal('before_agent_start'),
  prompt: z.string(),
  systemPromptOptions: z
    .looseObject({
      sections: z.record(z.string(), z.string()),
    })
    .optional(),
});
export type PiBeforeAgentStartEvent = z.infer<typeof PiBeforeAgentStartEventSchema>;

/** `message_end`: fired when a message (user, assistant, toolResult, custom) is finalized. */
export const PiMessageEndEventSchema = z.looseObject({
  type: z.literal('message_end'),
  message: PiMessageSchema,
});
export type PiMessageEndEvent = z.infer<typeof PiMessageEndEventSchema>;

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

/** `bash` / `powershell` tool input (`bash.ts` / `powershell.ts` schemas). */
export const PiBashToolInputSchema = z.looseObject({
  command: z.string().min(1),
  timeout: z.number().optional(),
});
export type PiBashToolInput = z.infer<typeof PiBashToolInputSchema>;

/** `bash` / `powershell` `structuredContent` (BashToolOutput — the exit code lives here). */
export const PiBashToolOutputSchema = z.looseObject({
  output: z.string().optional(),
  truncated: z.boolean().optional(),
  full_output_path: z.string().optional(),
  exit_code: z.number().int().optional(),
  wall_time_seconds: z.number().optional(),
});
export type PiBashToolOutput = z.infer<typeof PiBashToolOutputSchema>;

/** `edit` tool input (`edit.ts`): one or more exact replacements against the original file. */
export const PiEditToolInputSchema = z.looseObject({
  path: z.string().min(1),
  edits: z
    .array(z.looseObject({ oldText: z.string(), newText: z.string() }))
    .min(1),
});
export type PiEditToolInput = z.infer<typeof PiEditToolInputSchema>;

/** `write` tool input (`write.ts`): full file content. */
export const PiWriteToolInputSchema = z.looseObject({
  path: z.string().min(1),
  content: z.string(),
});
export type PiWriteToolInput = z.infer<typeof PiWriteToolInputSchema>;

/**
 * `tool_result` for any tool. `input` is validated per tool inside the translator; a shape that
 * does not fit the named tool is a counted drop there (the OTHER mappings that do not depend on
 * it still proceed — same policy as the Claude adapter's PostToolUse translation).
 */
export const PiToolResultEventSchema = z.looseObject({
  type: z.literal('tool_result'),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  /** Present when another tool (a codemode script) issued this call. */
  parentToolCallId: z.string().optional(),
  input: z.record(z.string(), z.unknown()),
  content: z.array(z.union([PiTextContentSchema, z.looseObject({ type: z.string() })])),
  structuredContent: z.unknown().optional(),
  isError: z.boolean(),
  details: z.unknown().optional(),
});
export type PiToolResultEvent = z.infer<typeof PiToolResultEventSchema>;

// ---------------------------------------------------------------------------
// The union this adapter subscribes to
// ---------------------------------------------------------------------------

export const PiCaptureEventSchema = z.discriminatedUnion('type', [
  PiSessionStartEventSchema,
  PiSessionShutdownEventSchema,
  PiBeforeAgentStartEventSchema,
  PiMessageEndEventSchema,
  PiToolResultEventSchema,
]);
export type PiCaptureEvent = z.infer<typeof PiCaptureEventSchema>;

/** The event names the generated extension registers handlers for. */
export const PI_CAPTURE_EVENT_NAMES = [
  'session_start',
  'session_shutdown',
  'before_agent_start',
  'message_end',
  'tool_result',
] as const;
export type PiCaptureEventName = (typeof PI_CAPTURE_EVENT_NAMES)[number];
