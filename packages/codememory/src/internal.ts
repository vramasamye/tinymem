/**
 * Package-internal helpers shared by the M4 modules (not exported from the package index —
 * these are implementation details, not API): one error-description format and one text
 * comparator, so warnings and deterministic orderings render identically everywhere.
 */

/** `Error.name: message`, or the value itself for non-error throws. */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Total-order comparator for strings (deterministic sortings everywhere). */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
