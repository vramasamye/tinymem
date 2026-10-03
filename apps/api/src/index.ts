/**
 * `@onememory/api` — the REST surface plus the runtime composition root.
 *
 * The REST app is transport; the runtime (storage, security, embedder, retrieval engine, model
 * router, job handlers, worker) is what the CLI reuses. Exporting both from one package keeps the
 * dependency direction honest: apps depend on packages, and the CLI depends on this app.
 */

export { createApiApp, MEMORY_TYPES_FOR_CLI, type ApiDeps } from './server/app';
export * from './server/schemas';
export * from './runtime';
