# Mission 12 report — Security core: secret redaction, path exclusions, privacy gate

**Branch:** `mission/12-security`
**Scope delivered:** `packages/security` (`@onememory/security`) — the `Redactor` port implementation,
path exclusion policy, privacy network gate, the ingest integration helper, tests, this report.
**ADR:** 0007 (detect-and-redact at the earliest boundary; kind + location + length ONLY; `.env`/key
files excluded entirely; 100% local mode enforced by testable CI; no secret vault ever).

---

## 1. What changed

New package `packages/security` (10 source files + 5 test files). No existing file was touched;
`bun.lock` gained the workspace entry (storage is a **dev**Dependency — the taint test only).

| File | Role |
|---|---|
| `src/patterns.ts` | The pattern catalog: 14 groups, Zod-validated config (groups on/off, extra patterns), detector compilation |
| `src/marker.ts` | `[REDACTED:<kind>]` marker + `isRedactionMarker` (idempotency guard) |
| `src/redactor.ts` | Scanner (detect → overlap resolution → marker splice → records) + deep walker + `createRedactor` (core port) + `redactValue` |
| `src/redact-event.ts` | `redactEvent(envelope)` — ingest helper: validate → redact whole envelope → recompute `content_hash` → re-validate → `{event, redactions}` |
| `src/exclusions.ts` | Default exclusion globs (non-removable), custom-glob policies, `isPathExcluded`, `isEventPathExcluded` |
| `src/network-guard.ts` | `installNetworkGuard()` — monkey-patches global `fetch`, records origin-only attempts, `assertZeroCalls()` |
| `src/index.ts` | Public surface |
| `src/redactor.test.ts` | 42 tests: coverage table, embedded contexts, overlaps, deep walk, idempotency, config |
| `src/redact-event.test.ts` | 7 tests: canonical output, hash recompute, unknown-kind, taint-safe errors, overflow edge |
| `src/exclusions.test.ts` | 40 tests: 22 excluded / 7 allowed matrix rows, normalization, custom globs, whole-event gate |
| `src/network-guard.test.ts` | 6 tests: throw/reject modes, origin-only recording, double-install, restore |
| `src/taint.integration.test.ts` | 2 tests: the full storage-pipeline taint + zero-outbound proof; excluded-path drop |

`bun test` from worktree root: **184 pass / 0 fail / 14 skip** (198 tests; the 14 skips are M1's
env-gated Postgres-server leg). Security contributes **97 tests / 458+ assertions**, ~1.7s.
`bunx tsc --noEmit` clean in `packages/security` (strict), plus `core` and `storage` re-verified.

---

## 2. Pattern coverage table

Group → synthetic example → detected. Every fixture secret is **synthetic** (prefix + repeated
character). Overlaps resolve earliest-start-first; at equal start longest, then group priority
(specific → generic); overlapping later candidates drop — each secret counted once.

| # | Group | Synthetic example (abridged) | Detected as |
|---|---|---|---|
| 1 | `private-key` | `-----BEGIN RSA PRIVATE KEY-----…-----END RSA PRIVATE KEY-----` (also OPENSSH/EC/encrypted; truncated blocks without END covered by a second pattern) | `private-key` |
| 2 | `connection-string` | `postgres://admin:secretpw@db.internal:5432/app` (also mysql/mongodb(+srv)/redis/amqp/ftp/sftp/smtp/imap/ldap/http(s)/ws(s); the whole URL is redacted — longest wins) | `connection-string` |
| 3 | `anthropic-key` | `sk-ant-aaaa…` | `api-key` |
| 4 | `openai-key` | `sk-aaaa…` / `sk-proj-…` (`sk-ant-` excluded from this group) | `api-key` |
| 5 | `github-token` | `ghp_…` (36) · `gho_/ghu_/ghs_/ghr_` · `github_pat_…` | `token` |
| 6 | `aws-access-key` | `AKIA…` (16 upper) | `api-key` |
| 7 | `google-api-key` | `AIza…` (35) | `api-key` |
| 8 | `slack-token` | `xoxb-…-…` · `xoxa/xoxo/xoxp/xoxr/xapp-…` | `token` |
| 9 | `jwt` | `eyJ…`.`…`.`…` (three or more base64url segments; greedy so a sentence-final period is neither consumed nor blocks detection) | `token` |
| 10 | `bearer-token` | `Bearer <32 chars>` / `Token <value>` (value only; word preserved) | `token` |
| 11 | `basic-auth` | `Basic dXNlcjpwYXNzd29yZDEyMw==` (value only) | `password` |
| 12 | `session-cookie` | `sessionid=…` · `PHPSESSID=…` · `JSESSIONID=` · `connect.sid=s%3A…` · `remember-me=…` (value only; `;`-safe) | `token` |
| 13 | `password-assignment` | `password=hunter2` · `PASSWORD: hunter2` · `--password hunter2` (URL, CLI, prose) | `password` |
| 14 | `env-assignment` | `API_KEY=…` · `GITHUB_TOKEN="…"` · `SUPER_SECRET=…` · `x-api-key: …` — name-gated on key/secret/token/password/passwd/pwd/credential/passphrase; value (quotes included) redacted | by name: `api-key` / `token` / `password` |
| + | user extra patterns | `{id, kind, pattern, flags?}` — full match redacted, must not match empty | user-chosen `kind` |

