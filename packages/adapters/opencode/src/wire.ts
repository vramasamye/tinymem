/**
 * Zod mirrors of the OpenCode plugin surfaces this adapter consumes (all verified 2026-10-06,
 * mission 9, against the published packages and sources of sst/opencode — repo mirror
 * github.com/anomalyco/opencode, branch `dev`):
 *
 * - The plugin API (`@opencode-ai/plugin@1.18.34` `dist/index.d.ts`, unpkg):
 *   `Hooks["event"]?: (input: { event: Event }) => Promise<void>`,
 *   `Hooks["tool.execute.after"]?: (input: { tool, sessionID, callID, args: any }, output:
 *   { title, output: string, metadata: any }) => Promise<void>`,
 *   `Hooks["chat.message"]?: (input: { sessionID, agent?, model?, messageID?, variant? },
 *   output: { message: UserMessage, parts: Part[] }) => Promise<void>`,
 *   `Hooks["experimental.chat.system.transform"]?: (input: { sessionID?, model }, output:
 *   { system: string[] }) => Promise<void>`.
 * - The event vocabulary and payload shapes (`@opencode-ai/sdk@1.18.34`
 *   `dist/gen/types.gen.d.ts`, unpkg): `EventSessionCreated { info: Session }`,
 *   `EventSessionIdle { sessionID }`, `EventMessagePartUpdated { part: Part, delta? }` with
 *   `TextPart { …, synthetic?, ignored?, time?: { start, end? } }` and
 *   `ToolPart { tool, callID, state: ToolState }` (`ToolStateError { status: "error", error }`),
 *   `UserMessage { id, sessionID, role: "user", time: { created }, agent, model }`.
 * - The shell tool (`packages/opencode/src/tool/shell.ts` + `tool/shell/id.ts`): the exposed tool
 *   id is `"bash"` ("Keep the exposed tool ID and permission key as 'bash' for compatibility"),
 *   args `{ command, workdir?, timeout? }`, and the result carries
 *   `metadata: { output, exit: number | null, truncated, outputPath? }` — `exit` is `null` for
 *   abort/timeout, the process exit code otherwise.
 * - The edit tool (`tool/edit.ts`): id `"edit"`, args
 *   `{ filePath, oldString, newString, replaceAll? }`, result "Edit applied successfully." with
 *   `metadata.filediff: { file, patch, additions, deletions }`.
 * - The write tool (`tool/write.ts`): id `"write"`, args `{ filePath, content }`, result with
 *   `metadata.exists` (whether the file existed before the write — the create/overwrite signal).
 * - The config (`@opencode-ai/sdk` `Config`, https://opencode.ai/docs/config/): `opencode.json`
 *   with `mcp` entries `{ type: "remote", url, enabled?, headers?, oauth?, timeout? }` /
 *   `{ type: "local", command: string[], cwd?, environment?, enabled?, timeout? }` (`type` REQUIRED
 *   on both, unlike Cursor's). Local servers are spawned with
 *   `env: { ...process.env, ...entry.environment }` (verified: opencode `mcp/index.ts`
 *   `connectLocal`) — the parent environment is inherited and there is NO `${env:…}`
 *   interpolation for MCP environment values, so server-mode storage rides the inherited
 *   `ONEMEMORY_PG_URL` and the scaffold emits no placeholder. `instructions: string[]`
 *   (https://opencode.ai/docs/rules/ — "Additional instruction files or patterns to include").
 *
 * Loose objects throughout: OpenCode may add fields without breaking capture. A payload that does
 * not parse is a counted drop in the translator, never a crash — plugin handler errors are
 * reported by OpenCode but must not break the session.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// The event hook channel (`{ event }` wrapper → the SDK Event union subset we subscribe to)
// ---------------------------------------------------------------------------

/** `Session` (SDK `types.gen.d.ts`): the `info` of `session.created`. */
export const OpenCodeSessionSchema = z.looseObject({
  id: z.string().min(1),
  projectID: z.string(),
  directory: z.string(),
  parentID: z.string().optional(),
  title: z.string(),
  version: z.string(),
  time: z.looseObject({ created: z.number(), updated: z.number(), compacting: z.number().optional() }),
});
export type OpenCodeSession = z.infer<typeof OpenCodeSessionSchema>;

