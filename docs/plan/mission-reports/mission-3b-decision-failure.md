# Mission 3b: decision/failure capture (Phase 2 enrichment slice)

Branch: `mission/3b-decision-failure` · Base: `dec90b3` · Extends `mission/3-extraction` (M3) ·
Plan row: `docs/plan/phased-plan.md` Phase 2 "M3b Decision/failure capture"

## Scope delivered

EXTRACT (stage 4) now records two things it did not before, in both extractor paths, with the
existing provenance/evidence invariant untouched (every candidate still carries ≥ 1 evidence span
bound to a real event):

1. **Decision capture** — alternatives considered and the rationale, as a structured
   `decision_payload` on `decision` candidates, plus a content statement that carries them.
2. **Failure signatures** — a stable fingerprint (`type`, `hash`, `normalized_message`, `origin`,
   `tool`, `command`) on `failure` candidates derived from error / terminal / test events, plus the
   normalized class in the durable content. `test.results` runs with failures are now recognized as
   failure incidents at all (previously only `error.raised` and non-zero command exits were).

No new dependencies (100% local/offline: `node:crypto` sha256 only). No storage change.

## Extraction rules as implemented

### Decision enrichment (`src/enrichment/decision.ts`, wired in `heuristic/extractor.ts` §2)

Runs only after the existing `DECISION_PATTERNS` match and the existing
`DECISION_NOISE_PATTERNS` filter — enrichment can never create a decision that the decision rules
did not already find. Rules, in order:

1. The chosen option is `DECISION_PATTERNS` capture 1, cut at the first rationale connective
   (`because`, `since`, `due to`, `owing to`, `given that`, `so that`) and at the first clause break
   (`,`/`;`/`—` followed by `and|but|so|then|while|plus`). A leading `to ` is stripped
   ("the decision is to ship X" → `ship X`).
