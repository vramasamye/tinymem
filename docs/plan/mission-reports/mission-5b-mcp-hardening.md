# Mission 5b report — MCP hardening: Streamable HTTP + OAuth 2.1 + cross-runtime conformance

**Branch:** `mission/5b-mcp-hardening` (worktree `onememory-m5b`, base `ae24030`)
**Scope delivered:** the M5b extension of M5 (backlog M5 issues 2 + 5): the sessionful
Streamable-HTTP transport with session management, the OAuth 2.1 loopback PKCE client +
resource-server gate, the 5-runtime conformance suite extended to the streamable-http form,
the default-profile network-guard assertion in streamable form, and this report.

**Two workers, one mission.** The first M5b worker died (`model_provider_unreachable`) at
3.8 hours with the scope half-done; its independently-green work landed as the salvaged
milestone `a161e1e` (the parent coordinator's call — nothing was rewritten). This continuation
(`99890ae`, `8744e43`, `34e5727`, plus this docs commit) landed the remaining AC **on top of**
the salvage: the conformance suite, the network-guard pin, and the missing OAuth client test
file — while also discovering that one AC the continuation brief listed as "already green"
(OAuth loopback, AC 2) was in fact **unverified**: the salvaged code referenced
`packages/mcp/src/oauth.test.ts` twice (from `oauth/client.ts`'s header and
`server-mode.test.ts`), but the file did not exist. It now does, and the flow passes.

## Commits

| Commit | Summary |
|---|---|
| `a161e1e` | `feat(mcp)`: salvaged milestone — streamable-http/ (session-manager, event-store, serve), oauth/ (client, store, verifier, metadata), CLI `auth`/`serve` commands, daemon `/mcp` OAuth gate wiring, `server-mode.test.ts` (970 lines), `embedded-transactions.test.ts` |
| `99890ae` | `test(conformance)`: the 5-runtime conformance suite extended to the streamable-http form — byte-identical vs the in-process (stdio) form |
| `8744e43` | `test(security)`: the network guard's "zero outbound in default config" claim pinned against the Streamable-HTTP startup path |
| `34e5727` | `test(mcp)`: the OAuth 2.1 loopback PKCE flow end-to-end against a fake OIDC server (the missing `oauth.test.ts`) |
| (this) | `docs`: mission-5b report |

---

## 1. Acceptance criteria — delivered status

| # | AC (M5b) | Status | Where |
|---|---|---|---|
| 1 | Streamable HTTP transport (server mode) with session management | **delivered** (salvage) | `packages/mcp/src/streamable-http/{session-manager,event-store,serve,auth,index}.ts`; pinned by `server-mode.test.ts`: session lifecycle (`Mcp-Session-Id` mint/route, 400/404/405, DELETE terminate, 503 session cap, 406/415 gates), SSE framing + `id:` lines, `Last-Event-ID` resumability (replay-after, priming event, live-tail), concurrent sessions over one shared context, the real SDK client over a real socket, the M13c owner-guard on the http leg |
| 2 | OAuth 2.1 loopback PKCE flow (backlog M5.5, P4) | **delivered + now VERIFIED** | `packages/mcp/src/oauth/` (salvage) + `packages/mcp/src/oauth.test.ts` (this continuation): the full flow runs end-to-end against a fake OIDC server — RFC 8414 discovery → RFC 7591 DCR → PKCE S256 + state on the authorize wire → RFC 8252 loopback receiver → RFC 9207 `iss` binding → token exchange (PKCE re-derived and CHECKED by the fake AS) → 0600 atomic persistence; refresh rotation without a browser leg; tampered state refused before any code is exchanged. The resource-server side (bearer gate: 401 + `WWW-Authenticate` → RFC 9728 document, 403 `insufficient_scope`, RFC 8707 audience binding, public discovery docs) is pinned in `server-mode.test.ts` |
| 3 | Conformance suite (same events, same tools, same results) extended to the streamable-http form, all five runtimes, byte-identical vs the stdio form | **delivered** (this continuation) | `benchmarks/eval/src/mcp-conformance/{pipeline,streamable-http.test}.ts` — 13 tests / 145 expects, all five runtimes byte-identical vs the in-process form per runtime, deviations pinned by dedicated tests |
| 4 | Default-profile network-guard assertion in streamable-http form (local-first invariant) | **delivered** (this continuation) | `packages/security/src/network-guard.test.ts` — startup + full session + shutdown over `createOnememoryStreamableHttpServer` with default config under `installNetworkGuard`: zero outbound calls, `attempts == []`. (The salvaged `server-mode.test.ts` already pinned the session-level form; this extends the claim to the startup path, in the guard's own suite) |
| 5 | Mission report with exact counts, reuse citations, honest residual risks, concrete follow-ups | **delivered** (this commit) | this file |

---

## 2. The streamable-http conformance suite (the primary new deliverable)

**What it is.** One canonical 10-fact session (the M8/M9 `adapter-conformance/scenario.ts`),
rendered into each runtime's NATIVE hook payloads, translated by each adapter's own entry
point, ingested + extracted through the REAL engine — then the model-facing session surface
served over the REAL Streamable-HTTP transport: a real `Bun.serve` socket, the official SDK
client (`Client` + `StreamableHTTPClientTransport`), `Mcp-Session-Id` routing, one MCP session
per run. The wire surface exercised: `initialize` → `tools/list` → `memory_search` (the
progressive-disclosure ID-index) → `memory_get` for every index row → `DELETE` terminate.

**What is engine-side in both forms, by architecture.** Adapters deliver events through the
storage ingest path (hook payload → adapter translation → `ingestEvent` → extract job), not
through MCP tools — there is no event-ingest tool on the 8-tool surface. The transport under
test is the model-facing surface. The suite proves exactly that: the session through the
HTTP-serving world produces byte-identical durable memories AND reads back identically over
the wire.

**The headline assertions (per runtime, vs the in-process form):** same events, same
translation drops, same extraction counts, same memories + evidence, same working memory,
same `memory_search` ranking, same `memory_get` payload — **all six green for all five
runtimes (Claude, Cursor, Codex, Pi, OpenCode)**.

**Design decisions worth recording:**

- **One normalizer, not two.** The in-process pipeline's normalizers
  (`normalizeMemory/Get/Working/Evidence`, `compareMemories`) became shared exports; the wire
  pipeline imports them. A second normalizer could drift into its own notion of "equal" and
  make the cross-form assertion vacuous.
- **The wire validates the wire.** Every `tools/call` result crossing the streamable-http
  transport is parsed with the tool's own exported Zod output schema
  (`MemorySearchOutputSchema`, `MemoryGetOutputSchema`) — the package's wire contract is the
  boundary check, no `any`.
- **Packing-mode pin.** The in-process form's ranking is `type|content ?? summary` over the
  engine rows; the ID-index omits content bodies by design, so the wire reconstruction
  branches on the wire-REPORTED `tokens.packing` ('content' → `memory_get` bodies; other modes
  → the index row's summary — exact in all three modes). The mode itself ('summary' for this
  scenario) is pinned by a dedicated test so a budget/packing change flips one loud test
  instead of silently weakening the comparison.
- **Documented divergence, pinned not folded.** Codex keeps the remember clause's trailing
  period (pre-existing, stdio-form-pinned since M8). It reproduces IDENTICALLY through the
  wire form — which is precisely what the per-runtime byte-identical tests prove for Codex —
  and a dedicated test (`DOCUMENTED DIVERGENCE: only Codex keeps…`) pins it in the new form.
  Cross-runtime equality is asserted modulo that one divergence, exactly like the M8/M9
  suites.

---

## 3. The OAuth verification (completing the salvage's own contract)

The salvaged `oauth/client.ts` header says its security properties are "each pinned by a test
in `../oauth.test.ts`" and `server-mode.test.ts` says "the JWT/JWKS leg is exercised in
oauth.test.ts" — the file the dead worker never committed. Both references are now true.
What the file pins, against a fake OIDC server over real sockets (Bun.serve; the fake AS
VALIDATES rather than rubber-stamps — PKCE S256 re-derivation, redirect_uri binding,
single-use codes):

- the full loopback flow: discovery → DCR → PKCE + state → redirect → exchange → 0600
  persistence (`via: 'authorization-code'`, issuer/scope/savedAt reported);
- PKCE S256 END-TO-END: the token request's verifier hashes to the authorize challenge
  (43-char base64url, `code_challenge_method=S256` on the wire);
- the RFC 8707 `resource` indicator rides both the authorize URL and the token request;
- the tampered-state leg: a callback with a foreign state is refused BEFORE any code is
  exchanged — no token request ever happens, nothing persisted but the DCR client;
- an AS error redirect (`error=access_denied`) surfaces loudly, not as tokens;
- `refreshStoredOAuth` rotates tokens with NO browser leg (`grant_type=refresh_token`),
  and refuses loudly when nothing is stored;
- the credential store: 0600 + atomic writes, merge-by-part (client then tokens), issuer
  overwrite refusal, corrupt-file tolerance, the PKCE verifier NEVER on disk;
- `oauthStatus`: the real state, zero token material;
- the JWT verifier leg (`createJwtTokenVerifier`, jose): a real RS256 token over a served
  JWKS verifies to `AuthInfo`; wrong audience / no `exp` / no client identity are refused.

---

## 4. The network-guard pin (AC 4)

`packages/security/src/network-guard.test.ts` now carries the streamable-http form of the
local-first claim: under an ACTIVE guard, `createOnememoryStreamableHttpServer` with the
default config (embedded PGlite + migrations, session manager, `Bun.serve` socket bind), a
full model-facing session (initialize → tools/list → store → get → search → DELETE terminate)
and shutdown — `assertZeroCalls()` passes at every stage, `attempts == []`. Requests are
driven as real `Request` objects through the serve entry's `handle` (the same shape
`Bun.serve` receives) because the guard correctly blocks even loopback fetch — an SDK CLIENT
over the socket is an outbound call by definition; the server side, which is what the
default-profile claim is about, is fully exercised. `@onememory-ai/mcp` joined packages/security
as a test-only devDependency (the same pattern as the storage devDep its taint integration
test already uses).

---

## 5. Reuse (before build) — the honest citation

- **The MCP SDK**: `@modelcontextprotocol/client` + `@modelcontextprotocol/server` + core,
  all pinned at **2.3.0** — the official `modelcontextprotocol/typescript-sdk` v2 split
  packages (already verified in `docs/research/dependency-verification.md` §8). The
  sessionful transport IS `WebStandardStreamableHTTPServerTransport` (the SDK's); onememory
  owns only the per-process session REGISTRY the SDK leaves to hosts. The OAuth client flow
  IS the SDK's `auth()` orchestrator (discovery, DCR, PKCE via the SDK's `pkce-challenge`,
  token exchange, refresh); onememory implements only the SDK's `OAuthClientProvider` seam.
  The bearer gate shapes (`requireBearerAuth`-style 401/403 challenges, RFC 9728 document
  serving) are the SDK's.
- **`jose` 6.x** (JWT/JWKS verification) — surfaced as a direct dependency of
  `packages/mcp`, already in the lockfile as an SDK transitive.
- **`oidc-client-ts` was NOT used** — the continuation brief asked to confirm this citation,
  and the honest answer is the code never referenced it: the loopback flow rides the MCP SDK's
  own OAuth implementation, which is the better-reuse choice (it speaks MCP's authorization
  spec natively — RFC 9728 discovery, SEP-2352 issuer binding). No OIDC library was needed
  and none was added.

---

## 6. Tests and validation

All counts from this worktree at HEAD (`34e5727` + this docs commit):

| Suite | Result |
|---|---|
| `bun test benchmarks/eval packages/mcp packages/security apps/cli` (the validation scope) | **391 pass / 0 fail / 2091 expects / 26 files** — baseline at mission start was 369 / 0 / 1865 / 24, so the mission adds **+22 tests, 0 regressions** |
| `bun test benchmarks/eval` (both conformance forms) | 104 pass / 0 fail — the new `mcp-conformance/streamable-http.test.ts` is 13 tests / 145 expects |
| `bun test packages/mcp` | 139 pass / 0 fail / 940 expects / 9 files — the salvage's 131 + 8 new (`oauth.test.ts`) |
| `bun test packages/security` | 99 pass / 0 fail / 486 expects / 5 files — +1 (the streamable startup guard) |
| `bun test apps/cli` | 49 pass / 0 fail (unchanged by this continuation) |
| **Full repo `bun test --timeout=15000`** | **1703 pass / 0 fail / 30 skip** (1733 tests, 135 files, 12,780 expects, ~532 s) — the 30 skips are the env-gated Postgres-server leg, by design |
| Typecheck (`tsc --noEmit`) | clean in every touched package: `benchmarks/eval`, `packages/security`, `packages/mcp`, `apps/cli` |

---

## 7. Direct answers (as asked)

- **Does Streamable HTTP handle multiple concurrent sessions correctly today?** **Yes** —
  pinned by tests: concurrent initializes mint distinct ids, concurrent in-flight tool calls
  across sessions do not interfere, one shared context/storage, a live-session cap (default
  256) answers overflow with 503, DELETE deregisters, an initialize POST without a session
  header always mints a NEW session (a request can only address a live session through its
  own `Mcp-Session-Id`; unknown ids → 404). **Scope honesty:** sessions are in-process (a
  restart drops them; clients reconnect, which `Last-Event-ID` resumability makes safe within
  a process lifetime via the in-memory bounded event store). A multi-node session registry /
  durable event store is a documented follow-up, not faked.
- **Does OAuth 2.1 PKCE loopback run end-to-end against a fake OIDC server today?** **Yes** —
  proven by `packages/mcp/src/oauth.test.ts` (this continuation): discovery → DCR → PKCE S256 →
  redirect → exchange → 0600 persistence, plus refresh rotation and the tampered-state
  refusal. It did NOT run verified before this continuation: the implementation was complete
  (salvage) but its test file was missing.
- **Do all five adapters pass conformance in streamable HTTP form today?** **Yes** — 13/13
  tests green; all five byte-identical vs the stdio form per runtime, and identical to each
  other modulo the one pre-existing, dedicated-test-pinned Codex punctuation divergence.
- **Does the default profile pass the network-guard test in streamable-http form today?**
  **Yes** — zero outbound calls across startup + a full session + shutdown, `attempts == []`,
  in the network guard's own suite (`packages/security/src/network-guard.test.ts`), with the
  session-level form additionally pinned in `packages/mcp/src/server-mode.test.ts`.

---

## 8. Residual risks and concrete follow-ups

**Manus-side (coordinator-owned docs/ADR) — the ADR amendment the mission owes:**

1. **ADR-0010 amendment for the OAuth deployment story.** The shipped reality that needs
   recording: TWO HTTP surfaces exist by design — the daemon's stateless `/mcp` mount
   (`createOnememoryStreamableHttpHandler`, one shared context, fresh McpServer per request;
   `onemem serve --mcp-auth <issuer>` gates it) and the sessionful streamable-http transport
   (`onemem-mcp` with `ONEMEMORY_MCP_TRANSPORT=http`; `Mcp-Session-Id` + SSE + resumability;
   OAuth gate via `ONEMEMORY_MCP_AUTH_ISSUER`). The amendment should state which deployments
   pick which, the RFC 9728/8414 discovery contract both honor, and that JWT-with-JWKS is the
   token verification path (RFC 7662 introspection is the honest NOT-yet for ASes that do not
   sign JWTs — the `OAuthTokenVerifier` port is the seam). The risks table entry for the
   local-first default (no issuer → no auth → zero network) should be recorded there too.

**Code-side follow-ups (backlog candidates, none block Phase 4 DoD):**

2. **The daemon's `--mcp-auth` boot path has no direct test** (`apps/api/src/runtime/daemon.ts`
   loads the issuer's metadata + builds the gate at startup, refuses `port === 0`, reports the
   local credential). The gate itself is tested (static + JWT verifiers, in
   `server-mode.test.ts`); the daemon wiring (startup ordering, refusal semantics,
   `ServeInfo.mcp_auth`) is not.
