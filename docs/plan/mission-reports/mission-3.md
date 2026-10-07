# Mission 3 report — Model router, embeddings, extraction

**Branch:** `mission/3-extraction` (from `d26b3e5`; main has since advanced — see §6)
**Scope delivered:** (A) `@onememory-ai/llm` (model router, ADR-0006 §1–§2), (B) `@onememory-ai/embeddings`
(§3–§5), (C) `@onememory-ai/extraction` (EXTRACT stage 4 + CLASSIFY stage 5 + NORMALIZE stage 3 handlers),
(D) tests, (E) this report. No files outside the three new packages + this report + `bun.lock` were touched.

---

## 1. What changed

86 files, ~6.7k lines across three new packages (llm 1.2k, embeddings 1.5k, extraction 3.9k).

**Mission packages under `bun test`: 111 pass / 1 skip / 0 fail** (the skip is the
`ONEMEMORY_TESTS_LOCAL_EMBEDDINGS=1`-gated local-model download, by design). `tsc --noEmit` strict-clean
in all three packages.

### Commits (this branch)

1. `c1fb4ef` `feat(llm): model router with per-operation routing and AI SDK v6 provider`
2. `52a6310` `feat(embeddings): Ollama, OpenAI-compatible, and local transformers embedders`
3. `ecbca3b` `feat(extraction): heuristic + LLM extractors, classifier, future-value gate, job handlers`

---

## 2. `@onememory-ai/llm` — the model router (ADR-0006 §1–§2)

- **Internal `ModelProvider` seam** (`src/provider.ts`): `generate<T>({ operation, schema, prompt, … })`
  → `{ value, raw }`, validated against the caller's Zod schema at the provider boundary. The router,
  the retry loop, and the extraction package all depend on this seam only — the AI SDK is an
  implementation detail behind `providerFactory`.
- **AI SDK v6 implementation** (`src/providers/ai-sdk.ts`): dynamic per-kind imports (`@ai-sdk/openai`,
  `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai-compatible` — only the selected provider is ever
  imported), structured output via `generateText({ output: Output.object({ schema }) })`, `maxRetries: 0`
  (retry is owned, bounded and observable at the router). `ollama` is routed through the
  OpenAI-compatible provider against Ollama's `/v1` surface (ADR-0006 §2).
- **Config-driven routing table** (`src/config.ts`): `RouterConfigSchema` = `{ profile?, providers, routes,
  defaults? }`; `routes` is a **strict object** over the six operations (`embedding`, `classify`, `extract`,
  `consolidate`, `conflict`, `summarize`) — an unknown key is a typo, not forward compatibility, and fails
  loudly. `api_key_env` preferred over `api_key`; no key material is ever logged.
- **Fail-closed semantics** (`src/router.ts`, `src/errors.ts`): an unconfigured operation throws
  `RouterUnavailableError`; a schema-invalid model output throws `ModelProviderError('invalid-output', …)`
  after a bounded corrective retry (`max_retries` default 2, hard cap 5; the retry appends the validation
  issues and an "ONLY valid JSON" instruction); `local` profile (default) rejects hosted provider kinds
  (`openai`/`anthropic`/`google`) and non-loopback `base_url`s (`isLoopbackBaseUrl`).
- **21 tests**: routing resolution per operation, profile gating, loopback enforcement, retry-with-instruction,
  invalid-output typed failure, unconfigured failure, config parse (strict routes, api_key_env resolution).

## 3. `@onememory-ai/embeddings` — `Embedder` implementations (ADR-0006 §3–§5)

- **`createOllamaEmbedder`** — native `POST /api/embed` (not the OpenAI-compatible `/v1/embeddings`),
  loopback default `http://127.0.0.1:11434`, `keep_alive` support, batch + order restoration.
- **`createOpenAiCompatibleEmbedder`** — `{baseURL}/embeddings` for LM Studio / llama.cpp / vLLM
  (hosted only when explicitly configured + allowed by profile).
