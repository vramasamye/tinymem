/**
 * Config errors. Messages name the file and the exact key path, and never echo a secret value
 * (AGENTS.md rule 6): environment variables are referenced by name only.
 */

import type { ConfigIssue } from './schema';

/** A configuration problem with an actionable, file-scoped message. */
export class ConfigError extends Error {
  readonly issues: ConfigIssue[];
  readonly filePath: string | null;

  constructor(message: string, issues: ConfigIssue[] = [], filePath: string | null = null) {
    super(ConfigError.format(message, issues, filePath));
    this.name = 'ConfigError';
    this.issues = issues;
    this.filePath = filePath;
  }

  private static format(message: string, issues: ConfigIssue[], filePath: string | null): string {
    const where = filePath === null ? '' : ` in ${filePath}`;
    if (issues.length === 0) return `onememory config${where}: ${message}`;
    const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
    return [`onememory config${where}: ${message}`, ...lines].join('\n');
  }
}

/** No config file was found and one was required. */
export class ConfigNotFoundError extends ConfigError {
  constructor(cwd: string, detail: string) {
    super(
      `no onememory configuration found from ${cwd}\n  - run 'onemem init' to create .onememory/onememory.yaml, pass --config <file>, or set ONEMEMORY_CONFIG${detail === '' ? '' : `\n  - ${detail}`}`,
      [{ path: '.onememory/onememory.yaml', message: 'missing' }],
      null,
    );
    this.name = 'ConfigNotFoundError';
  }
}
