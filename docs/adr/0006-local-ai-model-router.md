# ADR-0006: Local-first AI — model router with per-operation routing; zero network by default

Status: Accepted · Date: 2026-10-03

## Context

Spec §18/§19/§27: everything must work without OpenAI/Anthropic APIs; local providers (Ollama,
llama.cpp, vLLM, LM Studio) supported; different memory operations use different models; 100%
local mode (no telemetry, no external calls, no account) is first-class. Critical engineering rule
§37: reuse the LLM abstraction rather than building one.

## Decision

1. **Router table** (config-driven, per operation class):

| Operation | Default profile | Notes |
|---|---|---|
| Embedding | local model | see below; one active model per deployment, dim recorded |
| Classification / dedupe assist | cheap local model if configured; rules otherwise | |
| Extraction | cheap/medium model if configured; heuristics otherwise | heuristics are the correctness baseline, never a stub |
| Consolidation / semantic derivation | strongest configured model | off-peak job |
| Conflict / contradiction adjudication | reasoning model if configured; authority rules otherwise | ADR-0003 order |
| Summarization / compression | cheap model or deterministic truncation rules | |

2. **Abstraction**: Vercel AI SDK v6 (Apache-2.0) behind our internal `ModelProvider` interface;
   providers loaded modularly (only the selected provider imports). Structured output via
   `generateText({ output: Output.object({ schema }) })` with Zod validation and explicit
   retries/fallbacks — never trust JSON-shaped output (AI SDK v6 note: `generateObject` is
   deprecated). Local OpenAI-compatible endpoints (LM Studio, llama.cpp, vLLM, Ollama `/v1`) work
   via `baseURL`; **Ollama embeddings use the native `/api/embed`** (current API; `/api/embeddings`
   is deprecated — do not bake it in).
3. **Default embedding provider**:
   - **Ollama, if detected/present** (nomic-embed-text / bge-m3 class): preferred — out-of-process
     inference sidesteps Bun×ONNX risk entirely.
   - **Else transformers.js v4** (`@huggingface/transformers` 4.x) with a small pinned model
     (bge-small-en-v1.5, 384-d, MIT weights — stronger than MiniLM at similar size) — **gated on a
     Bun × OS × backend smoke matrix**; if it fails, inference runs in a Node worker process;
     if unavailable, embedded profile degrades to lexical+graph retrieval with a warning.
   - First-run model download is documented (not zero-network on first use; prewarm command
     provided; model revision pinned so vectors are reproducible).
4. **Fail closed**: missing local provider → operation degrades (heuristic/lexical), never silently
   routes to a cloud provider. Cloud providers are opt-in per profile and clearly labeled
   (`hybrid`, `server`). Telemetry is opt-in, never default-on.
5. **Vector provenance**: `memory_vectors.model` + dim + revision recorded; any model/prefix/normalization
   change triggers the `re_embed` job (ADR-0002). Vectors from different models never mix in one index.

## Consequences

- The engine's correctness never depends on a model: heuristic extraction, rule-based dedupe,
  authority-based conflict resolution, lexical retrieval all work at zero network cost.
- Quality (extraction recall, semantic dedupe, consolidation) measurably improves with models —
  benchmarks must run both modes (M11).
- Model licenses/weights (bge = MIT; MiniLM/Arctic = Apache-2.0; nomic = Apache-2.0) recorded in
  the model catalog; release license scan includes them.

## References

`docs/research/dependency-verification.md` §5–§7 (embedding/router verdicts), §11;
`docs/research/memory-systems-landscape.md` avoid-item 6 (no standing LLM per ingest);
`docs/risks.md` R3, R4, R9, D2/D5.
