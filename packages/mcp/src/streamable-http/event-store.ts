/**
 * In-memory resumability store for the sessionful Streamable HTTP transport: the
 * `EventStore` port of `@modelcontextprotocol/server` (2.3.0) — the same port the SDK's
 * `WebStandardStreamableHTTPServerTransport` consults to (a) stamp SSE frames with `id:`
 * lines and (b) replay frames after a `Last-Event-ID` reconnect (spec 2025-06-18 §2.1.3:
 * the server MAY offer stream resumption; offering it requires exactly this replay path).
 *
 * Reuse note: the replay/`id:`-stamping MECHANICS stay in the SDK's transport — this module
 * only supplies bounded per-stream buffers. Streams are per-request POST response streams plus
 * the session's standalone GET stream; each holds a FIFO ring (bounded, oldest evicted) and an
 * id→stream index sized to a multiple of the ring so an evicted `Last-Event-ID` can still be
 * attributed to its stream. A replay from an id that has been evicted replays everything still
 * retained for that stream (at-least-once duplicates are legal SSE replay; silent gaps are not).
 *
 * Process-local by design: sessions are process-local in the sessionful transport (one
 * `WebStandardStreamableHTTPServerTransport` per session in one process), so the resumability
 * window is this process's lifetime — the standard first-tier deployment shape. A Redis/Postgres
 * store for multi-node deployments is the documented follow-up (same `EventStore` port).
 */

import { randomUUID } from 'node:crypto';

import type { EventId, EventStore, JSONRPCMessage, StreamId } from '@modelcontextprotocol/server';

/** Retained events per stream before the oldest are evicted (default 500). */
export const DEFAULT_MAX_EVENTS_PER_STREAM = 500;

/**
 * How many evicted event ids stay resolvable to their stream (as a multiple of the ring).
 * Reconnects happen within seconds; this covers a slow consumer that reconnects after eviction.
 */
const EVICTION_INDEX_MULTIPLE = 4;

interface StoredEvent {
  eventId: EventId;
  message: JSONRPCMessage;
}

interface StreamBuffer {
  /** FIFO ring of retained events. */
  events: StoredEvent[];
  /** Bounded id→(ring position at eviction time) index covering evicted ids. */
  evictedIndex: Map<EventId, true>;
  /** Retained events NOT yet replayed, for an in-progress replay that outlived its ring slice. */
  replayCursor: Map<EventId, StoredEvent[]>;
}

export interface InMemoryResumabilityStoreOptions {
  /** Retained events per stream (default 500; each frame is one JSON-RPC message). */
  maxEventsPerStream?: number;
}

export class InMemoryResumabilityStore implements EventStore {
  private readonly maxEvents: number;
  private readonly streams = new Map<StreamId, StreamBuffer>();

  constructor(options: InMemoryResumabilityStoreOptions = {}) {
    this.maxEvents = options.maxEventsPerStream ?? DEFAULT_MAX_EVENTS_PER_STREAM;
  }

  /** Retained event count for one stream (introspection/tests). */
  retained(streamId: StreamId): number {
    return this.streams.get(streamId)?.events.length ?? 0;
  }

  /** Total retained events across streams (introspection/tests). */
  get totalRetained(): number {
    let total = 0;
    for (const buffer of this.streams.values()) total += buffer.events.length;
    return total;
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = randomUUID();
    const buffer = this.streams.get(streamId);
    if (buffer === undefined) {
      // First event for a stream that has already been fully evicted or was never seen: seed it.
      this.streams.set(streamId, {
        events: [{ eventId, message }],
        evictedIndex: new Map(),
        replayCursor: new Map(),
      });
      return eventId;
    }
    buffer.events.push({ eventId, message });
    // An in-progress replay for this stream that has not consumed this event yet must see it:
    // append to the replay's snapshot so `replayEventsAfter` contracts (snapshot, then live tail)
    // hold even when the replay is slower than production.
    for (const pending of buffer.replayCursor.values()) pending.push({ eventId, message });
    if (buffer.events.length > this.maxEvents) {
      const evicted = buffer.events.shift()!;
      buffer.evictedIndex.set(evicted.eventId, true);
      if (buffer.evictedIndex.size > this.maxEvents * EVICTION_INDEX_MULTIPLE) {
        const oldest = buffer.evictedIndex.keys().next().value;
        if (oldest !== undefined) buffer.evictedIndex.delete(oldest);
      }
    }
    return eventId;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    for (const [streamId, buffer] of this.streams) {
      if (buffer.evictedIndex.has(eventId)) return streamId;
      if (buffer.events.some((event) => event.eventId === eventId)) return streamId;
    }
    return undefined;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const streamId = await this.getStreamIdForEventId(lastEventId);
    if (streamId === undefined) throw new Error(`unknown last event id: ${lastEventId}`);
    const buffer = this.streams.get(streamId)!;

    // Snapshot everything still retained; when the anchor id was evicted, replay the full
    // retained tail (duplicates are safe, gaps are not). Otherwise replay strictly AFTER it.
    const anchorIndex = buffer.events.findIndex((event) => event.eventId === lastEventId);
    const backlog: StoredEvent[] =
      anchorIndex === -1 ? [...buffer.events] : buffer.events.slice(anchorIndex + 1);

    // Live tail: events stored while the replay drains land in the cursor and are sent after
    // the backlog, re-splicing until the cursor is momentarily empty — the replay ends having
    // delivered a contiguous prefix of the stream, with no snapshot-to-live gap. (Events the
    // transport's own live mapping then delivers can duplicate frames — at-least-once replay
    // is legal SSE semantics; a gap would not be.)
    const cursor: StoredEvent[] = [];
    buffer.replayCursor.set(lastEventId, cursor);
    try {
      for (const event of backlog) await send(event.eventId, event.message);
      let batch = cursor.splice(0, cursor.length);
      while (batch.length > 0) {
        for (const event of batch) await send(event.eventId, event.message);
        batch = cursor.splice(0, cursor.length);
      }
    } finally {
      buffer.replayCursor.delete(lastEventId);
    }
    return streamId;
  }

  /** Drop every buffer for a closed session (the transport closes with it). */
  dropStream(streamId: StreamId): void {
    this.streams.delete(streamId);
  }
}
