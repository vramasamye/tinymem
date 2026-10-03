# onememory dependency verification

**Snapshot:** 2026-10-03  
**Scope:** Architecture-stage build-vs-reuse research; not an install or compatibility test.  
**Licenses:** Package license labels below are preliminary registry/repository metadata checks; verify transitive dependencies and model-weight terms before distribution.  
**Maturity method:** Prefer current npm version/release evidence and official docs over stale comparisons. Search result snippets did not consistently expose GitHub star or npm weekly-download totals, so no unsourced counts are invented. Where available, npm “projects using” counts are an adoption proxy, not download counts.

## Summary

- **Adopt the server-mode foundation:** PostgreSQL + upstream `pgvector`; PostgreSQL already supplies `tsvector` full-text search, and one SQL query can fuse lexical and vector rankings.
- **Keep PGlite as an evaluation target, not the storage commitment:** PGlite runs on Bun/Node and has a separate WASM `pgvector` extension package, but that package is still `0.0.x`; test extension/index parity, upgrade/recovery, and real workload performance first.
- **Use Drizzle as the provisional ORM:** it has PostgreSQL, PGlite, and vector support. Keep migrations in SQL/Drizzle Kit and exercise the same migrations against both real PostgreSQL and PGlite.
- **Make local embeddings a first-class provider:** Ollama’s current native endpoint is `/api/embed`; an in-process Transformers.js path is viable in principle but ONNX/Bun compatibility and CPU performance require an explicit matrix test.
- **Choose Hono + `@hono/zod-openapi`, Commander + Clack, and a native-Git wrapper/CLI path** for Bun with Node LTS portability.
- **Avoid speculative infrastructure:** do not add pgvectorscale, a reranker, graph clustering, or a general-purpose queue until measured workload needs justify their complexity.
- **The project’s zero-external-API mode is an application policy, not a property of AI SDK:** no remote provider should be selected by default; an embedded model or user-configured Ollama must work without credentials or network access.

## Verdicts by area

### 1. Storage: `@electric-sql/pglite`

**Verdict: EVALUATE** for the embedded/no-Docker profile; **do not replace PostgreSQL server mode**.

- PGlite is PostgreSQL compiled to WASM, with Node, Bun, and browser support; docs describe a database embedded in the app rather than a separately managed server.
- PGlite is on the **0.5.x** line: the latest surfaced GitHub release was **`@electric-sql/pglite` 0.5.8**. v0.4 was announced 2026-03-25 and 0.5.x has subsequent release tags; the search index did not return a trustworthy exact publish timestamp for 0.5.8. Confirm npm’s `latest` tag before pinning.
- Maturity/adoption: Electric reported **10 million weekly npm downloads** in June 2026. This is a strong adoption signal, but includes repeated/transitive installs and does not itself establish production suitability for this workload.
- Extension verification: **yes**—PGlite’s extension catalog links a separate `@electric-sql/pglite-pgvector` package, explicitly identified as pgvector for PGlite; its latest surfaced version was **0.0.9**, published 2026-08-26. This establishes a loadable `vector` extension path, not parity of every upstream pgvector feature/index.
- PostgreSQL FTS types and operators, including `tsvector`, are part of PostgreSQL; PGlite is a WASM Postgres build. Validate actual generated columns, GIN indexes, ranking, and migrations inside the chosen PGlite version.
- PGlite supports persistence through its virtual filesystem. For a local Node/Bun process, test its documented filesystem adapter and crash/restart behavior; browser IndexedDB persistence is a different deployment case.
- PGlite is an embedded in-process database, not a networked multi-client server. Recent v0.4 material adds connection multiplexing within an instance. That does not make multiple processes safe: a July 2026 report describes concurrent Node processes initializing PGlite causing a SIGSEGV, and a September issue asks for a stronger NodeFS persistence/durability contract. Keep one owner process per data directory; explicitly test write acknowledgment, fsync/reopen, backup, and crash/power-loss recovery.
- Drizzle documents a PGlite adapter. Use one instance per process and serialize writes; a connection pool does not create PostgreSQL server concurrency.
- Performance is native Postgres-like SQL semantics over WASM, not native PostgreSQL throughput. Expect higher initialization/compute cost and lower parallelism; benchmark load, indexes, restart, and representative retrieval on target machines.
- Production/adoption check: high package adoption, but no named production deployment with onememory-like persistent local agent data was verified. Public positioning remains embedded/local use, not a drop-in multi-tenant PostgreSQL server.
- License: the PGlite wrapper is MIT-licensed; its bundled PostgreSQL-derived code carries PostgreSQL licensing notices. The extension package has its own metadata, which should be included in the release license scan.

