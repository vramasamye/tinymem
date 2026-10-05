/**
 * Internal shared helpers (the one-line shapes every pass needs — one definition each).
 */

/** The message of an unknown thrown value — Errors, strings, anything. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
