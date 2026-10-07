/**
 * The in-memory entity lookup (retrieval.md §5: "Entity lookup: in-memory index per process").
 * Loads the project + global entity registry from storage (bounded), then matches query text
 * against canonical names, aliases, and normalized names — exact + alias + normalized matching,
 * longest surface form first so specific aliases win over short ones.
 */

import { normalizeEntityName } from '@onememory-ai/core';
import type { EntityRecord } from '@onememory-ai/core';

export interface EntityIndexOptions {
  /** Refresh TTL for the loaded registry (default 30s). */
  ttlMs?: number;
  /** Registry size bound (defensive; real projects are far below). */
  maxEntities?: number;
  /** Max entities returned per query match. */
  maxMatches?: number;
}

interface SurfaceForm {
  form: string;
  regex: RegExp;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function surfaceRegex(form: string): RegExp {
  // Word boundaries around the (escaped) surface form; internal whitespace is flexible.
  const pattern = form.trim().split(/\s+/).map(escapeRegex).join('\\s+');
  return new RegExp(`(^|[^a-z0-9])${pattern}($|[^a-z0-9])`, 'i');
}

export class EntityIndex {
  private cache?: { entities: EntityRecord[]; expires: number };
  private readonly options: Required<EntityIndexOptions>;

  constructor(
    private readonly load: (options: { limit: number }) => Promise<EntityRecord[]>,
    options?: EntityIndexOptions,
  ) {
    this.options = {
      ttlMs: options?.ttlMs ?? 30_000,
      maxEntities: options?.maxEntities ?? 1000,
      maxMatches: options?.maxMatches ?? 8,
    };
  }

  /** The loaded registry (cached, TTL-bounded). */
  async entities(): Promise<EntityRecord[]> {
    const now = Date.now();
    if (this.cache && this.cache.expires > now) return this.cache.entities;
    const entities = await this.load({ limit: this.options.maxEntities });
    this.cache = { entities, expires: now + this.options.ttlMs };
    return entities;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private surfaceForms(entity: EntityRecord): SurfaceForm[] {
    const forms = new Set<string>();
    forms.add(entity.name);
    for (const alias of entity.aliases) forms.add(alias);
    forms.add(entity.normalized_name);
    return [...forms]
      .filter((form) => form.trim() !== '')
      .sort((a, b) => b.length - a.length)
      .map((form) => ({ form, regex: surfaceRegex(form) }));
  }

  /**
   * Match entities against free text (the query): an entity matches when one of its surface forms
   * (name, alias, or normalized name) appears with word boundaries. Longest matched form first.
   */
  async matchText(text: string): Promise<EntityRecord[]> {
    const registry = await this.entities();
    const matches: Array<{ entity: EntityRecord; form: string }> = [];
    for (const entity of registry) {
      for (const { form, regex } of this.surfaceForms(entity)) {
        if (regex.test(text)) {
          matches.push({ entity, form });
          break; // one surface form per entity — the longest was tried first
        }
      }
    }
    matches.sort((a, b) => b.form.length - a.form.length || a.entity.name.localeCompare(b.entity.name));
    return matches.slice(0, this.options.maxMatches).map((match) => match.entity);
  }

  /**
   * Resolve explicitly named entities (the search request's `entities` filter): exact normalized
   * name or alias equality. Returns name → entity (or null when unresolved — the caller decides
   * that an unresolvable filter means an honest empty result, not a silent scope drop).
   */
  async resolveNames(names: readonly string[]): Promise<Map<string, EntityRecord | null>> {
    const registry = await this.entities();
    const result = new Map<string, EntityRecord | null>();
    for (const name of names) {
      const normalized = normalizeEntityName(name);
      const entity =
        registry.find((candidate) => candidate.normalized_name === normalized) ??
        registry.find((candidate) =>
          candidate.aliases.some((alias) => normalizeEntityName(alias) === normalized),
        ) ??
        null;
      result.set(name, entity);
    }
    return result;
  }

  get loadedCount(): number {
    return this.cache?.entities.length ?? 0;
  }
}
