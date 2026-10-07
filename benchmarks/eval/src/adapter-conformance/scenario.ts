/**
 * The canonical adapter-conformance scenario: ONE agent session expressed once, then rendered into
 * each runtime's NATIVE hook payloads.
 *
 * The point (backlog M5.4 / M8 acceptance 5): the same real-world session must produce the same
 * memory through every adapter. The scenario is deliberately run through the adapters' own
 * translation entry points — `translateHookInput` (Claude), `translateCodexHook` (Codex),
 * `translateHookInput` (Cursor), `translatePiEvent` (Pi), and the OpenCode translator's three
 * hook channels — so the assertion covers the actual wire contracts, not a shared normalization
 * helper.
 *
 * Facts are timestamped once; every runtime's payload for a fact is translated with that fact's
 * clock, exactly as separate hook processes would fire in real time. Claude delivers conversation
 * text from the transcript at `Stop` (its only conversation channel), so the scenario carries the
 * same utterances through Claude's transcript entries with their canonical timestamps. Pi stamps
 * its `message_end` payloads with the canonical fact time as the message timestamp (its
 * `occurred_at` source); OpenCode carries no per-payload time, so its clock is the fact time.
 *
 * Runtime-specific payload details that are NOT the same fact:
 * - Claude `PostToolUse` fires only on success; failures arrive as `PostToolUseFailure` with an
 *   `Exit code N` error string.
 * - Codex reports the exit code inside the Bash `tool_response` text ("Process exited with code N")
 *   and delivers the user prompt via `UserPromptSubmit`.
 * - Cursor reports a successful Shell exit code inside the JSON-stringified `tool_output`, has NO
 *   exit code for a failed command (documented gap), and delivers conversation turns via
 *   `beforeSubmitPrompt` / `afterAgentResponse`.
 * - Pi reports the exit code in the bash tool_result's `structuredContent.exit_code` and delivers
 *   conversation turns as `message_end` events.
 * - OpenCode splits the session across three hook channels: `session.created`/`message.part.updated`
 *   on the event hook, `tool.execute.after` for tools, and `chat.message` for user turns (the
 *   user's parts are claimed by that channel, so the part channel never double-captures them).
 */

import { translateCodexHook } from '@onememory-ai/adapter-codex';
import { translateHookInput as translateClaudeHook, type TranscriptTextEntry } from '@onememory-ai/adapter-claude';
import { translateHookInput as translateCursorHook } from '@onememory-ai/adapter-cursor';
import { translatePiEvent } from '@onememory-ai/adapter-pi';
import { createOpenCodeTranslator } from '@onememory-ai/adapter-opencode';
import type { OnememoryEvent } from '@onememory-ai/core';

export type RuntimeName = 'claude-code' | 'codex' | 'cursor' | 'pi' | 'opencode';
export const RUNTIMES: readonly RuntimeName[] = ['claude-code', 'codex', 'cursor', 'pi', 'opencode'];

/** The canonical fact ids, in session order. Evidence is normalized against these indices. */
export const FACT_IDS = [
  'session-start',
  'user-question',
  'assistant-1',
  'success-1',
  'file-edit',
  'failure',
  'remember',
  'assistant-2',
  'success-2',
  'session-end',
] as const;
export type FactId = (typeof FACT_IDS)[number];

export const SCENARIO_NOW = '2026-10-05T12:00:00.000Z';

/** The canonical fact times: T0 + 5s per fact (distinct instants, as real hooks fire). */
export function factTime(fact: FactId): string {
  const index = FACT_IDS.indexOf(fact);
  return new Date(Date.parse(SCENARIO_NOW) + index * 5_000).toISOString();
}

