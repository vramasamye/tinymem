/**
 * The one client abstraction both deployment profiles implement (ADR-0002: one Postgres dialect,
 * three targets). Repositories are handwritten parameterized SQL against this interface, so the
 * same repository code runs on PGlite (embedded) and node-postgres (server) unchanged.
 *
 * Parameter conventions (both drivers):
 * - timestamps are passed as ISO-8601 strings with explicit `::timestamptz` casts
 * - jsonb values are passed as `JSON.stringify` text with explicit `::jsonb` casts
 * - array values are passed as PG array literals with explicit `::text[]` / `::uuid[]` casts
 */

export interface QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface Database {
  readonly profile: 'embedded' | 'server';
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  /**
   * Run `work` inside a transaction. Nested calls become savepoints, so repository functions can
   * compose (the supersession transaction calls repo functions on the same tx).
   */
  transaction<T>(work: (tx: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** PG error code for a unique-constraint violation — the dedupe signal repos catch. */
export const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

// ---------------------------------------------------------------------------
// Value coercion helpers (shared by both drivers' row mappers)
// ---------------------------------------------------------------------------

/** Coerce a timestamptz cell (Date | string) to a normalized ISO-8601 UTC string. */
export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new TypeError(`storage: unparseable timestamp ${JSON.stringify(value)}`);
    }
    return parsed.toISOString();
  }
  throw new TypeError(`storage: unexpected timestamp cell ${typeof value}`);
}

/** Nullable variant of {@link toIso}. */
export function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

/** Coerce a text[] cell (JS array on both drivers, literal string as a fallback). */
export function toStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === 'string') return parsePgArrayLiteral(value);
  throw new TypeError(`storage: unexpected array cell ${typeof value}`);
}

/** Parse a Postgres array literal such as `{a,"b c"}` (fallback path; drivers usually parse). */
export function parsePgArrayLiteral(literal: string): string[] {
  const trimmed = literal.trim();
  if (trimmed === '{}' || trimmed === '') return [];
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new TypeError(`storage: not a PG array literal: ${literal}`);
  }
  const body = trimmed.slice(1, -1);
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  let wasQuoted = false;
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (inQuotes) {
      if (char === '\\') {
        current += body[i + 1] ?? '';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
      wasQuoted = true;
    } else if (char === ',') {
      out.push(wasQuoted || current !== 'NULL' ? current : '');
      current = '';
      wasQuoted = false;
    } else {
      current += char;
    }
  }
  out.push(wasQuoted || current !== 'NULL' ? current : '');
  return out;
}

/** Build a Postgres array literal for a text[] parameter (pass with an explicit `::text[]` cast). */
export function pgTextArray(values: readonly string[]): string {
  const escaped = values.map(
    (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
  );
  return `{${escaped.join(',')}}`;
}

/** Build a Postgres array literal for a uuid[] parameter (pass with `::uuid[]`). */
export function pgUuidArray(values: readonly string[]): string {
  return `{${values.join(',')}}`;
}