- **`createLocalTransformersEmbedder`** — optional peer `@huggingface/transformers ^4.3.0`, pinned
  `Xenova/bge-small-en-v1.5` @ revision `ea104dacec62c0de699686887e3f920caeb4f3e3`, 384-d, mean pooling +
  L2 normalization computed locally; **fully offline**. The env-gated real-model test
  (`ONEMEMORY_TESTS_LOCAL_EMBEDDINGS=1`) is skipped by default so `bun test` never downloads weights.
- **Vector provenance everywhere** (`src/types.ts` `EmbedderMeta`): every embedder reports
  `provider/model/dim/revision`; dimension is discovered, never guessed (Ollama/OpenAI-compatible learn it
  from the first response; `dim` access on a not-yet-called local embedder throws instead of lying).
- **`createReEmbedJobHandler(vectorsIndex, embedder, embedderMeta)`** (`src/re-embed-job.ts`) — the
  `re_embed` handler factory exported for M13. Fails closed on provenance drift: embedder-meta model ≠
  embedder model, index model ≠ embedder model, dim mismatches (meta or live), and stale payloads naming a
  different model/revision are all `ReEmbedError`s. Payload items carry `{ memory_id, text }` (text is never
  persisted — `memory_vectors` stores vectors only).
- **31 tests + 1 env-gated skip**: happy paths against fake `fetch`, error taxonomy, order restoration,
  provenance agreement (every mismatch rejected), re_embed payload validation + batching.

## 4. `@onememory-ai/extraction` — NORMALIZE / EXTRACT / CLASSIFY + handlers

- **`src/events.ts` (NORMALIZE, pure)**: `normalizeEvent` parses each event payload through core's
  canonical `PayloadSchemaByKind` into a structured `NormalizedEvent` (command + exit code + normalized
  command, error, file, tests, commit, PR, document, explicit); `normalizeCommand` keeps the executable +
  subcommand and drops flags/paths/env-assignments (`NODE_ENV=test bun test` → `''`); unknown kinds map to
  `api` sources; `storedEventToEnvelope` re-validated a stored row back into a core envelope. Malformed
  payloads throw `NormalizationError` — the **handler** flags the event `needs_review`, never drops it.
- **`src/heuristic/patterns.ts` + `extractor.ts` (EXTRACT baseline, zero LLM)**: eight recognition families
  — stack decisions (with a tech-alias catalogue: `postgres`≈`pg`≈`postgresql`…), preferences
  (both `prefer X over Y` and imperative `always/never …`), resolved failures (error message paired with the
  next successful command, exit-code verified, incident de-duplicated), versions, procedural sequences
  (adjacent distinct commands, `git status`-style noise denied), recurring commands (≥2 uses, deny-listed
  commands excluded), episodic stack mentions from commit messages, and `explicit.remember`.
  Every candidate carries `importance`, `confidence`, `entities`, `future_value_rationale`, and **evidence
  spans** (`event:<id>` / `commit:<sha>` + ≤200-char excerpt).
- **`src/gate.ts` (future-value gate — risk R6 pollution guard)**: floors on importance/confidence, evidence
  and rationale required, minimum content length, semantic-candidate confidence surcharge, in-batch merge of
  identical statements (unions evidence, keeps max importance), `max_memories`/`max_working` caps after
  importance sort; every discard is counted with a reason.
- **`src/llm/prompt.ts` + `extractor.ts` (EXTRACT recall path)**: bounded, numbered event list
  (`[n] (kind) text`) with an output schema that cites **event indexes only** — the extractor resolves them
  to real events and drops any candidate whose citations don't resolve (provenance is mandatory), so a
  hallucinated memory can never be stored. `type: 'semantic'` is rejected at the schema (must be
  `semantic_candidate`); retry/typed-failure reuse the router's `generateStructuredWithRetry`;
  `EXTRACTION_PROMPT_VERSION = 'extract-v1'`. `createFallbackExtractor(llm, heuristic)` is the pipeline's
  degradation policy (LLM unavailable/error → heuristics, with `onFallback` telemetry).
- **`src/classifier.ts` (CLASSIFY)**: type/subtype assignment, the **semantic-candidate rule** (`semantic`
  is only ever created by consolidation — a leaked `semantic` is coerced back to a candidate with
  `durable_type: 'episodic'`, `awaiting_consolidation: true`; `semantic.explicit` from an explicit user
  statement is the one exception), and working-signal routing (`unresolved_error → current_error`,
  `edited_file → current_file`, `stated_task`, `stated_hypothesis → hypothesis`, `open_question`,
  `temp_decision`) with repair (trim/collapse, truncate to 299, reject session-less or empty).
