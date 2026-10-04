/**
 * Bind the typed repository functions into the core `Store` and `JobQueue` ports. The ports are
 * the contract every other mission codes against (repository-structure.md); this object
 * structurally implements them, so `sdk` can wire storage behind the interfaces with zero glue.
 */

import type {
  CodeMemoryStore,
  DurableMemoryType,
  JobQueue,
  MemoryStatus,
  Store,
} from '@onememory/core';
import type {
  EntityBinding,
  EnqueueJobResult,
  EventIngestResult,
  JobRecord,
  MergeEntitiesInput,
  MemoryEventRecord,
  MemoryQuery,
  MemoryWriteResult,
  NewEdge,
  NewEntity,
  NewMemory,
  NewMemoryEvent,
  NewProject,
  NewSession,
  NewSource,
  NewUser,
  NewWorkingMemory,
  ProjectRecord,
  SessionRecord,
  SourceRef,
  StoredEvent,
  SupersedeResult,
  UserRecord,
  WorkingMemoryRecord,
  WorkingSweepResult,
  EdgeRecord,
  EntityRecord,
  MemoryRecord,
} from '@onememory/core';

import type { Database } from './drivers/client';

import * as codeMemoryRepo from './repositories/code-memory';
import * as edgesRepo from './repositories/edges';
import * as entitiesRepo from './repositories/entities';
import * as eventsRepo from './repositories/events';
import * as jobsRepo from './repositories/jobs';
import * as memoriesRepo from './repositories/memories';
import * as auditRepo from './repositories/memory-events';
import * as projectsRepo from './repositories/projects';
import * as workingRepo from './repositories/working-memory';

/** Build the core `Store` port over a Database (embedded or server — same code). */
export function createStore(db: Database): Store {
  return {
    createUser: (input: NewUser) => projectsRepo.createUser(db, input),
    createProject: (input: NewProject) => projectsRepo.createProject(db, input),
    getProject: (id: string) => projectsRepo.getProject(db, id),

    createSource: (input: NewSource) => projectsRepo.createSource(db, input),
    getSource: (id: string) => projectsRepo.getSource(db, id),
    ingestEvent: (event) => eventsRepo.ingestEvent(db, event),
    listPendingEvents: (limit: number) => eventsRepo.listPendingEvents(db, limit),
    markEventProcessed: (id, options) => eventsRepo.markEventProcessed(db, id, options),

    findDuplicate: (
      scope: { project_id?: string | null; user_id?: string | null },
      type: DurableMemoryType,
      contentHash: string,
    ) => memoriesRepo.findDuplicate(db, scope, type, contentHash),
    insertMemory: (candidate: NewMemory) => memoriesRepo.insertMemory(db, candidate),
    getMemory: (id: string) => memoriesRepo.getMemory(db, id),
    updateMemoryStatus: (id: string, to: MemoryStatus, options) =>
      memoriesRepo.updateMemoryStatus(db, id, to, options),
    supersede: (input) => memoriesRepo.supersede(db, input),
    deleteMemory: (id, options) => memoriesRepo.deleteMemory(db, id, options),
    queryCurrent: (query: MemoryQuery) => memoriesRepo.queryCurrent(db, query),
    queryAsOf: (at: string, query: MemoryQuery) => memoriesRepo.queryAsOf(db, at, query),
    historyOf: (memoryId: string) => memoriesRepo.historyOf(db, memoryId),
    reinforce: (memoryIds: string[], at?: string) => memoriesRepo.reinforce(db, memoryIds, at),

    appendMemoryEvent: (entry: NewMemoryEvent) => auditRepo.appendMemoryEvent(db, entry),
    listMemoryEvents: (memoryId: string) => auditRepo.listMemoryEvents(db, memoryId),

    addEdge: (edge: NewEdge) => edgesRepo.addEdge(db, edge),
    listEdges: (memoryId: string) => edgesRepo.listEdges(db, memoryId),

    findEntity: (scope, normalizedName) => entitiesRepo.findEntity(db, scope, normalizedName),
    createEntity: (input: NewEntity) => entitiesRepo.createEntity(db, input),
    mergeEntities: (input: MergeEntitiesInput) => entitiesRepo.mergeEntities(db, input),
    bindMemoryEntities: (memoryId: string, bindings: EntityBinding[]) =>
      entitiesRepo.bindMemoryEntities(db, memoryId, bindings),
    listMemoryEntities: (memoryId: string) => entitiesRepo.listMemoryEntities(db, memoryId),

    createSession: (input: NewSession) => workingRepo.createSession(db, input),
    insertWorking: (entry: NewWorkingMemory) => workingRepo.insertWorking(db, entry),
    markWorkingPromoted: (id: string, memoryId: string) =>
      workingRepo.markWorkingPromoted(db, id, memoryId),
    sweepWorking: (now?: string) => workingRepo.sweepWorking(db, now),
    listWorking: (sessionId: string) => workingRepo.listWorking(db, sessionId),
  };
}

/** Build the core `JobQueue` port over a Database. */
export function createJobQueue(db: Database, options?: { backoffBaseSeconds?: number }): JobQueue {
  const backoffBaseSeconds = options?.backoffBaseSeconds ?? 2;
  return {
    enqueue: (input): Promise<EnqueueJobResult> => jobsRepo.enqueueJob(db, input),
    claim: (input): Promise<JobRecord[]> => jobsRepo.claimJobs(db, input),
    complete: (jobId: string): Promise<void> => jobsRepo.completeJob(db, jobId),
    fail: (jobId: string, error: string, options?: { now?: string }): Promise<JobRecord> =>
      jobsRepo.failJob(db, jobId, error, { backoffBaseSeconds, now: options?.now }),
    getJob: (jobId: string): Promise<JobRecord | null> => jobsRepo.getJob(db, jobId),
  };
}

/** Build the core `CodeMemoryStore` port over a Database (M4 persistence — ADR-0008). */
export function createCodeMemoryStore(db: Database): CodeMemoryStore {
  return {
    ensureRepository: (input) => codeMemoryRepo.ensureRepository(db, input),
    getRepository: (id) => codeMemoryRepo.getRepository(db, id),
    listRepositories: (projectId) => codeMemoryRepo.listRepositories(db, projectId),
    saveSnapshot: (repositoryId, snapshot) =>
      codeMemoryRepo.saveSnapshot(db, repositoryId, snapshot),
    loadFingerprints: (repositoryId, filter) =>
      codeMemoryRepo.loadFingerprints(db, repositoryId, filter),
    loadSnapshotMetadata: (repositoryId) => codeMemoryRepo.loadSnapshotMetadata(db, repositoryId),
    recordCodeRefs: (input) => codeMemoryRepo.recordCodeRefs(db, input),
    listCodeRefs: (repositoryId, filter) => codeMemoryRepo.listCodeRefs(db, repositoryId, filter),
    saveSymbolTable: (repositoryId, input) =>
      codeMemoryRepo.saveSymbolTable(db, repositoryId, input),
    loadSymbols: (repositoryId, filter) => codeMemoryRepo.loadSymbols(db, repositoryId, filter),
  };
}

export type {
  Database,
  Store,
  JobQueue,
  EdgeRecord,
  EntityRecord,
  MemoryRecord,
  MemoryEventRecord,
};
