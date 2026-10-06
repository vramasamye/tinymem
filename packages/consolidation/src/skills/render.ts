/**
 * The canonical SKILL.md renderer (M15 issue 2; event-memory-schemas.md §5 layout; the six
 * sections memory-model.md §9 lists). PURE and CANONICAL:
 *
 *   - the same document in → the exact same bytes out (idempotent, no timestamps, no ids, no
 *     environment in the output — the AC's canonical-form requirement);
 *   - every section of `SKILL_MD_SECTIONS` is always rendered, in order — a missing section is
 *     a rendering bug, not an empty skill;
 *   - LF newlines, one trailing newline, `-` list items, `1.`-numbered procedure steps,
 *     fenced `bash` block for commands;
 *   - front matter carries exactly `name` (kebab-case), `description`, `version` (semver) —
 *     the fields Claude Code / OpenCode skill loaders read (research B.1: frontmatter name +
 *     description; ADR-0009 rule 5: files first).
 */

import { SKILL_MD_SECTIONS, type SkillMdSection } from '@onememory/core';

/** Bumped whenever the canonical byte layout changes (old files stay readable; regeneration
 * re-renders in the current template). */
export const SKILL_MD_TEMPLATE_VERSION = 'skill-md.v1';

/** The structured source of a SKILL.md — every section pre-extracted (see ./generate). */
export interface SkillDocument {
  /** kebab-case — the directory name and the loader key. */
  name: string;
  /** One line — the loader's listing text (front matter `description`). */
  description: string;
  /** Semver. */
  version: string;
  when_to_use: string[];
  prerequisites: string[];
  procedure: string[];
  commands: string[];
  validation: string[];
  known_failure_modes: string[];
}

/** The placeholder for an empty section — present, never fabricated. */
const NONE_RECORDED = 'None recorded.';

/** Normalize one line of prose for the canonical form: collapse whitespace, drop blank lines. */
function line(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function bulletLines(lines: readonly string[]): string {
  const cleaned = lines.map(line).filter((entry) => entry.length > 0);
  if (cleaned.length === 0) return NONE_RECORDED;
  return cleaned.map((entry) => `- ${entry}`).join('\n');
}

function numberedLines(lines: readonly string[]): string {
  const cleaned = lines.map(line).filter((entry) => entry.length > 0);
  if (cleaned.length === 0) return NONE_RECORDED;
  return cleaned.map((entry, index) => `${index + 1}. ${entry}`).join('\n');
}

/** The commands section: a fenced bash block, one command per line (prose stays in Procedure). */
function commandBlock(commands: readonly string[]): string {
  const cleaned = commands.map((command) => command.trim()).filter((command) => command.length > 0);
  if (cleaned.length === 0) return NONE_RECORDED;
  return ['```bash', ...cleaned, '```'].join('\n');
}

/** Front matter — the YAML block every runtime-native skill loader parses first. */
function frontMatter(doc: SkillDocument): string {
  return [
    '---',
    `name: ${line(doc.name)}`,
    `description: ${line(doc.description)}`,
    `version: ${line(doc.version)}`,
    '---',
  ].join('\n');
}

function sectionBody(doc: SkillDocument, section: SkillMdSection): string {
  switch (section) {
    case 'When to use':
      return bulletLines(doc.when_to_use);
    case 'Prerequisites':
      return bulletLines(doc.prerequisites);
    case 'Procedure':
      return numberedLines(doc.procedure);
    case 'Commands':
      return commandBlock(doc.commands);
    case 'Validation':
      return bulletLines(doc.validation);
    case 'Known failure modes':
      return bulletLines(doc.known_failure_modes);
  }
}

/**
 * Render the canonical SKILL.md bytes. Deterministic: the same `SkillDocument` yields the same
 * bytes on every call, every machine (the evaluator re-renders and compares byte-for-byte).
 */
export function renderSkillMarkdown(doc: SkillDocument): string {
  const body = SKILL_MD_SECTIONS.map(
    (section) => `## ${section}\n${sectionBody(doc, section)}`,
  ).join('\n\n');
  return `${frontMatter(doc)}\n\n${body}\n`;
}