/** The session's content. Every runtime must see exactly these strings. */
export const SCENARIO = {
  sessionId: 'sess-conformance',
  userPrompt: 'How does authentication work in this service? I need to add a protected route.',
  assistantFirst:
    'The auth module is three files: login.ts exposes verifyCredentials, session.ts exposes ' +
    'createSession, and middleware.ts exposes requireAuth, which guards protected routes.',
  rememberPrompt: 'Remember that the auth module signs sessions with a JWT in an HttpOnly cookie.',
  rememberedClause: 'the auth module signs sessions with a JWT in an HttpOnly cookie',
  assistantFinal:
    'The protected route is wired: requireAuth validates the signed session cookie before the ' +
    'orders handler runs.',
  successCommand: 'bun test src/auth/',
  successOutput: '3 pass (0.41s)',
  /** The re-run's output — deliberately different (the daemon dedupes identical event content). */
  successOutputFinal: '3 pass (0.38s)',
  failureCommand: 'bun test src/auth/middleware.test.ts',
  failureError: "Error: Cannot find module './middleware'",
  editPath: 'src/auth/middleware.ts',
  editOld: "export const guard = 'old';\n",
  editNew: "export const guard = 'new';\nexport const extra = true;\n",
} as const;

export interface ScenarioContext {
  /** Absolute project root the session runs in (also the temp storage dir's parent). */
  root: string;
  /** Registered project id. */
  projectId: string;
}

interface NativePayload {
  fact: FactId;
  /**
   * The hook channel OpenCode fires this fact on (`event`, `tool.execute.after`, `chat.message`);
   * the single-process runtimes leave it unset and receive the payload as their one argument.
   */
  channel?: 'event' | 'tool' | 'chat';
  payload: unknown;
  /** OpenCode's two-argument hooks only: the hook's output object. */
  output?: unknown;
  /** Claude only: the transcript entries its `Stop` hook reads (with canonical timestamps). */
  transcriptEntries?: readonly TranscriptTextEntry[];
}

function claudeTranscript(): readonly TranscriptTextEntry[] {
  return [
    { kind: 'text', role: 'user', text: SCENARIO.userPrompt, timestamp: factTime('user-question') },
    { kind: 'text', role: 'assistant', text: SCENARIO.assistantFirst, timestamp: factTime('assistant-1') },
    { kind: 'text', role: 'user', text: SCENARIO.rememberPrompt, timestamp: factTime('remember') },
    { kind: 'text', role: 'assistant', text: SCENARIO.assistantFinal, timestamp: factTime('assistant-2') },
  ];
}

function claudePayloads(ctx: ScenarioContext): NativePayload[] {
  const session = SCENARIO.sessionId;
  const cwd = ctx.root;
  return [
    {
      fact: 'session-start',
      payload: { hook_event_name: 'SessionStart', source: 'startup', session_id: session, cwd },
    },
    {
      fact: 'success-1',
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: session,
        cwd,
        tool_name: 'Bash',
        tool_input: { command: SCENARIO.successCommand },
        tool_response: { stdout: SCENARIO.successOutput, stderr: '', interrupted: false },
      },
    },
    {
      fact: 'file-edit',
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: session,
        cwd,
        tool_name: 'Edit',
        tool_input: { file_path: `${ctx.root}/${SCENARIO.editPath}`, old_string: SCENARIO.editOld, new_string: SCENARIO.editNew },
        tool_response: {},
      },
    },
    {
      fact: 'failure',
      payload: {
        hook_event_name: 'PostToolUseFailure',
        session_id: session,
        cwd,
        tool_name: 'Bash',
        tool_input: { command: SCENARIO.failureCommand },
        error: `Exit code 1\n${SCENARIO.failureError}`,
        is_interrupt: false,
      },
    },
    {
      fact: 'success-2',
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: session,
        cwd,
        tool_name: 'Bash',
        tool_input: { command: SCENARIO.successCommand },
        tool_response: { stdout: SCENARIO.successOutputFinal, stderr: '', interrupted: false },
      },
    },
    // Claude's only conversation channel: Stop carries the transcript delta + the final text.
    {
      fact: 'assistant-2',
      payload: { hook_event_name: 'Stop', session_id: session, cwd, last_assistant_message: SCENARIO.assistantFinal },
      transcriptEntries: claudeTranscript(),
    },
    {
      fact: 'session-end',
      payload: { hook_event_name: 'SessionEnd', session_id: session, cwd, reason: 'other' },
    },
  ];
}

