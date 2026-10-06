/**
 * The runtime skill-discovery table (M15 follow-up 3). These pin the exact paths — a typo here
 * would silently write SKILL.md files where no runtime looks, so each canonical root is asserted
 * against the value in the runtime's own docs (recorded as `source` on every entry).
 */

import { describe, expect, test } from 'bun:test';

import {
  AGENT_RUNTIME_IDS,
  RUNTIME_SKILL_TARGETS,
  isAgentRuntimeId,
  primarySkillRoot,
  resolveSkillRoot,
  resolveSkillRoots,
  runtimeForSkillDir,
  type AgentRuntimeId,
} from './runtime-skills';

/** The documented canonical (own) root per runtime — the target of a `--runtime <id>` write. */
const CANONICAL: Record<AgentRuntimeId, string> = {
  'claude-code': '.claude/skills',
  codex: '.agents/skills',
  cursor: '.cursor/skills',
  pi: '.pi/skills',
  opencode: '.opencode/skills',
};

const CTX = { root: '/repo', home: '/home/dev' };

describe('RUNTIME_SKILL_TARGETS', () => {
  test('every runtime carries a project-scoped canonical root, pinned to the documented path', () => {
    for (const runtime of AGENT_RUNTIME_IDS) {
      const target = RUNTIME_SKILL_TARGETS[runtime];
      expect(target.runtime).toBe(runtime);
      expect(target.roots.length).toBeGreaterThan(0);
      const first = target.roots[0]!;
      expect(first.scope).toBe('project');
      expect(first.path).toBe(CANONICAL[runtime]);
      // Provenance is mandatory: every row cites the doc it came from.
      expect(target.source.startsWith('https://')).toBeTrue();
    }
  });

  test('the compatibility roots the research recorded are present (Cursor / Pi also read .agents)', () => {
    expect(RUNTIME_SKILL_TARGETS.cursor.roots.map((r) => r.path)).toContain('.agents/skills');
    expect(RUNTIME_SKILL_TARGETS.pi.roots.map((r) => r.path)).toContain('.agents/skills');
    // No runtime declares a manifest/index — discovery is a directory scan everywhere.
    expect(JSON.stringify(RUNTIME_SKILL_TARGETS)).not.toContain('manifest');
  });
});

describe('isAgentRuntimeId', () => {
  test('accepts the five ids and rejects anything else', () => {
    for (const runtime of AGENT_RUNTIME_IDS) expect(isAgentRuntimeId(runtime)).toBeTrue();
    expect(isAgentRuntimeId('claude')).toBeFalse();
    expect(isAgentRuntimeId('')).toBeFalse();
  });
});

describe('resolveSkillRoot / resolveSkillRoots', () => {
  test('project roots resolve under the project root; global roots under HOME', () => {
    expect(resolveSkillRoot({ scope: 'project', path: '.claude/skills' }, CTX)).toBe('/repo/.claude/skills');
    expect(resolveSkillRoot({ scope: 'global', path: '~/.claude/skills' }, CTX)).toBe(
      '/home/dev/.claude/skills',
    );
  });

  test('a global root without a HOME resolves to null (never a bogus path)', () => {
    expect(resolveSkillRoot({ scope: 'global', path: '~/.pi/agent/skills' }, { root: '/repo', home: null })).toBeNull();
  });

  test('resolveSkillRoots drops global roots when no HOME is known, keeping project roots', () => {
    expect(resolveSkillRoots('claude-code', { root: '/repo', home: null })).toEqual(['/repo/.claude/skills']);
    expect(resolveSkillRoots('claude-code', CTX)).toEqual([
      '/repo/.claude/skills',
      '/home/dev/.claude/skills',
    ]);
  });

  test('trailing slashes never produce double separators', () => {
    expect(resolveSkillRoots('opencode', { root: '/repo/', home: '/home/dev/' })).toEqual([
      '/repo/.opencode/skills',
      '/home/dev/.config/opencode/skills',
    ]);
  });
});

describe('primarySkillRoot', () => {
  test('always prefers the project-scoped root (self-contained, portable across machines)', () => {
    for (const runtime of AGENT_RUNTIME_IDS) {
      expect(primarySkillRoot(runtime, CTX)).toBe(`/repo/${CANONICAL[runtime]}`);
    }
  });

  test('still resolves with no HOME (the project root does not need one)', () => {
    expect(primarySkillRoot('cursor', { root: '/repo', home: null })).toBe('/repo/.cursor/skills');
  });
});

describe('runtimeForSkillDir', () => {
  test('maps a canonical directory back to its runtime, tolerant of a trailing slash', () => {
    expect(runtimeForSkillDir('/repo/.claude/skills', CTX)).toBe('claude-code');
    expect(runtimeForSkillDir('/repo/.claude/skills/', CTX)).toBe('claude-code');
    expect(runtimeForSkillDir('/repo/.opencode/skills', CTX)).toBe('opencode');
  });

  test('an arbitrary directory maps to no runtime', () => {
    expect(runtimeForSkillDir('/repo/skills', CTX)).toBeNull();
    expect(runtimeForSkillDir('/somewhere/else', CTX)).toBeNull();
  });
});
