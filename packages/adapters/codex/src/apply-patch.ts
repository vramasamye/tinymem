/**
 * Parser for Codex's `apply_patch` format (verified: `codex-rs/apply-patch` /
 * `codex-rs/core/src/tools/handlers/apply_patch.rs`, and GitHub issue #16732 confirming the patch
 * body arrives on PostToolUse hooks as `tool_input.command` since Codex 0.123.0).
 *
 * The format's file directives (everything this parser relies on) are:
 *
 *   *** Begin Patch
 *   *** Add File: <path>
 *   *** Delete File: <path>
 *   *** Update File: <path>
 *   *** Move to: <destination>      (inside an Update File hunk → a rename)
 *   *** End Patch
 *
 * Only the directive lines are parsed; hunk bodies (context/+/- lines) are ignored — the adapter
 * needs paths and change kinds, not contents.
 */

import type { FileChangeKind } from '@onememory/core';

export interface ParsedFileChange {
  path: string;
  change: FileChangeKind;
  /** Present only for renames (`*** Update File: a` + `*** Move to: b`). */
  old_path?: string;
}

const FILE_DIRECTIVE = /^\*\*\* (Add|Delete|Update) File: (.*)$/;
const MOVE_DIRECTIVE = /^\*\*\* Move to: (.*)$/;
const MAX_CHANGES_PER_PATCH = 200;

/**
 * Parse an `apply_patch` body into file changes.
 *
 * Returns `null` when the text carries no `*** Begin Patch` marker (the caller drops the payload
 * with a counted reason — never coerces a non-patch into file events).
 */
export function parseApplyPatch(patch: string): ParsedFileChange[] | null {
  if (!patch.includes('*** Begin Patch')) return null;

  const changes: ParsedFileChange[] = [];
  let current: { path: string; change: FileChangeKind } | null = null;

  for (const rawLine of patch.split('\n')) {
    if (changes.length > MAX_CHANGES_PER_PATCH) break; // bounded: a runaway patch cannot wedge capture

    const fileMatch = FILE_DIRECTIVE.exec(rawLine);
    if (fileMatch !== null) {
      if (current !== null) changes.push(current);
      const kind = fileMatch[1]!;
      const path = fileMatch[2]!.trim();
      if (path.length === 0) {
        current = null;
        continue;
      }
      current =
        kind === 'Add'
          ? { path, change: 'created' }
          : kind === 'Delete'
            ? { path, change: 'deleted' }
            : { path, change: 'modified' };
      continue;
    }

    const moveMatch = MOVE_DIRECTIVE.exec(rawLine);
    if (moveMatch !== null && current !== null) {
      const destination = moveMatch[1]!.trim();
      if (destination.length > 0) {
        const renamed: ParsedFileChange = {
          path: destination,
          change: 'renamed',
          old_path: current.path,
        };
        changes.push(renamed);
        current = null;
      }
      continue;
    }

    if (rawLine.trim() === '*** End Patch') break;
  }
  if (current !== null) changes.push(current);
  return changes;
}