- **`src/handlers/normalize.ts` / `extract.ts` (job handler factories for M13)**:
  - NORMALIZE: `listPendingEvents` → `normalizeEvent` each → result counts + the structured batch is
    carried in the enqueued `extract` job payload (singleton key while pending) — events are **not** marked
    processed here; EXTRACT owns that transition.
  - EXTRACT: groups pending events by `project|session|runtime`, creates one `sources` row per group,
    re-validates stored payloads (malformed → `needs_review`, skipped, never dropped), runs
    extractor → classifier, **dedupe probe before every insert** (`store.findDuplicate`), stores with
    full provenance (`extraction.method/model/prompt_version`, evidence, `tags: ['extracted',
    'semantic_candidate'?]`), inserts working rows (creating the session upsert — `working_memory.session_id`
    FK), marks every event processed, and enqueues `re_embed` backfill jobs carrying
    `{ memory_id, text }` items (batched, `reason: 'backfill'`). Extractor failure fails the job and leaves
    every event pending (retry with backoff); `event_ids` in the payload can scope the run.
- **`src/testing/transcripts.ts`**: synthetic golden/noise/sessionless fixture transcripts (no secrets, no
  real transcripts). The golden session produces **8 durable candidates + 4 working signals from 20 events**
  (decision, 2 preferences, resolved failure with paired evidence, version, procedural sequence, recurring
  command, commit-message stack mention; current_error/current_file/hypothesis/open_question); the noise
  session produces **zero** candidates.
- **59 tests**: heuristic golden/noise/sessionless/gate-threshold suites; classifier; gate; events
  (normalize/command/envelope/needs_review); LLM extractor against an injected fake `ModelProvider` that
  re-validates with the router-supplied schema (invalid-JSON retry, `semantic` rejection, unresolvable
  citations dropped, unconfigured router, fallback on/off); and **handler integration on embedded PGlite**
  (temp data dirs, real migrations): events → stored memories with provenance + audit rows, dedupe probe
  across runs, idempotency, extractor-failure leaves events pending, `needs_review` flagging, `re_embed`
  enqueue + payload shape, worker wiring (`JobKindNotImplemented` → retry → dead-letter; registered
  handler → done).

---

## 5. Deviations from the normative docs (all deliberate)

1. **The NORMALIZE batch is carried in `jobs.payload`, not an `events.normalized` column.** memory-model §9
   has NORMALIZE persist structured forms; M1's committed schema has no such column (the pipeline's only
   WIP channel is `jobs.payload`). The handler recomputes normalized forms at EXTRACT from `events.payload`
   — `normalizeEvent` is a pure function, so this is idempotent and auditable. A later migration can add the
   column if NORMALIZE output must be queryable; decision for the coordinating session.
2. **BGE query/passage prefixes are not implemented.** bge-small prescribes `Represent this sentence…`
   for queries vs raw passages; core's `Embedder` port has a single `embed(texts)` with no query/passage
   split, and the local-first default only embeds passages (memories). Adding prefixes needs a core port
   change (`embedQuery`/`embedPassages`) — a decision for the coordinating session / M2 retrieval, since it
   also changes what's stored (prefix is never persisted, only the vector).
3. **`routes` is a strict object.** An unknown operation key in the routing table is a typo, not forward
   compatibility; it fails loudly rather than silently serving an operation from no provider.
4. **Provider majors are pinned to AI SDK v6 compatibility** (`@ai-sdk/openai ^2.0.133`, `@ai-sdk/anthropic
   ^2.0.108`, `@ai-sdk/google ^2.0.101`, `@ai-sdk/openai-compatible ^1.0.58`, `ai ^6.0.300`): latest
   provider majors expose `LanguageModelV4`, which v6 rejects. Verified by resolution probe before pinning.