function codexPayloads(ctx: ScenarioContext): NativePayload[] {
  const session = SCENARIO.sessionId;
  const cwd = ctx.root;
  // Codex's generated command-hook schemas require these on every event (codex-wire.ts):
  // `transcript_path` (nullable), plus `model` on SessionStart and `turn_id` on the turn-scoped
  // events. `stop_hook_active` is required on Stop.
  const common = { session_id: session, cwd, transcript_path: null };
  const successResponse = `Process exited with code 0\n${SCENARIO.successOutput}`;
  const successResponseFinal = `Process exited with code 0\n${SCENARIO.successOutputFinal}`;
  const failureResponse = `Process exited with code 1\n${SCENARIO.failureError}`;
  const patch = [
    '*** Begin Patch',
    `*** Update File: ${SCENARIO.editPath}`,
    '@@',
    `-${SCENARIO.editOld.trimEnd()}`,
    `+${SCENARIO.editNew.trimEnd()}`,
    '*** End Patch',
  ].join('\n');
  return [
    {
      fact: 'session-start',
      payload: { ...common, hook_event_name: 'SessionStart', source: 'startup', model: 'gpt-5-codex' },
    },
    {
      fact: 'user-question',
      payload: { ...common, hook_event_name: 'UserPromptSubmit', prompt: SCENARIO.userPrompt, turn_id: 'turn-1' },
    },
    {
      fact: 'assistant-1',
      payload: { ...common, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: SCENARIO.assistantFirst },
    },
    {
      fact: 'success-1',
      payload: {
        ...common,
        hook_event_name: 'PostToolUse',
        turn_id: 'turn-1',
        tool_name: 'Bash',
        tool_use_id: 'call-success-1',
        tool_input: { command: SCENARIO.successCommand },
        tool_response: successResponse,
      },
    },
    {
      fact: 'file-edit',
      payload: {
        ...common,
        hook_event_name: 'PostToolUse',
        turn_id: 'turn-1',
        tool_name: 'apply_patch',
        tool_use_id: 'call-edit',
        tool_input: { command: patch },
        tool_response: 'Success. Updated the following files:\nM src/auth/middleware.ts',
      },
    },
    {
      fact: 'failure',
      payload: {
        ...common,
        hook_event_name: 'PostToolUse',
        turn_id: 'turn-2',
        tool_name: 'Bash',
        tool_use_id: 'call-failure',
        tool_input: { command: SCENARIO.failureCommand },
        tool_response: failureResponse,
      },
    },
    {
      fact: 'remember',
      payload: { ...common, hook_event_name: 'UserPromptSubmit', prompt: SCENARIO.rememberPrompt, turn_id: 'turn-2' },
    },
    {
      fact: 'assistant-2',
      payload: { ...common, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: SCENARIO.assistantFinal },
    },
    {
      fact: 'success-2',
      payload: {
        ...common,
        hook_event_name: 'PostToolUse',
        turn_id: 'turn-2',
        tool_name: 'Bash',
        tool_use_id: 'call-success-2',
        tool_input: { command: SCENARIO.successCommand },
        tool_response: successResponseFinal,
      },
    },
    { fact: 'session-end', payload: { ...common, hook_event_name: 'SessionEnd', reason: 'other' } },
  ];
}

