# @onememory/adapter-opencode

The [OpenCode](https://opencode.ai) adapter for **onememory** — the self-hostable, local-first
persistent memory engine for AI coding agents.

One install gives OpenCode three things:

1. **Live capture** — a generated OpenCode [plugin](https://opencode.ai/docs/plugins/)
   (`.opencode/plugins/` auto-loads at startup, in-process) subscribes to the `event`,
   `tool.execute.after`, and `chat.message` hooks and translates every session into validated
   `OnememoryEvent` envelopes, delivered to the onememory daemon (`onemem serve`) over its public
   REST API. Commands, file edits, errors and how they were resolved, prompts that say "remember
   that …", assistant turns — all of it becomes evidence the engine can extract durable memories
   from.
2. **Context injection** — through the `experimental.chat.system.transform` hook, the plugin
   fetches the packed project context from the daemon once per session and appends it to the
   system prompt (sentinel-prefixed), so a fresh OpenCode session already knows the project's
   decisions, conventions, past failures, and solutions. The block is engine OUTPUT pushed into
   the SYSTEM prompt — it never becomes a message part, so the memory index is never re-ingested
   as user prose.
3. **MCP tools** — an `onememory` entry in `opencode.json` points OpenCode at the daemon's
   Streamable HTTP surface (`url = "http://127.0.0.1:<daemon.port>/mcp"`, ADR-0010 amendment
   2026-10-04) and exposes `memory_search` / `memory_get` / `memory_store` for explicit recall
   and writes during the session.

`.opencode/onememory.md` gets a compact, generated pointer block (registered in the config's
`instructions` array, OpenCode's [rules](https://opencode.ai/docs/rules/) surface) telling the
agent to *use those tools* — never a hand-maintained knowledge base.

---

## Setup

```sh
onemem init --with-opencode   # scaffolds opencode.json, .opencode/plugins/onememory.ts, .opencode/onememory.md
onemem serve                  # the daemon: MCP at /mcp + the REST API capture delivers to (keep it running)
```

`onemem init` calls this package's `scaffoldOpenCode({ transport: 'http', url })` with the URL
derived from `daemon.host`/`daemon.port`, and prints every returned warning as a required review
step. `onemem doctor` reports whether the three artifacts exist and whether the `url` matches the
configured daemon. The stdio form (`transport: 'stdio'`) is available for daemon-less or
server-profile setups — note that OpenCode spawns local MCP servers with the parent environment
merged under the entry's `environment` (no `${env:…}` interpolation), so the HTTP form is the
default and the stdio form only sets non-secret onememory variables.

The generated plugin shim is three lines — it imports `createOpenCodePlugin` from this package
(the project's `node_modules`) and exports the plugin function OpenCode loads. No build step, no
separate hook process:

```ts
import { createOpenCodePlugin } from '@onememory/adapter-opencode';

export const onememory = createOpenCodePlugin();
```

| Artifact | What lands there | Idempotency |
| --- | --- | --- |
| `opencode.json` | `mcp.onememory` entry (`type: "remote"`, loopback `url`, `enabled: true`) + the `instructions` registration | re-running replaces only our entry and appends only our instruction; other servers, keys, and instructions stay byte-identical |
| `.opencode/plugins/onememory.ts` | the capture + injection shim (generated marker in the header) | replaced when the marker is present; a foreign file is never touched |
| `.opencode/onememory.md` | the compact pointer block (comment-fenced) | re-running replaces only the block |

**Two review steps OpenCode requires (by design, this adapter never bypasses them):**

- **Restart after scaffolding.** Plugins, config, and instruction files load at startup — files in
  `.opencode/plugins/` are picked up on the next launch, so restart `opencode` after `onemem init`
  writes them outside a session.
- **Allow the tools.** OpenCode asks before running MCP tools by default — allow the onememory
  tools (or configure the permission for the `onememory` server) so the agent can read and write
  memory unattended.

## What is captured

| OpenCode signal | Onememory event kind(s) |
| --- | --- |
| `event` `session.created` | `session.start` (cwd from `info.directory`, title in the summary) |
| `event` `session.idle` | `session.end` (the quiescence boundary — see the gap note below) |
| `chat.message` hook (user message) | `conversation.message` (role `user`) |
| `chat.message` leading "remember/note/don't forget …" | `explicit.remember` (one event, not two) |
| `event` `message.part.updated` text part, complete, not synthetic | `conversation.message` (role `assistant`) |
| `event` `message.part.updated` tool part, `state.status: "error"` | `error.raised` (origin `tool`) |
| `tool.execute.after` `bash` (`metadata.exit === 0`) | `terminal.output` (exit_code 0; the tool id is `"bash"` upstream, kept for compatibility) |
| `tool.execute.after` `bash` (`metadata.exit > 0`) | `terminal.output` **and** `error.raised` (origin `terminal`, first meaningful output line — the resolution-pair family) |
| `tool.execute.after` `bash` (`metadata.exit == null`) | `terminal.output` (exit_code `null`) **and** `error.raised` ("command failed (aborted or timed out)" — shell.ts returns `null` exactly there, and this adapter never guesses a code) |
| `tool.execute.after` `edit` | `file.changed` (`modified`, exact line deltas from `oldString`/`newString`, the Claude/Cursor line math) |
| `tool.execute.after` `write` (`metadata.exists === false`) | `file.changed` (`created`, with `lines_added` from the content — the create signal write.ts reports) |
| `tool.execute.after` `write` (file existed) | `file.changed` (`modified` — an overwrite's delta is not derivable without the previous content, so line counts stay unset, never guessed) |
| `tool.execute.after` a tool named `*onememory*` | counted drop `own_memory_tool` (our memory-tool traffic is never ingested — the claude-mem/codex-rollout lesson) |

Deliberately **not** captured (each with a counted reason, never a silent skip): streaming text
deltas (a part without `time.end` is unstable text), synthetic parts (runtime-injected prose),
`session.error` (LLM-provider flaps are not tool/command failures), read-only tools
(`read`/`grep`/`glob` must not cost memory events; their failures ride the tool-part error state),
and the user message's parts on the part channel (the `chat.message` hook claims the message id, so
the utterance is captured exactly once).

**Documented gap:** OpenCode's event vocabulary has no session-END signal (sessions are long-lived
and resumable). `session.idle` — which OpenCode's own docs use for "session completed"
notifications — is mapped to `session.end` honestly: it fires per turn-end, the daemon treats it
like the other runtimes' session boundaries, and a resumed session gets a fresh boundary. The
`experimental.chat.system.transform` injection channel is experimental upstream (the name says
so): a future rename surfaces as a counted no-op, never a broken session — the static
`.opencode/onememory.md` instructions pointer is the durable channel.

### The fail-soft contract

Capture runs inside the OpenCode process, so it must never stall a session: every delivery is
hard-bounded (2.5s ingest, 2s context fetch), no retries, and every failure mode resolves to a
one-line diagnostic through `client.app.log` — never a thrown error into an OpenCode hook.

## Security

The adapter applies the security package's adapter contract before anything leaves the process:
path exclusion (`.env`, key files, …) drops the event locally, and `redactEvent` runs over every
surviving event. The daemon redacts again on arrival — two boundaries, defense in depth.
Redaction failure is a drop, never an unredacted send. The scaffolded MCP URL must be loopback
(Phase 1 has no authentication), enforced by Zod before any file is written.

## Sources

Every wire shape in this package was verified against OpenCode's own sources on 2026-10-06
(mission 9): the plugin docs (`opencode.ai/docs/plugins/`) and `@opencode-ai/plugin@1.18.34`
`dist/index.d.ts` (hook signatures), `@opencode-ai/sdk@1.18.34` `dist/gen/types.gen.d.ts` (the
Event union, Part shapes, `UserMessage`), the sources `tool/shell.ts` + `tool/shell/id.ts` (tool id
`"bash"`, `metadata.exit: number | null`), `tool/edit.ts` (args, `metadata.filediff`),
`tool/write.ts` (`metadata.exists`), `mcp/index.ts` (`connectLocal` spawns with the parent
environment merged under `entry.environment`; no `${env:…}` interpolation for MCP env values),
and the config/rules docs (`opencode.json` `mcp`/`instructions`, `type` required on both entry
forms).
