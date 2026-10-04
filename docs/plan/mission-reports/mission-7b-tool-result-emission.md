# Mission 7b: Codex generic tool results — correlated name, honest status

Branch: `mission/7b-tool-result-emission` (worktree `onemem-m7b-tool-results`) · Base: `a103665`
(main) · Delivers follow-up #1 of M3c (`docs/plan/mission-reports/mission-3c-tool-incidents.md`)
inside the Codex adapter built by M7 (`docs/plan/mission-reports/mission-7.md`)

## Scope delivered

A generic `conversation.tool_result` emitted by the Codex rollout translator now carries the tool
name of its correlated `function_call`, and the adapter documents — in code, README, and tests —
that runtime failure status is **not recoverable** from the rollout wire. M3c added the `tool`
field to the payload contract and recognition for `ok: false` results; M7b makes the Codex
adapter populate the name half of that contract, and proves the adapter never fabricates the
status half.

- **Name preservation** (`packages/adapters/codex/src/translate-rollout.ts`): the translator's
  existing pending-call map (keyed by `call_id`) already held each generic call's name for shell
  pairing; the emitted result now reuses it, so **parallel calls correlate by `call_id`, not by
  recency** — three interleaved MCP calls whose outputs arrive in reverse order each keep their own
  name (pinned). The name is the call's exact string, never derived from output text.
- **Bounded by core's contract**: core's `ConversationToolResultPayloadSchema.tool` is
  `.min(1).max(80)` (M3c) and the bound is not exported, so a name longer than 80 characters is
  **omitted with a counted `tool-result-name-overlength` drop** (never silent, never a validation
  dead-letter of the whole result — the result and its bounded digest are still captured). An
  empty name is simply omitted. `MAX_TOOL_RESULT_TOOL_NAME = 80` mirrors the schema bound with a
  comment saying so; if core ever exports the bound, the adapter should import it instead.
- **Status stays honest**: `ok: true` is retained unchanged. It is the pre-M7b legacy mapping and
  is now documented as *compatibility*, not as evidence the tool succeeded. No `error` envelope is
  fabricated, and no heuristic reads output prose or JSON: an output body of
  `{"isError":true}`, `Error: …` text, or any other error-shaped content still yields
  `ok: true` with no error field (each pinned). Top-level unverifiable status fields on the wire
  (`isError`, `success`, `ok` of any type) are ignored (pinned).

## The status question — source evidence

The mission's stop condition was: if the Codex rollout discards MCP `isError`, cut the status
work to documentation rather than guesswork. Verified against primary sources, it discards it.
All `codex-rs` citations are from openai/codex main at commit
`afb436df8b70bb5bc57b86d9a3e829968988cd21` (2026-10-04) unless tagged otherwise.

- **The wire item cannot carry status.** `codex-rs/protocol/src/models.rs`:
  `FunctionCallOutputPayload { body, success: Option<bool> }` — whose doc comment says `success`
  "remains internal metadata". The hand-written `Serialize` impl writes **only** `body` (a string
  or a content-item array), and `Deserialize` sets `success: None`. The type's own tests
  (`serializes_failure_as_string`) show a failing output serializing byte-identical to a success.
- **The MCP flag is dropped before the rollout.** `CallToolResult::as_function_call_output_payload`
  in the same file maps MCP `isError` → the internal `success` flag (never serialized);
  `structuredContent` becomes a serialized-JSON string; text content becomes `input_text` items.
  The MCP spec (2025-06-18 schema) does define `CallToolResult.isError: boolean` — the flag exists
  at the MCP boundary and is then thrown away by Codex's serialization.
