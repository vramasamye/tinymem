/**
 * Version of the canonical schemas (`event-memory-schemas.md` §8).
 *
 * Breaking changes to the event envelope are not allowed after 1.0 — only additive optional
 * fields. Unknown-field tolerance is required at every boundary (implemented via loose objects).
 */
export const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;
