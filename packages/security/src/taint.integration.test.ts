/**
 * The redaction-invariant taint test (ADR-0007 / backlog M12 issue 2): a redacted event goes
 * through the REAL storage pipeline — `createEmbeddedDb` (PGlite, temp dir) → `ingestEvent` →
 * `listPendingEvents` — and the synthetic secrets must not appear anywhere: not in the stored
 * payload, not in the raw jsonb text, not in the redactions, not in captured console output.
 * The same run proves the pipeline performs ZERO outbound network under the guard.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eventContentHash, uuidv7, validateOnememoryEvent } from '@onememory-ai/core';
import { createEmbeddedDb } from '@onememory-ai/storage';
import type { OnememoryStorage } from '@onememory-ai/storage';

import { installNetworkGuard, isEventPathExcluded, redactEvent } from './index';

const A = (n: number, char = 'a'): string => char.repeat(n);

const OPENAI_KEY = `sk-${A(48)}`;
const ANTHROPIC_KEY = `sk-ant-${A(48, 'b')}`;
const AWS_KEY = `AKIA${A(16, 'C')}`;
const SESSION_COOKIE = A(32, 's');
const DB_PASSWORD = 'secretpw-1234';
const CONNECTION_STRING = `postgres://admin:${DB_PASSWORD}@db.internal:5432/app`;

const ALL_SECRETS: readonly string[] = [OPENAI_KEY, ANTHROPIC_KEY, AWS_KEY, SESSION_COOKIE, DB_PASSWORD, CONNECTION_STRING];

function envelope(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    id: uuidv7(),
    kind,
    occurred_at: '2026-10-04T12:00:00.000Z',
    ingested_at: '2026-10-04T12:00:01.000Z',
    source: { runtime: 'claude-code', adapter_version: '0.1.0' },
    scope: {},
    payload,
    content_hash: eventContentHash(payload),
    redactions: [],
  };
}

/** Capture every console method so the "never reaches logs" invariant is asserted, not assumed. */
function captureConsole(sink: string[]): () => void {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map((method) => [method, console[method]] as const);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg === 'string') sink.push(arg);
        else {
          try {
            sink.push(JSON.stringify(arg));
          } catch {
            sink.push(String(arg));
          }
        }
      }
    };
  }
  return () => {
    for (const [method, original] of originals) {
      console[method] = original;
    }
  };
}

let storage: OnememoryStorage;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'onemem-m12-taint-'));
  storage = await createEmbeddedDb(dataDir);
});