function cursorPayloads(ctx: ScenarioContext): NativePayload[] {
  const session = SCENARIO.sessionId;
  const root = ctx.root;
  const successOutput = JSON.stringify({ exitCode: 0, stdout: SCENARIO.successOutput });
  const successOutputFinal = JSON.stringify({ exitCode: 0, stdout: SCENARIO.successOutputFinal });
  return [
    {
      fact: 'session-start',
      payload: { hook_event_name: 'sessionStart', session_id: session, workspace_roots: [root], is_background_agent: false, composer_mode: 'agent' },
    },
    {
      fact: 'user-question',
      payload: { hook_event_name: 'beforeSubmitPrompt', conversation_id: session, workspace_roots: [root], prompt: SCENARIO.userPrompt },
    },
    {
      fact: 'assistant-1',
      payload: { hook_event_name: 'afterAgentResponse', conversation_id: session, workspace_roots: [root], text: SCENARIO.assistantFirst },
    },
    {
      fact: 'success-1',
      payload: {
        hook_event_name: 'postToolUse',
        conversation_id: session,
        workspace_roots: [root],
        cwd: root,
        tool_name: 'Shell',
        tool_input: { command: SCENARIO.successCommand },
        tool_output: successOutput,
        tool_use_id: 'call-success-1',
      },
    },
    {
      fact: 'file-edit',
      payload: {
        hook_event_name: 'afterFileEdit',
        conversation_id: session,
        workspace_roots: [root],
        file_path: `${root}/${SCENARIO.editPath}`,
        edits: [{ old_string: SCENARIO.editOld, new_string: SCENARIO.editNew }],
      },
    },
    {
      fact: 'failure',
      payload: {
        hook_event_name: 'postToolUseFailure',
        conversation_id: session,
        workspace_roots: [root],
        cwd: root,
        tool_name: 'Shell',
        tool_input: { command: SCENARIO.failureCommand },
        error_message: SCENARIO.failureError,
        failure_type: 'error',
        is_interrupt: false,
      },
    },
    {
      fact: 'remember',
      payload: { hook_event_name: 'beforeSubmitPrompt', conversation_id: session, workspace_roots: [root], prompt: SCENARIO.rememberPrompt },
    },
    {
      fact: 'assistant-2',
      payload: { hook_event_name: 'afterAgentResponse', conversation_id: session, workspace_roots: [root], text: SCENARIO.assistantFinal },
    },
    {
      fact: 'success-2',
      payload: {
        hook_event_name: 'postToolUse',
        conversation_id: session,
        workspace_roots: [root],
        cwd: root,
        tool_name: 'Shell',
        tool_input: { command: SCENARIO.successCommand },
        tool_output: successOutputFinal,
        tool_use_id: 'call-success-2',
      },
    },
    {
      fact: 'session-end',
      payload: { hook_event_name: 'sessionEnd', session_id: session, workspace_roots: [root], reason: 'completed' },
    },
  ];
}

function piPayloads(ctx: ScenarioContext): NativePayload[] {
  const session = SCENARIO.sessionId;
  return [
    { fact: 'session-start', payload: { type: 'session_start', reason: 'startup' } },
    {
      fact: 'user-question',
      payload: {
        type: 'message_end',
        message: {
          role: 'user',
          content: [{ type: 'text', text: SCENARIO.userPrompt }],
          timestamp: factTime('user-question'),
        },
      },
    },
    {
      fact: 'assistant-1',
      payload: {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: SCENARIO.assistantFirst }],
          timestamp: factTime('assistant-1'),
        },
      },
    },
    {
      fact: 'success-1',
      payload: {
        type: 'tool_result',
        toolCallId: 'call-success-1',
        toolName: 'bash',
        input: { command: SCENARIO.successCommand },
        content: [{ type: 'text', text: SCENARIO.successOutput }],
        structuredContent: { output: SCENARIO.successOutput, truncated: false, exit_code: 0, wall_time_seconds: 0.41 },
        isError: false,
      },
    },
    {
      fact: 'file-edit',
      payload: {
        type: 'tool_result',
        toolCallId: 'call-edit',
        toolName: 'edit',
        input: { path: `${ctx.root}/${SCENARIO.editPath}`, edits: [{ oldText: SCENARIO.editOld, newText: SCENARIO.editNew }] },
        content: [{ type: 'text', text: 'Successfully replaced 1 block(s).' }],
        isError: false,
      },
    },
    {
      fact: 'failure',
      payload: {
        type: 'tool_result',
        toolCallId: 'call-failure',
        toolName: 'bash',
        input: { command: SCENARIO.failureCommand },
        content: [{ type: 'text', text: `${SCENARIO.failureError}\n\nCommand exited with code 1` }],
        structuredContent: { output: SCENARIO.failureError, truncated: false, exit_code: 1, wall_time_seconds: 0.2 },
        isError: true,
      },
    },
    {
      fact: 'remember',
      payload: {
        type: 'message_end',
        message: {
          role: 'user',
          content: [{ type: 'text', text: SCENARIO.rememberPrompt }],
          timestamp: factTime('remember'),
        },
      },
    },
    {
      fact: 'assistant-2',
      payload: {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: SCENARIO.assistantFinal }],
          timestamp: factTime('assistant-2'),
        },
      },
    },
    {
      fact: 'success-2',
      payload: {
        type: 'tool_result',
        toolCallId: 'call-success-2',
        toolName: 'bash',
        input: { command: SCENARIO.successCommand },
        content: [{ type: 'text', text: SCENARIO.successOutputFinal }],
        structuredContent: { output: SCENARIO.successOutputFinal, truncated: false, exit_code: 0, wall_time_seconds: 0.38 },
        isError: false,
      },
    },
    { fact: 'session-end', payload: { type: 'session_shutdown', reason: 'quit' } },
  ];
}

