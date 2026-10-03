/**
 * Commit-message enrichment for `PostToolUse` of Bash `git commit` calls.
 *
 * The git.commit event schema REQUIRES `sha`, `message`, `author_name`, and `files`, but the hook
 * payload alone only proves that a commit command ran (the command line) and carries git's summary
 * stdout — never the author or the full message. Rather than coerce a half-event (mission rule: a
 * payload that can't be mapped honestly is dropped, never coerced), the hook script asks git for
 * the facts of HEAD in a single read-only invocation. When git is unavailable, not installed, or
 * the directory is not a repository, the commit event is dropped with a counted reason while the
 * ordinary `terminal.output` command event still flows.
 *
 * Detection guard: a real commit's stdout begins with `[<branch> <short-sha>] <subject>` (git's
 * documented summary line; `-q` commits print nothing and are dropped with a counted reason). The
 * enrichment is only trusted when the `git log` sha agrees with the short sha in that line, which
 * also kills false positives like `echo "git commit"`.
 */

/** `git.commit` payload caps (packages/core event schema): files max 500. */
const MAX_COMMIT_FILES = 500;

export interface GitCommitFacts {
  /** Full commit sha (%H). */
  sha: string;
  /** Commit author name (%an) — the schema deliberately never captures the email. */
  authorName: string;
  /** Subject (%s) + body (%b), reconstructed the way git stores it. */
  message: string;
  /** Paths affected by the commit (--no-renames --name-only), capped at 500. */
  files: string[];
}

export type GitRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;

/** Field separators that cannot occur in paths/subjects the way newlines can (\x1f unit, \x1e record). */
const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';

/** Args after the `git` binary. */
const GIT_ARGS: readonly string[] = [
  'log',
  '-1',
  '--no-renames',
  '--name-only',
  `--format=%H${FIELD_SEP}%an${FIELD_SEP}%s${FIELD_SEP}%b${FIELD_SEP}${RECORD_SEP}`,
];

/**
 * Run `git log -1` for HEAD in `cwd`. Uses node:child_process (Bun-compatible, Node LTS-compatible)
 * with a hard 2s timeout and a non-shell argv — the cwd can contain any characters safely.
 */
const defaultRunner: GitRunner = async (args, cwd) => {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: 2000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          resolve({ ok: false, error: error.message });
          return;
        }
        resolve({ ok: true, stdout });
      },
    );
  });
};

/**
 * Cheap pre-check (string-only) used by the hook script before spending a subprocess.
 * The command must mention a git commit invocation; the stdout check below does the real gating.
 */
export function looksLikeGitCommit(command: string): boolean {
  return /(?:^|[;&|]|\s)git\s+commit\b/.test(command);
}

/**
 * Match `[<branch> <short-sha>] <subject...>` — git's commit summary line — and return the short sha.
 */
export function commitShaFromStdout(stdout: string): string | null {
  const match = /^\[[^\]\s]+ ([0-9a-f]{7,40})\]/.exec(stdout.trimStart());
  return match === null ? null : (match[1] ?? null);
}

/** Parse `N files changed, X insertions(+), Y deletions(-)` from the commit summary stdout. */
export function commitStatsFromStdout(stdout: string): { files_changed: number; insertions: number; deletions: number } | undefined {
  const filesMatch = /(\d+) files? changed/.exec(stdout);
  const insertionsMatch = /(\d+) insertions?\(\+\)/.exec(stdout);
  const deletionsMatch = /(\d+) deletions?\(-\)/.exec(stdout);
  if (filesMatch === null) return undefined;
  return {
    files_changed: Number(filesMatch[1]),
    insertions: insertionsMatch === null ? 0 : Number(insertionsMatch[1]),
    deletions: deletionsMatch === null ? 0 : Number(deletionsMatch[1]),
  };
}

/**
 * Read the facts of HEAD. Returns null whenever anything is missing, non-git, or malformed — the
 * caller drops the commit event with a counted reason; the terminal.output event is unaffected.
 */
export async function readGitCommitFacts(
  cwd: string,
  options: { runner?: GitRunner; shortSha?: string } = {},
): Promise<GitCommitFacts | { error: string }> {
  const runner = options.runner ?? defaultRunner;
  const result = await runner(GIT_ARGS, cwd);
  if (!result.ok) return { error: `git log failed: ${result.error}` };

  const [record = '', filesText = ''] = result.stdout.split(RECORD_SEP);
  const fields = record.split(FIELD_SEP);
  const sha = (fields[0] ?? '').trim();
  const authorName = (fields[1] ?? '').trim();
  const subject = (fields[2] ?? '').replace(/\n+$/, '').trim();
  const body = (fields[3] ?? '').trim();

  if (!/^[0-9a-f]{40}$/.test(sha)) return { error: 'git log did not return a full commit sha' };
  if (authorName.length === 0) return { error: 'git log returned an empty author name' };
  if (subject.length === 0) return { error: 'git log returned an empty commit subject' };

  // Trust the enrichment only when it agrees with the commit the command actually made.
  if (options.shortSha !== undefined && !sha.startsWith(options.shortSha)) {
    return { error: `HEAD ${sha.slice(0, 7)} does not match the committed sha ${options.shortSha}` };
  }

  const files = filesText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_COMMIT_FILES);

  const message = body.length === 0 ? subject : `${subject}\n\n${body}`;
  return { sha, authorName, message, files };
}
