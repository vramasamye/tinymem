# Mission 23: the Pi injection channel (system-prompt sections, not steering user messages)

Branch: `mission/23-pi-injection-channel` · Base: `e8e6c8b` (main, the M22 merge) · Decision record:
ADR-0010 §6 (injection beats polling — the channel detail lives here) · Found by: the first real
end-to-end run of the Pi adapter against the installed pi 1.0.4.

## Why

The carried "test the memory with the pi.dev coding agent" run — packed tarballs installed into a
scratch project, `onemem init --with-pi`, real daemon, real `pi -p` session — failed on the
injection channel. `pi -p` printed no answer at all and:

```
Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.
```

Root cause, read from the installed pi 1.0.4's own declarations
(`@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`, `core/extensions/types.d.ts`,
`core/system-prompt.d.ts`):

- The extension-facing `sendUserMessage` "**always triggers a turn**" and can queue via
  `deliverAs: "steer"` only **while the agent is streaming**.
- At `before_agent_start` the agent is **processing** (pre-streaming), so the call throws —
  every time, in `-p` mode *and* in interactive mode at the first prompt. The throw propagates
  through the awaited handler, the initial turn dies, and `pi -p` exits with no answer.
- Mission 9 verified the steer design against pi's *docs/sources* (2026-10-06) but never against a
  running `pi` — exactly the gap this run closed.
- The sanctioned channel is on the event itself: `BeforeAgentStartEvent.systemPromptOptions` is
  the **mutable, normalized** prompt state — "Mutable prompt sections. Later handlers observe
  mutations made by earlier handlers" — with a guaranteed `sections: Record<string, string>`, and
  pi diffs sections against the transcript so an unchanged section costs no tokens.

(For the record, the second error in that run — `Extension error (<boundary>): turn_end could not
resolve the persisted assistant entry ID` — is **not** onememory's: the adapter drops `turn_end`
events by design, the string lives in pi's own `agent-session`, and it surfaces through the
user's other extension. It is an environment observation, not a defect here.)

## Scope delivered

- **Injection now writes the `onememory-project-context` section** into the event's
  `systemPromptOptions.sections` (`PI_CONTEXT_SECTION`, `applyPiContextSection` in
  `extension.ts`): one section, riding the same agent run as the user's prompt.
- **Fetched once per session, applied on every agent start**: pi re-normalizes
  `systemPromptOptions` per agent run, so a section written once would be gone by the next
  prompt — the context is cached per session (`Map`) and re-applied per run (token-free: pi
  patches only changed sections).
- **Fail-soft against an older pi**: no `systemPromptOptions` surface → no throw, no injection,
  a one-line degradation notice; the injection channel must never break a session.
- **`pi-wire.ts`** mirrors the new optional `systemPromptOptions` on `PiBeforeAgentStartEvent`
  (loose: extra fields tolerated), with the live-verified citation.
- **The regression seam**: `FakePi` now mirrors real pi 1.0.4 — `sendUserMessage` **throws**
  while a prompt is processing at `before_agent_start` — so the old channel fails the suite, and
  `beforeAgentStartEvent()` fixtures carry the real event shape.
- Sentinel (`PI_CONTEXT_INJECTION_PREFIX`) kept as the engine-output marker: the injection
  envelope is unchanged across adapters, and the translator still drops sentinel-prefixed user
  messages (`own_injection`) so engine output can never become memory input.

## Validation

- `packages/adapters/pi`: **98 pass / 0 fail** (3 new injection tests, red-first), typecheck clean.
- Full repo `bun test`: 2138–2139 pass / 56 skip / 1 fail — `onemem compact` dry-run timeout under
  the parallel suite, **passes standalone in 2.8s** (the known PGlite-parallel load flake family,
  unrelated to this change).
- The real-pi feedback loop (`pi -p -a --thinking off "Say OK."` in the packed-install scratch
  project): red before the fix (2 errors, no answer), re-run green after the fix ships below.
- The full e2e (read + write through real pi) recorded in the mission follow-up.

## Files changed

- `packages/adapters/pi/src/extension.ts` (section channel, per-run re-apply, fail-soft; header),
  `src/extension.test.ts` (FakePi mirrors real pi; new contract tests),
  `src/testing.ts` (`beforeAgentStartEvent` / `beforeAgentStartEventWithoutOptions`),
  `src/pi-wire.ts` (schema + live-verified header), `src/capture.ts` + `src/translate.ts` (headers),
  `README.md` (channel description), this report.

## Commits

- (recorded on merge)
