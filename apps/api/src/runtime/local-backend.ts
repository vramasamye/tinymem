/**
 * The in-process backend: CLI commands and the Hono routes both call the service layer directly
 * through this object. No HTTP, no duplicated semantics.
 *
 * This is the "no daemon running" path (ADR-0002: CLI may open the embedded database itself as long
 * as no daemon owns it). The CLI decides which backend to build; the semantics below are identical
 * to the remote path by construction, because both implement {@link OnememoryBackend}.
 */

import { llmProfileSummary } from '@onememory/config';
import type { MemorySearchRequest } from '@onememory/core';

import type { OnememoryRuntime } from './composition';
import { inspectRuntime, type DoctorOptions } from './doctor';
import {
  forgetMemory,
  ingestEvents,
  inspectMemory,
  purgeMemory,
  rememberMemory,
  restoreMemory,
  searchMemories,
  sessionContext,
  typedMemoryList,
  requireProject,
} from './memory-service';
import { computeStats, type StatsOptions } from './stats';
import { BackendError, type HealthReport, type OnememoryBackend } from './types';
import { ONEMEMORY_VERSION } from './version';

export interface LocalBackendOptions {
  /** Recorded in `extraction.adapter` (which surface performed the write). */
  adapter: string;
  /** Close the runtime when the backend closes (daemon: false, CLI: true). */
  closeRuntime?: boolean;
}

export function createLocalBackend(
  runtime: OnememoryRuntime,
  options: LocalBackendOptions,
): OnememoryBackend {
  const adapter = options.adapter;

  return {
    kind: 'local',
    endpoint: null,

    async health(): Promise<HealthReport> {
      let status: HealthReport['status'] = runtime.warnings.length > 0 ? 'degraded' : 'ok';
      try {
        await runtime.storage.store.listPendingEvents(1);
      } catch {
        status = 'failed';
      }
      return {
        status,
        version: ONEMEMORY_VERSION,
        uptime_ms: Date.now() - runtime.started_at,
        pid: process.pid,
        config_path: runtime.loaded.paths.config_path,
        storage: {
          profile: runtime.storage.profile,
          vector_backend: runtime.storage.vectors.backend,
          vector_model: runtime.storage.vectors.model,
          vector_dim: runtime.storage.vectors.dim,
        },
        llm: llmProfileSummary(runtime.config),
        embedder: {
          provider: runtime.embedder?.provider ?? null,
          model: runtime.embedder?.model ?? null,
          dim: runtime.embedder?.meta.dim ?? null,
        },
        network_guard: {
          enforced: runtime.networkGuard !== null,
          attempts: runtime.networkGuard?.count ?? 0,
          reason: runtime.networkGuard !== null ? 'installed' : 'not installed',
        },
        warnings: runtime.warnings,
      };
    },

    doctor(options: DoctorOptions = {}) {
      return inspectRuntime(runtime, options);
    },

    createProject(input) {
      return runtime.storage.store.createProject({
        name: input.name,
        ...(input.root_path === undefined ? {} : { root_path: input.root_path }),
        ...(input.git_remote === undefined ? {} : { git_remote: input.git_remote }),
        ...(input.description === undefined ? {} : { description: input.description }),
      });
    },

    getProject(id) {
      return requireProject(runtime, id);
    },

    async listProjects() {
      const warnings: string[] = [
        'project listing is incomplete: @onememory/storage exposes no list-projects query, so only the project registered in .onememory/project.json can be returned (coordinator follow-up, mission-13 report)',
      ];
      const projects = [];
      const registered = runtime.loaded.project_state;
      if (registered !== null) {
        const project = await runtime.storage.store.getProject(registered.project_id);
        if (project !== null) projects.push(project);
        else {
          warnings.push(
            `.onememory/project.json points at project ${registered.project_id}, which does not exist in this database — run 'onemem init' again`,
          );
        }
      }
      return { projects, warnings };
    },

    ingestEvents(projectId, events) {
      return ingestEvents(runtime, projectId, events);
    },

    search(request: MemorySearchRequest) {
      return searchMemories(runtime, request);
    },

    remember(input) {
      return rememberMemory(runtime, input, { adapter });
    },

    forget(input) {
      return forgetMemory(runtime, input, { adapter });
    },

    restore(input) {
      return restoreMemory(runtime, input, { adapter });
    },

    purge(input) {
      return purgeMemory(runtime, input, { adapter });
    },

    inspect(projectId, memoryId) {
      return inspectMemory(runtime, projectId, memoryId);
    },

    stats(projectId, options: StatsOptions = {}) {
      return computeStats(runtime, projectId, options);
    },

    context(projectId, options = {}) {
      return sessionContext(runtime, projectId, {
        ...(options.budget === undefined ? {} : { budget: options.budget }),
      });
    },

    decisions(projectId, options = {}) {
      return typedMemoryList(runtime, projectId, 'decision', options);
    },

    failures(projectId, options = {}) {
      return typedMemoryList(runtime, projectId, 'failure', options);
    },

    async close() {
      if (options.closeRuntime === false) return;
      await runtime.close();
    },
  };
}

/** Guard used by the CLI: a project id must be present before a write. */
export function requireProjectId(projectId: string | undefined): string {
  if (projectId === undefined || projectId === '') {
    throw new BackendError('no project resolved: pass --project or run onemem init', 'invalid_request');
  }
  return projectId;
}
