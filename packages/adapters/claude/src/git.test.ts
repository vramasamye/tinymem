/**
 * Commit enrichment tests: detection regexes, stdout summary parsing, and the single `git log`
 * enrichment call — with an injected runner (no git dependency in tests). The sha cross-check
 * between the commit summary line and the enrichment kills `echo "git commit"` false positives.
 */

import { describe, expect, test } from 'bun:test';

import { commitShaFromStdout, commitStatsFromStdout, looksLikeGitCommit, readGitCommitFacts, type GitRunner } from './git';

describe('looksLikeGitCommit', () => {
  test('matches plain and prefixed git commit invocations', () => {
    expect(looksLikeGitCommit('git commit -m "feat: x"')).toBeTrue();
    expect(looksLikeGitCommit('cd packages/storage && git commit -m "x"')).toBeTrue();
    expect(looksLikeGitCommit('git commit --amend --no-edit')).toBeTrue();
  });

  test('does not match other git subcommands', () => {
    expect(looksLikeGitCommit('git status --short')).toBeFalse();
    expect(looksLikeGitCommit('git log --oneline -5')).toBeFalse();
    expect(looksLikeGitCommit('bun test')).toBeFalse();
  });
});

describe('commitShaFromStdout', () => {
  test('extracts the short sha from the documented summary line', () => {
    expect(commitShaFromStdout('[main 8a6a2f3] docs: report\n 2 files changed')).toBe('8a6a2f3');
    expect(commitShaFromStdout('  [feature-x abc12345] feat: y\n')).toBe('abc12345');
  });

  test('rejects output without a commit summary line (the -q / echo cases)', () => {
    expect(commitShaFromStdout('')).toBeNull();
    expect(commitShaFromStdout('plain output, no commit')).toBeNull();
    expect(commitShaFromStdout('git commit -m x')).toBeNull();
  });
});

describe('commitStatsFromStdout', () => {
  test('parses the files/insertions/deletions summary', () => {
    expect(commitStatsFromStdout('[main 8a6a2f3] x\n 2 files changed, 120 insertions(+), 3 deletions(-)')).toEqual({
      files_changed: 2,
      insertions: 120,
      deletions: 3,
    });
  });

  test('handles the singular forms and missing halves', () => {
    expect(commitStatsFromStdout('[main 8a6a2f3] x\n 1 file changed, 1 insertion(+)')).toEqual({
      files_changed: 1,
      insertions: 1,
      deletions: 0,
    });
    expect(commitStatsFromStdout('[main 8a6a2f3] x\n 1 file changed, 2 deletions(-)')).toEqual({
      files_changed: 1,
      insertions: 0,
      deletions: 2,
    });
  });

  test('absent stats → undefined (optional field, never guessed)', () => {
    expect(commitStatsFromStdout('[main 8a6a2f3] x')).toBeUndefined();
  });
});

const SEP = '\x1f';
const RECORD = '\x1e';
const FULL_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function gitOutput(subject: string, body: string, files: string[]): string {
  return [FULL_SHA, 'Fixture Author', subject, body].join(SEP) + SEP + RECORD + '\n\n' + files.join('\n') + '\n';
}

describe('readGitCommitFacts', () => {
  test('parses subject-only and subject+body messages with the file list', async () => {
    const runner: GitRunner = async () => ({
      ok: true,
      stdout: gitOutput('feat(storage): schema', '', ['a.ts', 'b.ts']),
    });
    const facts = await readGitCommitFacts('/repo', { runner, shortSha: 'a1b2c3d' });
    expect(facts).toEqual({
      sha: FULL_SHA,
      authorName: 'Fixture Author',
      message: 'feat(storage): schema',
      files: ['a.ts', 'b.ts'],
    });

    const withBody = await readGitCommitFacts('/repo', {
      runner: async () => ({ ok: true, stdout: gitOutput('feat: x', 'Longer body line.', ['c.ts']) }),
    });
    expect(withBody).toEqual({
      sha: FULL_SHA,
      authorName: 'Fixture Author',
      message: 'feat: x\n\nLonger body line.',
      files: ['c.ts'],
    });
  });

  test('cross-checks the enrichment against the committed short sha (echo/false-positive guard)', async () => {
    const runner: GitRunner = async () => ({ ok: true, stdout: gitOutput('feat: x', '', ['a.ts']) });
    const result = await readGitCommitFacts('/repo', { runner, shortSha: 'fffffff' });
    expect('error' in result && result.error).toContain('does not match');
  });

  test('runner failure → error (the caller drops the commit event, counted)', async () => {
    const runner: GitRunner = async () => ({ ok: false, error: 'fatal: not a git repository' });
    const result = await readGitCommitFacts('/repo', { runner });
    expect('error' in result && result.error).toContain('not a git repository');
  });

  test('malformed git output → error', async () => {
    const runner: GitRunner = async () => ({ ok: true, stdout: 'garbage without separators' });
    const result = await readGitCommitFacts('/repo', { runner });
    expect('error' in result).toBeTrue();
  });

  test('caps the file list at the schema max (500)', async () => {
    const many = Array.from({ length: 600 }, (_, index) => `f-${index}.ts`);
    const runner: GitRunner = async () => ({ ok: true, stdout: gitOutput('s', '', many) });
    const facts = await readGitCommitFacts('/repo', { runner });
    expect('files' in facts && facts.files).toHaveLength(500);
  });
});
