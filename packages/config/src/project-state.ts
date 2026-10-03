/**
 * Machine-managed project state: `.onememory/project.json`.
 *
 * `onemem init` registers a project row (name + root path) and records the resulting UUIDv7 here.
 * The config file stays a human-authored, comment-preserving template; this file is the anchor the
 * CLI/API resolve `--project` against. Keeping the id out of the YAML means re-running `init` or
 * editing config never rewrites (and never strips the comments from) the user's file.
 *
 * The authoritative record is always the `projects` row in storage; this file is a local pointer,
 * verified against storage on every use (a stale pointer fails with an actionable message).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { ConfigError } from './errors';

export const PROJECT_STATE_FILE_NAME = 'project.json';
export const PROJECT_STATE_VERSION = 1 as const;

export const ProjectStateSchema = z.strictObject({
  version: z.literal(PROJECT_STATE_VERSION).default(PROJECT_STATE_VERSION),
  project_id: z.uuid(),
  name: z.string().min(1),
  root_path: z.string().min(1),
  git_remote: z.string().min(1).optional(),
  created_at: z.iso.datetime(),
});
export type ProjectState = z.infer<typeof ProjectStateSchema>;

export function projectStatePath(configDir: string): string {
  return join(configDir, PROJECT_STATE_FILE_NAME);
}

/** Read `.onememory/project.json`; `null` when the file does not exist. */
export function loadProjectState(configDir: string): ProjectState | null {
  const path = projectStatePath(configDir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `project state is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      [{ path: PROJECT_STATE_FILE_NAME, message: 'invalid JSON — delete the file and re-run onemem init' }],
      path,
    );
  }
  const result = ProjectStateSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      'project state failed validation',
      result.error.issues.map((issue) => ({
        path: issue.path.length === 0 ? PROJECT_STATE_FILE_NAME : issue.path.map(String).join('.'),
        message: issue.message,
      })),
      path,
    );
  }
  return result.data;
}

/** Write `.onememory/project.json` (pretty-printed, stable key order). */
export function saveProjectState(configDir: string, state: ProjectState): string {
  const path = projectStatePath(configDir);
  const payload: ProjectState = { ...state, version: PROJECT_STATE_VERSION };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return path;
}
