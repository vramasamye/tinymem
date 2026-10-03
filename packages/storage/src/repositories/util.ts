/**
 * Shared repository utilities: boundary errors + Zod enforcement at the storage boundary
 * (AGENTS.md: "Zod schemas validate every external boundary").
 */

import { z } from 'zod';

/** A Zod boundary violation on a Store/JobQueue input. */
export class ValidationError extends Error {
  constructor(
    public readonly where: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(`storage: invalid input for ${where}`);
    this.name = 'ValidationError';
  }
}

/** A missing row (get/update by id). */
export class NotFoundError extends Error {
  constructor(
    public readonly entity: string,
    public readonly id: string,
  ) {
    super(`storage: ${entity} ${id} not found`);
    this.name = 'NotFoundError';
  }
}

/**
 * Parse a port input through its Zod schema or throw ValidationError with the issues. The input
 * is `unknown` on purpose: the port interfaces carry the compile-time contract; this is the
 * runtime check at the storage boundary.
 */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown, where: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(where, result.error.issues);
  }
  return result.data;
}
