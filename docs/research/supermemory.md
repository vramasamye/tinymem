# Supermemory — architecture research

Research date: 2026-10-03. All claims sourced to primary material (supermemory.ai docs/blog/research/pricing,
the supermemoryai GitHub org, and the live OpenAPI spec). Their docs publish a machine index at
<https://supermemory.ai/docs/llms.txt> and a live spec at <https://api.supermemory.ai/v4/openapi> (also `/v3/openapi`).

## Summary

Supermemory is a commercial "memory and context engine" (Memory-as-a-Service) with an open-source core and
open-source agent plugins. Its public model is two data planes in one store, scoped by a hard `containerTag`
boundary: **documents** (raw ingested content → chunks, for RAG/`SuperRAG`) and **memories** (LLM-extracted atomic
facts stored in a temporal vector-graph, from which per-container **profiles** are synthesized)
([how-it-works](https://supermemory.ai/docs/concepts/how-it-works), [graph-memory](https://supermemory.ai/docs/concepts/graph-memory)).
Ingestion is async (`queued → extracting → chunking → embedding → indexing → done`), and a second phase called
**dreaming** builds the fact graph, links relations, and resolves contradictions ([how-it-works](https://supermemory.ai/docs/concepts/how-it-works)).
Retrieval is a single `POST /v4/search` with `searchMode: memories | documents | hybrid`, optional rerank,
query rewriting, metadata filters, and an `aggregate` step that synthesizes multiple memories into one result slot
([search](https://supermemory.ai/docs/recall/search), [search-memory-entries](https://supermemory.ai/docs/api-reference/recall-search/search-memory-entries)).

Strategically the most relevant facts for us: (a) as of 2026 they ship **Supermemory local**, an open-source
single-binary self-hosted server that speaks the same API and runs fully offline with Ollama
([self-hosting/overview](https://supermemory.ai/docs/self-hosting/overview)); (b) the hosted platform's
differentiator is now explicitly the **proprietary extraction model**, not the storage/search layer
([local-vs-enterprise](https://supermemory.ai/docs/self-hosting/local-vs-enterprise)); (c) they publish an
open-source benchmark harness (MemoryBench) and open plugins for exactly the agents we target — Claude Code, Cursor,
Codex, OpenCode ([README](https://github.com/supermemoryai/supermemory)).

## Findings

### 1. Memory architecture

**Two-plane model: documents vs memories.** Documents are raw input (text, markdown, HTML, PDF, images, audio/video,
code, URLs, connector items); memories are facts extracted from them. Docs state you do not pre-chunk or pick an
embedding model — the engine handles extraction, "Contextual Chunking", embedding, and indexing
([how-it-works](https://supermemory.ai/docs/concepts/how-it-works)). The same document yields three outputs inside one
`containerTag`: **chunks** (grounding for RAG/SuperRAG), **memories** (graph facts), and a **profile**
([how-it-works](https://supermemory.ai/docs/concepts/how-it-works)).

**Engine internals (their own claim).** "Powered by a custom learning model and a graph database that we built
internally": a *learning model* that "decides what and how to learn, what is important, when to forget, creating
relations", and a *temporal vector-graph engine* — "Fact-based temporal graph that has Vector, FTS, and graph built in"
([how-it-works](https://supermemory.ai/docs/concepts/how-it-works)). No schema, index, or model names are published;
the self-hosted binary is described only as an "embedded Supermemory graph engine"
([self-hosting/overview](https://supermemory.ai/docs/self-hosting/overview)). An older engineering post (2025-06-05)
describes the lineage as brain-inspired: smart forgetting/decay, recency+relevance bias, context rewriting,
and hierarchical memory layers (hot KV vs deeper retrieval), then built on Cloudflare infra
([blog/memory-engine](https://supermemory.ai/blog/memory-engine/)). Treat that post as historical; the current docs
supersede it.

**Ingestion pipeline (documented statuses).** `Queued → Extracting (text/OCR/transcription/page fetch) → Chunking
(type-aware) → Embedding → Indexing → Done`; poll `GET /v3/documents/{id}`
([how-it-works](https://supermemory.ai/docs/concepts/how-it-works)). Errors: "If an irrecoverable processing error
occurs, the document is automatically deleted after 2 minutes"
([add-memories](https://supermemory.ai/docs/ingestion/add-memories)). Limits: text 1MB, files 50MB, URL fetch up to
10MB; text is "chunked at the sentence level with a 2-sentence overlap"; typical latency text ~instant, PDF 1–5s,
images 2–10s, video 10s+, webpages 1–3s ([content-types](https://supermemory.ai/docs/concepts/content-types)).

**"Dreaming" = the graph-building/consolidation phase.** After (and alongside) indexing, dreaming extracts facts,
links related memories, resolves updates, and produces `derives` facts never stated in one place. `dynamic` (default)
groups related documents so memories form from "coherent units"; `instant` processes a document alone immediately and
bills one extra operation ([how-it-works](https://supermemory.ai/docs/concepts/how-it-works),
[graph-memory](https://supermemory.ai/docs/concepts/graph-memory)). The launch post describes dream cycles as
self-scheduled ("no cron job, no fixed timer"; heuristics decide depth), which "reconsolidates", merges fragments,
reweights old facts, tempers over-confident memories, and resolves contradictions; dreamt state "catches up in the
background, at most fifteen minutes", while unprocessed content stays queryable via hybrid retrieval
([blog/dynamic-dreaming, 2026-05-25](https://supermemory.ai/blog/introducing-dynamic-dreaming-supermemory-now-connects-the-dots-for-you/)).

**Chunking is type-aware.** PDFs/DOCX by semantic sections (headers/paragraphs); markdown by heading hierarchy; web
pages by article structure; **code by AST via their open-source `code-chunk` library** (functions/classes intact)
([super-rag](https://supermemory.ai/docs/concepts/super-rag), [content-types](https://supermemory.ai/docs/concepts/content-types),
[code-chunk](https://github.com/supermemoryai/code-chunk)).

**Search.** Single call, `searchMode: memories | documents | hybrid` (hybrid recommended). Parameters: `q`, `limit`
(default 10, max 100), `threshold` (docs default 0.5; OpenAPI default 0.6), `rerank` (bool, +~100ms, "cross-encoder"
per super-rag page), `rewriteQuery` (bool; docs say "no extra cost" but OpenAPI says ~400ms added latency),
`filters` (AND/OR metadata), `include` (`documents`, `summaries`, `relatedMemories`, `forgottenMemories`, `chunks`),
`aggregate` (bool — merges multiple memories into synthesized results, "works in conjunction with reranking"),
`containerTag`/`containerTags` ([search](https://supermemory.ai/docs/recall/search),
[search-memory-entries OpenAPI](https://supermemory.ai/docs/api-reference/recall-search/search-memory-entries)).
Results are `{id, memory?|chunk?, similarity, metadata, updatedAt, version}` plus `timing`/`total`
([search](https://supermemory.ai/docs/recall/search)).

**Aggregation** is their precision/recall fix: each result slot becomes "a synthesis of multiple documents condensed
into one", so a `limit` of 2 can still answer a multi-part question; the post shows `similarity: 1.00` on synthesized
results ([blog/aggregation, 2026-04-05](https://supermemory.ai/blog/solving-the-precision-recall-tradeoff-search-result-aggregation/)).

**"Memory is not a vector DB" — what they concretely claim.** Their positioning reduces to four testable assertions:
(1) facts are extracted and *tracked over time*, not just embedded ("I just moved to SF supersedes I live in NYC");
(2) contradictions are resolved and expired facts auto-forgotten ("I have an exam tomorrow" expires);
(3) per-entity profiles exist independently of any query, because "there's rarely a query that is semantically close"
to facts like a preferred name; (4) the store is a vector+FTS+graph engine, not a flat ANN index
([README](https://github.com/supermemoryai/supermemory), [memory-vs-rag](https://supermemory.ai/docs/concepts/memory-vs-rag),
[user-profiles](https://supermemory.ai/docs/concepts/user-profiles), [how-it-works](https://supermemory.ai/docs/concepts/how-it-works)).
The memory-vs-rag page contrasts pipelines explicitly: RAG = `Query → Embedding → Vector Search → Top-K → LLM`;
memory = `Query → Entity Recognition → Graph Traversal → Temporal Filtering → Context Assembly → LLM`
([memory-vs-rag](https://supermemory.ai/docs/concepts/memory-vs-rag)).

**Profiles** are per-`containerTag` synthesized context split into `static` (long-term) and `dynamic` (recent), plus
topic **buckets** (default bucket `preferences`; org-level and space-level, space add-only) that a classifier fills
during ingestion. Profiles accept the same metadata `filters` as search, which narrows which memories may contribute.
Claimed cost: one call, ~50ms vs 3–5 searches at 200–500ms
([user-profiles](https://supermemory.ai/docs/concepts/user-profiles), [quickstart](https://supermemory.ai/docs/quickstart)).

**Token-efficiency claim.** "It returns an average of 10 tokens per fact, so even 50 facts is just 500 tokens"
([rules](https://supermemory.ai/docs/concepts/rules)).

**RRF / "deep search": not documented.** Their own hybrid-search blog explains reciprocal rank fusion *as general
background* and explicitly separates it from their product semantics: "Supermemory's search modes use 'hybrid' to
return both extracted memories and document chunks. Distinguish that content-selection meaning from the
lexical-plus-vector design" ([blog/hybrid-search, 2026-04-23](https://supermemory.ai/blog/hybrid-search-guide/)).
I found **no primary source** stating they use RRF, BM25, or a specific fusion constant internally, and **no current
"deep search" feature** in the docs index ([llms.txt](https://supermemory.ai/docs/llms.txt)). Treat both as silent.

**SMFS (Supermemory Filesystem)** is a parallel access path: mounts a container as a real directory (NFSv3 on macOS,
FUSE on Linux) where `grep` is semantic by default and a virtual `profile.md` digests the container; also shipped as a
virtual-bash tool for serverless. Claimed 3.0x fewer tokens on Claude (24M vs 72M) and 1.75x on Codex over 110 xAFS
questions ([smfs/overview](https://supermemory.ai/docs/smfs/overview), [README](https://github.com/supermemoryai/supermemory),
[smfs repo (Rust, MIT)](https://github.com/supermemoryai/smfs)).

### 2. API surface

Base `https://api.supermemory.ai`; self-hosted uses your instance URL (default `http://localhost:6767`). Auth is
`Authorization: Bearer sm_...` only ([api-reference/overview](https://supermemory.ai/docs/api-reference/overview)).

Canonical endpoints, per their own integration prompt and docs: write `POST /v3/documents` (SDK `client.add`), search
`POST /v4/search`, profile `POST /v4/profile`, settings `PATCH /v3/settings`. Explicitly deprecated/fabricated:
`/v1/*`, `/v3/memories`, `/v3/search` (as search), `x-supermemory-api-key`/`x-api-key` headers, `containerTags`
(plural) as the only write scope ([agents-and-mcp](https://supermemory.ai/docs/agents-and-mcp)).

Groups ([llms.txt](https://supermemory.ai/docs/llms.txt), [api-reference/overview](https://supermemory.ai/docs/api-reference/overview)):

- **Ingest**: add document, upload file, batch add, ingest/update conversation.
- **Documents**: get/list/update/delete, bulk delete, get chunks (ordered), get processing documents
  (`view=active|pending|all`), presigned file URL (24h).
- **Recall**: `POST /v4/search` (`memories|documents|hybrid`), `POST /v3/search` (document/SuperRAG-oriented),
  `POST /v4/profile`, `POST /v4/profile/buckets`.
- **Memories (v4, extracted entries)**: create directly (bypassing ingestion; 1–100 items, ≤10k chars each,
  `isStatic` flag for permanent traits), list with history, update (versioned, `isLatest=false` on the old row),
  forget (soft delete, `isForgotten=true`, `forgetReason`), forget-matching (agentic mass-forget with `dryRun`,
  `threshold`, `maxForget`, returns `forgetBatchId`).
- **Memory review (v3)**: `GET /v3/container-tags/{tag}/inferred` and
  `POST .../inferred/{memoryId}/review` with `action: approve|decline|undo`.
- **Container tags**: get/update settings, delete (owner/admin only), merge (async, poll merge status).
- **Connections**: create (returns auth URL), list, get by id/provider, configure resources (GitHub only), fetch
  resources, sync, list indexed documents, delete.
- **Settings**: get/update org settings, suggest profile buckets, reset organization data.
- **Billing/analytics** (org-admin only; scoped keys get 403): `GET /v3/auth/billing`, `/billing/usage`,
  `/billing/usage-events`, `/billing/auto-topups`, `/billing/invoices`, `GET /v3/analytics/usage?period=24h|7d|30d`.
- **Scoped keys**: `POST /v3/auth/scoped-key` (`containerTag`, `name`, `expiresInDays` 1–365,
  `rateLimitMax` default 500, `rateLimitTimeWindow` default 60000ms), `DELETE /v3/auth/scoped-key/{id}`.

**SDKs and clients**: official TypeScript (`npm install supermemory`) and Python (`pip install supermemory`); generated
from OpenAPI, with SDK generation migrating "off Stainless SaaS to stlc"
([api-reference/overview](https://supermemory.ai/docs/api-reference/overview)). Framework wrappers under
`@supermemory/tools` (Vercel AI SDK `withSupermemory`, Mastra, LangChain/LangGraph, OpenAI Agents SDK, Agno,
Claude Memory Tool, n8n, and more) ([README](https://github.com/supermemoryai/supermemory), [llms.txt](https://supermemory.ai/docs/llms.txt)).
Also a CLI: `npx supermemory` with `setup`, `add`, `search`, `profile`, `docs`, `tags`, `config`, `whoami`,
`help --json` for agents ([agents-and-mcp](https://supermemory.ai/docs/agents-and-mcp)).

**Rate limits**: no org-wide rate-limit page is published. The only concrete numbers are the scoped-key defaults
(500 requests / 60s window, both configurable up to 10,000 and 3,600,000ms) and ingestion guidance ("batch size 3-5
documents at once", "delay 1-2 seconds between requests"), with `429` documented as RateLimitError
([authentication](https://supermemory.ai/docs/authentication), [add-memories](https://supermemory.ai/docs/ingestion/add-memories)).
Enterprise pricing mentions "custom rate limits and throughput" ([pricing](https://supermemory.ai/pricing)).

**Webhooks**: the README and connector docs describe connectors using "real-time webhooks" for Google Drive/Gmail/
Notion sync ([README](https://github.com/supermemoryai/supermemory), [connectors/overview](https://supermemory.ai/docs/connectors/overview)).
I found **no documented user-facing webhook subscription API** for memory events. Treat as silent.

### 3. Deduplication, contradiction, temporal handling

- **Document-level dedupe by `customId`.** "Pass `customId` to identify content and avoid duplicates." Sending content
  under the same `customId` either appends new turns or diffs the full updated content — "Supermemory detects the diff
  and only processes new parts". Full replace (`documents.update`) triggers full reprocessing
  ([add-memories](https://supermemory.ai/docs/ingestion/add-memories), [how-it-works](https://supermemory.ai/docs/concepts/how-it-works)).
- **Contradiction resolution is a first-class relation type.** New fact *replaces* the old for search (`updates`);
  `isLatest` and graph fields "keep retrieval on the current fact without erasing the past". Other relations:
  `extends` (adds detail, both valid) and `derives` (inferred from patterns) ([graph-memory](https://supermemory.ai/docs/concepts/graph-memory)).
- **Versioned memories.** `PATCH /v4/memories` creates a new version and preserves the original with `isLatest=false`;
  search responses expose `version` and `rootMemoryId` ("ID of the root (first version) memory entry this one descends
  from"), and `context.parents/children` with relative `version` distance (-1 direct parent, +1 direct child)
  ([memory-operations](https://supermemory.ai/docs/recall/memory-operations),
  [search-memory-entries](https://supermemory.ai/docs/api-reference/recall-search/search-memory-entries)).
- **Forgetting.** Time-based expiry (`forgetAfter`; expired memories excluded from search by default), contradiction
  (updates win for "what's true now"), and noise filtering ("casual, non-meaningful chatter is less likely to become
  durable memory"). Forgetting is a soft delete, recoverable via `include.forgottenMemories`
  ([graph-memory](https://supermemory.ai/docs/concepts/graph-memory), [search](https://supermemory.ai/docs/recall/search)).
- **Inferred memories are down-weighted until reviewed.** `isInference: true` facts "are down-weighted in search until
  someone confirms them"; `approve` clears the flag, `decline` forgets, `undo` restores. Queue returns up to 50 ordered
  by `parentCount` desc, then `createdAt` desc ([memory-review](https://supermemory.ai/docs/recall/memory-review)).
- **Memory types with different lifecycles**: facts (persist until updated), preferences (strengthen with repetition),
  episodes (decay unless significant) ([graph-memory](https://supermemory.ai/docs/concepts/graph-memory)).
- **Ordering matters for temporal reasoning.** Docs recommend ingesting documents sequentially within a `containerTag`
  "since that's how supermemory determines what came first (used for `updates` relations and temporal reasoning)"
  ([rules](https://supermemory.ai/docs/concepts/rules)).
- **What is NOT documented**: no published similarity-threshold dedupe, no explicit "supersede if cosine > X" rule,
  no exposure of a validity interval (`valid_from`/`valid_until`) on memories. Their own temporal-memory blog is
  careful to say their graph "describes update, extension, and derivation relationships" and advises keeping extra
  validity intervals "in application-owned records when historical queries require them"
  ([blog/temporal-knowledge-graphs](https://supermemory.ai/blog/temporal-knowledge-graphs-agent-memory/)).

### 4. Integrations (how agents connect)

Two distinct MCP products, easy to confuse:

- **Memory MCP (consumer)**: remote server `https://mcp.supermemory.ai/mcp`, OAuth (no API key), "spaces" = container
  tags. Tools: `search_memory`, `get_profile`, `add_memory` (save/forget), `list_documents`, `get_document`,
  `list_memories`, `list_spaces`, `who_am_i`; MCP Apps widgets `select-space`, `guided-save`, `upload-file`,
  `memory-graph`; resources `supermemory://profile`, `supermemory://spaces`; prompt `context`
  ([supermemory-mcp/mcp](https://supermemory.ai/docs/supermemory-mcp/mcp)). Source lives in the main monorepo at
  `apps/mcp` ([mcp doc link](https://supermemory.ai/docs/supermemory-mcp/mcp)). README advertises 3 headline tools
  (`memory`, `recall`, `context`) — an older description than the 8-tool docs page; docs are authoritative.
- **Docs MCP (developer)**: `https://supermemory.ai/docs/mcp`, for agents *building with* the API, plus an installable
  skill (`npx skills add https://github.com/supermemoryai/skills --skill supermemory`) and `npx supermemory setup`
  ([agents-and-mcp](https://supermemory.ai/docs/agents-and-mcp)).

**Per-agent plugins (all in the supermemoryai org, per the repo list at
<https://github.com/orgs/supermemoryai/repositories>):** `claude-supermemory` (2.8k stars), `opencode-supermemory`
(1.6k), `openclaw-supermemory` (797), `codex-supermemory`, `cursor-supermemory`, `muse-supermemory`,
`hermes-supermemory` (Python), `eve-supermemory`, `pipecat-memory`.

**Coding-agent UX (Claude Code / Cursor, the best-documented):**

- Claude Code: `/plugin marketplace add supermemoryai/claude-supermemory` then `/plugin install supermemory`; auth via
  `SUPERMEMORY_CC_API_KEY`; runs as Node hooks. Features: "reasoned recall" (the model decides whether recalling helps
  before each turn), auto-capture, **team memory shared separately from personal memory**, and explicit skills.
  Commands: `/supermemory:index` (index codebase architecture), `/supermemory:project-config`, `/supermemory:session`,
  `/supermemory:status`, `/supermemory:logout`. Global settings (`~/.supermemory-claude/settings.json`):
  `maxProfileItems` (default 5), `recallDirective`, `signalExtraction` (default false), `signalKeywords`
  (`remember, architecture, decision, bug, fix`), `signalTurnsBefore` (3), `includeTools`
  ([claude-code](https://supermemory.ai/docs/integrations/claude-code)).
- Cursor: `/add-plugin cursor-supermemory` or marketplace; `/supermemory-setup` OAuth; skills `memory-init`,
  `memory-save`, `memory-search`; MCP tools `supermemory_get_config`, `supermemory_set_config`, `supermemory_containers`,
  `supermemory_search`, `supermemory_add`, `supermemory_list`, `supermemory_forget`, `supermemory_profile`. Config adds
  `similarityThreshold` (default 0.55, values below are floored), `maxMemories` (10), `injectProfile` (true).
  Contains a **context gatherer** that "fans out targeted searches before substantial work" and an always-on rule for
  proactive recall; automatic recall "deduplicates results, and injects them after the first supported tool result"
  ([cursor](https://supermemory.ai/docs/integrations/cursor)).

**Cross-agent shared repo memory — directly relevant to us.** Cursor, Claude Code, Muse Code, Codex, and OpenCode
share one repository container tag of the form `repo_<project_name>__<project_id>`, where "the project ID is a stable
hash of the normalized Git remote" and repos without a remote fall back to their resolved local path — "Two repos with
the same directory name never collide". Within that one tag, personal/session memories are separated from explicit
project knowledge by an `sm_scope` metadata field ([cursor](https://supermemory.ai/docs/integrations/cursor)).
This is a working design for the exact problem onememory faces.

**Other surfaces**: Chrome extension — the `chore(web)` commit "reduce the app to a redirect shell, drop the browser
extension" indicates the browser extension workspace was **removed** in Sept 2026; `app.supermemory.ai` now 308-redirects
to the console ([commit 5258cb7](https://github.com/supermemoryai/supermemory/commit/5258cb74c895c5297fbfff594935741aeb14a915)).
Connectors: Google Drive, Gmail, Notion, OneDrive, S3, Granola, GitHub, Web Crawler
([connectors/overview](https://supermemory.ai/docs/connectors/overview)).

### 5. Open vs closed

**Open (verified):**

- `supermemoryai/supermemory` — the flagship repo: "Memory and context engine + app that can be run fully locally",
  31.1k stars, 2.7k forks, 119 contributors, 1,936 commits, last commit Oct 3 2026 (hours before this research),
  693 branches. **License: MIT** (LICENSE file verified: "MIT License, Copyright (c) 2025 supermemory"), not
  Apache-2.0 ([repo](https://github.com/supermemoryai/supermemory), [LICENSE](https://raw.githubusercontent.com/supermemoryai/supermemory/main/LICENSE)).
  Layout: `apps/`, `packages/`, `skills/supermemory/`, `CLAUDE.md`; TypeScript 51.2%, MDX 30.5%, Python 14.9%.
  Releases are tagged `supermemory-server` (latest `server-v0.0.8`, Aug 17 2026).
- **Supermemory local** — the self-hosted server shipped from that repo: `curl -fsSL https://supermemory.ai/install | bash`
  or `npx supermemory local`; one binary, no Docker/DB, data in `./.supermemory`, port 6767, full Memory API
  (`/v3/documents`, `/v4/search`, `/v4/profile`), local embeddings by default
  (`Xenova/bge-base-en-v1.5`, 768d), bring-your-own LLM (OpenAI/Anthropic/Gemini/Groq/Workers AI/Vertex, or any
  OpenAI-compatible endpoint incl. Ollama), no telemetry
  ([self-hosting/overview](https://supermemory.ai/docs/self-hosting/overview),
  [configuration](https://supermemory.ai/docs/self-hosting/configuration)). The docs' "open source" link
  (`https://git.new/memory`) resolves to the main repo.
- 33 public repos total. Licenses are mixed: MIT (supermemory, code-chunk, supermemory-mcp, memorybench, smfs, markdowner,
  llm-bridge, install-mcp, emoji-resolve, pipecat-memory, backend-api-kit, hermes-supermemory, muse-supermemory),
  Apache-2.0 (sdk-ts, python-sdk, company-brain, preprint), "Other" (messages-memory, infinite-chat).
- Notable OSS libraries/tools: `code-chunk` (AST-aware code chunking, MIT), `markdowner` (URL→LLM-ready markdown, MIT,
  2k stars), `memorybench` (benchmark harness, MIT, 321 stars), `smfs` (Rust filesystem, MIT, 483 stars),
  `supermemory-mcp` (MIT, 1.7k stars), `install-mcp` (MIT), `llm-bridge` (MIT), `skills` (agent skill),
  `company-brain` (Apache-2.0, 901 stars), `sdk-ts`/`python-sdk` (Apache-2.0).

**Closed / platform-only (verified):** the docs state the self-hosted binary excludes
"**Connectors** (Drive/Notion/Gmail/OneDrive background sync), **Supermemory MCP** managed endpoints,
**Optimized memory extraction** — the platform's extraction pipeline is tuned for higher quality at lower cost than
bring-your-own-key, **Managed scale**", and that "Any other environment variables you may find referenced in the
codebase are platform-only"
([configuration](https://supermemory.ai/docs/self-hosting/configuration)). Local-vs-Enterprise confirms the moat is the
"proprietary models, purpose-tuned for long-horizon data understanding", plus org auth/roles/scoped keys, console
observability, connectors, and elastic hosting ([local-vs-enterprise](https://supermemory.ai/docs/self-hosting/local-vs-enterprise)).
So: the **storage/search/graph/API layer is open; the extraction model and managed multi-tenant control plane are closed.**

**`olm`: not found.** No repo named `olm` appears in the org's 33 public repos, and `github.com/supermemoryai/olm`
returns 404. If an `olm` project existed, it is gone or private. (Note: `packages/` in the monorepo is not enumerable
from the public README.)

**Activity/focus signal:** Sept 2026 they discontinued the "company brain" and "Nova" products (refunding charged users)
to "go all in on the memory API"; MCP and plugins continued, moved to the developer platform
([blog/an-update, 2026-09-10](https://supermemory.ai/blog/an-update-to-supermemory)). They then open-sourced the
company brain (Sept 25, 2026) as `supermemoryai/company-brain`.

### 6. SaaS model

**Tenancy primitives.** `containerTag` is "a hard boundary — its own namespace"; a scoped API key for tag A gets
`403` (not silently filtered) on tag B. Metadata filters operate *inside* a tag and can never cross it. Recommended
patterns: `user_{id}`, `org_{id}`, `org:{orgId}:user:{userId}`, `project_{id}`. Documented scale per container:
"up to 1M documents and 10M memories per container"
([multi-tenancy](https://supermemory.ai/docs/concepts/multi-tenancy), [rules](https://supermemory.ai/docs/concepts/rules)).
Container tags support **merge** (async) and **delete-all** (owner/admin only)
([llms.txt](https://supermemory.ai/docs/llms.txt)).

**Auth model.** Org API keys (all endpoints), scoped keys (allowed only on `/v3/documents`, `/v3/memories`,
`/v4/memories`, `/v3/search`, `/v4/search`, `/v4/profile`; cannot read billing, manage settings, or mint keys),
org members/roles with team management from Pro up, connector OAuth branding with your own client ID
([authentication](https://supermemory.ai/docs/authentication)).

**Pricing / where free ends.** Usage-based USD credits; plan inclusion is consumed before top-up credits; no rollover
on subscription credits, top-ups persist ([billing](https://supermemory.ai/docs/overview/billing)):

| Plan | List | Included credits/mo | Seats | Notable gates |
|---|---|---|---|---|
| Free | $0 | $5 | 1 | API + plugins; no team mgmt, no connectors |
| Pro | $19 | $20 | 3 | Drive/OneDrive/Notion/Granola connectors, auto top-up |
| Max | $100 | $130 | 3 | + Gmail connector |
| Scale | $399 | $600 | unlimited | + GitHub/S3/Web Crawler, advanced PDF extraction, User Insights, SOC 2/HIPAA |
| Enterprise | custom | contract | unlimited | SSO, custom metering, air-gap, FDE, SLA |

Rates (same on every plan, from [billing](https://supermemory.ai/docs/overview/billing) and
[pricing](https://supermemory.ai/pricing)): Memory text $0.000005/token ($5/1M), Memory rich $0.00001 ($10/1M),
SuperRAG text $0.000001 ($1/1M), SuperRAG rich $0.000002 ($2/1M), search $0.000005/query ($5/1M queries),
operations $0.0001 ($100/1M). Claimed scale: "100B+ tokens a month, 187ms median recall"
([pricing](https://supermemory.ai/pricing)); security page says "~sub-300ms p50" for typical search
([security](https://supermemory.ai/docs/overview/security)). These two latency figures are inconsistent in emphasis.

**Diff billing is the key commercial mechanic**: re-ingesting under the same `customId` bills only
`max(0, fullTokenCount - previousTokenCount)` — "tokens Supermemory has already processed are not billed again".
Requires stable `customId`, same org, and an update path rather than full replace
([billing](https://supermemory.ai/docs/overview/billing)). This makes long-lived agent loops cheap and is a strong
argument for the customId design.

**Self-host vs SaaS — a documented conflict.** The self-hosting docs say Supermemory local is "free, open source, and
great for local development, air-gapped environments, and privacy-sensitive workloads" with no connectors/MCP
([self-hosting/overview](https://supermemory.ai/docs/self-hosting/overview)). The pricing FAQ says "Self-hosted
deployments are available on Scale and Enterprise" ([pricing](https://supermemory.ai/pricing)). Reading them together:
the *binary* is free/OSS; *supported/managed self-hosting* is a paid tier. Also note the from-mem0 migration guide
advertises a "Generous free tier (100k tokens)" ([from-mem0](https://supermemory.ai/docs/migration/from-mem0)) while
billing/pricing say Free = $5 credits/month — an older marketing line vs the current credit model.

**Compliance.** SOC 2 Type II certified, GDPR compliant, HIPAA BAA available (Scale/Enterprise); AES-256-class at rest,
TLS in transit; "Your customer content is never used to train models — this applies to every plan"
([security](https://supermemory.ai/docs/overview/security)).

### 7. Published comparisons vs Mem0 (marketing — read as positioning)

Their docs' comparison page deliberately avoids a vendor scorecard and instead names *categories*: DIY vector stack,
"memory layers that are thin wrappers" (thin extraction over a vector store), pure RAG products, and building in-house.
The dimensions they compete on: temporal truth, entity identity + profiles, multimodal extraction, connectors,
forgetting, multi-tenant isolation, and "you'd otherwise sign up for 6+ / 20 vendors"
([comparison](https://supermemory.ai/docs/overview/comparison)).

The explicit Mem0 mapping is in the migration guide, which claims Supermemory offers a "knowledge graph architecture",
"multiple content types", a "generous free tier", and more integration options (API, MCP, SDKs); the code maps
`user_id` → `containerTag`, `client.search` → `client.search.memories`, `client.get_all` → `client.documents.list`
([from-mem0](https://supermemory.ai/docs/migration/from-mem0)). Note the migration snippets use `container_tags=[...]`
(plural) and `supermemory.memories.add`, which contradict the current canonical API guidance in
[agents-and-mcp](https://supermemory.ai/docs/agents-and-mcp) — stale docs.

Benchmark claims (all self-reported, via their own harness or their own judge setup):
`#1` on LongMemEval, LoCoMo, ConvoMem; LongMemEval 95% Recall@15 with ~720 tokens of context ("99.4% context
reduction"), category recall: Knowledge Updates 99%, Assistant 100%, User 97%, Multi-session 93%, Temporal 91%,
Preference 90% ([README](https://github.com/supermemoryai/supermemory)). The research page reports a separate
LongMemEval-S run: 97% Recall@20 overall vs Zep 71.2% and full-context 60.2%, judged by gpt-4o
([research](https://supermemory.ai/research)). The two numbers (95% @15 vs 97% @20) come from different configs —
do not conflate. They also publish **MemoryBench** (MIT) explicitly to let others reproduce/compare providers including
Mem0 and Zep ([memorybench](https://github.com/supermemoryai/memorybench)).

Case-study claims (customer-attributed, unaudited): Chatarmin "ditched RAG… 40s → 12s average response time and
40–50% fewer tokens" ([pricing](https://supermemory.ai/pricing)); Scira AI switched from Mem0
([blog/why-scira](https://supermemory.ai/blog/why-scira-ai-switched)).

## What onememory should adopt

1. **Two-plane data model with an explicit identity for each.** Documents (immutable-ish source of truth for RAG) vs
   memories (derived, versioned, graph-linked) is a clean separation that maps well onto our `episodic`/`source` vs
   `semantic`/`entity`/`decision` layers. Keep the raw source retrievable alongside the derived fact.
2. **`customId`-style stable identity + diff-aware re-ingest.** This is both a correctness mechanism (updates append to
   one logical document) and a cost mechanism (bill/process only the delta). Our ingest step should compute a content
   delta per stable source id rather than inserting a new row per sync.
3. **A `dreaming`-equivalent async consolidation stage, decoupled from ingest.** Their design keeps fresh content
   queryable immediately (hybrid fallback) while graph consolidation catches up in the background. That is exactly the
   right shape for our `consolidate`/`reinforce` stages, and it avoids blocking writes on LLM calls.
4. **Typed relations on memories: `updates` / `extends` / `derives`, plus `isLatest` + version chains
   (`rootMemoryId`, `parent`/`child` with relative version distance).** This gives temporal correctness without
   destroying history and is cheap to model in Postgres (self-referencing edge table + version column).
5. **Inference down-weighting + a human review queue.** `isInference` facts rank below stated facts until
   `approve`/`decline`/`undo`, and `decline` soft-forgets. For coding agents this is the right trust model for
   auto-generated skills and derived decisions.
6. **Soft delete + recoverable search (`isForgotten`, `include.forgottenMemories`, `forgetReason`, `forgetBatchId`,
   `dryRun` previews for bulk forget).** Cheap to build, high operator trust. Copy the `dryRun`-then-`ids` two-phase
   pattern for destructive ops.
7. **Profiles as a separate read path with static/dynamic split + topic buckets.** "Facts that must be true regardless
   of the query" (names, preferences, tone, timezone) is a real gap that pure retrieval cannot close. Our `preference`
   and `working` layers should be profile-addressable in one call.
8. **`containerTag` as a hard, authorization-enforced boundary, with metadata as the intra-scope filter.** Their rule
   — never use a tag for something metadata should do, never use metadata to cross a tag — is a good ADR constraint for
   our project/entity scoping. Also copy scoped credentials that `403` rather than silently filter.
9. **Cross-agent shared repo memory via a deterministic repo fingerprint tag** (`repo_<name>__<hash(normalized git
   remote)>`) with an `sm_scope`-style metadata discriminator between personal and project knowledge. This is precisely
   our "git-fingerprint code memory" requirement and they have a shipped implementation to learn from.
10. **AST-aware code chunking.** They open-sourced `code-chunk` (MIT) — we can either reuse it or mirror its contract
    (functions/classes/methods intact, comments attached). Directly applicable to our code memory.
11. **An open benchmark harness as a credibility artifact.** MemoryBench being MIT and provider-pluggable is how they
    make their numbers contestable. If onememory claims retrieval quality, ship the harness, not just the number.
12. **Token-budget-friendly result shapes.** Their `aggregate` mode (multiple memories synthesized into one result
    slot) is a concrete answer to "hybrid token-budgeted retrieval": bound slots, not just count.

## What to avoid

1. **Do not make a hosted proprietary extraction model the load-bearing part of the product.** That is Supermemory's
   moat and it makes their OSS binary strictly worse than their cloud ("higher-quality memories at a lower effective
   cost"). For an Apache-2.0 local-first engine, extraction quality must be reachable with a user's own model or the
   OSS build becomes a demo.
2. **Avoid a wide public API surface with parallel versions and undocumented deprecations.** They carry `/v3` and `/v4`
   simultaneously, have deprecated `/v3/search` and `include.chunks`, a `containerTag`/`containerTags` ambiguity, and
   their own migration guide uses plural `container_tags` that their integration prompt forbids. That drift is a real
   support cost. Version deliberately and keep one canonical write/read pair.
3. **Do not rely on undocumented internals in our own claims.** "Custom learning model" and "temporal vector-graph
   engine" are marketing labels with no published schema, index, or model details; no RRF/BM25/fusion specifics, no
   validity intervals, no memory-event webhooks. If we describe our engine, name the actual structures.
4. **Don't copy the "return average 10 tokens per fact" claim without measuring.** It is their stated number under
   their extraction; ours will differ and it drives prompt budgets.
5. **Don't build features that compete with your own users.** Their discontinued company-brain/Nova products were
   killed partly for "conflict of interest" with customers. Our roadmap should keep onememory a layer, not a
   competing app, and say so explicitly.
6. **Don't let marketing and docs disagree.** Free tier is "$5 credits" in two places but "100k tokens" in another;
   self-hosting is "free and open source" in one place and "available on Scale and Enterprise" in another; recall
   latency is "187ms median" and "~sub-300ms p50". Pick one source of truth per number.
7. **Don't over-index on any single benchmark number.** They publish 95% Recall@15 (README) and 97% Recall@20
   (research page) for the same benchmark family under different configs; aggregator params materially move the score.
   Report config alongside result.
8. **Don't assume self-hosting parity.** Their own docs enumerate what the binary omits (connectors, MCP, tuned
   extraction, scale). If onememory claims self-host parity, it must actually hold for every layer we ship.

## Open questions

1. **What storage engine is actually inside "Supermemory local"?** Docs say "embedded graph engine" with data in one
   directory and no DB to provision. Is it SQLite/embedded Postgres/DuckDB/custom? Nothing published. Relevant to our
   Postgres-dialect + PGlite decision — worth reading `packages/` source directly before we lock the storage ADR.
2. **How exactly are memories deduplicated at write time?** `customId` dedupes documents, but there is no published
   rule for two semantically identical facts from different documents. Is dedupe LLM-judgment inside dreaming? Unclear.
3. **Are validity intervals stored, or only derived?** `updates` + `isLatest` + version chains are documented, but
   `valid_from`/`valid_until` are not. Their own blog advises keeping those in the application. Confirm by reading code.
4. **What is the actual retrieval fusion?** No primary source confirms RRF, BM25, dense+sparse, or how `similarity`
   is computed or calibrated against `threshold` (0.5 docs vs 0.6 OpenAPI default). We need our own calibration plan.
5. **Are there memory-level webhooks/events?** Connectors use webhooks inbound; no user-facing memory-change
   subscription is documented. If onememory wants agent hooks (on-stop → save), we define this ourselves.
6. **What are org-wide rate limits?** Only scoped-key defaults are documented. Need real limits before designing
   client backoff/retry.
7. **How is `aggregate` implemented, and what does it cost?** It is billed under `sm_operations` ($100/1M) and its
   output IDs look synthetic (`aggregated_0_<ts>`); whether aggregated results are persisted, cached, or re-synthesized
   per query is not documented. Matters for our consolidation layer.
8. **What did `olm` refer to?** Not present in the org (404). Confirm whether it was ever a supermemory project or an
   unrelated name before we cite it.
9. **Is the self-hosted binary's license really just the repo MIT, or are parts under other terms?** The top-level
   LICENSE is MIT; individual `packages/` may carry their own terms. Verify before we plan any reuse.
10. **Does `dreaming: dynamic` have a bounded latency guarantee in the hosted API?** The blog says "at most fifteen
    minutes"; the API docs only say extraction "may continue after `status: done`". We need a deterministic
    consolidation SLA in our own design, not a heuristic.
