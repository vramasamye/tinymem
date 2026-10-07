/**
 * The Markdown export service (ADR-0013 §5): the one surface `onemem export` (and later the REST
 * routes) share — page the project's durable memories through the canonical read path, render the
 * deterministic tree with `@onememory/core`'s pure renderer, write it under the resolved root, and
 * prune exactly the files the export owns (marker-bearing), never the operator's own files.
 *
 * The canonical-store rule (ADR-0013 §1) is enforced by shape: this module only writes; nothing
 * reads the export back. The DB stays the sole source of truth.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  DURABLE_MEMORY_TYPES,
  EXPORT_OWNERSHIP_MARKER,
  ExportCapExceededError,
  MEMORY_STATUSES,
  renderProjectExport,
  type MemoryRecord,
} from '@onememory/core';
import { memoriesRepo, searchRepo } from '@onememory/storage';

import type { OnememoryRuntime } from './composition';
import { requireProject } from './memory-service';
import { BackendError } from './types';

export interface ExportProjectInput {
  project_id: string;
  /** Explicit export root (the CLI `--dir` override). Absolute, project-relative, or `~/...`. */
  dir?: string;
  /** HOME for `~/` roots (tests inject; defaults to `process.env.HOME`). */
  home?: string | null;
}

/** What `onemem export` prints and the REST route returns. */
export interface ExportProjectReport {
  project_id: string;
  root: string;
  /** Which knob supplied the root: the run flag, the config section, or the project-root default. */
  root_source: 'flag' | 'config' | 'project';
  memories: number;
  by_type: Record<string, number>;
  files_written: number;
  files_pruned: number;
}

/**
 * Expand an export dir: `~/...` against HOME, absolute as-is, otherwise relative to the project's
 * filesystem root. A relative dir with no project root is a configuration error, not a guess.
 */
function normalizeExportDir(dir: string, projectRoot: string | null, home: string | null): string {
  if (dir.startsWith('~/')) {
    if (home === null || home === '') {
      throw new BackendError('a ~/ export root needs HOME to expand — pass an absolute --dir', 'invalid_request');
    }
    return join(home, dir.slice(2));
  }
  if (isAbsolute(dir)) return dir;
  if (projectRoot === null) {
    throw new BackendError('the project has no filesystem root — pass an absolute --dir', 'invalid_request');
  }
  return resolve(projectRoot, dir);
}

/**
 * Page the project's durable memories through the same keyset read the typed lists use, then
 * hydrate each one via `getMemory` — the canonical read path that fills entities AND the typed
 * payload rows (`listMemoryPage` rows carry neither payloads nor per-row payload joins, and the
 * export renders payloads). Every durable status is in scope (ADR-0013 §3: working memory never
 * exports, all durable statuses do); working rows live in a separate store and are never seen.
 */
async function pageDurableMemories(runtime: OnememoryRuntime, projectId: string): Promise<MemoryRecord[]> {
  const db = runtime.storage.client;
  const ids: string[] = [];
  let after: searchRepo.MemoryPageCursor | undefined;
  for (;;) {
    const page = await searchRepo.listMemoryPage(
      db,
      {
        types: DURABLE_MEMORY_TYPES,
        pageSize: 200,
        ...(after === undefined ? {} : { after }),
      },
      {
        statuses: [...MEMORY_STATUSES],
        window: { kind: 'overlap', from: null, until: null },
        projectId,
      },
    );
    ids.push(...page.memories.map((memory) => memory.id));
    if (page.next === null) break;
    after = page.next;
  }
  const rows = await Promise.all(ids.map((id) => memoriesRepo.getMemory(db, id)));
  return rows.filter((row): row is MemoryRecord => row !== null);
}

/** Remove owned-but-stale files (marker-bearing) and the empty directories the export emptied. */
async function pruneOwned(root: string, wanted: ReadonlySet<string>): Promise<number> {
  let pruned = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        if (dir !== root && (await readdir(full)).length === 0) await rm(full);
      } else if (entry.isFile() && !wanted.has(relative(root, full))) {
        // The ownership marker is the ONLY prune license (ADR-0013 §4): a file the operator
        // wrote into the export tree is never the export's to delete.
        if (!(await readFile(full, 'utf8')).includes(EXPORT_OWNERSHIP_MARKER)) continue;
        await rm(full);
        pruned += 1;
      }
    }
  };
  await walk(root);
  return pruned;
}

/** Resolve the export root: the run flag wins, then the config section, then the project default. */
function resolveExportRoot(
  flagDir: string | undefined,
  configDir: string | undefined,
  project: { name: string; root_path: string | null; digest: Record<string, unknown> },
  home: string | null,
): { root: string; source: 'flag' | 'config' | 'project' } {
  if (flagDir !== undefined) {
    return { root: normalizeExportDir(flagDir, project.root_path, home), source: 'flag' };
  }
  if (configDir !== undefined) {
    return { root: normalizeExportDir(configDir, project.root_path, home), source: 'config' };
  }
  if (project.root_path === null) {
    throw new BackendError(
      'the project has no filesystem root and no export dir is configured — pass --dir',
      'invalid_request',
    );
  }
  return { root: join(project.root_path, 'memory'), source: 'project' };
}

export async function exportProject(
  runtime: OnememoryRuntime,
  input: ExportProjectInput,
): Promise<ExportProjectReport> {
  const project = await requireProject(runtime, input.project_id);
  const home = input.home !== undefined ? input.home : (process.env['HOME'] ?? null);

  const { root, source } = resolveExportRoot(input.dir, runtime.config.export.dir, project, home);

  const rows = await pageDurableMemories(runtime, input.project_id);
  const by_type: Record<string, number> = {};
  for (const row of rows) by_type[row.type] = (by_type[row.type] ?? 0) + 1;

  let files;
  try {
    files = renderProjectExport({
      project_name: project.name,
      digest: project.digest ?? null,
      memories: rows,
    });
  } catch (error) {
    if (error instanceof ExportCapExceededError) {
      throw new BackendError(
        `export refused: the project digest cannot fit the MEMORY.md cap (${error.message}) — regenerate the digest`,
        'invalid_request',
      );
    }
    throw error;
  }

  await mkdir(root, { recursive: true });
  const wanted = new Set(files.map((file) => file.path));
  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
  const files_pruned = await pruneOwned(root, wanted);

  return {
    project_id: input.project_id,
    root,
    root_source: source,
    memories: rows.length,
    by_type,
    files_written: files.length,
    files_pruned,
  };
}
