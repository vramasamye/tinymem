/**
 * `@onememory/core` — the engine core: canonical Zod schemas, the memory model (status machine,
 * hashing, temporal semantics, UUIDv7), and the lifecycle PORTS (pure interfaces).
 *
 * Core never imports agent-runtime code or implementations (repository-structure.md dependency
 * rules). Everything here is runtime-free apart from `node:crypto` for sha256.
 */

// Canonical schemas (event-memory-schemas.md — the enforcement point at every boundary)
export * from './schema/index';

// Memory model (ADR-0003): types, transitions, hashing, temporal predicates, ids
export * from './model/index';

// Retention / events-compaction contract (M14.6 — the EventsCompactor port + plan types)
export * from './types/retention';

// Skill-generation contract (M15 — the SkillStore port, the lifecycle machine, the report types)
export * from './types/skills';

// Runtime skill discovery (M15 follow-up 3 — where each runtime loads SKILL.md from)
export * from './types/runtime-skills';

// Shared pure defaults used across engine packages
export * from './shared';

// Cross-package type contracts (M14.5: the project digest rollup candidate + the
// projects.digest renderable record — shared by consolidation, storage, and the CLI)
export * from './types/digest';

// Ports (repository-structure.md): the contract every other package codes against
export * from './ports/index';