- **The wire item cannot carry a name either.** `From<ResponseInputItem::McpToolCallOutput>` sets
  `name: None`, and at tag `rust-v0.134.0` (the fixture's `cli_version`) the
  `ResponseItem::FunctionCallOutput` variant is `{ call_id, output }` with no name field at all,
  while `ResponseItem::FunctionCall` requires both `name` and `call_id`. **`call_id` correlation
  with the preceding `function_call` is therefore the only name source** — which is exactly what
  the pending-call map provides.
- **The rollout stores what the serializer wrote.** `codex-rs/history/src/rollout_payload.rs`:
  `RolloutItemWire` records `ResponseItem` payloads verbatim, so backfill sees precisely the
  status-stripped shape above.
- **Status does survive on one record we deliberately skip.**
  `codex-rs/protocol/src/protocol.rs`: `EventMsg::McpToolCallEnd(McpToolCallEndEvent { call_id,
  turn_id, invocation: McpInvocation { server, tool, arguments }, duration, result:
  Result<CallToolResult, String> })` with `is_success()`. The translator skips `event_msg` records
  because it mirrors the record selection of Codex's own memory pipeline (`rollout_input.rs`);
  this is the producer seam a future mission can consume (below).
- **The hook path cannot supply status either.** The published
  `codex-rs/hooks/schema/generated/post-tool-use.command.input.schema.json` types
  `tool_response` as `true` — free-form JSON with no status field.

**Decision under the stop condition:** wire the name (fully achievable, and M3c's follow-up #1);
do not invent status. A `named` + `ok: false` failure signature is therefore **not constructible
from Codex rollouts today**, so the mission's "named failure → success signature end-to-end"
acceptance is delivered as its honest negative proof: the new integration test
(`apps/api/src/runtime/adapter-tool-failure.test.ts`) runs the real adapter output through M3c's
extractor and asserts named results arrive with **zero invented failure incidents or signatures**,
including a result whose text is a genuine MCP error body (`Error: path outside the allowed
roots`). M3c's recognition path (`ok: false` → incident) remains correct and reachable from any
runtime that does emit verified status; the Codex adapter simply cannot be that runtime on this
wire.

## Files changed

| File | Change |
|---|---|
| `packages/adapters/codex/src/translate-rollout.ts` | `MAX_TOOL_RESULT_TOOL_NAME = 80`; generic result carries correlated `tool` when 1–80 chars; overlength → omitted + counted `tool-result-name-overlength`; `ok: true` retained with an honest comment; header mapping table + note updated |
| `packages/adapters/codex/src/translate-rollout.test.ts` | golden rollout's result asserted named `mcp__linter__lint`; new "named generic results (M7b bounded cut)" block: reverse-order parallel correlation (3 results), 7 opaque-output cases (error prose, error-mentioning success text, JSON `isError` bodies as string/array/objects), 4 ignored top-level status-field cases, 80/81 boundary, empty-name/no-name orphaning, duplicate/mismatched `call_id` reuse, own-memory exclusion, bounded digests with name |
| `packages/adapters/codex/src/testing.ts` | exported `mcpToolResultsRollout()` — session_meta (`cli_version: 0.134.0`) + 3 MCP calls (`mcp__linter__lint`, `mcp__files__read_file`, `mcp__search__query`) with outputs as `input_text` content-item arrays in reverse call order, one a real MCP failure body byte-shape-identical to a success |
| `packages/adapters/codex/src/capture.test.ts` | capture/redaction test: the result's name equals its call's name (no new surface), digests redacted, no secret anywhere outside the tool-identifier fields |
| `packages/adapters/codex/README.md` | rollout-backfill section: name retention + overlength behavior, status unavailability with the serializer evidence, `ok: true` as compatibility not proof, link here |
| `apps/api/src/runtime/adapter-tool-failure.test.ts` (new) | integration: `translateRolloutSession` → M3c `failureIncidentOf` + heuristic extractor over the same events; 3 named results, no failure incidents, no failure memories, no signatures |

No new dependency (`bun.lock` untouched). No storage or schema change (core's M3c `tool` field
already ships). No ADR, root-config, or `docs/architecture/` edits (coordinator-owned).

## Validation

- Baseline (before this branch): focused `packages/adapters/codex` 138 pass / 0 fail; full suite
  **1025 pass / 21 skip / 0 fail** (1046 tests, 77 files, ~162 s). The 21 skips are the
  environment-gated Postgres-server storage legs (no Postgres on this host).
- Focused now (`packages/adapters/codex` + the new integration test): **157 pass / 0 fail** across
  12 files — +19 executions over the baseline: 17 in the new translate block (1 + 7 + 4 + 1 + 1 +
  1 + 1 + 1), 1 capture, 1 integration.
- Typechecks (`tsc --noEmit`, strict, all 14 packages: core, config, embeddings, extraction, llm,
  mcp, retrieval, security, storage, codememory, adapters/claude, adapters/codex, apps/api,
  apps/cli): all clean.
- Full suite at the worktree root: **1044 pass / 21 skip / 0 fail** (1065 tests, 78 files) — the
  +19 are this mission's; zero regressions.

## Explicitly out of scope / follow-ups

1. **Named `ok: false` from Codex requires a producer change — three seams, in preference order:**
   - **Upstream fix (best):** make Codex's `FunctionCallOutputPayload` serializer include the
     already-existing `success` flag. One upstream change makes status available to every
     consumer; the adapter would then map `success === false` → `ok: false` +
     `error.message` from the output body.
   - **`event_msg` `mcp_tool_call_end` consumption:** the rollout contains these records (the
     translator counts-and-skips them today, mirroring Codex's own memory selection). A future
     mission could correlate by `call_id` and set `ok: is_success()` with the message from the
     `Err(String)` or the `CallToolResult` text content. That diverges from the mirror-Codex's-
     selection precedent and needs its own verification pass (record availability across CLI
     versions), which is why it is a follow-up, not this cut.
   - **PostToolUse hook status:** only if Codex's published hook schema grows a status field
     (`tool_response` is free JSON today, so a hook can carry anything — and nothing verifiable).
2. **`redactEvent` does not redact tool identifiers** (`@onememory/security`, pre-existing): a
   secret embedded in a tool name flows through `conversation.tool_call.tool` and now also
   `conversation.tool_result.tool` — but the result can only repeat the exact name its correlated
   call already carried (asserted in the new capture test), so M7b adds no new surface. The
   follow-up is redaction of tool-identifier fields in the security package, shaped so
   `mcp__server__tool` names stay useful (pattern-based, not blanket).
3. **`signature.tool` is still not persisted** — unchanged from M3b/M3c; recurrence counting
   remains future work.
4. **`docs/architecture/` sync is coordinator-owned:** wherever the event schema or adapter
   mapping tables document `conversation.tool_result`, the Codex generic-result row now includes
   the optional correlated `tool` (and its overlength omission), and `ok: true` should be
   described as adapter-legacy, never as verified success.
