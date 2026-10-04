# Mission 3c: failing tool results become failure incidents

Branch: `mission/3c-tool-incidents` · Base: `2859037` (main) · Backlog follow-up to M3b
(`docs/backlog/issues.md` "Tool-result failures as incidents") · Extends
`docs/plan/mission-reports/mission-3b-decision-failure.md`

## Scope delivered

A `conversation.tool_result` the runtime itself marked `ok: false` is now a failure incident, in
the same single definition of "a failure happened" the heuristic and LLM extractor paths already
share. The signature's `tool` is populated from the tool name the raw event carries.

- **NORMALIZE shape** (`packages/extraction/src/events.ts`): `NormalizedEvent` gained an optional
  `tool_result: { call_id, ok, tool?, error_message?, output_digest }` struct, populated for
  `conversation.tool_result`. Additive: the event's `text` is unchanged, and every other event
  kind is byte-identical.
- **Raw boundary** (`packages/core/src/schema/event.ts`): `ConversationToolResultPayloadSchema`
  gained an optional `tool: string.min(1).max(80)`. The schema is already a `looseObject`, so an
  adapter could always smuggle a name through; declaring it makes the field validated and bounded
  instead of unvalidated pass-through (same rationale M3b used for its boundary change).
- **Recognition** (`packages/extraction/src/enrichment/failure.ts`): `failureIncidentOf` returns a
  tool incident for `event.tool_result && !event.tool_result.ok` — `origin: 'tool'`, `tool` from the
  event, `message` from the tool's own `error.message` (falling back to `output_digest`, then a
  constant `'tool call failed'`). `classifyFailure` returns `TOOL_ERROR` for a tool incident that no
  message rule classified.
- **Resolution pairing** (`packages/extraction/src/heuristic/extractor.ts`): a later successful
  tool_result of the *same* tool resolves the failure. The success list now reads the normalized
  `tool_result.ok`; the resolution label names the tool (`` `Edit` succeeded ``).

Both extractor paths stay byte-identical because recognition lives in `failureIncidentOf` only:
the LLM path still fingerprints the candidate's cited events via `failureSignatureForEvents`, so
the heuristic and LLM extractors emit the same signature for the same tool-result failure (pinned
by a test that runs both over the same inputs).

## Origin-mapping decision

**Decision: added `'tool'` to `FAILURE_SIGNATURE_ORIGINS` and set `origin: 'tool'`.** The
alternative — `origin: 'error'` with `error_origin: 'tool'` — was rejected as dishonest to both
fields:

- `FailureSignatureSchema.origin` is documented as "the event kind the signature was normalized
  from". A failing `conversation.tool_result` is not an `error.raised`, so calling it `error`
  would make `origin` mean different event kinds for different signatures.
- `error_origin` is documented as "`error.raised.origin`, when the signature came from an error
  event". A tool-result failure carries no `error.raised.origin`; populating it would assert a
  provenance the event does not have. `FAILURE_ERROR_ORIGINS` already contains `'tool'` for a
  genuine `error.raised` with `origin: 'tool'` (the claude PostToolUseFailure path), and that case
  must stay distinguishable from a failed tool result.

`FAILURE_SIGNATURE_ORIGINS` is the only consumer of the enum, and `failure_signature` is carried on
the extraction candidate, not persisted (the `failures.signature_hash` wiring is still deferred per
M3b), so the enum extension needs no storage migration and no `CHECK`-constraint change.

**Digest semantics preserved.** `hash` still covers `type` + `normalized_message` only. The tool
name is deliberately kept out of `message`, so one root cause reached through different tools
collapses to one signature; a test pins that a `TOOL_ERROR` reached via `Edit` and via `Write`
hashes identically.

**"Failing" is `ok: false` and nothing else.** No message heuristics: a successful tool result whose
output merely *mentions* an error (`error: Cannot find module …`) is not an incident (pinned).

**The tool name is never fabricated.** If the raw event carries no `tool`, the incident still fires
(so a failed result without an accompanying `error.raised` is not lost) but `signature.tool` stays
unset and no pairing is attempted — "same tool" cannot be established from result text. A
`tool_result` whose `tool` is missing is not paired with a successful result of a *named* tool, and
vice versa.

## Files changed

