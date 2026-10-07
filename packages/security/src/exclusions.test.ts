/**
 * Path exclusion policy tests: the default glob matrix, custom globs, and the
 * document.added / file.changed whole-event check (drop BEFORE redaction).
 */

import { describe, expect, test } from 'bun:test';

import { eventContentHash, uuidv7, validateOnememoryEvent } from '@onememory-ai/core';
import type { OnememoryEvent } from '@onememory-ai/core';


import {
  DEFAULT_EXCLUDED_GLOBS,
  DEFAULT_PATH_EXCLUSION_POLICY,
  createPathExclusionPolicy,
  isEventPathExcluded,
  isPathExcluded,
  PathExclusionConfigError,
} from './index';

const EXCLUDED: readonly string[] = [
  '.env',
  '.env.local',
  '.env.production',
  '.envrc',
  'config/.env',
  'infra/.env.staging',
  'certs/server.pem',
  'keys/id_rsa',
  'keys/id_ed25519',
  'keys/deploy_ed25519',
  'deploy/aws_credentials.json',
  'terraform/prod.tfvars',
  'terraform/dev.tfvars.json',
  'terraform/prod.tfstate',
  'secrets.yaml',
  'config/secrets.production.yaml',
  'vault.kdbx',
  '.npmrc',
  '.netrc',
  'gcp/proj-service_account-abc.json',
  'auth/authorized_keys',
  // Conservative by design (ADR-0007): `*credentials*` matches prose documents ABOUT
  // credentials too — the safe direction of error is dropping the event.
  'docs/credentials-guide.md',
];

const ALLOWED: readonly string[] = [
  'src/app.ts',
  'README.md',
  'package.json',
  'docs/handbook.md',
  'config/env.example.txt',
  'src/key-utils.ts', // "key" alone is not a .key file
  'tests/env-loader.spec.ts',
];

describe('default exclusion matrix', () => {
  for (const path of EXCLUDED) {
    test(`excluded: ${path}`, () => {
      expect(isPathExcluded(path)).toBe(true);
    });
  }

  for (const path of ALLOWED) {
    test(`allowed: ${path}`, () => {
      expect(isPathExcluded(path)).toBe(false);
    });
  }

  test('normalization: ./ prefixes, file:// schemes, and empty paths', () => {
    expect(isPathExcluded('./.env')).toBe(true);
    expect(isPathExcluded('file:///home/alice/project/.env')).toBe(true);
    expect(isPathExcluded('file://relative/id_rsa')).toBe(true);
    expect(isPathExcluded('  .env  ')).toBe(true);
    expect(isPathExcluded('')).toBe(false);
    expect(isPathExcluded('./src/app.ts')).toBe(false);
  });
});

describe('custom policies', () => {
  test('config globs ADD to the non-removable defaults', () => {
    const policy = createPathExclusionPolicy({ globs: ['*.vault', 'internal/*'] });

    expect(policy.globs.length).toBe(DEFAULT_EXCLUDED_GLOBS.length + 2);
    expect(isPathExcluded('keys/prod.vault', policy)).toBe(true);
    expect(isPathExcluded('internal/config.yml', policy)).toBe(true);
    expect(isPathExcluded('internal/deep/nested/config.yml', policy)).toBe(true); // * crosses /
    // defaults still in effect:
    expect(isPathExcluded('.env', policy)).toBe(true);
    expect(isPathExcluded('certs/server.pem', policy)).toBe(true);
  });

  test('the default policy is equivalent to createPathExclusionPolicy()', () => {
    expect(DEFAULT_PATH_EXCLUSION_POLICY.globs).toEqual(DEFAULT_EXCLUDED_GLOBS);
    expect(DEFAULT_PATH_EXCLUSION_POLICY.globs).toEqual(createPathExclusionPolicy().globs);
  });

  test('invalid config is rejected', () => {
    expect(() => createPathExclusionPolicy({ globs: [''] })).toThrow(PathExclusionConfigError);
    expect(() => createPathExclusionPolicy({ globs: ['ok', ''] })).toThrow(PathExclusionConfigError);
    expect(() => createPathExclusionPolicy({ globs: ['a', 'b', 'c'] })).not.toThrow();
  });

  test('glob special characters are literal except * and ?', () => {
    const policy = createPathExclusionPolicy({ globs: ['a+b.txt'] });
    expect(isPathExcluded('a+b.txt', policy)).toBe(true);
    expect(isPathExcluded('aab.txt', policy)).toBe(false); // '+' is literal, not a regex +
    expect(isPathExcluded('axb.txt', policy)).toBe(false);

    const q = createPathExclusionPolicy({ globs: ['secret?.txt'] });
    expect(isPathExcluded('secret1.txt', q)).toBe(true);
    expect(isPathExcluded('secret12.txt', q)).toBe(false);
  });
});

