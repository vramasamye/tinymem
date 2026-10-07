# Security & deployment architecture

Status: living document · Owners: coordinating session · Last updated: 2026-10-06

This document is the operator's reference for running onememory **outside a single trusted
machine**. It complements the decision records — it does not restate them:

| Decision | What it fixes |
|---|---|
| [ADR-0007](../adr/0007-security-privacy-provenance.md) | Redact at ingest, no secret vault, provenance/audit backbone, 100%-local profile |
| [ADR-0010](../adr/0010-mcp-protocol-adapters.md) | MCP protocol + adapters; the daemon's stateless `/mcp` surface |
| [ADR-0011](../adr/0011-saas-path.md) | Multi-tenant posture (RLS, org isolation) |
| [ADR-0012](../adr/0012-oauth-deployment-posture.md) | OAuth 2.1 posture per deployment mode |

Where this document and an ADR disagree, the **code is the tie-breaker** and the disagreement is a
documentation bug — §7 lists the ones known today.

## 1. What "local-first" guarantees, and where it stops

The default install is a single process on a single machine:

- `onemem serve` binds **loopback only** (`daemon.host`, default `127.0.0.1`).
- The default profile makes **zero outbound calls**: no embedder and no LLM provider are
  configured, so the network guard is installed and blocks every `fetch`
  (`packages/security/src/network-guard.ts`, plan decided by `networkGuardPlan` in
  `packages/config/src/derive.ts`).
- Secrets are redacted **before** anything is persisted (ADR-0007); `.env*`, key files, and
  configured globs are excluded from ingestion entirely.

Everything below is about the moment you step outside that envelope.

## 2. Trust boundaries

```
                          untrusted network
                                 │
                    ┌────────────▼────────────┐
                    │  reverse proxy / gateway │   TLS, OIDC/SSO, rate limits,
                    │  (operator-owned)        │   path routing, request logs
                    └────────────┬────────────┘
                                 │  authenticated request
                    ┌────────────▼────────────┐
                    │  onemem serve            │   binds a PRIVATE interface
                    │   ├─ POST /mcp   (gated) │   ← the only auth-aware surface
                    │   └─ /v1/*       (open)  │   ← NO authentication
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  Postgres + pgvector     │   single owner (ADR-0002)
                    └─────────────────────────┘
```

Two boundaries carry all the risk:

1. **The `/v1/*` REST API has no authentication.** It is a loopback control plane for the CLI and
   the web explorer. Never publish it. The compose stack publishes it on `127.0.0.1` only for
   exactly this reason. It also writes to the host filesystem: `POST
   /v1/projects/{id}/skills/{skillId}/promote` accepts an explicit `dir` and writes
   `<dir>/<name>/SKILL.md` as the daemon user, so a published `/v1` is a file-write primitive,
   not only a data leak.
2. **The `/mcp` endpoint is the model-facing surface.** It can be gated with OAuth 2.1
   (`--mcp-auth`), and it is the only surface that should ever face a proxy.

## 3. Deployment modes

### 3.1 Local (default)

| Property | Value |
|---|---|
| Bind | loopback only; a non-loopback `--host` is refused unless `--listen-public` is passed |
| Auth | none — the loopback boundary *is* the control |
| Outbound | none (network guard enforced) |
| MCP | `POST /mcp`, stateless, unauthenticated |

Use this for one developer, one machine, one agent runtime at a time.

### 3.2 Hosted single-tenant (operator owns the box)

The operator runs `onemem serve` on a server and reaches it from remote agent runtimes.

```bash
onemem serve \
  --host 127.0.0.1 \          # keep the socket private; the proxy is the public face
  --port 7331 \
  --mcp-auth https://idp.example.com   # OAuth 2.1 on /mcp
```

`--mcp-auth <issuer>` does three things at **startup** (a misconfigured issuer fails the boot, not
the first request — `apps/api/src/runtime/daemon.ts`):

1. loads the issuer's RFC 8414 metadata and JWKS,
2. builds the RFC 9728 Protected Resource Metadata document, served unauthenticated at
   `/.well-known/oauth-protected-resource` (and the AS metadata at
   `/.well-known/oauth-authorization-server`) so a client without a token can discover where to
   authorize,
3. installs a bearer gate on `/mcp` that requires the configured scopes (default
   `onememory:read onememory:write`) and validates the token's **audience** against the daemon's
   own URL (RFC 8707 — a token minted for another resource is refused with 401).

`--mcp-auth` requires an **explicit port**; an ephemeral port cannot be a token audience.

Client side: `onemem auth login --server-url <daemon-url>` (or `--issuer <as-url>`) runs the OAuth
2.1 PKCE dance and stores the credential `0600` under the config dir. `onemem auth status` and
`onemem auth logout` round it out.

The daemon's outbound network in this mode is the operator-configured issuer only: the RFC 8414
metadata at startup, and the JWKS URI resolved from it (jose caches the key set, so token
verification itself performs no per-request network). Nothing else.

There are **two** ways to serve MCP; both take the same OAuth gate:

