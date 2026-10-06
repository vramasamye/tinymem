# ADR-0012: OAuth 2.1 deployment posture — local loopback, hosted OIDC, proxy for SaaS

Status: Accepted · Date: 2026-10-06

## Context

M5b `mission/5b-mcp-hardening` shipped a Streamable-HTTP MCP transport with an OAuth 2.1
PKCE client (`packages/mcp/src/oauth/`: `client.ts`, `store.ts`, `verifier.ts`,
`metadata.ts`) plus an operator surface (`onemem auth` loopback). The client exercises
end-to-end against a fake OIDC server in `packages/mcp/src/oauth.test.ts`. The production
deployment posture — what a real install does in each of the three supported modes —
was committed in code but not codified in an ADR, leaving an honest gap that the
M5b cross-follow-up document calls out.

ADR-0007 `security-privacy-provenance` covers the credential and redaction story; this
ADR is the OAuth-specific complement for the new transports.

## Decision

Three deployment modes, each with an explicit posture enforced in the default profile:

### 1. Local (default profile — single user, single machine)

- **Auth posture**: MCP server binds loopback only. No external OIDC discovery.
- The OAuth 2.1 PKCE client is wired for the `Streamable-HTTP` transport when the operator
  opts in (e.g. a headless `onemem serve` against a remote MCP client); the default `serve`
  is still the daemon-backed HTTP form documented in ADR-0010 §2.
- The default-profile network-guard assertion (`packages/security/src/network-guard.test.ts`)
  pin: zero outbound HTTP calls during `onemem serve` bind. The M5b cross-follow-up surfaces
  this as a P3 follow-up that is **already** asserted for the Streamable-HTTP startup path
  (`test(security): pin zero-outbound on the streamable-http startup path`).

### 2. Hosted OIDC (operator-controlled, on a server the operator owns)

- The operator supplies `ONEMEMORY_OIDC_ISSUER` and `ONEMEMORY_OIDC_CLIENT_ID` env vars.
- `onemem auth login` performs the PKCE dance and persists tokens via the existing
  `packages/mcp/src/oauth/store.ts` (encrypted at rest by the project-local secret store).
- Loopback redirect URI in this mode is the **server's** localhost plus a stable port:
  `http://127.0.0.1:<configured-port>/oauth/callback`. There is no public callback.
- `metadata.ts` does discovery against the configured issuer only; no other URL fetches.
- Token refresh is automatic; revocation is via the existing `onemem auth logout` surface
  (M5b cross-follow-up item 3 — small follow-up).

### 3. SaaS / multi-tenant (ADR-0011 posture)

- The MCP server sits behind a reverse proxy (the canonical pattern). The proxy terminates
  TLS, performs any SSO/OIDC redirect on behalf of the MCP client, and forwards an
  authenticated request to the MCP server with a short-lived bearer token it mints.
- The MCP server validates the bearer against the proxy (HMAC of issuer URL + expiry
  window; or public-key verification depending on proxy choice).
- **The PKCE client in `packages/mcp/src/oauth/` does not run in this mode.** The
  proxy handles OAuth; the MCP server sees only a verified bearer. This avoids double
  OAuth with the proxy.
- The MCP server never holds long-lived OAuth tokens in this mode; trust is established
  with the proxy by an out-of-band mechanism (mTLS, HMAC secret rotation, etc.).

### Network-guard invariant (applied to all three modes)

The default `packages/security/src/network-guard.test.ts` always asserts zero outbound
calls during:
- `onemem serve` startup (Streamable-HTTP and stdio bin transports).
- `onemem auth login` (PKCE discovery, token exchange, token refresh — all URL-allowlisted
  to the configured issuer).
- The conformance runner startup.

The hosted and SaaS modes **opt in** to outbound calls but only to the configured issuer
URL. The guard's allowlist is read from config (`ONEMEMORY_OIDC_ISSUER` and the SaaS
proxy URL). Any other URL is rejected with `network_guard.rejected` and the call is
recorded in the audit trail.

### Token storage

Tokens minted during `onemem auth login` are stored in
`packages/mcp/src/oauth/store.ts`, which uses the project's existing secret store
(`packages/security/`). They are encrypted at rest and only decrypted on demand by the
client. The plain token never appears in logs, prompts, or pull-request text.

### Conformance

ADR-0010 §4 conformance suite already exercises 5 runtimes × {stdio, streamable-http}
forms. OAuth posture conformance is at the unit level against a fake OIDC server
(`packages/mcp/src/oauth.test.ts`); cross-runtime OAuth is not yet a conformance
fixture — track as a follow-up and pin in a future mission.

## Consequences

- The default profile is unchanged: local-first, zero-outbound, single user, single
  machine. No telemetry. Per ADR-0007.
- Hosted OIDC mode requires explicit operator consent (`ONEMEMORY_OIDC_ISSUER` +
  `ONEMEMORY_OIDC_CLIENT_ID`); defaults still bind loopback only.
- SaaS mode delegates OAuth to a reverse proxy. The MCP server never touches the
  long-lived token. Compatible with ADR-0011's multi-tenant model.
- The network-guard becomes config-driven. M1b's guarding story extends naturally; the
  canned test should run in all three modes by switching `ONEMEMORY_OIDC_ISSUER`.

## References

- ADR-0007 `security-privacy-provenance` (credential, redaction, audit-trail story).
- ADR-0010 `mcp-protocol-adapters` (Streamable-HTTP transport and 11-tool surface).
- ADR-0011 `saas-path` (multi-tenant posture).
- `docs/plan/mission-reports/mission-5b-mcp-hardening.md` (M5b result).
- `packages/mcp/src/oauth/{client,store,verifier,metadata}/` (M5b PKCE client).
- `packages/mcp/src/streamable-http/` (M5b transport).
- Cross-mission follow-up #1 of M5b (backlog `## Cross-mission follow-ups — raised by M5b`).