3. **`onemem auth` (apps/cli/src/commands/auth.ts) has no test file.** The flow it drives is
   now covered by `oauth.test.ts`, but the CLI surface (config-dir resolution, status/logout
   exits, io rendering) is untested.
4. **Sessionful transport durability:** `InMemoryResumabilityStore` drops resumability state
   on restart (bounded rings, per-stream). A pluggable durable `EventStore` (the port already
   exists) is the multi-instance deployment follow-up.
5. **`oauthStatus().resource` is always `undefined` today** — the store never persists the
   RFC 8707 resource the tokens were minted for (the SDK's `saveTokens` carries none). The
   status surface already renders it; a one-line capture at save time would light it up.
6. **The Codex remember-clause trailing-period normalization divergence** remains the one
   open cross-runtime gap (pre-existing since M8, pinned by dedicated tests in BOTH
   conformance forms now — a Codex-side normalization fix is that mission's lane).
7. **Vector-channel conformance:** both conformance forms run with no embedding provider
   configured (the lexical + graph channels only) — a vector-channel variant of the suite is a
   future quality-gate, not a correctness gap.

**No follow-up from this mission touches `docs/architecture/**` or `docs/adr/**`** — the
file lane held: `benchmarks/eval/src/{adapter-conformance,mcp-conformance}/**`,
`packages/security/src/network-guard.test.ts` (additive), `packages/mcp/src/oauth.test.ts`
(new, the salvage's own promised file), the two touched `package.json` dev/deps + `bun.lock`,
and this report.
