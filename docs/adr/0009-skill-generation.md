# ADR-0009: Automatic skill generation from verified failure/solution patterns

Status: Accepted · Date: 2026-10-03

## Context

Spec §14: repeated successful procedures become reusable skills (`skills/<slug>/SKILL.md` with
when-to-use, prerequisites, procedure, commands, validation, known failure modes); verification is
required before promotion.

## Decision

Published evidence directly supports the feature (Memp ACL 2026: procedural memory in two
granularities with correction/deprecation, strong→weak model transfer; MIRIX: skills distilled
from sessions *including tool errors, retries, and the fix* — 68.7% vs 52.2% on ALFWorld; memU:
agent-authored Markdown skills where the memory service itself makes no LLM calls). We implement:

1. **Failure signature recurrence**: failures are fingerprinted (`signature_hash` + embedding of
   the problem statement). A recurrence (same signature, equivalent solution, ≥2 occurrences)
   creates a **skill candidate** — never a direct skill.
2. **Verification gate** (spec: "Require verification before promoting"): promotion requires
   verification evidence (successful command output digest / test result bound as evidence) AND
   user confirmation via `onemem skills review` (`auto_promote_skills = false` by default; the
   config exists but the default is conservative — D7 resolved).
3. **Two granularities in one SKILL.md** (Memp): step-level procedure (commands, in order) + the
   script-level abstraction (when this pattern applies). Skills are prose + commands, model-agnostic
   (Memp transfer result), so a skill written under one agent/model serves all of them.
4. **Lifecycle**: `candidate → verified → promoted → deprecated` with usage tracking
   (`usage_count`, `success_rate`) from follow-up sessions; deprecation mirrors Memp's explicit
   deprecation rather than silent removal.
5. **Serving**: skills are files (`skills/<slug>/SKILL.md`) so runtime-native skill loaders
   (Claude Code, OpenCode) pick them up directly; the MCP `memory_skills` tool lists them for
   every other runtime.

## Consequences

- Skills are diffable, auditable artifacts with provenance to the failures that produced them.
- The engine never auto-writes into an agent's skill directory without the promotion flow —
  candidates live in the DB until reviewed.
- Failure-mine quality depends on the extraction layer's error/resolution capture (backlog M3b).

## References

`docs/research/memory-systems-landscape.md` adopt-item 8, Memp https://arxiv.org/abs/2508.06433 ,
MIRIX repo (skill distillation) https://github.com/Mirix-AI/MIRIX , memU
https://github.com/NevaMind-AI/memU ; `docs/architecture/event-memory-schemas.md` §5 (SkillPayload,
SKILL.md layout); backlog M15.