function opencodePayloads(ctx: ScenarioContext): NativePayload[] {
  const session = SCENARIO.sessionId;
  const agent = 'build';
  // OpenCode session/part ids are ULID-shaped; the canonical session id rides the SDK's
  // sessionID fields (the engine's scope.session_id, same as the other runtimes).
  const sessionPart = (id: string) => ({
    id,
    sessionID: session,
    messageID: `msg-${id}`,
    type: 'text' as const,
    text: '',
    time: { start: Date.parse(SCENARIO_NOW), end: Date.parse(SCENARIO_NOW) },
  });
  const userTurn = (fact: FactId, messageId: string, text: string): NativePayload => ({
    fact,
    channel: 'chat',
    payload: { sessionID: session, agent, messageID: messageId },
    output: {
      message: { id: messageId, sessionID: session, role: 'user', time: { created: Date.parse(SCENARIO_NOW) }, agent },
      parts: [{ ...sessionPart(`prt-${messageId}`), messageID: messageId, text }],
    },
  });
  const assistantPart = (fact: FactId, messageId: string, text: string): NativePayload => ({
    fact,
    channel: 'event',
    payload: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: `prt-${messageId}`,
          sessionID: session,
          messageID: messageId,
          type: 'text',
          text,
          time: { start: Date.parse(SCENARIO_NOW), end: Date.parse(SCENARIO_NOW) },
        },
      },
    },
  });  return [
    {
      fact: 'session-start',
      channel: 'event',
      payload: {
        type: 'session.created',
        properties: {
          info: {
            id: session,
            projectID: 'prj-conformance',
            directory: ctx.root,
            title: 'wire the protected route',
            version: 'opencode-conformance',
            time: { created: Date.parse(SCENARIO_NOW), updated: Date.parse(SCENARIO_NOW) },
          },
        },
      },
    },
    userTurn('user-question', 'msg-user-1', SCENARIO.userPrompt),
    assistantPart('assistant-1', 'msg-asst-1', SCENARIO.assistantFirst),
    {
      fact: 'success-1',
      channel: 'tool',
      payload: { tool: 'bash', sessionID: session, callID: 'call-success-1', args: { command: SCENARIO.successCommand } },
      output: {
        title: 'Bash',
        output: SCENARIO.successOutput,
        metadata: { output: SCENARIO.successOutput, exit: 0, truncated: false, duration: 410 },
      },
    },
    {
      fact: 'file-edit',
      channel: 'tool',
      payload: {
        tool: 'edit',
        sessionID: session,
        callID: 'call-edit',
        args: { filePath: `${ctx.root}/${SCENARIO.editPath}`, oldString: SCENARIO.editOld, newString: SCENARIO.editNew },
      },
      output: { title: 'Edit', output: 'Edit applied successfully.', metadata: {} },
    },
    {
      fact: 'failure',
      channel: 'tool',
      payload: { tool: 'bash', sessionID: session, callID: 'call-failure', args: { command: SCENARIO.failureCommand } },
      output: {
        title: 'Bash',
        output: SCENARIO.failureError,
        metadata: { output: SCENARIO.failureError, exit: 1, truncated: false, duration: 200 },
      },
    },
    userTurn('remember', 'msg-user-2', SCENARIO.rememberPrompt),
    assistantPart('assistant-2', 'msg-asst-2', SCENARIO.assistantFinal),
    {
      fact: 'success-2',
      channel: 'tool',
      payload: { tool: 'bash', sessionID: session, callID: 'call-success-2', args: { command: SCENARIO.successCommand } },
      output: {
        title: 'Bash',
        output: SCENARIO.successOutputFinal,
        metadata: { output: SCENARIO.successOutputFinal, exit: 0, truncated: false, duration: 380 },
      },
    },
    {
      fact: 'session-end',
      channel: 'event',
      payload: { type: 'session.idle', properties: { sessionID: session } },
    },
  ];
}