| Surface | Bind | Auth switch |
|---|---|---|
| Daemon REST app | `onemem serve --host --port` (`daemon.host`/`daemon.port`) | `--mcp-auth <issuer>` |
| Standalone MCP HTTP server | `ONEMEMORY_MCP_TRANSPORT=http`, `ONEMEMORY_MCP_HTTP_HOST`/`_PORT` (default `127.0.0.1:7333`) | `ONEMEMORY_MCP_AUTH_ISSUER` (+ `ONEMEMORY_MCP_AUTH_SCOPES`) |

Both refuse a non-loopback bind unless you opt in (`--listen-public` /
`ONEMEMORY_MCP_HTTP_ALLOW_PUBLIC=true`) and both refuse an ephemeral port when auth is on.

### 3.3 SaaS / multi-tenant — the reverse-proxy pattern

For anything multi-tenant, put the MCP server behind a reverse proxy. This is the canonical
pattern and the subject of §4.

## 4. Reverse-proxy pattern (production)

onememory does **not** ship a proxy. It ships an MCP server that behaves well behind one. The
pattern:

```
        MCP client (agent runtime)
                 │  HTTPS
        ┌────────▼──────────────────────────────────────────┐
        │  proxy (nginx / Caddy / Envoy / cloud LB)         │
        │   • terminates TLS                                │
        │   • authenticates the end user (OIDC/SSO)         │
        │   • forwards Authorization: Bearer <access token> │
        │   • routes /onememory/* → 10.0.0.5:7331/mcp       │
        │   • streaming-friendly (no response buffering)    │
        └────────┬──────────────────────────────────────────┘
                 │  private network
        ┌────────▼──────────────────────────────────────────┐
        │  onemem serve --host 0.0.0.0 --listen-public      │
        │               --mcp-auth https://idp.example.com  │
        └───────────────────────────────────────────────────┘
```

### 4.1 Division of responsibility