| File | Change |
|---|---|
| `packages/core/src/schema/event.ts` | optional bounded `tool` on `ConversationToolResultPayloadSchema` |
| `packages/core/src/schema/extraction.ts` | `'tool'` added to `FAILURE_SIGNATURE_ORIGINS`; origin/error_origin doc comment |
| `packages/extraction/src/events.ts` | `NormalizedToolResultSchema`; `tool_result` on `NormalizedEvent`; `conversation.tool_result` case in `normalizeEvent` |
| `packages/extraction/src/enrichment/failure.ts` | `'tool'` in `FailureIncident['origin']`; tool-result branch in `failureIncidentOf`; `TOOL_ERROR` in `classifyFailure`; header doc |
| `packages/extraction/src/heuristic/extractor.ts` | same-tool pairing rule in `isRelated`; tool-aware resolution label; success check reads the normalized `tool_result.ok`; docs |
| `packages/extraction/src/testing/transcripts.ts` | `toolFailureSession()` fixture (failing `Edit` result resolved by a successful `Edit` result) |
| `packages/extraction/src/enrichment/failure.test.ts` | 4 incident cases + 1 classify case + 1 signature case |
| `packages/extraction/src/heuristic/extractor.test.ts` | 4 end-to-end cases |
| `packages/extraction/src/llm/extractor.test.ts` | 1 case proving the LLM and heuristic signatures are identical |
| `packages/extraction/src/events.test.ts` | 1 normalization case (name carried vs. left unset) |

No new dependency (`bun.lock` untouched). No storage change. No Postgres leg needed.
`apps/api/src/runtime/extraction-temporal.test.ts` is **untouched**: the golden transcript contains
no tool results, so the acceptance test's expectations did not move.

## Validation

- Focused `packages/extraction`: **132 pass / 0 fail** (M3b baseline 121; +11 tests).
- Typechecks (`tsc --noEmit`, strict): core, config, embeddings, extraction, llm, mcp, retrieval,
  security, storage, codememory, adapters/claude, adapters/codex, apps/api, apps/cli — all clean.
- Full suite at the worktree root: **1010 pass / 20 skip / 0 fail** (1030 tests, 75 files). Base
  was 999 pass / 20 skip / 0 fail (1019 tests, 75 files); the +11 are this mission's. The 20 skips
  are the environment-gated Postgres-server storage legs (no Postgres on this host).
- AC demonstrated: `toolFailureSession()` (failing `Edit` result, then a successful `Edit` result)
  yields exactly one `failure` candidate whose signature is
  `{ type: 'TOOL_ERROR', origin: 'tool', tool: 'Edit', normalized_message: 'string to replace not found in file <path>', hash: failureSignatureHash('TOOL_ERROR', …) }`
  and whose content is
  ``Failure: TOOL_ERROR — Edit failed: String to replace not found in file src/store.ts — resolved by: `Edit` succeeded``.
  The LLM path emits the identical signature for the same inputs.

## Explicitly out of scope / follow-ups

1. **Adapters do not yet populate `tool` on a tool result** (`packages/adapters/**` is outside this
   mission's ownership). The codex rollout translator is the only producer of
   `conversation.tool_result`, it always writes `ok: true` (a failed shell call becomes
   `terminal.output` + `error.raised` instead), and it drops the pending call's tool name before
   emitting the result. So a real transcript today still produces no failing tool result and no
   populated `tool`; the contract and recognition now exist for adapters/runtimes that emit
   `ok: false` with a name. Wiring the name into the codex (or a future) adapter is the follow-up
   that turns the AC into an end-to-end observation on live capture.
2. **No `call_id` correlation.** The tool name is taken only from the result event itself. The
   preceding `conversation.tool_call` carries the same `call_id` and the tool name, but correlating
   across events would have to happen at NORMALIZE/handler level (a batch concern) or inside the
   extractor — and scope #5 requires recognition to stay in the per-event `failureIncidentOf`. Left
   out rather than half-built.
3. **`signature.tool` is still not persisted** — the `failures` payload-table wiring M3b deferred is
   unchanged, so recurrence counting remains future work.
4. **`docs/architecture/event-memory-schemas.md` §2/§3 are not updated** (coordinator-owned): the
   `conversation.tool_result` payload now has an optional `tool`, and the extraction `origin`
   vocabulary now includes `tool`. The coordinator should sync those docs.