/** The native payloads one runtime would actually receive, in session order. */
export function nativePayloads(runtime: RuntimeName, ctx: ScenarioContext): NativePayload[] {
  if (runtime === 'claude-code') return claudePayloads(ctx);
  if (runtime === 'codex') return codexPayloads(ctx);
  if (runtime === 'cursor') return cursorPayloads(ctx);
  if (runtime === 'pi') return piPayloads(ctx);
  return opencodePayloads(ctx);
}

export interface TranslatedScenario {
  /** Events in the order the adapter emitted them, each tagged with the fact that produced it. */
  events: Array<{ fact: FactId; event: OnememoryEvent }>;
  drops: Array<{ reason: string; count: number }>;
}

/** Translate the canonical session through one runtime's own adapter. */
export function translateScenario(runtime: RuntimeName, ctx: ScenarioContext): TranslatedScenario {
  const tagged: TranslatedScenario['events'] = [];
  const drops: TranslatedScenario['drops'] = [];
  // Events are tagged by the CANONICAL FACT they describe. The adapter's own clock is the reliable
  // signal: every fact has one instant, and each runtime stamps its events with it (Claude emits
  // the transcript turns while handling `Stop`, but with the turn's own timestamp).
  const factByTime = new Map(FACT_IDS.map((fact) => [factTime(fact), fact as FactId]));
  // One translator per OpenCode run, exactly like the real plugin holds (the user-message claim
  // set is instance state — a fresh translator per payload would double-capture user turns).
  const opencode = createOpenCodeTranslator({ projectId: ctx.projectId, projectRoot: ctx.root });

  for (const entry of nativePayloads(runtime, ctx)) {
    const now = new Date(factTime(entry.fact));
    const result =
      runtime === 'claude-code'
        ? translateClaudeHook(entry.payload, {
            now,
            projectId: ctx.projectId,
            projectRoot: ctx.root,
            ...(entry.transcriptEntries === undefined ? {} : { transcriptEntries: entry.transcriptEntries }),
          })
        : runtime === 'codex'
          ? translateCodexHook(entry.payload, { now, projectId: ctx.projectId })
          : runtime === 'cursor'
            ? translateCursorHook(entry.payload, { now, projectId: ctx.projectId, projectRoot: ctx.root })
            : runtime === 'pi'
              ? translatePiEvent(entry.payload, {
                  now,
                  projectId: ctx.projectId,
                  cwd: ctx.root,
                  // Pi's wire payloads carry no session id; its real extension reads one from
                  // Pi's sessionManager and passes it in the context — the scenario renders that
                  // same production shape (the canonical session's id).
                  sessionId: SCENARIO.sessionId,
                })
              : entry.channel === 'tool'
                ? opencode.translateToolAfter(entry.payload, entry.output, { now })
                : entry.channel === 'chat'
                  ? opencode.translateChatMessage(entry.payload, entry.output, { now })
                  : // The event hook receives `{ event }` — the same wrapper the plugin passes.
                    opencode.translateEvent({ event: entry.payload }, { now });

    const dropped = 'drops' in result ? result.drops : result.dropped;
    for (const event of result.events) {
      tagged.push({ fact: factByTime.get(event.occurred_at) ?? entry.fact, event });
    }
    drops.push(...dropped.map((drop) => ({ reason: drop.reason, count: drop.count })));
  }

  // Deterministic order for the pipeline: the session timeline, then a stable tiebreak.
  tagged.sort((a, b) => {
    if (a.event.occurred_at !== b.event.occurred_at) return a.event.occurred_at < b.event.occurred_at ? -1 : 1;
    if (a.event.kind !== b.event.kind) return a.event.kind < b.event.kind ? -1 : 1;
    return 0;
  });
  return { events: tagged, drops };
}