afterAll(async () => {
  await storage.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('redaction invariant over the real ingest pipeline (taint test)', () => {
  test('secrets never reach the database, the audit records, or the logs', async () => {
    const guard = installNetworkGuard(); // the whole pipeline must stay fully offline
    const consoleLines: string[] = [];
    const restoreConsole = captureConsole(consoleLines);

    try {
      // 1. REDACT at the ingest boundary (conversation + terminal payloads, nested content).
      const conversation = redactEvent(
        envelope('conversation.message', {
          kind: 'conversation.message',
          role: 'user',
          content: `use ${OPENAI_KEY} for openai and ${ANTHROPIC_KEY} for anthropic; session=${SESSION_COOKIE}`,
        }),
      );
      const terminal = redactEvent(
        envelope('terminal.output', {
          kind: 'terminal.output',
          command: 'psql --password hunter2-secret',
          exit_code: 1,
          output_digest: `connection refused for ${CONNECTION_STRING} with key ${AWS_KEY}`,
        }),
      );

      // 2. INGEST through the real events repository (redactions passthrough).
      const storedConversation = await storage.store.ingestEvent(conversation.event);
      const storedTerminal = await storage.store.ingestEvent(terminal.event);
      expect(storedConversation.status).toBe('stored');
      expect(storedTerminal.status).toBe('stored');

      // Dedupe is computed over the REDACTED payload: re-ingesting the same redacted event is a duplicate.
      const again = await storage.store.ingestEvent(conversation.event);
      expect(again.status).toBe('duplicate');
      expect(again.duplicate_of).toBe(conversation.event.id);

      // 3. QUERY the stored rows back (what extraction/prompt-building would consume).
      const pending = await storage.store.listPendingEvents(100);
      const storedConversationRow = pending.find((row) => row.id === conversation.event.id);
      const storedTerminalRow = pending.find((row) => row.id === terminal.event.id);
      expect(storedConversationRow).toBeDefined();
      expect(storedTerminalRow).toBeDefined();

      // 4. TAINT assertions — payload level.
      const conversationPayloadText = JSON.stringify(storedConversationRow!.payload);
      const terminalPayloadText = JSON.stringify(storedTerminalRow!.payload);
      for (const secret of ALL_SECRETS) {
        expect(conversationPayloadText).not.toContain(secret);
        expect(terminalPayloadText).not.toContain(secret);
        expect(JSON.stringify(storedConversationRow!.redactions)).not.toContain(secret);
        expect(JSON.stringify(storedTerminalRow!.redactions)).not.toContain(secret);
      }
      expect(conversationPayloadText).toContain('[REDACTED:api-key]');
      expect(conversationPayloadText).toContain('[REDACTED:token]');
      expect(terminalPayloadText).toContain('[REDACTED:connection-string]');

      // 5. TAINT assertions — raw jsonb text from the database itself.
      const raw = await storage.client.query<{ payload_text: string; redactions_text: string }>(
        'SELECT payload::text AS payload_text, redactions::text AS redactions_text FROM events ORDER BY ingested_at',
      );
      const rawAll = raw.rows.map((row) => `${row.payload_text} ${row.redactions_text}`).join('\n');
      for (const secret of ALL_SECRETS) {
        expect(rawAll).not.toContain(secret);
      }

      // 6. Redactions stored with kind + location + length (never the value).
      expect(storedConversationRow!.redactions).toEqual(conversation.redactions);
      expect(storedTerminalRow!.redactions).toEqual(terminal.redactions);
      const locations = [...storedConversationRow!.redactions, ...storedTerminalRow!.redactions].map(
        (record) => record.location,
      );
      expect(locations).toContain('$.payload.content');
      expect(locations).toContain('$.payload.output_digest');
      for (const record of [...conversation.redactions, ...terminal.redactions]) {
        expect(record.length).toBeGreaterThanOrEqual(1);
        expect(['api-key', 'password', 'token', 'private-key', 'connection-string', 'other']).toContain(record.kind);
      }
    } finally {
      restoreConsole();
      guard.restore();
    }

    // 7. TAINT assertions — logs: nothing the pipeline printed contains a secret.
    for (const line of consoleLines) {
      for (const secret of ALL_SECRETS) {
        expect(line).not.toContain(secret);
      }
    }

    // 8. PRIVACY GATE: the entire redact + ingest + query pipeline made zero outbound calls.
    guard.assertZeroCalls();
    expect(guard.count).toBe(0);
  });

  test('excluded-path events are dropped by the caller BEFORE redaction and never stored', async () => {
    const before = (await storage.store.listPendingEvents(1000)).length;

    const documentEvent = envelope('document.added', {
      kind: 'document.added',
      path: 'config/.env',
      mime: 'text/plain',
      content_digest: `API_KEY=${A(40)}`,
    });
    const fileEvent = envelope('file.changed', {
      kind: 'file.changed',
      path: 'terraform/prod.tfvars',
      change: 'modified',
    });

    // Validate like an adapter would, then apply the exclusion gate the way ingest must:
    // excluded path → drop the whole event BEFORE redaction, never hand it to the repository.
    const accepted: unknown[] = [];
    for (const candidate of [documentEvent, fileEvent]) {
      const validated = validateOnememoryEvent(candidate);
      expect(validated.ok).toBe(true);
      if (!validated.ok) continue;
      if (!isEventPathExcluded(validated.value)) accepted.push(candidate);
    }
    expect(accepted).toEqual([]); // both events are excluded: nothing survives the gate

    for (const candidate of accepted) {
      const { event } = redactEvent(candidate);
      await storage.store.ingestEvent(event);
    }

    // Nothing was stored above the baseline — the excluded paths never reached the DB.
    expect((await storage.store.listPendingEvents(1000)).length).toBe(before);
  });
});
