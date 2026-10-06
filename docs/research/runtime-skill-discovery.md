# Runtime skill discovery — where each agent loads `SKILL.md` from

Research for M15 follow-up 3 (the configurable skill write surface). Question: where does each
runtime onememory wires load skills from, and does any of them consume a manifest/index?

Checked 2026-10-06 against each vendor's own documentation. Where a fact is undocumented it is
flagged as such rather than guessed.

## Headline

**Every runtime discovers skills by scanning a skills root for `<name>/SKILL.md`. None consumes a
`manifest.json` or any machine-readable index for local-disk discovery.** The follow-up's
`manifest.json` premise was therefore ungrounded: the only index file in the ecosystem (OpenCode
v2's `index.json`) applies to *remote HTTP catalogs* only. The only per-runtime knob is the
skills root (and frontmatter strictness, which the engine already satisfies — see the last
section).

## Per runtime

| Runtime | Project root(s) | Global root(s) | Source |
|---|---|---|---|
| Claude Code | `.claude/skills` | `~/.claude/skills` | https://code.claude.com/docs/en/skills |
| Codex | `.agents/skills` (scanned CWD → repo root) | `~/.agents/skills`; admin `/etc/codex/skills` | https://developers.openai.com/codex/skills |
| Cursor | `.cursor/skills`, `.agents/skills` | `~/.cursor/skills`, `~/.agents/skills` | https://cursor.com/docs/skills |
| Pi | `.pi/skills`, `.agents/skills` | `~/.pi/agent/skills`, `~/.agents/skills` | https://pi.dev/docs/latest/skills |
| OpenCode | `.opencode/skills` | `~/.config/opencode/skills` | https://opencode.ai/docs/skills/ |

Notes that matter for a writer:

- **Claude Code** also reads enterprise, nested (monorepo), `--add-dir`, and plugin skill
  directories, and legacy `.claude/commands/*.md`. It follows the Agent Skills open standard
  (https://agentskills.io/specification).
- **Codex** scans `.agents/skills` from the working directory **up to the repository root at every
  level**. The older experimental location `~/.codex/skills` is *not* in current docs (see
  Uncertainties).
- **Cursor** and **Pi** additionally read `.agents/skills` — the emerging cross-runtime location.
- **Pi** relocates its global dir via `PI_CODING_AGENT_DIR`; the default is `~/.pi/agent`.
- **OpenCode** has two live doc tracks (v1 and v2) with different rules (see Uncertainties).

## Frontmatter

All five accept the same core: `name` + `description` (+ optional fields). The Agent Skills spec
(the standard Claude Code, Cursor, Codex, and Pi follow) constrains `name` to lowercase
`a-z0-9`/hyphens, ≤64 chars, matching the parent directory, and `description` to 1–1024 chars.

onememory's renderer already emits `name`, `description`, and `version`, and writes into a
directory named after the skill (`skills/<name>/`), so the same bytes satisfy every runtime. This
is why the write surface needed only a root knob, not a per-runtime formatter.

## Uncertainties (flagged, not guessed)

1. **Codex `~/.codex/skills`** — current official docs list only `.agents/skills`, `$HOME/.agents/skills`,
   and `/etc/codex/skills`. Whether current Codex still reads the Dec-2025 experimental
   `~/.codex/skills` is undocumented; do not target it.
2. **Claude Code on-disk `name` enforcement** — the local docs restate no charset/length caps and
   no rejection behavior; the spec constraints are enforced on the claude.ai upload path and by
   `claude plugin validate`.
3. **Claude Code hard description cap** — docs state a listing *truncation* (1,536 chars combined
   `description` + `when_to_use`), not a hard validation cap, for on-disk skills.
4. **OpenCode v1 vs v2 divergence** — v1 requires `name`/`description` and validates the name
   pattern; v2 derives the id from the path and enforces nothing. Both doc tracks are live. A
   writer targeting OpenCode should stay within the v1 (stricter) rules, which onememory does.
5. **Pi standalone-Markdown skills** — "Pi accepts some standalone Markdown skills"; the exact
   flat-file forms are undocumented. The directory + `SKILL.md` form is the documented portable one.

## What shipped from this

`packages/core/src/types/runtime-skills.ts` — the `RUNTIME_SKILL_TARGETS` table (paths +
source URL per runtime) and the `primarySkillRoot` / `resolveSkillRoots` / `runtimeForSkillDir`
resolvers. Consumed by `onemem skills promote --runtime <id>` and by the `skills.dir` config knob.