Sources: [PGlite repository](https://github.com/electric-sql/pglite), [0.5.8 release](https://github.com/electric-sql/pglite/releases/tag/%40electric-sql/pglite%400.5.8), [release history](https://github.com/electric-sql/pglite/releases), [v0.4 announcement](https://electric.ax/blog/2026/03/25/announcing-pglite-v04), [10m weekly downloads announcement](https://electric.ax/blog/2026/06/25/pglite-reaches-10-million-weekly-downloads), [license](https://github.com/electric-sql/pglite/blob/main/LICENSE), [PostgreSQL license notice](https://github.com/electric-sql/pglite/blob/main/POSTGRES-LICENSE), [filesystem docs](https://pglite.dev/docs/filesystems), [NodeFS durability issue](https://github.com/electric-sql/pglite/issues/1107), [concurrent initialization issue](https://github.com/electric-sql/pglite/issues/1053), [ORM support](https://pglite.dev/docs/orm-support), [`pglite-pgvector` npm](https://www.npmjs.com/package/@electric-sql/pglite-pgvector), [PGlite extensions](https://pglite.dev/extensions/).

### 2. Server storage: `pg` + `pgvector`

**Verdict: ADOPT** for server mode.

- `pg` / node-postgres is a mature Node PostgreSQL client; npm surfaced **8.23.1**, published 2026-09-30. It is pure JavaScript for the standard client path and works with Node LTS; run a Bun smoke test for the exact pool/TLS configuration.
- `pgvector`’s extension is mature and maintained upstream. **0.8.2** was released 2026-02-26; its release fixes a buffer overflow in parallel HNSW index builds (CVE-2026-3172). Prefer at least this fixed version where server images expose it; check upstream tags and deployment-image availability before pinning. pgvector uses the PostgreSQL License.
- `pgvector-node` supplies TypeScript/Node/Deno/Bun serialization support; npm surfaced **`pgvector` 0.3.0**, last published about three months before this snapshot. It is a convenience layer, not the database extension.
- HNSW: generally the better first ANN index when recall/latency matter and index memory/build cost is acceptable; tune `m`, `ef_construction`, and query `ef_search`.
- IVFFlat: lower build/memory cost and tunable `lists`/`probes`, but needs representative data and careful recall tuning. Do not build it before a useful training corpus exists.
- Approximate indexes can return too few rows after selective filters. pgvector 0.8-era iterative scans improve this case; verify query plans and filtered recall.
- Hybrid search is available without another search service: rank a `tsvector`/`tsquery` candidate set and vector KNN candidates in separate CTEs, then fuse ranks with Reciprocal Rank Fusion (RRF), e.g. `sum(1 / (k + rank))`. Tune lexical/vector candidate depth and `k` on judged queries.
- `pgvectorscale` adds DiskANN-oriented indexing and can be relevant once the vector index is memory-bound at larger scale; it is a PostgreSQL extension with separate build/deployment requirements and ecosystem surface. It is not a PGlite extension and is not justified for the initial local-first design.
- License: `pg` and `pgvector-node` are permissively licensed (verify exact package metadata); upstream pgvector uses the PostgreSQL license. No new license restriction is apparent from the cited upstream materials.

Sources: [`pg` npm](https://www.npmjs.com/package/pg), [node-postgres docs](https://node-postgres.com/), [pgvector](https://github.com/pgvector/pgvector), [pgvector 0.8.2 release](https://www.postgresql.org/about/news/pgvector-082-released-3245/), [pgvector release notes](https://github.com/pgvector/pgvector/releases), [pgvector-node](https://github.com/pgvector/pgvector-node), [pgvector-node npm](https://www.npmjs.com/package/pgvector), [PostgreSQL text-search types](https://www.postgresql.org/docs/current/datatype-textsearch.html), [text-search controls](https://www.postgresql.org/docs/current/textsearch-controls.html), [pgvectorscale](https://github.com/timescale/pgvectorscale).

### 3. ORM: Drizzle vs Kysely

**Verdict: ADOPT Drizzle provisionally; EVALUATE migration parity.**

- `drizzle-orm` npm surfaced **0.45.3**, published 2026-09-21, with thousands of dependent projects shown in the registry result. Its frequent releases are active maintenance, but mean pin/upgrade discipline matters.
- Drizzle has a PGlite connection adapter and native PostgreSQL vector column support (`vector(name, { dimensions })`); vector operators, custom SQL ranking, and some index details may still need SQL expressions.
- The migration model is schema + generated SQL via Drizzle Kit. Commit generated migrations; test them against a fresh PostgreSQL database and PGlite, including `CREATE EXTENSION`, vector indexes, generated `tsvector`, and downgrade/recovery expectations.
- PGlite adapter support is not equivalent to full Drizzle Studio / migration-tool support for every extension; there has been an upstream issue around PGlite extensions in Studio.
- Kysely **0.29.5** was surfaced as last published about a month before the snapshot. It is a mature, type-safe SQL query builder (MIT) with a smaller abstraction footprint than an ORM.
- The `kysely-pglite` adapter surfaced at **0.6.1**, last published around two years ago. That specific adapter’s release age is a meaningful maintenance concern; do not infer current compatibility from Kysely’s own recent release.
- Choose Kysely instead if SQL-first query composition is more valuable than Drizzle’s schema/migration DX; avoid mixing both for the same tables.

Sources: [Drizzle npm](https://www.npmjs.com/package/drizzle-orm), [Drizzle PostgreSQL vector guide](https://orm.drizzle.team/docs/guides/vector-similarity-search), [PGlite connection guide](https://orm.drizzle.team/docs/connect-pglite), [PGlite ORM support](https://pglite.dev/docs/orm-support), [Drizzle releases](https://github.com/drizzle-team/drizzle-orm/releases), [Kysely npm](https://www.npmjs.com/package/kysely), [`kysely-pglite` npm](https://www.npmjs.com/package/kysely-pglite).

### 4. Embedded fallback: `bun:sqlite` + `sqlite-vec` + FTS5

**Verdict: EVALUATE only if PGlite fails the embedded acceptance test; otherwise AVOID as the primary storage dialect.**

- `sqlite-vec` npm surfaced **0.1.9**, published about five months before the snapshot, with about 994 registry projects shown as using it. That is useful adoption, but it remains a 0.x extension with a comparatively young API and release cadence.
- Its project documents JavaScript integrations for Bun and provides a simple Bun example. It is a loadable extension; test extension loading/binaries and distribution on macOS, Linux, Windows, and arm64/x64.
- FTS5 plus vector KNN and RRF is a viable SQLite hybrid pattern. FTS5 availability depends on the SQLite build bundled by Bun; Bun SQLite/FTS5 bugs have also been reported, so check the actual supported Bun release and close/reopen behavior.
- SQLite is a real dialect fork from the chosen Postgres-everywhere design: migrations, SQL types, concurrency semantics, and vector indexes will not remain identical.
- `sqlite-vec` is described as MIT OR Apache-2.0; verify the exact release and bundled binaries. `bun:sqlite` is part of Bun.

Sources: [`sqlite-vec` repository](https://github.com/asg017/sqlite-vec), [releases](https://github.com/asg017/sqlite-vec/releases), [JavaScript/Bun docs](https://alexgarcia.xyz/sqlite-vec/js.html), [Bun demo](https://github.com/asg017/sqlite-vec/blob/main/examples/simple-bun/demo.ts), [Bun FTS5 report](https://github.com/oven-sh/bun/issues/37044).

### 5. Local embeddings: Transformers.js and model choices

**Verdict: EVALUATE; do not promise in-process Bun inference until tested.**

- The prompt names Transformers.js v3, but that is stale: npm surfaced **`@huggingface/transformers` 4.3.0**, last published 2026-09-16. v4 is the current line; pin and read its v4 migration notes rather than selecting v3 from old examples.
- The feature-extraction pipeline supports embedding workflows; models commonly use mean pooling and normalization. Pin the model revision and pooling/task settings so a model upgrade does not silently make stored vectors incompatible.
- Node support is a first-class target, but the Node ONNX path uses native/runtime-specific components. Bun has historical issues with `onnxruntime-node` native bindings and Transformers.js itself. Use an explicit Bun × OS × architecture smoke matrix, and compare the WASM backend as a possible fallback.
- Model weights are downloaded/cached on first use through Hugging Face model loading. Ship clear cache location, offline prewarm, `local_files_only`/offline behavior, model revision pinning, and disk-space UX; first-run download is not zero-network.
- **all-MiniLM-L6-v2:** small 384-dimensional English baseline; often the easiest latency/footprint test. Model family is Apache-2.0. Its shorter context and retrieval quality may be limiting for coding-agent memory.
- **BGE-small-en-v1.5:** 384-dimensional, roughly 33M-parameter English retrieval model; likely a stronger small CPU baseline. The BAAI model family is MIT-licensed; follow its query/passage instruction convention consistently.
- **BGE-base-en-v1.5:** 768-dimensional, roughly 109M parameters; higher footprint and CPU cost. Compare only if small-model retrieval quality is insufficient.
- **Snowflake Arctic Embed XS/S/M:** Apache-2.0 family with increasing model sizes/cost. The XS/S variants are sensible local candidates; check that the selected exact ONNX export and Transformers.js task support are available.
- **nomic-embed-text-v1.5:** Apache-2.0, 768-dimensional/long-context option, but materially larger than small models and has search-query/document prefixes. Verify ONNX export provenance and practical throughput rather than assuming a standard Transformers.js model card is drop-in.
- Approximate float32 weight payload by parameter count is about 4 bytes/parameter (quantized weights are smaller); actual model downloads include config/tokenizer and may have multiple quantizations. Treat published “model size” figures as export-specific.
- No reliable apples-to-apples CPU latency number for Bun + the exact ONNX backend + these model exports was found. Warm latency depends heavily on CPU, backend, quantization, token length, batching, and first-use initialization.
- Benchmark cold startup/download separately from warm p50/p95 per text and batched texts on representative Apple Silicon and x64 machines. A short-text bi-encoder is likely viable for interactive use; larger/base models must earn their cost with retrieval gains.
- License applies separately to the JS package, ONNX runtime, and model weights; retain each model’s license and revision in the model catalog.

Sources: [Transformers.js npm](https://www.npmjs.com/package/@huggingface/transformers), [v4 announcement](https://huggingface.co/blog/transformersjs-v4), [Transformers.js docs](https://huggingface.co/docs/transformers.js/en/index), [pipeline API](https://huggingface.co/docs/transformers.js/en/api/pipelines), [ONNX backend docs](https://huggingface.co/docs/transformers.js/api/backends/onnx), [Bun ONNX issue](https://github.com/oven-sh/bun/issues/18079), [MiniLM](https://huggingface.co/Xenova/all-MiniLM-L6-v2), [BGE small](https://huggingface.co/Xenova/bge-small-en-v1.5), [BGE base](https://huggingface.co/Xenova/bge-base-en-v1.5), [Arctic XS](https://huggingface.co/Snowflake/snowflake-arctic-embed-xs), [Arctic S](https://huggingface.co/Snowflake/snowflake-arctic-embed-s), [Arctic M](https://huggingface.co/Snowflake/snowflake-arctic-embed-m), [Nomic](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5).

### 6. Local embedding/model endpoints

**Verdict: ADOPT provider adapters; prefer Ollama native embeddings, allow OpenAI-compatible endpoints.**

- Current Ollama embeddings API is **`POST /api/embed`**. `/api/embeddings` is the older/deprecated API; do not bake it into new clients.
- Ollama exposes OpenAI-compatible routes under `/v1`; the OpenAI TypeScript SDK can point at the local server with `baseURL`. Confirm embeddings on the precise Ollama version/model; prefer native `/api/embed` for embeddings and use compatibility routes when they are the desired common abstraction.
- LM Studio documents OpenAI-compatible `/v1/embeddings`, and llama.cpp server documents OpenAI-compatible server routes when launched/configured for embedding models.
- A TS client can use `openai` against an OpenAI-compatible `baseURL`; LM Studio and llama.cpp need their own local URL/model setup. Ollama native `/api/embed` is a small `fetch` adapter and avoids compatibility ambiguities.
- Keep embedding-provider ID, model ID/revision, dimensions, and normalization in stored metadata. Never mix vectors from different embedding models in one index without an explicit migration strategy.
- These are local network calls, not external API calls, when the service is bound to loopback. Do not silently route to cloud when local service is missing.

Sources: [Ollama embeddings API](https://docs.ollama.com/api/embed), [Ollama embedding guidance](https://docs.ollama.com/capabilities/embeddings), [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [LM Studio embeddings](https://lmstudio.ai/docs/developer/openai-compat/embeddings), [LM Studio OpenAI compatibility](https://lmstudio.ai/docs/developer/openai-compat), [llama.cpp server docs](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [OpenAI Node SDK](https://github.com/openai/openai-node).

### 7. Model router / structured extraction: Vercel AI SDK vs OpenAI SDK

**Verdict: ADOPT AI SDK behind an internal provider interface; EVALUATE structured output against the local models.**

- AI SDK is a widely adopted TypeScript toolkit with a fast release cadence; AI SDK 6 is the current major line in 2026. Its source and package have recent releases. Exact `ai` package semver should be read from npm at dependency lock time.
- Provider coverage includes first-party OpenAI, Anthropic, Google, AI Gateway; OpenRouter has its provider; Ollama is served by community providers; `@ai-sdk/openai-compatible` supports custom OpenAI-style endpoints/base URLs.
- Structured extraction is supported with Zod schemas and JSON-schema output. Important v6 note: `generateObject` is deprecated in favor of `generateText({ output: Output.object({ schema }) })`; write new extraction code against the current API.
- Model/provider behavior varies: local OpenAI-compatible servers may not implement constrained JSON schema or tool semantics consistently. Validate returned data with Zod and make retries/fallback explicit; a valid JSON-shaped response is not necessarily semantically valid memory.
- AI SDK’s provider abstraction is useful for swapping backends, but it does not make cloud providers local. Do not configure AI Gateway, OpenAI, or OpenRouter as automatic fallback in a zero-external-call profile.
- Keep provider dependencies modular and import only the selected provider; avoid shipping browser/UI packages into the server core. The core package can use the provider interface and dynamically load optional SDK adapters.
- The `openai` SDK is simpler if the product supports only OpenAI-compatible endpoints. It is actively maintained (npm surfaced **7.25.0**, published 2026-10-02) and provides `baseURL`; it lacks the common typed abstraction and provider breadth of AI SDK.
- License: AI SDK is Apache-2.0; OpenAI Node SDK is Apache-2.0. Confirm license metadata for community Ollama adapters independently.

Sources: [AI SDK repo](https://github.com/vercel/ai), [AI SDK 6 announcement](https://vercel.com/blog/ai-sdk-6), [current structured-data docs](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data), [v6 generateObject notice](https://v6.ai-sdk.dev/docs/reference/ai-sdk-core/generate-object), [OpenAI-compatible providers](https://ai-sdk.dev/providers/openai-compatible-providers), [LM Studio provider](https://ai-sdk.dev/providers/openai-compatible-providers/lmstudio), [Ollama provider options](https://ai-sdk.dev/providers/community-providers/ollama), [OpenRouter provider](https://github.com/OpenRouterTeam/ai-sdk-provider), [OpenAI SDK npm](https://www.npmjs.com/package/openai).

### 8. MCP: `@modelcontextprotocol/sdk`

**Verdict: ADOPT the official v2 split packages for a new implementation, subject to a Bun transport smoke test.**

- The original umbrella **`@modelcontextprotocol/sdk` 1.31.0** was published 2026-09-28 and remains an actively maintained v1 line.
- SDK transports include stdio for local agent integration and Streamable HTTP for remote/server deployments. Prefer Streamable HTTP over legacy SSE for new remote transport work.
- OAuth is part of the remote authorization story. Local stdio normally relies on process launch/configuration, not OAuth; remote auth still needs safe token storage, scopes, origin checks, and deployment configuration.
- SDK v2 is now a released split-package line: GitHub’s **2.3.0** release lists `@modelcontextprotocol/core`, `/client`, `/server`, and compatibility packages all at 2.3.0. npm search snippets for the individual split packages were stale/inconsistent (one showed server 2.1.0 and client 2.0.0-alpha.2), so verify the exact current registry tags rather than copying those snippets.
- Bun is a plausible host for stdio and `Bun.serve` HTTP, but verify stdio stream handling, request cancellation, and authorization against the exact chosen package. Keep the MCP adapter at a package boundary.
- License: official SDK repository is Apache-2.0; check package metadata for each split package.

Sources: [official SDK repo](https://github.com/modelcontextprotocol/typescript-sdk), [v2.3.0 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.3.0), [v1 npm package](https://www.npmjs.com/package/@modelcontextprotocol/sdk), [v2 migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html), [server package](https://www.npmjs.com/package/@modelcontextprotocol/server), [client package](https://www.npmjs.com/package/@modelcontextprotocol/client), [server docs](https://ts.sdk.modelcontextprotocol.io/documents/server.html), [transport spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports), [OAuth authorization guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/authorization).

### 9. Code intelligence: Tree-sitter vs native bindings vs ast-grep

**Verdict: ADOPT `web-tree-sitter` for portable parsing; EVALUATE `@ast-grep/napi` as a convenience alternative.**

- `web-tree-sitter` npm surfaced **0.27.0**, published about ten days before the August-indexed search result; it executes WebAssembly and avoids an OS native addon in the Bun/Node indexer.
- Use grammars for TypeScript/TSX, JavaScript, Python, Go, and Rust; language grammars are separately published/maintained artifacts. Pin grammar versions, include license notices, and smoke-test syntax changes.
- Tree-sitter gives syntax trees and source ranges; declaration extraction still needs language-specific traversal/normalization. It is a parser, not a complete language server or semantic resolver.
- Native `tree-sitter` npm surfaced **0.25.1**, last published about two months before snapshot. Native bindings can be fast but introduce build/prebuilt-binary and Bun portability friction.
- `@ast-grep/napi` surfaced **0.42.2**, last published about eight days before snapshot. Its N-API/native Rust implementation is active and ergonomic for structural matching, but test the exact Bun/Node platform matrix and bundled grammar footprint.
- For extracting symbols (functions/classes/types), prefer portable Tree-sitter with a narrow visitor; ast-grep is attractive when its prebuilt grammar set covers the required syntax and its native addon works on every supported target.
- Grammar maintenance is decentralized. Treat TS/JS/Python/Go/Rust grammar upgrades as data-indexer changes; add fixtures for declarations, decorators/macros, malformed/incomplete files, and Unicode offsets.

Sources: [`web-tree-sitter` npm](https://www.npmjs.com/package/web-tree-sitter), [Tree-sitter web binding](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web), [Tree-sitter TypeScript grammar](https://github.com/tree-sitter/tree-sitter-typescript), [`tree-sitter` npm](https://www.npmjs.com/package/tree-sitter), [`@ast-grep/napi` npm](https://www.npmjs.com/package/@ast-grep/napi), [ast-grep docs](https://ast-grep.github.io/), [language-pack alternatives](https://github.com/kreuzberg-dev/tree-sitter-language-pack).

### 10. Git integration: simple-git vs isomorphic-git vs system Git

**Verdict: ADOPT system Git via an argument-safe subprocess; use simple-git only if its wrapper DX pays for itself. AVOID isomorphic-git for the core indexer.**

- `simple-git` npm surfaced **4.0.2**, published 2026-09-27, with about 8,592 registry projects shown using it. It wraps the installed Git executable; active, popular, MIT-licensed, and a reasonable Bun/Node-compatible promise API.
- Directly calling `git` is the least surprising path for object IDs, `git hash-object`, `git diff --name-status -z`, rename handling, worktrees, and repository config. Use `execFile`/`Bun.spawn` with argv, never concatenate user-controlled shell strings.
- Require/detect system Git and return actionable setup errors. Node LTS and Bun can both spawn it; test paths with spaces, detached HEAD, shallow clones, and large diffs.
- `isomorphic-git` is pure JS and npm surfaced **1.42.2**; GitHub releases also surfaced 1.42.4 on 2026-09-29, an npm/search snapshot mismatch worth checking directly at lock time. It is actively maintained, but historical Bun compatibility issues and edge-case Git parity make it a less dependable fingerprint source.
- For stable fingerprints, define canonical file/path hashing and content normalization in project code rather than treating a library’s internal hash as a persistent schema.

Sources: [`simple-git` npm](https://www.npmjs.com/package/simple-git), [simple-git GitHub](https://github.com/steveukx/git-js), [`isomorphic-git` npm](https://www.npmjs.com/package/isomorphic-git), [isomorphic-git releases](https://github.com/isomorphic-git/isomorphic-git/releases), [historical Bun issue](https://github.com/oven-sh/bun/issues/7818).

### 11. Reranking: local cross-encoders and optional hosted APIs

**Verdict: EVALUATE behind an opt-in reranker interface; do not make it retrieval’s default stage.**

- Transformers.js can potentially run cross-encoder ONNX models, but inherits the native ONNX/Bun compatibility risk and the need to verify the exact exported architecture.
- `cross-encoder/ms-marco-MiniLM-L6-v2` is a small MS MARCO reranker candidate; BGE rerankers offer larger/more capable candidates. Model family licensing is separate from package licensing.
- Cross-encoders score each query/document pair, so cost grows with candidate count and token length. Run only after first-stage retrieval, batch a bounded top-N (e.g. 20–50), truncate deliberately, and benchmark cold/warm p50/p95.
- No target-hardware Bun CPU latency was validated here. Do not assert interactive latency from GPU benchmark claims; compare local reranking to the actual end-to-end recall/latency budget.
- Cohere Rerank and Jina-hosted reranking are optional remote providers only. They transmit query and candidate text outside the local installation; require explicit user opt-in and document privacy/cost implications.

Sources: [MS MARCO MiniLM model](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2), [BGE reranker base](https://huggingface.co/BAAI/bge-reranker-base), [BGE reranker v2 M3](https://huggingface.co/BAAI/bge-reranker-v2-m3), [Cohere rerank API](https://docs.cohere.com/reference/rerank), [Sentence Transformers cross-encoder docs](https://www.sbert.net/docs/cross_encoder/pretrained_models.html).

### 12. Parsing and ingestion

**PDF — Verdict: ADOPT `unpdf`; avoid defaulting to `pdf-parse`.**

- `unpdf` npm surfaced **1.8.1**, published 2026-08-13 (about a month old), with several hundred registry projects shown using it. It explicitly targets Node/browser/worker runtimes and is the better Bun-fit candidate.
- `pdf-parse` surfaced **2.4.5**, last published about a year before snapshot. It is TypeScript/cross-platform but has slower visible release cadence; retain only if its extraction behavior beats unpdf on the project corpus.
- Test scanned/OCR-only PDFs separately; neither text extractor supplies OCR by itself.

Sources: [`unpdf` npm](https://www.npmjs.com/package/unpdf), [unpdf repo](https://github.com/unjs/unpdf), [`pdf-parse` npm](https://www.npmjs.com/package/pdf-parse).

**HTML — Verdict: ADOPT Cheerio for DOM parsing; EVALUATE Readability extraction.**

- `cheerio` **1.2.0** was last published about eight months before the snapshot. It is mature, MIT-licensed, and useful for selectors without a browser engine.
- `@mozilla/readability` **0.6.0** was last published about two years before snapshot. The Firefox Reader View algorithm is a useful optional content extractor, but its visible npm cadence is low and it expects a DOM.
- Keep URL fetch/sanitization, script removal, and Readability execution isolated. HTML ingestion can carry prompt-injection text; parsing is not trust/safety filtering.

Sources: [`cheerio` npm](https://www.npmjs.com/package/cheerio), [Cheerio repo](https://github.com/cheeriojs/cheerio), [Mozilla Readability npm](https://www.npmjs.com/package/@mozilla/readability), [Readability repo](https://github.com/mozilla/readability).

**Markdown — Verdict: ADOPT `unified` + `remark-parse` (+ only needed plugins).**

- `unified` **11.0.5**, `remark` **15.0.1**, and `remark-parse` **11.0.0** showed last publishes around two to three years ago. The API/ecosystem is established; this looks like low-churn maintenance, not evidence of a recent release cadence.
- Use syntax trees when preserving headings, links, code fences, and frontmatter matters; do not round-trip/reformat source unless requested.

Sources: [`unified` npm](https://www.npmjs.com/package/unified), [`remark` npm](https://www.npmjs.com/package/remark), [`remark-parse` npm](https://www.npmjs.com/package/remark-parse), [unified package guide](https://unifiedjs.com/explore/package/remark/).

**CSV — Verdict: ADOPT PapaParse.**

- PapaParse **5.7.0** was published about a month before snapshot; registry pages show continued releases and it supports streaming/large files. It is mature, widely used, and MIT-licensed.
- Set explicit limits on input size, rows, columns, and cell length; avoid eagerly materializing unbounded files.

Sources: [PapaParse npm](https://www.npmjs.com/package/papaparse), [PapaParse releases](https://github.com/mholt/PapaParse/releases).

### 13. Graph algorithms: Graphology, Louvain, Leiden

**Verdict: EVALUATE; avoid treating clustering as entity resolution.**

- Graphology core **0.26.0** and `graphology-communities-louvain` **2.0.2** surfaced with latest npm releases about two years old. Both are useful JS/TS graph primitives, but the visible release cadence is low.
- Louvain is a plausible exploratory community detector; its result is a partition, not evidence that two entities are identical. Use deterministic blocking, provenance, and review thresholds for identity merges.
- Leiden implementations are less cohesive in the Graphology ecosystem; source material shows community requests and third-party implementations rather than a clear maintained official module. Avoid adopting an unverified Leiden port as a core dependency.
- Prefer simple connected components / scoring first; adopt Louvain only after graph structure and evaluation prove useful.

Sources: [Graphology](https://github.com/graphology/graphology), [Graphology npm](https://www.npmjs.com/package/graphology), [Louvain npm](https://www.npmjs.com/package/graphology-communities-louvain), [Louvain docs](https://graphology.github.io/standard-library/communities-louvain.html), [Leiden discussion](https://github.com/graphology/graphology/issues/543), [third-party Leiden implementation](https://github.com/aflsolutions/graphology-communities-leiden).

### 14. REST API: Hono vs Fastify

**Verdict: ADOPT Hono + `@hono/zod-openapi`.**

- Hono **4.13.12** was published within hours of the 2026-10-03 npm snapshot; it targets Web APIs and explicitly supports Bun and Node.
- `@hono/zod-openapi` **1.6.3** was published 2026-09-04 and provides Zod-validated routes with generated OpenAPI. This meets the REST + schema/API-doc need without a separate schema source.
- Hono composes directly with `Bun.serve` and also runs under Node; keep the server bootstrap replaceable for Node LTS tests/deployments.
- Fastify **5.12.1** was also actively released and is a strong Node-focused choice with plugin maturity. Prefer it if the service becomes Node-only or needs its specific ecosystem; otherwise Hono’s Bun/Web-standards fit is cleaner.
- Both projects are MIT-licensed; validate Hono OpenAPI/Zod version compatibility on upgrades.

Sources: [Hono npm](https://www.npmjs.com/package/hono), [Hono repo](https://github.com/honojs/hono), [Hono Zod OpenAPI](https://www.npmjs.com/package/@hono/zod-openapi), [official Zod OpenAPI example](https://hono.dev/examples/zod-openapi), [Fastify npm](https://www.npmjs.com/package/fastify), [Fastify releases](https://github.com/fastify/fastify/releases).

### 15. CLI and prompts

**Verdict: ADOPT Commander + `@clack/prompts`; AVOID Clipanion RC for this project.**

- Commander **15.0.0** was the npm latest in the search snapshot, last published about four months before Oct 3; the registry result showed roughly 149,797 projects using it. This is the maturity/compatibility pick (MIT).
- `citty` **0.2.2** last published about six months before snapshot; elegant and Bun/Node-friendly but has a smaller, still-0.x maturity profile. Evaluate if its subcommand API materially improves the CLI.
- `clipanion` surfaced **4.0.0-rc.4**, last published about a year earlier; avoid its RC for a new core CLI.
- `@clack/prompts` **1.8.1** was published 2026-09-13 and actively maintained; use for optional interactive setup, but ensure every command also works in CI/non-TTY mode.
- Commands that consume stdin/stdio should not print prompts or progress to MCP stdio transport.

Sources: [Commander npm](https://www.npmjs.com/package/commander), [Commander releases](https://github.com/tj/commander.js/releases), [Citty npm](https://www.npmjs.com/package/citty), [Clipanion npm](https://www.npmjs.com/package/clipanion), [Clack npm](https://www.npmjs.com/package/@clack/prompts), [Clack repo](https://github.com/bombshell-dev/clack).

### 16. Background jobs and scheduling

**Verdict: ADOPT a small Postgres `jobs` table + worker loop initially; EVALUATE pg-boss at scale.**

- `pg-boss` is mature and actively released: npm surfaced **12.35.1**, published 2026-09-26. It is PostgreSQL-backed and provides scheduling/retries/concurrency; it is MIT-licensed.
- Bun compatibility is not merely inferred from Node compatibility: release 12.35.1 includes a fix for the Bun SQL adapter (`fromBunSql`) double-encoding JSON payloads. That is a positive Bun support signal; still test its timers, signals, graceful shutdown, and schema migrations in the intended profile.
- A small queue table can use `FOR UPDATE SKIP LOCKED`, lease/visibility timeout, attempt count, backoff, and idempotent jobs. Keep claims, lease renewal, and completion atomic; this is more code/operational burden than pg-boss.
- Begin with a DB-backed worker and explicit lifecycle (`setTimeout`/loop + graceful shutdown), avoiding an extra cron package and avoiding reliance on Node timer quirks.
- Store due times as UTC timestamps and enqueue recurring work idempotently. Move to pg-boss when concurrency, schedules, retries, or observability needs exceed the maintained in-house worker.
- Test the selected worker design against PGlite if PGlite must run jobs; do not assume pg-boss’s production PostgreSQL behavior is reproduced by its embedded profile.

Sources: [pg-boss npm](https://www.npmjs.com/package/pg-boss), [pg-boss repo](https://github.com/timgit/pg-boss), [scheduling docs](https://pgboss.io/api/scheduling), [pg-boss releases](https://github.com/timgit/pg-boss/releases).

### 17. Testing and microbenchmarks

**Verdict: ADOPT Vitest for cross-runtime package tests; retain `bun:test` for Bun-only smoke tests; use tinybench.**

- Bun’s built-in `bun:test` is fast and appropriate for runtime-specific integration tests, but it does not demonstrate Node LTS compatibility by itself.
- Vitest **5.0.3** was published 2026-09-25 and supports a Node-based test run for npm-published packages. Its Vite dependency/tooling is more overhead than Bun’s built-in runner; test actual package entrypoints in CI under both runtimes.
- `tinybench` **6.2.0** was published 2026-09-09; it is the actively released, compact benchmark pick for portable microbenchmarks.
- `mitata` **1.0.34** surfaced as last published about two years before this snapshot. Its cross-engine design remains interesting, but the visible release gap makes it a secondary choice unless its reporting features are needed.
- Benchmark database query plans, embedding throughput, reranker latency, startup, and ingestion end-to-end; microbenchmarks do not substitute for representative corpus tests.

Sources: [Bun releases](https://github.com/oven-sh/bun/releases), [Vitest npm](https://www.npmjs.com/package/vitest), [Vitest guide](https://vitest.dev/guide/), [Vitest release policy](https://main.vitest.dev/releases.html), [tinybench npm](https://www.npmjs.com/package/tinybench), [tinybench releases](https://github.com/tinylibs/tinybench/releases), [mitata npm](https://www.npmjs.com/package/mitata), [mitata repo](https://github.com/evanwashere/mitata).

## Recommended stack table

| Layer | Recommended choice | License (verify on lock) | Confidence |
|---|---|---|---|
| Server database | PostgreSQL + upstream pgvector | PostgreSQL license | High |
| PostgreSQL TS client | `pg` + `pgvector` Node helper | MIT / MIT | High |
| ORM and schema migrations | Drizzle; generated, committed SQL | MIT | Medium-high |
| Embedded database | PGlite 0.5.x + `@electric-sql/pglite-pgvector`, behind profile flag | MIT + PostgreSQL-derived notices; extension metadata to verify | Medium-low |
| Embedded fallback | `bun:sqlite` + sqlite-vec + FTS5 only if PGlite fails | Bun / MIT OR Apache-2.0 | Medium-low |
| Embedding default | User-configured Ollama `/api/embed` adapter | MIT | High |
| Optional in-process embeddings | Transformers.js v4 + pinned small ONNX model, after Bun test | Apache-2.0 package; model-specific | Medium-low |
| LLM/extraction router | AI SDK v6 + internal provider boundary; Zod output | Apache-2.0 | Medium-high |
| MCP server | Official SDK v2 split packages 2.3.x; keep v1.31 migration boundary if needed | Apache-2.0 | Medium |
| Code parsing | `web-tree-sitter` + pinned language grammars | MIT (check grammars individually) | Medium-high |
| Git history/fingerprints | System `git` via argument-safe subprocess; optionally simple-git | Git GPL-2.0; wrapper MIT | High |
| Reranking | Disabled by default; optional local/hosted adapter | Model/provider-specific | Low |
| PDF / HTML / Markdown / CSV | unpdf / Cheerio + optional Readability / unified+remark / PapaParse | Mostly MIT; check each package | Medium-high |
| Graph clustering | None initially; Graphology/Louvain only after evaluation | MIT | Low |
| HTTP/OpenAPI | Hono + `@hono/zod-openapi` | MIT | High |
| CLI | Commander + Clack prompts | MIT | High |
| Jobs/scheduling | Own Postgres jobs table + worker loop; pg-boss trigger for revisit | MIT if pg-boss | Medium |
| Tests / benchmarks | Vitest + Bun smoke tests / tinybench | MIT | High |

## Risks & watch items

- **Model versioning:** store embedding model/provider/revision, dimension, normalization, and prompt-prefix metadata; changing any of these requires re-embedding or a parallel index.
- **PGlite extension parity:** prove load/DDL, vector values, HNSW/IVFFlat behavior, FTS, persistence/reopen, backup, migrations, and interruption recovery on both Postgres and PGlite. Keep PGlite experimental until this passes.
- **Bun and ONNX:** historical native-addon issues mean that Node compatibility claims do not establish Bun compatibility. Maintain a small OS/architecture/backend CI matrix or run inference in an explicit worker process.
- **External data egress:** hosted LLM/rerank providers receive memory content. Require opt-in; local errors must fail closed rather than silently switch to cloud.
- **Runtime double support:** test Node LTS as the published package contract and Bun as the project runtime. Avoid importing Bun-only APIs in shared library packages.
- **MCP version transition:** v1 and v2 package names diverge; pin a transport/auth contract and test supported agent clients before moving to v2.
- **Stale-but-stable parsers:** Readability, unified/remark, Graphology/Louvain and the PGlite Kysely adapter show low recent npm release cadence. Review open issues/security notices before accepting them.
- **Migrations and capabilities:** vector index DDL and hybrid RRF are SQL-heavy. Preserve escape hatches and tests instead of forcing every operation through ORM abstractions.
- **Supply chain/licenses:** review exact lockfile, package licenses, bundled native/wasm artifacts, model licenses, and transitive dependencies at release; several package/model licenses are not inherited from their parent tool.
- **Unquantified performance:** no generic benchmark establishes realistic on-device embedding/reranking latency. Measure with a representative coding-agent corpus on supported hardware.
- **Popularity counters:** GitHub pages and registry snippets did not expose consistent same-day star/download totals. Do not compare packages using stale counters; record a dated `npm view`/GitHub snapshot if ADR criteria require numeric popularity.

## Open questions

1. What is the minimum supported embedded profile: one process/one user, or concurrent local agents across processes? This determines whether PGlite’s embedded locking model is acceptable.
2. Is the embedded profile required to support pgvector HNSW/IVFFlat specifically, or is exact/linear vector scan acceptable for small memory corpora?
3. Which migration mechanism is canonical across real Postgres and PGlite: Drizzle Kit output only, or handwritten SQL with Drizzle schema as a type layer?
4. Which first embedding model is acceptable for English/code memory, and must the model download be bundled, prewarmed, or user-managed?
5. Which tested Apple Silicon and x64 hardware should define the local embedding/reranking latency and memory budgets?
6. Is a remote MCP server in scope at first release? If yes, which OAuth issuer, audience, token storage, and tenant isolation model are required?
7. Can onememory require a system Git executable, or must ingestion work in environments without Git?
8. What ingestion formats and safety limits are in the first-release contract (PDF size/pages, HTML fetch policy, CSV row/column caps)?
9. Are recurring jobs required in embedded mode, and should the local worker run continuously or only when the CLI/server is active?
10. Are numeric GitHub stars and npm monthly-download snapshots required for ADR acceptance? If so, capture them from live primary registry/repository metadata on the ADR date rather than carrying forward search-index snippets.