describe('whole-event exclusion (drop BEFORE redaction)', () => {
  /** Build + validate a canonical event exactly like an adapter does. */
  function event(kind: string, payload: Record<string, unknown>): OnememoryEvent {
    const result = validateOnememoryEvent({
      id: uuidv7(),
      kind,
      occurred_at: '2026-10-04T12:00:00.000Z',
      ingested_at: '2026-10-04T12:00:01.000Z',
      source: { runtime: 'file-watcher', adapter_version: '0.1.0' },
      scope: {},
      payload,
      content_hash: eventContentHash(payload),
      redactions: [],
    });
    if (!result.ok) {
      throw new Error(`fixture event failed validation: ${JSON.stringify(result.dead_letter.issues)}`);
    }
    return result.value;
  }

  test('document.added with an excluded path is dropped', () => {
    const ev = event('document.added', {
      kind: 'document.added',
      path: 'config/.env',
      mime: 'text/plain',
      content_digest: 'DB_PASSWORD=letmein',
    });
    expect(isEventPathExcluded(ev)).toBe(true);
  });

  test('document.added with a file:// uri pointing at a key file is dropped', () => {
    const ev = event('document.added', {
      kind: 'document.added',
      uri: 'file:///repo/keys/id_rsa',
      mime: 'text/plain',
      content_digest: 'ssh-rsa …',
    });
    expect(isEventPathExcluded(ev)).toBe(true);
  });

  test('document.added with an https uri is matched on its pathname', () => {
    const dropped = event('document.added', {
      kind: 'document.added',
      uri: 'https://host/.env',
      mime: 'text/plain',
      content_digest: 'x',
    });
    const kept = event('document.added', {
      kind: 'document.added',
      uri: 'https://docs.example.com/guide.md',
      mime: 'text/markdown',
      content_digest: '# guide',
    });
    expect(isEventPathExcluded(dropped)).toBe(true);
    expect(isEventPathExcluded(kept)).toBe(false);
  });

  test('document.added with a normal path is kept', () => {
    const ev = event('document.added', {
      kind: 'document.added',
      path: 'docs/architecture.md',
      mime: 'text/markdown',
      content_digest: '# architecture',
    });
    expect(isEventPathExcluded(ev)).toBe(false);
  });

  test('file.changed checks both path and old_path (a rename into .env is dropped)', () => {
    const modified = event('file.changed', { kind: 'file.changed', path: 'config/.env.local', change: 'modified' });
    const renamed = event('file.changed', { kind: 'file.changed', path: 'env.txt', old_path: 'secrets.yaml', change: 'renamed' });
    const kept = event('file.changed', { kind: 'file.changed', path: 'src/app.ts', change: 'modified' });

    expect(isEventPathExcluded(modified)).toBe(true);
    expect(isEventPathExcluded(renamed)).toBe(true);
    expect(isEventPathExcluded(kept)).toBe(false);
  });

  test('other kinds are never path-excluded; malformed payloads are never dropped here', () => {
    const message = event('conversation.message', {
      kind: 'conversation.message',
      role: 'user',
      content: 'look at the path .env',
    });
    expect(isEventPathExcluded(message)).toBe(false);

    // An invalid document payload (missing required fields) is not dropped by the exclusion
    // check — the ingest validator dead-letters it separately.
    const malformed = {
      ...message,
      kind: 'document.added',
      payload: { kind: 'document.added' },
    } as OnememoryEvent;
    expect(isEventPathExcluded(malformed)).toBe(false);
  });
});
