# @onememory/adapter-codex

The [OpenAI Codex CLI](https://developers.openai.com/codex/overview) adapter for
**onememory** — the self-hosted, local-first persistent memory engine for AI coding agents.

One install gives Codex three things:

1. **Live capture** — Codex [hooks](https://developers.openai.com/codex/hooks) translate every
   session into validated `OnememoryEvent` envelopes and deliver them to the onememory daemon
   (`onemem serve`) over its public REST API. Commands, file edits, errors and how they were
   resolved, prompts that say "remember that …", assistant turns — all of it becomes evidence
   the engine can extract durable memories from.
2. **Context injection** — a `SessionStart` hook fetches the packed project context from the
   daemon and injects it as `additionalContext`, so a fresh Codex session already knows the
   project's decisions, conventions, past failures, and solutions.
3. **MCP tools** — a `[mcp_servers.onememory]` block in `config.toml` exposes
   `memory_search` / `memory_get` / `memory_store` (mission-5 server, `default8` profile) for
   explicit recall and writes during the session.

AGENTS.md gets a compact, generated pointer block telling the agent to *use those tools* — never
a hand-maintained knowledge base.

---

## Setup

```sh
onemem init          # scaffolds .codex/config.toml, .codex/hooks.json, AGENTS.md (project scope)
onemem serve         # the local daemon capture delivers to (keep it running)
```

`onemem init` calls this package's `scaffoldCodex()`. To set up by hand instead:

```sh
npx onemem-codex-capture --help
```

| Artifact | What lands there | Idempotency |
| --- | --- | --- |
| `.codex/config.toml` | `[mcp_servers.onememory]` stdio block (marker-fenced) | re-running replaces only the fenced block; your comments and tables stay byte-identical |
| `.codex/hooks.json` | capture handlers for `SessionStart` (sync, injects context), `UserPromptSubmit`, `PostToolUse` (`^Bash$`, `^(apply_patch\|Edit\|Write)$`), `Stop` (async), `SessionEnd` (sync, 3s) | our entries are replaced, foreign hooks preserved |
| `AGENTS.md` | ~0.7 KiB pointer block (comment-fenced) | re-running replaces only the block |

**Two review steps Codex requires (by design, this adapter never bypasses them):**

- **Trust the project.** Project-scoped `.codex/` config and hooks load only for trusted
  projects — accept the trust prompt the first time you open the project.
- **Trust the hooks.** Codex skips non-managed hooks until you review them: run `/hooks` once
  and approve the onememory entries. Changed hook definitions need re-approval.

## What is captured

| Codex signal | Onememory event kind(s) |
| --- | --- |
| `SessionStart` hook | `session.start` (+ context fetched and injected as `additionalContext`) |
| `SessionEnd` hook | `session.end` |
| `UserPromptSubmit` — plain prompt | `conversation.message` (role `user`) |
| `UserPromptSubmit` — leading "remember/note/don't forget …" | `explicit.remember` (one event, not two) |
| `Stop` — `last_assistant_message` | `conversation.message` (role `assistant`) |
| `PostToolUse` `Bash` — exit 0 | `terminal.output` (command + verified exit code + bounded output digest) |
| `PostToolUse` `Bash` — non-zero exit | `terminal.output` **and** `error.raised` (the resolution-pair family) |
| `PostToolUse` `apply_patch` (aliases `Edit`/`Write`) | `file.changed` per patch directive (`created`/`modified`/`deleted`/`renamed`) |
| Rollout JSONL (manual backfill) | any of the above, from sessions that predate the hooks |

Everything else is **dropped with a counted reason** — never coerced into an event it does not
honestly fit. Drops are visible in `onemem doctor`'s dead-letter audit, not swallowed.

### Exit codes and blocking (the fail-soft contract)

`onemem-codex-capture` **exits 0 for every capture outcome** — no daemon, timeout, bad
payload, unreachable server: capture can never fail or stall the agent (ADR-0010 §6). A
one-line `[onememory] …` diagnostic goes to stderr; stdout is reserved for the SessionStart
hook output (the only event that prints). Exit 2 is reserved for operator errors (unknown
flags, unreadable rollout file).

Delivery is bounded: 2.5s timeout per request, batches of ≤500 events, hard caps on rollout
size (20k lines / 25 MiB). Duplicate events are deduplicated by the daemon's content hash, so
re-running a rollout backfill is safe.

### Secrets never enter memory

The capture pipeline runs every event through `@onememory/security`'s path exclusion
(`.env`, key files, … are never ingested) and `redactEvent` (credential-shaped strings become
`[REDACTED:…]`) **before delivery**; the daemon redacts again on arrival — two boundaries.
Redaction is a fixpoint: already-redacted text is stable, never nested.

---

## Rollout backfill (manual)

Codex writes session transcripts as rollout JSONL. The format is documented as *not* a stable
interface, so it is never parsed live — only via the explicit ingest path:

```sh
onemem-codex-capture --rollout ~/.codex/sessions/2026/10/03/rollout-2026-10-03T09-00-00.jsonl
```

Sessions run before the hooks existed, wrapper-driven flows, and CI runs are all backfillable.
The translator mirrors the record selection Codex's own memory pipeline uses (skips
`event_msg`, `turn_context`, harness-injected context, our own memory-tool calls).

---

## Division of labor with Codex native memories

Codex has its own **local memories** feature — per-thread recall, stored under
`~/.codex/memories/`, generated by Codex's background pipeline. The two systems are
complementary, and this adapter never silently reconfigures yours:

| | Codex native memories | onememory |
| --- | --- | --- |
| Default state | **off** (`[features] memories = true` to enable) | on after `onemem init` |
| Scope | your Codex threads (machine-local) | one project, shared across Claude Code / Codex / Cursor / … |
| Source | chat transcripts, summarized in the background | validated, evidence-linked events from live capture |
| Strength | zero-setup personal recall | cross-runtime project memory with provenance, dedup, redaction, token budgets |
| Config | `memories.*` keys in `config.toml` | `.onememory/onememory.yaml` |

**`memories.disable_on_external_context`** (verified against the
[config reference](https://developers.openai.com/codex/config-reference), 2026-10-03): when
`true`, threads that used *external context such as MCP tool calls, web search, or tool search*
are kept out of **native memory generation**. It **defaults to `false`** — an onememory-assisted
session still feeds Codex's own memories unless you opt out. If you enable native memories and
want Codex's summarizer to leave onememory-assisted threads alone (avoiding two memory layers
over the same session), set:

```toml
[features]
memories = true

[memories]
disable_on_external_context = true
```

The older `memories.no_memories_if_mcp_or_web_search` key is accepted as an alias. onememory's
injected context arrives through a SessionStart hook, and its tools through MCP — both count as
external context for this switch.

---

## Capability tier

| Capability | Tier | Notes |
| --- | --- | --- |
| Session lifecycle (`session.start` / `session.end`) | full | from SessionStart/SessionEnd hooks; `SessionEnd` fires on close, archive, delete, or 30-min idle — not on conversation switch |
| Context injection at session start | full | SessionStart `additionalContext`, clamped under Codex's ~2,500-token spill threshold |
| User prompts | full | incl. "remember that …"-style directives → `explicit.remember` |
| Assistant turns | good | `Stop` carries `last_assistant_message`; mid-turn assistant text without a tool call can arrive rollout-only |
| Terminal command + output | full | exit code parsed from the verified `Process exited with code N` response header; PTY sessions report `null` until they finish |
| Errors + resolutions | full | non-zero exits emit the `terminal.output` + `error.raised` pair; resolutions are captured from later successful commands |
| File edits | full | apply_patch directives (incl. `Move to` renames) → `file.changed` events; content is not stored, only paths and change kinds |
| MCP / other tool calls | basic | generic `conversation.tool_call` / `conversation.tool_result` with bounded digests |
| Historical sessions | full (manual) | rollout backfill via `--rollout`; duplicate-safe by daemon content hash |
| Blocking / approval control | none (by design) | capture is advisory-only; onememory never steers, blocks, or approves |

Version floor: **Codex ≥ 0.123.0** for `apply_patch` on `PostToolUse` hooks
([openai/codex#16732](https://github.com/openai/codex/issues/16732)); the matched tool names,
hook events, and config keys above follow the current published contracts.

## Architecture notes

- Depends only on **public surfaces**: `@onememory/core` (event schemas, validation),
  `@onememory/security` (redaction, path exclusion), `@onememory/config` (project discovery).
  Delivery speaks the daemon's public REST API and reads the documented `daemon.json` lock —
  no engine internals.
- TOML is rendered and patched as **text** (never parse→stringify, which would destroy user
  comments); generated TOML is round-trip-verified against [`smol-toml`](https://www.npmjs.com/package/smol-toml)
  (BSD-3-Clause, zero dependencies) in the test suite.
- The wire schemas for every hook event are Zod mirrors of the generated schemas published in
  the [Codex repository](https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated);
  unknown fields pass through so Codex can add fields without breaking capture.

## Package surface

```ts
import {
  scaffoldCodex,                    // onemem init wiring (writes/paches the three artifacts)
  captureHook, captureRollout,      // translate → exclude → redact → deliver (never throws)
  buildSessionStartOutput,          // context injection payload for SessionStart
  translateCodexHook,
  translateRolloutSession,
  patchCodexConfigToml, renderCodexMcpServerToml,
  patchCodexHooksJson, buildCodexHooksFile,
  patchAgentsMd, renderOnememoryAgentsBlock,
} from '@onememory/adapter-codex';
```

`@onememory/adapter-codex/testing` exports verified-shape fixtures (hook inputs, bash tool
responses, a golden rollout) and a loopback fake daemon for integration tests.