2. The primary alternative is the `over` capture, cleaned the same way.
3. The rationale is the clause after the decision phrase **within the same sentence**, or the
   rationale the phrase itself carried — never one behind a clause break (a rationale behind a
   clause break belongs to that clause, and is captured as that clause's own `why_rejected`).
4. Rejection statements within 400 characters after the decision ("we ruled out SQLite because …")
   become further alternatives with `why_rejected`.
5. An alternative is dropped when it is a pronoun/filler (`it`, `the other`, …), repeats the chosen
   option, or is shorter than two characters. Alternatives are capped at 3 and de-duplicated.
6. The rationale is attached as the alternative's `why_rejected` when it names that alternative.
7. Bounds: decision ≤ 200, option ≤ 120, rationale ≤ 200 (all ≤ the canonical schema limits).

Content composition (this is what is persisted today):

```text
Decision: <chosen> [over <alt1>] [— because <rationale>] [— also rejected: <alt2>, <alt3>]
```

Subtype is unchanged in spirit: `decision.choice` when alternatives exist, else
`decision.statement`. The payload mirrors the `decisions` payload table columns
(`decision`, `alternatives [{option, why_rejected?}]`, `rationale`); memory-model.md §9's promotion
precondition is now directly checkable (`alternatives.length > 0 && rationale !== undefined`).
`explicit.remember --type decision` keeps the user's own wording as content and gains the payload
when that wording is parseable. Decision *recall* is deliberately unchanged (same patterns).

### Failure signatures (`src/enrichment/failure.ts`, wired in `heuristic/extractor.ts` §4)

**What is a failure incident** (one definition, `failureIncidentOf`, used by both extractor paths):
an `error.raised` (any origin), a `terminal.output` with a non-zero exit code, or a `test.results`
run with `failed > 0`. An exit code of `null` (still running) is not a failure; passing tests and
exit 0 are not failures.

**Signature fields**

| field | rule |
|---|---|
| `type` | normalized error class, first match of an ordered table: `NETWORK_ERROR`, `PERMISSION_DENIED`, `FILE_NOT_FOUND`, `MODULE_NOT_FOUND`, `TYPECHECK_ERROR`, `SYNTAX_ERROR`, `TYPE_ERROR`, `REFERENCE_ERROR`, `RANGE_ERROR`, `ASSERTION_FAILURE`, `OUT_OF_MEMORY`, `CONSTRAINT_VIOLATION`, `DEADLOCK`, `TIMEOUT`; else `TEST_FAILURE` / `NONZERO_EXIT` by origin, or `BUILD_ERROR` / `TOOL_ERROR` / `RUNTIME_ERROR` / `COMMAND_FAILURE` from `error.raised.origin`. |
| `hash` | `sha256("failure-v1" ␀ type ␀ normalized_message)`, first 16 hex chars. The salt is the normalization version: changing the rules cannot silently collide with old signatures. |
| `normalized_message` | the noise-normalized message the digest was computed over (capped at 300 first, so the stored form always reproduces the stored hash — the digest is auditable). |
| `origin` | `error` \| `command` \| `test` — which event kind supplied the signature. |
| `error_origin` | `error.raised.origin`, when the incident is an error event. |
| `tool` | failing executable (`bun`), the tool named in an `origin: 'tool'` error's context, or the test framework. |
| `command` | the failing command, normalized by the existing `normalizeCommand()` (command incidents only). |

The digest covers **type + normalized_message only**: `command`/`tool` are recorded context, not
signature inputs, so one root cause reached through different tools collapses to one signature
(pinned by test). Classification runs on the *normalized* message, so `type` and `hash` can never
disagree about what the failure was.

**Message normalization** (ordered, deterministic, documented on `normalizeFailureMessage`):

1. strip ANSI/CSI escape sequences (colour, cursor moves, progress bars);
2. collapse whitespace, trim;
3. lowercase;
4. UUIDs → `<uuid>`;
5. hex addresses / long hex runs (`0x7ffee1…`, content hashes) → `<hex>`;
6. IPv4 addresses → `<host>`;
7. paths → `<path>`: anchored paths (`/abs/x.ts`, `./x`, `../a/b`) first, then relative
   multi-segment paths (`packages/storage/src/store.ts`) — a bare filename is not a path;
8. `line:col` → `:<line>:<col>`;
9. `:<port>` → `:<port>`;
10. durations (`1.2s`, `5000ms`, `3 min`) → `<duration>`;
11. remaining numbers/decimals (`87`, `exit 1`, test counts) → `<n>`;
12. collapse, cap at 300.

Preserved as identity (not noise): bare quoted module names (`"react"`), identifiers, error codes
(`ts2345`), test names, class-recognizing words. Documented consequence: a *path-like* quoted
literal (`"./schema"`) is normalized as a path, so `"./schema"` and `"./vectors"` share a signature
(the same failure mode — a missing relative module); the candidate content still names which one.

**Where it lands today** — `content` becomes
`Failure: <TYPE> — <label> — resolved by: <resolution>` (the label is the error message, the
failing command, or the failing test names). Evidence, importance, confidence, subtype
(`failure.resolved`), and the unresolved→working-memory routing are unchanged; unresolved incidents
still produce a session-scoped `current_error` note, never a durable failure.

### LLM path consistency (`src/llm/prompt.ts`, `src/llm/extractor.ts`)

- The prompt (`extract-v2`) asks for `decision_payload` on decision memories and explicitly forbids
  inventing alternatives or emitting a failure signature/hash. Model output is normalized through
  the same tolerant boundary (`parseDecisionPayload`: garbage → dropped, over-long → capped); a
  payload on a non-decision candidate is dropped.
- Failure signatures are **never** requested from the model: the extractor fingerprints the
  candidate's own cited events (`failureSignatureForEvents`), so the heuristic and LLM paths emit
  byte-identical signatures for the same failure, and a failure candidate citing no failure event
  carries no signature rather than an invented one.
- Both extractors bumped their rule-set version: `heuristic-v1 → heuristic-v2`,
  `extract-v1 → extract-v2` (stored provenance must be able to tell which rules produced a memory).

## Dependency reuse

- `decisions` / `failures` payload table shapes and core's `DecisionPayloadSchema`
  (`packages/core/src/schema/memory.ts`) — the new `DecisionExtractionSchema` is the bounded,
  extraction-time projection of that existing schema, not a parallel model.
- Existing pattern vocabulary (`patterns.ts`): `DECISION_PATTERNS`, `DECISION_NOISE_PATTERNS`,
  `firstMatch`, `significantTokens`, `executableOf`, `normalizeCommand` (events.ts).
- Existing failure/success pairing, future-value gate, classifier, and evidence binding — all
  reused unchanged; the new code adds data to candidates, it does not add a stage.
- `node:crypto` sha256 (already the repo's hashing primitive in core) — no new dependency,
  no network, offline-safe.

## Boundary change (documented)

`packages/core/src/schema/extraction.ts` gained two **optional** fields on `ExtractedMemory`
(`decision_payload`, `failure_signature`) plus the two Zod schemas (`DecisionExtractionSchema`,
`FailureSignatureSchema`), and `FAILURE_SIGNATURE_ORIGINS` / `FAILURE_ERROR_ORIGINS`. This is the
only file touched outside `packages/extraction/**`. It was needed because the structured payloads
are the extraction→STORE contract; relying on `looseObject` pass-through would have left the
boundary unvalidated. `docs/architecture/event-memory-schemas.md` §3 does not yet list them — the
coordinator owns that doc and should sync it (same pattern as commit `dec90b3`).

## Validation

- Focused: `packages/extraction` 121 pass / 0 fail (was 59 tests at base) —
  `src/enrichment/failure.test.ts` 31, `src/enrichment/decision.test.ts` 17,
  `src/heuristic/extractor.test.ts` 20 (11 before), `src/llm/extractor.test.ts` 15 (10 before).
  Negative cases are pinned: a chatter session whose only legitimate candidate is the stated
  preference yields no decision/failure candidate and no payload/signature anywhere; a passing
  command whose output mentions "cannot find module" is not a failure; "we ruled out X because Y",
  "that makes sense because …" and "I prefer …" produce no decision payload; decision noise
  ("we decided to take a break") is still discarded.
- Typechecks (strict, `tsc --noEmit`): core, extraction, mcp, retrieval, storage, apps/api,
  apps/cli — all clean.
- Full suite at the worktree root: **960 pass / 18 skip / 0 fail** (978 tests, 71 files). Base was
  898 pass / 18 skip / 0 fail (916 tests, 69 files); the 62 added tests are this mission's.
- `apps/api/src/runtime/extraction-temporal.test.ts` (Phase-1 combined acceptance) is **unchanged
  and green**: the golden transcript still yields exactly 8 memories / 4 working notes, because the
  golden decision states no alternatives/rationale and the golden failure incident is unchanged —
  only the failure content prefix (`Error:` → `Failure: MODULE_NOT_FOUND —`) and the stored
  `prompt_version` moved. No edit to that file was needed; no other package's fixtures changed.
- macOS host, no Postgres: storage server-leg tests remain environment-gated skips (18 skips).

## Explicitly not complete

1. **STORE wiring for the payload tables is deferred** (out of this slice's file ownership): the
   `decisions` and `failures` payload rows are still not written. `insertMemory` writes the
   `memories` row only, so `decision_payload`/`failure_signature` currently live on the candidate
   and in the durable `content`, not in `decisions.alternatives` / `failures.signature_hash`. The
   structured fields are the exact input that wiring needs (`title`/`participants`/`decided_at`/
   `status` derive at STORE; `problem`/`context`/`solution`/`verification` derive from the
   candidate's label, command/tool, resolution and evidence). `packages/storage/**` is owned by the
   parallel M4c mission in this wave, so this was cut, not faked. A small extraction-side gap
   remains until it lands: post-STORE, the persisted memory does not expose the signature, so
   recurrence counting (`occurrence_count`, `last_seen_at`) is still impossible.
2. **Recurrence and promotion logic** (ADR-0009 rule 1 skill candidates, memory-model.md §9
   promotion `proposed → accepted`) is M14/consolidation work; this slice only makes the inputs
   exist. Nothing decides that two signatures are the same failure yet.
3. **Rationale recall is deliberately narrow**: only `because/since/due to/owing to/given
   that/so that` inside the decision's own sentence, and only same-source rejection statements
   (a rejection stated in a *different* message of the same session is not attached). Bare `so`
   and cross-event pronoun resolution are not attempted; the LLM path covers the long tail.
4. **`conversation.tool_result` failures are not incidents**: `tool` is populated from an
   `error.raised` with `origin: 'tool'` (the context's leading token) or from a command's
   executable/test framework, but a failed tool result with no accompanying error event does not
   create a failure memory — that needs a tool-name field on the normalized event, which is a
   NORMALIZE-shape change beyond this slice.
5. **No benchmarks/token measurement** were added for the enriched content (M11 owns benchmarks).
   Content growth is bounded by design: decisions add the rationale clause, failures add a ~20-char
   class prefix; nothing else in the candidate grew.
6. **`docs/architecture/event-memory-schemas.md` and `database-schema.md` are not updated**
   (coordinator-owned): §3 does not list `decision_payload`/`failure_signature`, and the
   `failures`/`decisions` payload docs remain aspirational until item 1 lands.
