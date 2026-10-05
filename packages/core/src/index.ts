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

// Shared pure defaults used across engine packages
export * from './shared';

// Ports (repository-structure.md): the contract every other package codes against
export * from './ports/index';