5. **Heuristic subtype inference** (`decision.statement` vs `decision.choice`, `procedural.sequence` vs
   `procedural.command`, `failure.observed` vs `failure.resolved`) lives in the classifier, not the
   extractor — the extractor stays pattern-only so an LLM extractor reuses the same classification.
6. **`explicit.remember` with `type: 'decision'` is stored as a decision** (explicit statements are the
   one path allowed to declare a durable type directly); plain explicit statements become
   `semantic_candidate`/`semantic.explicit`.

## 6. Pre-existing red tests on this branch's base (not caused by M3)

Full-repo `bun test` on this branch: **196 pass / 15 skip / 2 fail**. Both failures are in M1's storage
suites and are the wall-clock time-bomb already fixed on main by `02546c7`
("fix(storage): deterministic clock in job and working-memory integration tests", found by M2 close-out):
the GATE-1 claim test and the embedded jobs scenario claimed at the fixed instant `2026-10-03T12:00Z`
while enqueue defaulted `run_at` to the real clock — the branch base (`d26b3e5`) predates that fix, so the
suite goes red once the wall clock passes that time. **M3 did not touch `packages/storage`; the merge with
main resolves both.** (Reproduced root-cause exactly: `run_at` DDL default is `now()`, claim predicate
`run_at <= $fixed`.) Mission packages alone are green: `bun test packages/llm packages/embeddings
packages/extraction` → 111 pass / 1 skip / 0 fail.

## 7. Decisions needed (coordinating session)

1. **`events.normalized` column vs payload-carried batch** (deviation 1): keep the payload-carried batch
   (recommended — no migration, pure recomputation) or schedule a column migration.
2. **Query/passage prefixes on the `Embedder` port** (deviation 2): needed for best bge-small retrieval
   quality; requires a core port change and affects M2. Recommended: add `embedQuery(texts)` later, keep
   passages prefix-free for storage.
3. **bun.lock merge**: main advanced (M2 retrieval, M12 redaction, storage test fix) after this branch
   forked at `d26b3e5`; both sides added dependencies to `bun.lock`. Expect a trivial lock merge (disjoint
   packages) — flagging it so the merge isn't mistaken for a conflict of substance.

## 8. Follow-ups (handed to later missions / the coordinating session)

- **M13 wiring** (no blockers — all factories are exported; see §9): register `normalize` / `extract` /
  `re_embed` in one handler registry; `re_embed` requires an `Embedder` + `EmbeddingIndex` bound to the same
  model/dim (config-owned).
- **Worker-process ONNX fallback**: transformers.js runs in-process today; running the local embedder (and
  LLM calls) in a child process to keep the daemon's event loop unblocked is an M13+ daemon concern.
- **Dimension discovery UX**: `createEmbeddedDb(dataDir, { vectors: { dim, model } })` must match the
  configured embedder; a `onemem doctor` check (M16/CLI) should compare them at startup and fail closed.
- **Consolidation (M-later)** consumes `semantic_candidate`-tagged memories (`awaiting_consolidation`) and
  is the only creator of `type: 'semantic'`.
- **LLM-extractor prompt tuning** belongs to the M11 benchmarks (prompt version is already recorded per
  memory via `prompt_version`).

## 9. What M12/M13/M16 can rely on now (API surface)

### `@onememory-ai/llm`

| Export | Purpose |
|---|---|
| `createModelRouter(config, options?)` | the router; `options.providerFactory` overrides the AI SDK (tests) |
| `createAiSdkProviderFactory()` | default factory; `DEFAULT_OLLAMA_BASE_URL` |
| `parseRouterConfig(input)` / `RouterConfigSchema` | the `llm:` config fragment (below) |
| `generateStructuredWithRetry` | bounded retry used by every structured call site |
| `RouterUnavailableError`, `ModelProviderError`, `StructuredOutputError` | typed failure taxonomy |
| `isLoopbackBaseUrl`, `isHostedProviderKind`, `MODEL_OPERATIONS`, `PROVIDER_KINDS`, `ROUTER_PROFILES` | vocabulary |

### `@onememory-ai/embeddings`

