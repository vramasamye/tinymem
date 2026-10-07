/**
 * The remote backend: the same {@link OnememoryBackend} surface over `/v1/*`.
 *
 * The CLI uses this whenever a daemon owns the embedded database (ADR-0002: exactly one owner
 * process per data dir). Because it implements the same interface, every CLI command works
 * unchanged in both modes — the only difference is where the work happens.
 */

import type { MemorySearchRequest, MemorySearchResponse } from '@onememory-ai/core';

import type { DoctorReport } from './doctor';
import {
  BackendError,
  type BackendErrorCode,
  type ContextOptions,
  type ConsolidateInput,
  type ConsolidateOutcome,
  type CreateProjectInput,
  type DeprecateSkillInput,
  type DeprecateSkillResult,
  type PromoteSkillInput,
  type PromoteSkillResult,
  type SkillListResult,
  type SkillReviewResult,
  type ForgetInput,
  type ForgetOutcome,
  type HealthReport,
  type IngestResult,
  type InspectResult,
  type ListOptions,
  type MemoryPageOptions,
  type MemoryPageResult,
  type OnememoryBackend,
  type ProjectListResult,
  type PurgeInput,
  type PurgeOutcome,
  type RememberInput,
  type RememberOutcome,
  type StatsResult,
} from './types';
import type { ProjectRecord } from '@onememory-ai/core';
import type { SessionContext } from '@onememory-ai/retrieval';

export interface HttpBackendOptions {
  baseUrl: string;
  /** Per-request timeout (default 30s; a doctor probe can be slower). */
  timeoutMs?: number;
  /** Injectable fetch (tests use the Hono app's `request`). */
  fetch?: typeof fetch;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: unknown };
}

const KNOWN_CODES: readonly BackendErrorCode[] = [
  'not_found',
  'invalid_request',
  'conflict',
  'unavailable',
  'internal',
];