| Concern | Owner |
|---|---|
| TLS termination, HSTS, cipher policy | proxy |
| User authentication / SSO redirect | proxy (or the IdP directly, via the client's PKCE flow) |
| Issuing or forwarding the access token | proxy |
| Token signature/issuer/audience/scope verification | **onememory** (`--mcp-auth`) |
| Path routing, multiple MCP servers under one host | proxy |
| Rate limiting, request size caps, WAF | proxy |
| Per-memory authorization (ACLs) | **not implemented** — see §7 |
| Redaction, provenance, audit trail | **onememory** (ADR-0007) |

### 4.2 Two ways to get a token to the daemon

**A. Forward the user's OIDC access token (simplest, fully supported).** The proxy authenticates
the user against the IdP and forwards the IdP's access token unchanged. The daemon validates it
directly: signature against the issuer's JWKS, `iss` = the configured issuer, `aud` = the daemon's
resource URL, and the required scopes. The token's audience must therefore be the daemon's URL (or
include it) — configure your IdP's audience/resource parameter accordingly.

**B. Mint a short-lived token at the proxy.** If your IdP cannot set the audience to the daemon's
URL, have the proxy mint its own short-lived JWT and point `--mcp-auth` at *the proxy's* issuer
URL. The proxy then owns token lifetime and revocation, and the daemon holds no long-lived
credential. This is the ADR-0012 "SaaS" shape.

Do **not** run the `packages/mcp/src/oauth/` PKCE client in the daemon in either mode — it is the
*client* side (used by `onemem auth`). Running both would double up OAuth.

### 4.3 Aggregating several MCP servers behind one host

An MCP client can be pointed at one host and several servers. Route by path and rewrite:

```
location /onememory/ {
    proxy_pass         http://10.0.0.5:7331/mcp;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   Authorization $http_authorization;   # forward, never log
    proxy_buffering    off;          # Streamable HTTP uses SSE; buffering breaks it
    proxy_read_timeout 3600s;        # long-lived streams
    chunked_transfer_encoding on;
}
```

Caveats for aggregation:

- The **audience** check is per-resource. If the daemon sits at `/onememory/mcp` but its
  `resourceServerUrl` is `http://10.0.0.5:7331`, tokens must carry that audience. Either give the
  daemon a public hostname (`--host` / a `Host`-preserving proxy) so the audience matches what the
  client requests, or use pattern B and let the proxy be the issuer.
- The RFC 9728 discovery documents are served by the **daemon** at the well-known paths. A client
  discovering from the proxy's public origin needs the proxy to route
  `/.well-known/oauth-protected-resource` to the daemon too (the daemon's `resourceServerUrl` must
  be the public origin for discovery to be coherent).
- A resource URL that **carries a path** (`https://gw.example.com/onememory`) makes RFC 9728
  clients request the path-suffixed form `/.well-known/oauth-protected-resource/onememory`. The
  daemon registers only the bare path, so the proxy must map the suffixed form to the bare one (or
  give the daemon a path-less public origin, e.g. a dedicated hostname).

### 4.4 What the proxy must not do

- **Do not log `Authorization` headers or request bodies.** Memory payloads and tokens both flow
  here; the daemon's own redaction (ADR-0007) protects the *store*, not your access logs.
- **Do not buffer SSE responses.** Streamable HTTP relies on server-sent events.
- **Do not rewrite the request path to `/v1/*`.** Only `/mcp` is auth-gated; `/v1/*` has no
  authentication and must never be reachable from an untrusted network.
- **Do not enable CORS `*` on `/mcp`.** MCP clients are not browsers; a permissive CORS policy on
  an auth-gated endpoint only widens the attack surface.

## 5. Network guard in hosted modes

The guard (`packages/security/src/network-guard.ts`) blocks **every** `fetch`, including loopback.
`networkGuardPlan` decides whether it is installed:

- `security.network_guard: auto` (default) — installed exactly when the resolved config enables no
  network-capable component (no embedder, no LLM provider). That is the zero-network promise.
- `security.network_guard: enforce` — always installed; a configured provider's requests will fail.
- `security.network_guard: off` — **rejected** while `llm.profile: local`; the 100%-local
  guarantee is a product invariant.

Consequence for hosted deployments: a config that enables a remote embedder or LLM provider makes
`auto` *not* install the guard (the plan reports the reason and `onemem doctor` surfaces it as a
warning). The daemon's startup OAuth fetch to the configured issuer happens **before** the guard is
relevant (it is the only outbound call the authed daemon makes), and the conformance/CLI paths that
need to reach a daemon pass a pre-guard fetch deliberately.

> **Gap (see §7):** the guard has no *host allowlist*. It is all-or-nothing. A future change
> should allow loopback + an explicit issuer allowlist so `enforce` can coexist with a hosted
> IdP. ADR-0012 describes such an allowlist as if it exists; it does not yet.

## 6. Hardening checklist

Before exposing an MCP endpoint beyond loopback:

- [ ] `onemem serve` bound to a **private** interface; the proxy is the only public entry.
- [ ] `--mcp-auth <issuer>` set, and the issuer is reachable and correct (the boot fails otherwise).
- [ ] `/v1/*` is **not** routable from the untrusted network (verify with a request from outside).
- [ ] The proxy forwards `Authorization` and logs neither it nor request bodies.
- [ ] `proxy_buffering off` (or the equivalent) for the MCP location.
- [ ] Token audience matches the daemon's resource URL (or the proxy is the issuer — pattern B).
- [ ] Required scopes match your intent (`onememory:read` only for read-only agents).
- [ ] TLS enforced; HSTS set at the proxy.
- [ ] Rate limits and request-size caps configured at the proxy.
- [ ] `onemem doctor` run against the deployed config; every warning read, not silenced.
- [ ] Backups of the Postgres data dir (the memory is the product).

## 7. Honest gaps (known, tracked)

These are real limitations, not hypotheticals. Each is a backlog candidate.

1. **The `/v1/*` REST API has no authentication.** Only `/mcp` can be gated. Any deployment that
   exposes `/v1` must rely entirely on network isolation. Tracked as a Phase-3 concern.
2. **No per-memory ACLs.** Isolation is project/user scope (ADR-0007 §3, ADR-0011); memory-level
   ACLs are backlog M12.5.
3. **The network guard has no host allowlist** (§5) — `enforce` cannot coexist with a hosted IdP
   today.
4. **ADR-0012 names `ONEMEMORY_OIDC_ISSUER` / `ONEMEMORY_OIDC_CLIENT_ID` env vars; the shipped
   surface is `--mcp-auth <issuer>` on `onemem serve`, and `ONEMEMORY_MCP_AUTH_ISSUER` /
   `ONEMEMORY_MCP_AUTH_SCOPES` for the MCP bin's `http` transport.** Treat those as authoritative;
   the ADR-0012 names are aspirational until an amendment reconciles them.
5. **Cross-runtime OAuth is not a conformance fixture.** OAuth posture is pinned at the unit level
   against a fake OIDC server (`packages/mcp/src/oauth.test.ts`); the 5-runtime conformance suite
   exercises stdio and streamable-http *without* OAuth.
6. **No in-process rate limiting.** The daemon trusts the proxy for that.

## 8. References

- [ADR-0007](../adr/0007-security-privacy-provenance.md) — redaction, no secret vault, provenance.
- [ADR-0012](../adr/0012-oauth-deployment-posture.md) — OAuth 2.1 posture per mode.
- [ADR-0010](../adr/0010-mcp-protocol-adapters.md) — MCP transport and tool surface.
- `apps/api/src/runtime/daemon.ts` — bind guard, startup OAuth load, `/mcp` gating.
- `packages/mcp/src/streamable-http/auth.ts` — the bearer gate (scopes, audience, discovery).
- `packages/security/src/network-guard.ts` — the outbound gate.
- `benchmarks/eval/src/mcp-conformance/streamable-http.test.ts` — the wire-surface conformance
  suite (the reference for how a client actually talks to `/mcp`).
- `docker/compose.yaml` — the loopback-published local stack.
