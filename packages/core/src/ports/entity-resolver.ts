/**
 * ENTITY RESOLUTION stage port (memory-model.md §8 stage 7): entity mentions → canonical
 * entities (create/merge/alias). Implemented by `packages/graph`, backed by the Store's entity
 * primitives. Ambiguity policy: create an unresolved entity, flag for a later merge — never drop.
 */

import type { EntityKind } from '../model/types';

import type { EntityRecord } from './records';

export interface EntityMention {
  name: string;
  kind?: EntityKind;
  /** Hints the resolver toward create-vs-bind. */
  confidence?: number;
}

export interface ResolvedEntity {
  entity: EntityRecord;
  /** True when this call created the entity (vs binding an existing canonical). */
  created: boolean;
  /** Set when the mention folded into an existing canonical entity (merge/alias). */
  merged_into?: string;
}

export interface EntityResolver {
  resolve(input: { mentions: EntityMention[]; project_id?: string }): Promise<ResolvedEntity[]>;
}