export function createHttpBackend(options: HttpBackendOptions): OnememoryBackend {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    init?: { body?: unknown; timeoutMs?: number },
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new BackendError(
        `cannot reach the onememory daemon at ${baseUrl}${path}: ${error instanceof Error ? error.message : String(error)}`,
        'unavailable',
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text !== '') {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new BackendError(
          `the daemon returned a non-JSON response (${response.status}) from ${path}`,
          'internal',
        );
      }
    }

    if (!response.ok) {
      const envelope = payload as ErrorEnvelope | null;
      const code = envelope?.error?.code;
      throw new BackendError(
        envelope?.error?.message ?? `request to ${path} failed with status ${response.status}`,
        KNOWN_CODES.includes(code as BackendErrorCode) ? (code as BackendErrorCode) : 'internal',
        envelope?.error?.details,
      );
    }
    return payload as T;
  }

  const encode = (value: string | number | undefined): string =>
    value === undefined ? '' : encodeURIComponent(String(value));

  return {
    kind: 'remote',
    endpoint: baseUrl,

    health: () => call<HealthReport>('GET', '/v1/health'),

    doctor: () => call<DoctorReport>('GET', '/v1/doctor', { timeoutMs: Math.max(timeoutMs, 120_000) }),

    createProject: (input: CreateProjectInput) => call<ProjectRecord>('POST', '/v1/projects', { body: input }),

    getProject: (id: string) => call<ProjectRecord>('GET', `/v1/projects/${encode(id)}`),

    listProjects: () => call<ProjectListResult>('GET', '/v1/projects'),

    ingestEvents: (projectId: string, events: unknown[]) =>
      call<IngestResult>('POST', `/v1/projects/${encode(projectId)}/events`, { body: { events } }),

    search: (request: MemorySearchRequest) => {
      if (request.project_id === undefined) {
        return Promise.reject(new BackendError('project_id is required for a search', 'invalid_request'));
      }
      return call<MemorySearchResponse>('POST', `/v1/projects/${encode(request.project_id)}/search`, {
        body: request,
      });
    },

    remember: (input: RememberInput) =>
      call<RememberOutcome>('POST', `/v1/projects/${encode(input.project_id)}/memories`, {
        body: {
          content: input.content,
          ...(input.type === undefined ? {} : { type: input.type }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.subtype === undefined ? {} : { subtype: input.subtype }),
          ...(input.importance === undefined ? {} : { importance: input.importance }),
          ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          ...(input.entities === undefined ? {} : { entities: input.entities }),
        },
      }),

    forget: (input: ForgetInput) =>
      call<ForgetOutcome>(
        'POST',
        `/v1/projects/${encode(input.project_id)}/memories/${encode(input.memory_id)}/forget`,
        { body: input.reason === undefined ? {} : { reason: input.reason } },
      ),

    restore: (input: ForgetInput) =>
      call<ForgetOutcome>(
        'POST',
        `/v1/projects/${encode(input.project_id)}/memories/${encode(input.memory_id)}/restore`,
        { body: input.reason === undefined ? {} : { reason: input.reason } },
      ),

    purge: (input: PurgeInput) =>
      call<PurgeOutcome>(
        'POST',
        `/v1/projects/${encode(input.project_id)}/memories/${encode(input.memory_id)}/purge`,
        {
          body: {
            expected_revision: input.expected_revision,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
        },
      ),

    inspect: (projectId: string, memoryId: string) =>
      call<InspectResult>('GET', `/v1/projects/${encode(projectId)}/memories/${encode(memoryId)}`),

    stats: (projectId: string, options: { session_id?: string } = {}) =>
      call<StatsResult>(
        'GET',
        `/v1/projects/${encode(projectId)}/stats${
          options.session_id === undefined ? '' : `?session=${encode(options.session_id)}`
        }`,
      ),

    context: (projectId: string, options: ContextOptions = {}) =>
      call<SessionContext>(
        'GET',
        `/v1/projects/${encode(projectId)}/context${
          options.budget === undefined ? '' : `?budget=${encode(options.budget)}`
        }`,
      ),

    decisions: (projectId: string, options: ListOptions = {}) =>
      call<MemorySearchResponse>('GET', `/v1/projects/${encode(projectId)}/decisions${listQuery(options)}`),

    failures: (projectId: string, options: ListOptions = {}) =>
      call<MemorySearchResponse>('GET', `/v1/projects/${encode(projectId)}/failures${listQuery(options)}`),

    listMemories: (projectId: string, options: MemoryPageOptions = {}) =>
      call<MemoryPageResult>('GET', `/v1/projects/${encode(projectId)}/memories${memoryPageQuery(options)}`),

    consolidate: (input: ConsolidateInput) =>
      call<ConsolidateOutcome>('POST', `/v1/projects/${encode(input.project_id)}/consolidate`, {
        body: {
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.actor === undefined ? {} : { actor: input.actor }),
        },
      }),

    listSkills: (projectId: string) => call<SkillListResult>('GET', `/v1/projects/${encode(projectId)}/skills`),

    reviewSkill: (projectId: string, skillId: string) =>
      call<SkillReviewResult>('GET', `/v1/projects/${encode(projectId)}/skills/${encode(skillId)}`),

    promoteSkill: (input: PromoteSkillInput) =>
      call<PromoteSkillResult>('POST', `/v1/projects/${encode(input.project_id)}/skills/${encode(input.skill_id)}/promote`, {
        body: {
          ...(input.dir === undefined ? {} : { dir: input.dir }),
          ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
          ...(input.note === undefined ? {} : { note: input.note }),
        },
      }),

    deprecateSkill: (input: DeprecateSkillInput) =>
      call<DeprecateSkillResult>(
        'POST',
        `/v1/projects/${encode(input.project_id)}/skills/${encode(input.skill_id)}/deprecate`,
        { body: { note: input.note } },
      ),

    async close() {
      // The daemon owns its lifetime; the client has nothing to release.
    },
  };
}

function memoryPageQuery(options: MemoryPageOptions): string {
  const params = new URLSearchParams();
  if (options.cursor !== undefined) params.set('cursor', options.cursor);
  if (options.page_size !== undefined) params.set('page_size', String(options.page_size));
  if (options.types !== undefined && options.types.length > 0) params.set('types', options.types.join(','));
  if (options.include !== undefined && options.include.length > 0) params.set('include', options.include.join(','));
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

function listQuery(options: ListOptions): string {
  const params: string[] = [];
  if (options.query !== undefined) params.push(`q=${encodeURIComponent(options.query)}`);
  if (options.max_tokens !== undefined) params.push(`max_tokens=${encodeURIComponent(String(options.max_tokens))}`);
  if (options.max_memories !== undefined) params.push(`max_memories=${encodeURIComponent(String(options.max_memories))}`);
  return params.length === 0 ? '' : `?${params.join('&')}`;
}
