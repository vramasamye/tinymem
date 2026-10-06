/**
 * The skill write-surface precedence (M15 follow-up 3): `--dir` > `--runtime` > `skills.dir` >
 * `<project root>/skills`. Pure resolution, so every branch (including the refusals) is pinned
 * without touching the filesystem.
 */

import { describe, expect, test } from 'bun:test';

import { parseConfig, type OnememoryConfig } from '@onememory/config';

import { expandHome, resolveSkillsTarget } from './commands/skills-promote';

const CTX = { projectRoot: '/repo', home: '/home/dev' };

function config(skillsDir?: string): OnememoryConfig {
  return parseConfig(skillsDir === undefined ? { version: 1 } : { version: 1, skills: { dir: skillsDir } });
}

describe('expandHome', () => {
  test('expands ~ and ~/x against HOME; leaves everything else alone', () => {
    expect(expandHome('~/skills', '/home/dev')).toBe('/home/dev/skills');
    expect(expandHome('~', '/home/dev')).toBe('/home/dev');
    expect(expandHome('/abs/skills', '/home/dev')).toBe('/abs/skills');
    expect(expandHome('rel/skills', '/home/dev')).toBe('rel/skills');
  });

  test('a ~/ path with no HOME is refused (never a bogus literal path)', () => {
    expect(() => expandHome('~/skills', null)).toThrow(/HOME is not set/);
    expect(expandHome('~', null)).toBe('~');
  });
});

describe('resolveSkillsTarget precedence', () => {
  test('--dir wins over everything, and expands ~', () => {
    expect(
      resolveSkillsTarget({ dirFlag: '/explicit', runtime: 'claude-code', config: config('.opencode/skills'), ...CTX }),
    ).toEqual({ dir: '/explicit', source: 'dir-flag' });
    expect(resolveSkillsTarget({ dirFlag: '~/skills', config: config(), ...CTX }).dir).toBe('/home/dev/skills');
  });

  test('--runtime resolves the runtime canonical root (and records which runtime)', () => {
    expect(resolveSkillsTarget({ runtime: 'claude-code', config: config('.opencode/skills'), ...CTX })).toEqual({
      dir: '/repo/.claude/skills',
      source: 'runtime-flag',
      runtime: 'claude-code',
    });
    expect(resolveSkillsTarget({ runtime: 'opencode', config: config(), ...CTX }).dir).toBe('/repo/.opencode/skills');
  });

  test('--runtime with an unknown id is refused, naming the known ones', () => {
    expect(() => resolveSkillsTarget({ runtime: 'claude', config: config(), ...CTX })).toThrow(/unknown runtime 'claude'/);
    expect(() => resolveSkillsTarget({ runtime: 'claude', config: config(), ...CTX })).toThrow(/claude-code/);
  });

  test('--runtime with no project root is refused (every canonical root is project-scoped)', () => {
    expect(() =>
      resolveSkillsTarget({ runtime: 'cursor', config: config(), projectRoot: null, home: '/home/dev' }),
    ).toThrow(/no root path/);
  });

  test('skills.dir (relative) resolves against the project root', () => {
    expect(resolveSkillsTarget({ config: config('.claude/skills'), ...CTX })).toEqual({
      dir: '/repo/.claude/skills',
      source: 'config',
    });
  });

  test('skills.dir (absolute, or ~/global) is used as given', () => {
    expect(resolveSkillsTarget({ config: config('/etc/skills'), ...CTX }).dir).toBe('/etc/skills');
    expect(resolveSkillsTarget({ config: config('~/.claude/skills'), ...CTX })).toEqual({
      dir: '/home/dev/.claude/skills',
      source: 'config',
    });
  });

  test('a relative skills.dir with no project root is refused', () => {
    expect(() => resolveSkillsTarget({ config: config('.claude/skills'), projectRoot: null, home: '/home/dev' })).toThrow(
      /skills\.dir/,
    );
  });

  test('with nothing set, the documented default is <project root>/skills', () => {
    expect(resolveSkillsTarget({ config: config(), ...CTX })).toEqual({
      dir: '/repo/skills',
      source: 'project-default',
    });
  });

  test('with nothing set and no project root, it refuses with actionable guidance', () => {
    expect(() => resolveSkillsTarget({ config: config(), projectRoot: null, home: '/home/dev' })).toThrow(/--dir/);
  });
});