Proven overlap behaviors (tested): JWT-as-bearer → one `token` record; password inside a
connection string → one `connection-string` record; provider key as an env value → one
`api-key` record (provider group wins the tie); distinct secrets in one string → one record each.

**Marker:** `[REDACTED:<kind>]` (e.g. `[REDACTED:api-key]`). Marker-valued spans are skipped, so
redaction is idempotent and a second pass never records the marker's length as a secret.

---

## 3. Exported API (what adapters/ingest call)

| Call | Contract |
|---|---|
| `redactEvent(envelope, config?) → {event, redactions}` | **The ingest call.** Zod-validates the envelope (unknown kinds → `raw.unknown`), redacts the WHOLE envelope (payload + source + scope), recomputes `content_hash` over the redacted payload, merges pre-existing redactions, re-validates against `OnememoryEventSchema`, returns an event ready for `store.ingestEvent` (redactions passthrough). Throws `RedactEventError` with path+message-only issues for the caller to dead-letter. |
| `isEventPathExcluded(event, policy?) → boolean` | **First gate, BEFORE redaction.** For `document.added` (path / `file://` / other-URI pathname) and `file.changed` (path + old_path). `true` → the caller drops the whole event. Malformed payloads → `false` (dead-lettered separately). |
| `isPathExcluded(path, policy?) → boolean` | Path-level check (full path or basename; `*` crosses `/`). |
| `createPathExclusionPolicy({globs})` | Defaults + custom globs. **Defaults are not removable** (ADR-0007): `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.kdbx`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `*_rsa`, `*_dsa`, `*_ed25519`, `*credentials*`, `*secrets*`, `*.tfvars`, `*.tfvars.*`, `*.tfstate`, `*.tfstate.*`, `.npmrc`, `.netrc`, `.git-credentials`, `.htpasswd`, `authorized_keys*`, `*service_account*.json`. |
| `createRedactor(config?)` | The core `Redactor` port (async `redact()`), compiled once; plus `redactSync()` and standalone sync `redactValue(value, config?)`. |
| `installNetworkGuard({mode?})` | Patches global `fetch`: every attempt records **origin only** (scheme://host:port — paths/queries can carry secrets) and fails (`throw` default, `reject` optional); `assertZeroCalls()`, `count`, `attempts`, `restore()`. For local-profile tests now, the M13 daemon later. |
| Config/validation | `RedactorConfigSchema` (`{groups?, extraPatterns?}`), `ExtraPatternSchema`, `RedactorConfigError`, `RedactEventError`, `PathExclusionConfigError`, `NetworkGuardError` — all carry path+message issues, never input values. |
| Metadata | `PATTERN_GROUPS`/`PATTERN_GROUP_IDS` (doctor can list what scans), `redactionMarker`/`isRedactionMarker`, `DEFAULT_EXCLUDED_GLOBS`, `DEFAULT_PATH_EXCLUSION_POLICY`. |

## 4. The taint invariant is a test, not a promise

`taint.integration.test.ts` runs the REAL pipeline — `createEmbeddedDb` (PGlite, temp dir) →
`redactEvent` → `store.ingestEvent` → `listPendingEvents` → raw `payload::text` — under an
installed network guard, with every console method captured, and asserts six synthetic secrets
(OpenAI, Anthropic, AWS keys, session cookie, DB password, connection string) appear in NONE of:
stored payload JSON, stored redactions JSON, raw jsonb text from the database, captured console
output — while markers `[REDACTED:…]` are present, redactions carry exact kind/location/length,
re-ingest of the same redacted event dedupes (proving `content_hash` was recomputed over the
redacted payload), and `guard.assertZeroCalls()` passes (the pipeline made zero outbound calls).
Prompt-level taint assertions land with the extractor (M3) — extractors consume only these
stored payloads, which the suite proves are clean.

---

## 5. Deviations (all deliberate, all tested)

1. **Location format is `$`-rooted JSON paths** (`$.payload.content.foo`, arrays `$.payload.files[0]`,
   non-identifier keys `$.payload["weird key!"]`) — per the task text. `event-memory-schemas.md` §1
   shows an unrooted example (`payload.content`); the core schema only requires a non-empty string,
   so this is doc-example drift, not a schema change. UI renders locations verbatim.
2. **Overlap rule operationalized** as: earliest start wins; equal start → longest, then group
   priority (private-key → connection-string → provider keys → jwt → bearer/basic → cookie →
   password → env → extras). This is interval-greedy, chosen over global-longest because the
   nesting cases that matter (JWT-in-bearer, credentials-in-URL, key-in-env-value) all tie at
   equal starts.
3. **Connection strings redact whole-URL** — host/port/query are removed too (kind
   `connection-string`); conservative by design.
4. **Default exclusion globs cannot be switched off** — ADR-0007 invariant; config only ADDS.
   Consequence: `*credentials*`/`*secrets*` also match prose docs about credentials
   (`docs/credentials-guide.md` is dropped) — the safe direction of error, documented in tests.
5. **`.env*` matches `.envrc`** (direnv files hold secrets) and `*.tfstate*` — same rationale.
6. **`redactEvent` throws** (dead-letter-able, never a silent store) in two cases: malformed input,
   and the documented edge where marker replacement grows a length-capped field past its cap
   (e.g. a 390-char `arguments_digest` of short passwords → ~1.1k of markers fails the ≤400
   schema). Caller contract: catch `RedactEventError` → dead-letter log.
7. **Network guard scope is `globalThis.fetch`** with origin-only recording (taint-safe by
   construction). It does not cover `node:http` sockets, WebSocket, or `sendBeacon` — see follow-ups.
8. **`@onememory/storage` is a devDependency** of security (taint test only). No runtime
   dependency; no cycle (storage does not import security).
9. Regexes use ES2022 `d` (hasIndices) + lookbehind — fine on Bun and Node ≥22 (root engines).

## 6. Follow-ups (coordinator / later missions)

- **ACL groundwork (Phase 3, backlog M12.5):** redaction already records kind + location + length,
  which is everything the UI needs to show "what was redacted, never what". Memory-level ACLs will
  layer on the storage scope model + a policy table — no schema breakage required, nothing in this
  package blocks it.
- **M13 daemon:** use exported `installNetworkGuard()` to enforce `profile: local` (auto-install,
  assertZeroCalls on shutdown); consider widening coverage beyond `fetch` (node:http/https,
  WebSocket, sendBeacon) before calling it a hard guarantee.
- **M16 config:** wire `RedactorConfigSchema.groups/extraPatterns` and exclusion globs into
  `onememory.config.yaml`; the Zod schemas here are ready to embed.
- **M3 extraction:** add prompt-taint assertions (extractors see stored payloads only).
- **M1 storage suite robustness (infra):** under heavy parallel-machine load (8 cores at load
  ~5.7, other mission worktrees running), individual PGlite scenario tests occasionally exceed
  bun's default 5s test timeout (observed: `migrations apply cleanly twice` at 123s once,
  `status transitions are audited` at 20s once; both pass repeatedly when the machine is unloaded
  — full suite 184/0/14 in ~16s). Recommend raising the per-test timeout in the storage suite
  (M1-owned files; not touched here).
- **Candidate future patterns** (trivial via `extraPatterns` or new groups): Stripe (`sk_live_`),
  Twilio, SendGrid, git-credential helpers, K8s Secret manifests.