| Export | Purpose |
|---|---|
| `createOllamaEmbedder` / `createOpenAiCompatibleEmbedder` | HTTP embedders (loopback defaults) |
| `createLocalTransformersEmbedder` | offline, pinned bge-small-en-v1.5 (384-d); optional peer dep |
| `createReEmbedJobHandler(vectors, embedder, meta)` | the `re_embed` handler for the M13 registry |
| `ReEmbedJobPayloadSchema`, `RE_EMBED_JOB_KIND`, `ReEmbedError` | payload contract + failures |
| `EmbedderMeta` (`{ provider, model, dim, revision? }`) | the provenance record the config must match |

### `@onememory-ai/extraction`

| Export | Purpose |
|---|---|
| `createHeuristicExtractor()` / `createLlmExtractor({ router })` / `createFallbackExtractor(llm, heuristic)` | the EXTRACT strategies |
| `createHeuristicClassifier()` | CLASSIFY + working routing (`classify`, `routeWorking`, `normalizeWorking`) |
| `createFutureValueGate()` | thresholds + discard accounting |
| `createNormalizeHandler(store, jobs)` / `createExtractHandler(store, jobs, extractor, classifier)` | the job handler factories for M13 |
| `normalizeEvent`, `storedEventToEnvelope`, `normalizeCommand`, `buildEvidence` | the NORMALIZE vocabulary |
| `buildExtractionPrompt`, `EXTRACTION_PROMPT_VERSION` | the LLM prompt + version stamp |
| pattern catalogue (`DECISION_PATTERNS`, `PREFERENCE_PATTERNS`, `VERSION_PATTERNS`, `COMMAND_DENYLIST`, `extractTechMentions`) | extensible heuristic vocabulary for M3b/M11 |

### M13 daemon wiring (exact shape)

```ts
const embedder = createOllamaEmbedder({ model: 'nomic-embed-text', dim: 768 });
const storage = await createEmbeddedDb(dataDir, { vector: { model: embedder.model, dim: 768 } });
const router = createModelRouter(parseRouterConfig(config.llm));
const extractor = createFallbackExtractor(
  createLlmExtractor({ router }),
  createHeuristicExtractor(),
);
const normalize = createNormalizeHandler(storage.store, storage.jobs);
const extract = createExtractHandler(storage.store, storage.jobs, extractor, createHeuristicClassifier());
const reEmbed = createReEmbedJobHandler(storage.vectors, embedder, embedder.meta);

const worker = createJobWorker({
  db: storage.client,
  registry: createHandlerRegistry({
    normalize: async ({ job }) => {
      await normalize(job);
    },
    extract: async ({ job }) => {
      await extract(job);
    },
    re_embed: async ({ job }) => {
      await reEmbed(job);
    },
  }),
});
```

The `vector.model`/`vector.dim` must match the embedder (`createReEmbedJobHandler` fails closed on
any mismatch, and `embedder.probe()` forces dimension discovery for the `onemem doctor` check).

### M16 config fragment (`llm:` — the normative shape, validated by `RouterConfigSchema`)

```yaml
llm:
  profile: local                    # local | hybrid | server (default local — fail-closed)
  providers:
    - id: ollama
      kind: ollama                  # openai | anthropic | google | openai-compatible | ollama
      base_url: http://127.0.0.1:11434/v1
    # - id: openai
    #   kind: openai
    #   api_key_env: ONEMEMORY_OPENAI_API_KEY   # env var name, never the key itself
  routes:                           # strict: unknown operation keys are rejected
    extract:      { provider: ollama, model: qwen3:8b }
    # classify:   { provider: ollama, model: … }
    # consolidate: { provider: ollama, model: … }
    # conflict:   { provider: ollama, model: … }
    # summarize:  { provider: ollama, model: … }
    # embedding:  { provider: …, model: … }     # embeddings may also be served via the router
  defaults: { temperature: 0.2, max_retries: 2, max_output_tokens: 2048, timeout_ms: 60000 }
```

`profile: local` rejects hosted kinds and non-loopback base URLs; an unset route for an operation fails
closed with `RouterUnavailableError` — the caller (e.g. `createFallbackExtractor`) degrades to heuristics.
`embedding:` routes are for future classify-side embeddings; the `@onememory-ai/embeddings` package is the
primary embedder path and does not go through the router.