/** `session.created` — "Fired when a new session is created." */
export const SessionCreatedEventSchema = z.looseObject({
  type: z.literal('session.created'),
  properties: z.looseObject({ info: OpenCodeSessionSchema }),
});
export type SessionCreatedEvent = z.infer<typeof SessionCreatedEventSchema>;

/** `session.idle` — the runtime's session-quiescence signal (its docs use it for "session completed" notifications). */
export const SessionIdleEventSchema = z.looseObject({
  type: z.literal('session.idle'),
  properties: z.looseObject({ sessionID: z.string().min(1) }),
});
export type SessionIdleEvent = z.infer<typeof SessionIdleEventSchema>;

/** `TextPart` — the prose carrier; `time.end` is set when the part is complete (streaming done). */
export const TextPartSchema = z.looseObject({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  messageID: z.string().min(1),
  type: z.literal('text'),
  text: z.string(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
  time: z
    .looseObject({ start: z.number().optional(), end: z.number().optional() })
    .optional(),
});
export type TextPart = z.infer<typeof TextPartSchema>;

/** `ToolPart.state` — only the error arm is a capture signal; the rest are progress states. */
export const ToolStateSchema = z.looseObject({
  status: z.enum(['pending', 'running', 'completed', 'error']),
  error: z.string().optional(),
});
export type ToolPartState = z.infer<typeof ToolStateSchema>;

/** `ToolPart` — a tool execution's transcript part; `state.status === "error"` is the failure channel. */
export const ToolPartSchema = z.looseObject({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  messageID: z.string().min(1),
  type: z.literal('tool'),
  callID: z.string().optional(),
  tool: z.string().min(1),
  state: ToolStateSchema,
});
export type ToolPart = z.infer<typeof ToolPartSchema>;

/** `message.part.updated` — fired on every part mutation; `delta` carries streaming text. */
export const MessagePartUpdatedEventSchema = z.looseObject({
  type: z.literal('message.part.updated'),
  properties: z.looseObject({ part: z.unknown(), delta: z.string().optional() }),
});
export type MessagePartUpdatedEvent = z.infer<typeof MessagePartUpdatedEventSchema>;

/** The subscribed event union (anything else is a counted `unsubscribed_event:<type>` drop). */
export const OpenCodeEventSchema = z.discriminatedUnion('type', [
  SessionCreatedEventSchema,
  SessionIdleEventSchema,
  MessagePartUpdatedEventSchema,
]);
export type OpenCodeEvent = z.infer<typeof OpenCodeEventSchema>;

/** Any event's `type`, for value-free drop reasons on the events we do not subscribe to. */
export const EventTypeSchema = z.looseObject({ type: z.string().min(1) });
export type TypedEvent = z.infer<typeof EventTypeSchema>;

/** The `event` hook's input wrapper (plugin API: `event?: (input: { event: Event }) => …`). */
export const EventHookInputSchema = z.looseObject({ event: z.unknown() });
export type EventHookInput = z.infer<typeof EventHookInputSchema>;

// ---------------------------------------------------------------------------
// The `tool.execute.after` hook channel
// ---------------------------------------------------------------------------

/** `tool.execute.after` input (plugin API): the executed tool plus its args. */
export const ToolAfterInputSchema = z.looseObject({
  tool: z.string().min(1),
  sessionID: z.string().min(1),
  callID: z.string().min(1),
  args: z.unknown(),
});
export type ToolAfterInput = z.infer<typeof ToolAfterInputSchema>;

/** `tool.execute.after` output (plugin API): `{ title, output, metadata }`. */
export const ToolAfterOutputSchema = z.looseObject({
  title: z.string(),
  output: z.string(),
  metadata: z.unknown(),
});
export type ToolAfterOutput = z.infer<typeof ToolAfterOutputSchema>;

/** The bash tool's args (`shell.ts` `Parameters`: `{ command, workdir?, timeout? }`). */
export const BashToolArgsSchema = z.looseObject({ command: z.string().min(1) });
export type BashToolArgs = z.infer<typeof BashToolArgsSchema>;

/** The bash tool's result metadata: `exit` is the process exit code, `null` on abort/timeout. */
export const BashToolMetadataSchema = z.looseObject({
  output: z.string().optional(),
  exit: z.number().int().nullable().optional(),
  truncated: z.boolean().optional(),
  outputPath: z.string().optional(),
});
export type BashToolMetadata = z.infer<typeof BashToolMetadataSchema>;

/** The edit tool's args (`edit.ts` `Parameters`: exact string replacement). */
export const EditToolArgsSchema = z.looseObject({
  filePath: z.string().min(1),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});
export type EditToolArgs = z.infer<typeof EditToolArgsSchema>;

/** The write tool's args (`write.ts` `Parameters`: full file content). */
export const WriteToolArgsSchema = z.looseObject({
  filePath: z.string().min(1),
  content: z.string(),
});
export type WriteToolArgs = z.infer<typeof WriteToolArgsSchema>;

/** The write tool's result metadata: `exists` is the create/overwrite signal. */
export const WriteToolMetadataSchema = z.looseObject({
  exists: z.boolean().optional(),
  filepath: z.string().optional(),
});
export type WriteToolMetadata = z.infer<typeof WriteToolMetadataSchema>;

// ---------------------------------------------------------------------------
// The `chat.message` hook channel
// ---------------------------------------------------------------------------

/** `chat.message` input (plugin API): "Called when a new message is received." */
export const ChatMessageInputSchema = z.looseObject({
  sessionID: z.string().min(1),
  agent: z.string().optional(),
  messageID: z.string().optional(),
  variant: z.string().optional(),
});
export type ChatMessageInput = z.infer<typeof ChatMessageInputSchema>;

/** `UserMessage` (SDK `types.gen.d.ts`) — the role 'user' arm of the Message union. */
export const UserMessageSchema = z.looseObject({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  role: z.literal('user'),
  time: z.looseObject({ created: z.number() }),
  agent: z.string(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

/** `chat.message` output (plugin API): `{ message, parts }` — the user text lives in the parts. */
export const ChatMessageOutputSchema = z.looseObject({
  message: UserMessageSchema,
  parts: z.array(z.unknown()).optional(),
});
export type ChatMessageOutput = z.infer<typeof ChatMessageOutputSchema>;

// ---------------------------------------------------------------------------
// `opencode.json` (the config this adapter's scaffolds merge into)
// ---------------------------------------------------------------------------

/** A loopback `http:` URL — the only daemon endpoint Phase 1 scaffolds (no auth, no headers). */
export function isLoopbackHostname(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

export const LoopbackHttpUrlSchema = z
  .url({ protocol: /^http$/ })
  .refine((value) => isLoopbackHostname(new URL(value).hostname), {
    message: 'the daemon MCP URL must be a loopback address (Phase 1 has no authentication)',
  });

/** `McpRemoteConfig` (SDK `Config`): `type: "remote"` is REQUIRED — the stricter reading, emitted. */
export const OpenCodeMcpRemoteEntrySchema = z.strictObject({
  type: z.literal('remote'),
  url: LoopbackHttpUrlSchema,
  enabled: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  oauth: z.union([z.looseObject({}), z.literal(false)]).optional(),
  timeout: z.number().optional(),
});
export type OpenCodeMcpRemoteEntry = z.infer<typeof OpenCodeMcpRemoteEntrySchema>;

/** `McpLocalConfig` (SDK `Config`): `type: "local"`, `command` is a string array, `cwd` optional. */
export const OpenCodeMcpLocalEntrySchema = z.strictObject({
  type: z.literal('local'),
  command: z.array(z.string()),
  cwd: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().optional(),
});
export type OpenCodeMcpLocalEntry = z.infer<typeof OpenCodeMcpLocalEntrySchema>;

export const OpenCodeMcpEntrySchema = z.union([OpenCodeMcpRemoteEntrySchema, OpenCodeMcpLocalEntrySchema]);
export type OpenCodeMcpEntry = z.infer<typeof OpenCodeMcpEntrySchema>;

/** The name of the onememory server inside the config's `mcp` object. */
export const MCP_SERVER_NAME = 'onememory';

/** The strict shape of a document this adapter EMITS (user documents are read loosely). */
export const OpenCodeConfigDocumentSchema = z.looseObject({
  $schema: z.string().optional(),
  mcp: z.record(z.string(), OpenCodeMcpEntrySchema).optional(),
  instructions: z.array(z.string()).optional(),
  plugin: z.array(z.string()).optional(),
});
export type OpenCodeConfigDocument = z.infer<typeof OpenCodeConfigDocumentSchema>;
