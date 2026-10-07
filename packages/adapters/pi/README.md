# @onememory-ai/adapter-pi

The [Pi coding agent](https://pi.dev) adapter for **onememory** — the self-hostable, local-first
persistent memory engine for AI coding agents.

One install gives Pi three things:

1. **Live capture** — a generated Pi [extension](https://pi.dev/docs/latest/extensions)
   (`pi.on()` lifecycle events) translates every session into validated `OnememoryEvent` envelopes
   and delivers them to the onememory daemon (`onemem serve`) over its public REST API. Commands,
   file edits, errors and how they were resolved, prompts that say "remember that …", assistant
   turns — all of it becomes evidence the engine can extract durable memories from.
2. **Context injection** — on the first `before_agent_start` of a session, the extension fetches
   the packed project context from the daemon and delivers it as a steering user message, so a
   fresh Pi session already knows the project's decisions, conventions, past failures, and
   solutions. The injection is engine OUTPUT — the translator drops it on the way back in, so the
   memory index is never re-ingested as user prose.
3. **MCP tools** — an `onememory` entry in `.pi/mcp.json` points Pi at the daemon's Streamable
   HTTP surface (`url = "http://127.0.0.1:<daemon.port>/mcp"`, ADR-0010 amendment 2026-10-04) and
   exposes `memory_search` / `memory_get` / `memory_store` for explicit recall and writes during
   the session.

`.pi/APPEND_SYSTEM.md` gets a compact, generated pointer block telling the agent to *use those
tools* — never a hand-maintained knowledge base.

---

## Setup

```sh
onemem init --with-pi      # scaffolds .pi/mcp.json, .pi/extensions/onememory.ts, .pi/APPEND_SYSTEM.md
onemem serve               # the daemon: MCP at /mcp + the REST API capture delivers to (keep it running)
```

`onemem init` calls this package's `scaffoldPi({ transport: 'http', url })` with the URL derived
from `daemon.host`/`daemon.port`, and prints every returned warning as a required review step.
`onemem doctor` reports whether the three artifacts exist and whether the `url` matches the
configured daemon. The stdio form (`transport: 'stdio'`) is still available for daemon-less or
server-profile setups — with embedded storage the daemon is the only owner of the data dir, so
`onemem init` scaffolds the HTTP form by default.

The generated extension shim is three lines: it imports `createPiExtension` from this package
(the project's `node_modules`) and exports the default factory Pi loads via jiti — no build step,
no separate hook process:

```ts
import { createPiExtension } from '@onememory-ai/adapter-pi';

export default function onememory(pi) {
  createPiExtension(pi);
}
```

| Artifact | What lands there | Idempotency |
| --- | --- | --- |
| `.pi/mcp.json` | `mcpServers.onememory` streamable-HTTP entry (`url`, `description`, `exposure: "direct"`, `enabled: true`) | re-running replaces only our entry; other servers and keys stay byte-identical |
| `.pi/extensions/onememory.ts` | the capture + injection shim (generated marker in the header) | replaced when the marker is present; a foreign file is never touched |
| `.pi/APPEND_SYSTEM.md` | ~0.8 KiB pointer block (comment-fenced) | re-running replaces only the block |

**Two review steps Pi requires (by design, this adapter never bypasses them):**

- **Trust the project.** Pi reads project `.pi/mcp.json` and `.pi/extensions/` only after
  [project trust](https://pi.dev/docs/latest/security) is granted — accept the trust prompt the
  first time you open the project.
- **Reload after scaffolding.** Extensions and mcp.json load at session start — run `/reload`
  (or restart Pi) after `onemem init` writes them outside a session.

## What is captured

| Pi signal | Onememory event kind(s) |
| --- | --- |
| `session_start` (reason `startup`/`reload`/`new`/`resume`/`fork`) | `session.start` |
| `session_shutdown` (any reason) | `session.end` |
| `message_end` — role `user` | `conversation.message` (role `user`) |
| `message_end` — leading "remember/note/don't forget …" | `explicit.remember` (one event, not two) |
| `message_end` — role `assistant` | `conversation.message` (role `assistant`) |
| `tool_result` `bash`/`powershell`, not an error | `terminal.output` (exit code 0 — `bash.ts` marks `isError` only for non-zero exits, so a non-error result proves a zero exit) |
| `tool_result` `bash`/`powershell`, `isError` | `terminal.output` **and** `error.raised` (the resolution-pair family) |
| `tool_result` `bash` running `git commit` | `git.commit` (enrichment-gated: only when git's `[branch sha]` summary line and a `git log` sha agree) |
| `tool_result` `edit` | `file.changed` (`modified`, exact line deltas from `edits[]`) |
| `tool_result` `write` | `file.changed` (`modified` — write.ts reports no create/overwrite distinction, so line deltas stay unset) |
| `tool_result` any other tool, `isError` | `error.raised` (origin `tool`) |

Deliberately **not** captured (each with a counted reason, never a silent skip):
`before_agent_start` (the injection-only channel — the prompt itself arrives via `message_end`, so
capturing both would double every turn), `message_end` of system/toolResult/custom messages, our
own `mcp__onememory__*` tool results, our own injected context, and successful read-only tools
(`read`/`grep`/`find`/`ls` must not cost memory events). Nested tool calls (a codemode script
calling bash, `parentToolCallId` set) ARE captured — they are real tool executions whose results
never reach the transcript.

### The fail-soft contract

Capture runs inside the Pi process, so it must never stall a session: every delivery is hard-bounded
(2.5s ingest, 2s context fetch), no retries, and every failure mode resolves to a one-line
diagnostic — never a thrown error into a Pi event handler. Pi reports handler errors and continues;
this adapter's contract is that it never produces one.

## Security

The adapter applies the security package's adapter contract before anything leaves the process:
path exclusion (`.env`, key files, …) drops the event locally, and `redactEvent` runs over every
surviving event. The daemon redacts again on arrival — two boundaries, defense in depth. Redaction
failure is a drop, never an unredacted send.

## Sources

Every wire shape in this package was verified against Pi's own sources on 2026-10-06 (mission 9):
the extension docs and the canonical `packages/coding-agent/src/core/extensions/types.ts`
(event payloads), `src/core/tools/{bash,edit,write}.ts` (tool input and structured-content shapes),
the MCP docs (`mcp.json` format, exposure vocabulary, SSE rejection), and the configuration docs
(`.pi/` layout, `APPEND_SYSTEM.md` semantics, project trust).
