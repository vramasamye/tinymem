/**
 * Phase 2 DoD acceptance (the last undemonstrated check, phased-plan.md): "How does
 * authentication work?" returns procedures with code refs — end to end through the REAL
 * pipeline, no mocks of extraction or retrieval, under the network guard (zero model calls).
 *
 * The fixture is a realistic auth module (login / session / middleware / auth tests) in a real
 * Git repository, and the event stream is what an agent session actually produces over it.
 * The test is deliberately two-phased so it demonstrates the DoD WITHOUT contriving it:
 *
 * - Phase 1 (the honest gap, asserted): `document.added` events carrying the REAL auth-module
 *   text, plus the conversation that asked and answered "how does authentication work", run
 *   through the real extract job — and produce ZERO procedural memories. Stack mentions from
 *   the document events DO become episodic memories (asserted by tying their evidence to the
 *   exact `document.added` events), so the zero is a PROCEDURAL gap, not a broken pipeline.
 *   The heuristic extractor has no procedure-mining rule for code text: procedures enter
 *   durable memory only through explicit user intent (`explicit.remember`) or recurring commands
 *   (`terminal.output`). That gap is the product finding this mission reports; the assertion
 *   below pins it so it cannot silently regress or silently "fix" itself.
 * - Phase 2 (the DoD substance): the two REAL procedural input channels — the user explicitly
 *   remembering the auth procedure, and the agent running the auth test command twice — run
 *   through the same real extract job and DO produce the two procedural memories (auth flow +
 *   recurring auth test command), with full provenance and evidence citing their events.
 * - Phase 3: both procedures get code refs recorded through the real `CodeMemoryStore` write
 *   port (`recordCodeRefs`) against blobs captured from the REAL fixture repository — the
 *   same linkage the drift/re-index path performs for its winners — and the fixture's symbol
 *   tables are extracted with the real tree-sitter pipeline (`extractSymbolTable` +
 *   `saveSymbolTable`, the same snapshot-then-symbols order the re-index runs).
 * - Phase 4 (the DoD query): the real retrieval engine answers "How does authentication work?"
 *   and two paraphrases under the DEFAULT token budget, with `how_to` intent routing and the
 *   intent×type affinity boost visible in explain, and the top result is the procedural
 *   auth-flow memory. THE CODE REFS NOW SURFACE (M4g2 closed finding F5): every returned item
 *   carries `codeRefs`, and the top procedure's refs arrive complete — the real repoId, the
 *   real capture commit, the real path, the real captured worktree blob as evidence, and the
 *   symbol the procedure's own content names — asserted over the ACTUAL search result.
 */

import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { captureSnapshot, extractSymbolTable } from '@onememory/codememory';
import {
  createExtractHandler,
  createHeuristicClassifier,
  createHeuristicExtractor,
} from '@onememory/extraction';
import { createRetrievalEngine } from '@onememory/retrieval';
import { installNetworkGuard } from '@onememory/security';
import { createEmbeddedDb } from '@onememory/storage';
import type { OnememoryStorage } from '@onememory/storage';

import { makeInput } from '../../../../packages/extraction/src/testing/transcripts';

const execute = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execute('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30_000 });
  return result.stdout.trim();
}

async function commitAll(root: string, message: string): Promise<string> {
  await git(root, 'add', '--all');
  await git(
    root,
    '-c', 'user.name=fixture',
    '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', message,
  );
  return git(root, 'rev-parse', 'HEAD');
}

// ---------------------------------------------------------------------------
// The fixture repository: a realistic auth module.
// ---------------------------------------------------------------------------

const LOGIN_TS = `/**
 * Credential verification for the auth module.
 */

/** The credentials a login request carries. */
export interface Credentials {
  username: string;
  password: string;
}

/**
 * Verifies a username and password pair against the stored bcrypt hash.
 * Returns the account id on match, null otherwise.
 */
export async function verifyCredentials(
  credentials: Credentials,
  accounts: AccountStore,
): Promise<string | null> {
  const record = await accounts.findByUsername(credentials.username);
  if (record === null) return null;
  const matches = await verifyPassword(credentials.password, record.passwordHash);
  return matches ? record.id : null;
}
`;

const SESSION_TS = `/**
 * Session issuance for the auth module.
 */
import { signJwt } from "../crypto/jwt.js";

const SESSION_COOKIE = "session";
const MAX_AGE_SECONDS = 60 * 60 * 8;

/**
 * Signs the account id as a JWT (HS256) and returns the Set-Cookie header
 * value for the session cookie: HttpOnly, Secure, SameSite=Lax.
 */
export function createSession(accountId: string): string {
  const token = signJwt({ sub: accountId }, MAX_AGE_SECONDS);
  return [
    \`\${SESSION_COOKIE}=\${token}\`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    \`Max-Age=\${MAX_AGE_SECONDS}\`,
  ].join("; ");
}
`;

const MIDDLEWARE_TS = `/**
 * Route guard for the auth module.
 */
import { verifyJwt } from "../crypto/jwt.js";

/**
 * Guards protected routes: validates the session cookie's JWT signature
 * and rejects unauthenticated requests with 401 before the wrapped handler
 * runs. Returns the verified account id for the handler.
 */
export async function requireAuth(
  request: Request,
): Promise<{ accountId: string } | Response> {
  const token = readSessionCookie(request);
  if (token === null) return new Response("unauthenticated", { status: 401 });
  const payload = verifyJwt(token);
  if (payload === null) return new Response("unauthenticated", { status: 401 });
  return { accountId: payload.sub };
}
`;

const AUTH_TEST_TS = `import { describe, expect, test } from "bun:test";

import { verifyCredentials } from "./login.js";
import { createSession } from "./session.js";
import { requireAuth } from "./middleware.js";

describe("authentication", () => {
  test("verifyCredentials accepts a matching pair", async () => {
    const accounts = accountStore([{ username: "ada", passwordHash: hashed("lovelace") }]);
    const outcome = await verifyCredentials({ username: "ada", password: "lovelace" }, accounts);
    expect(outcome).toBe("acct-1");
  });

  test("createSession sets an HttpOnly session cookie", () => {
    const cookie = createSession("acct-1");
    expect(cookie).toContain("session=");
    expect(cookie).toContain("HttpOnly");
  });

  test("requireAuth rejects unauthenticated requests with 401", async () => {
    const outcome = await requireAuth(new Request("https://example.invalid/orders"));
    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(401);
  });
});
`;

const PACKAGE_JSON = `{
  "name": "auth-fixture-service",
  "private": true,
  "type": "module"
}
`;

const FLOW_PATHS = ['src/auth/login.ts', 'src/auth/session.ts', 'src/auth/middleware.ts'] as const;
const COMMAND_PATH = 'src/auth/auth.test.ts';

/** The auth procedure the user explicitly asks the engine to remember (< the 500-char cap). */
const AUTH_PROCEDURE =
  'Authentication procedure: verifyCredentials in src/auth/login.ts validates the ' +
  'username and password against the stored bcrypt hash; createSession in src/auth/session.ts ' +
  'signs the account id as a JWT and sets it as an HTTP-only session cookie; requireAuth in ' +
  'src/auth/middleware.ts guards protected routes and rejects unauthenticated requests with ' +
  '401. To protect a new route, wrap its handler with requireAuth.';

/** What the real extractor emits for a command seen twice in one session. */
const RECURRING_CONTENT = 'Recurring command: `bun test src/auth/` (used 2 times)';

const SESSION_ID = 'sess-auth-review';
const QUERIES = [
  'How does authentication work?',
  'What is the procedure for authentication?',
  'How can I protect a route?',
] as const;

test('auth procedures with code refs: extracted from real events, answered by real retrieval', async () => {
  const guard = installNetworkGuard();
  const dataDir = await mkdtemp(join(tmpdir(), 'onemem-proc-db-'));
  const repoRoot = await mkdtemp(join(tmpdir(), 'onemem-proc-auth-'));
  let storage: OnememoryStorage | undefined;

  try {
    // --- the fixture repository ---------------------------------------------------------
    await git(repoRoot, 'init', '-q');
    await mkdir(join(repoRoot, 'src/auth'), { recursive: true });
    const files: Array<[string, string]> = [
      ['src/auth/login.ts', LOGIN_TS],
      ['src/auth/session.ts', SESSION_TS],
      ['src/auth/middleware.ts', MIDDLEWARE_TS],
      ['src/auth/auth.test.ts', AUTH_TEST_TS],
      ['package.json', PACKAGE_JSON],
    ];
    for (const [path, text] of files) {
      await writeFile(join(repoRoot, path), text);
    }
    const head = await commitAll(repoRoot, 'feat(auth): wire requireAuth into the orders routes');

    storage = await createEmbeddedDb(dataDir);
    const project = await storage.store.createProject({
      name: 'auth-fixture-service',
      root_path: repoRoot,
    });
    const scope = { projectId: project.id, sessionId: SESSION_ID };

    // The REAL extraction path: the same extract-job handler the daemon worker runs, over the
    // real heuristic extractor + classifier, reading the pending events table.
    const extraction = createExtractHandler(
      storage.store,
      storage.jobs,
      createHeuristicExtractor(),
      createHeuristicClassifier(),
      { enqueueReEmbed: false },
    );

    // --- phase 1: real code + real conversation alone (the honest gap) --------------------
    const sessionStart = makeInput(
      'session.start',
      {
        kind: 'session.start',
        cwd: repoRoot,
        summary: 'reviewing the authentication module before adding a protected route',
      },
      { ...scope, offsetSeconds: 0 },
    );
    const userQuestion = makeInput(
      'conversation.message',
      {
        kind: 'conversation.message',
        role: 'user',
        content: 'How does authentication work in this service? I need to add a protected route.',
      },
      { ...scope, offsetSeconds: 5 },
    );
    const assistantAnswer = makeInput(
      'conversation.message',
      {
        kind: 'conversation.message',
        role: 'assistant',
        content:
          'The auth module is three files: login.ts exposes verifyCredentials, session.ts ' +
          'exposes createSession, and middleware.ts exposes requireAuth, which guards the ' +
          'protected routes with a signed session cookie.',
      },
      { ...scope, offsetSeconds: 10 },
    );
    // The adapter's document events for the files the session read: the REAL auth-module text.
    const documentEvents = (['src/auth/login.ts', 'src/auth/session.ts', 'src/auth/middleware.ts', COMMAND_PATH] as const)
      .map((path, index) => {
        const text = files.find(([file]) => file === path)![1]!;
        return makeInput(
          'document.added',
          {
            kind: 'document.added',
            path,
            mime: 'text/typescript',
            title: path,
            content_digest: text,
          },
          { ...scope, offsetSeconds: 15 + index * 5 },
        );
      });
    const commitEvent = makeInput(
      'git.commit',
      {
        kind: 'git.commit',
        sha: head,
        message: 'feat(auth): wire requireAuth into the orders routes',
        author_name: 'fixture',
        files: files.map(([path]) => path),
        stats: { files_changed: files.length, insertions: 90, deletions: 0 },
      },
      { ...scope, offsetSeconds: 35 },
    );
    const codeEvents = [sessionStart, userQuestion, assistantAnswer, ...documentEvents, commitEvent];
    for (const input of codeEvents) {
      expect((await storage.store.ingestEvent(input.event)).status).toBe('stored');
    }

    const phase1 = await extraction({ id: 'extract-4g-phase1', kind: 'extract', payload: {} });
    expect(phase1.events_processed).toBe(codeEvents.length);
    expect(phase1.needs_review).toBe(0);
    // Extraction demonstrably worked on the REAL code text, not just the conversation: at least
    // one current episodic memory's evidence cites a `document.added` event from this batch (a
    // stack mention extracted from the auth-module text). So the zero-procedural result below is
    // a PROCEDURAL gap, not a broken pipeline.
    const episodic = await storage.store.queryCurrent({
      project_id: project.id,
      types: ['episodic'],
    });
    const documentEventIds = new Set(documentEvents.map((input) => input.event.id));
    const fromCodeText = episodic.filter((memory) =>
      memory.provenance.evidence.some((span) => {
        if (!span.locator.startsWith('event:')) return false;
        return documentEventIds.has(span.locator.slice('event:'.length));
      }));
    expect(episodic.length).toBeGreaterThanOrEqual(1);
    expect(fromCodeText.length).toBeGreaterThanOrEqual(1);
    expect(
      await storage.store.queryCurrent({ project_id: project.id, types: ['procedural'] }),
    ).toHaveLength(0);

    // --- phase 2: the real procedural input channels --------------------------------------
    const explicitEvent = makeInput(
      'explicit.remember',
      {
        kind: 'explicit.remember',
        content: AUTH_PROCEDURE,
        type: 'procedural',
        importance: 0.9,
        scope: 'project',
      },
      { ...scope, offsetSeconds: 40 },
    );
    const testRunOne = makeInput(
      'terminal.output',
      { kind: 'terminal.output', command: 'bun test src/auth/', exit_code: 0, output_digest: '3 pass (0.41s)' },
      { ...scope, offsetSeconds: 45 },
    );
    const testRunTwo = makeInput(
      'terminal.output',
      { kind: 'terminal.output', command: 'bun test src/auth/', exit_code: 0, output_digest: '3 pass (0.38s)' },
      { ...scope, offsetSeconds: 50 },
    );
    for (const input of [explicitEvent, testRunOne, testRunTwo]) {
      expect((await storage.store.ingestEvent(input.event)).status).toBe('stored');
    }

    const phase2 = await extraction({ id: 'extract-4g-phase2', kind: 'extract', payload: {} });
    expect(phase2.events_processed).toBe(3);
    const procedural = await storage.store.queryCurrent({
      project_id: project.id,
      types: ['procedural'],
    });
    expect(procedural).toHaveLength(2);

    const flow = procedural.find((memory) => memory.content === AUTH_PROCEDURE);
    const testCommand = procedural.find((memory) => memory.content === RECURRING_CONTENT);
    expect(flow?.subtype).toBe('procedural.sequence');
    expect(testCommand?.subtype).toBe('procedural.command');
    if (!flow || !testCommand) {
      throw new Error('the real extractor did not produce the auth-flow and test-command procedures');
    }
    // Full provenance, evidence citing the exact events each procedure was derived from.
    expect(flow.provenance.source.kind).toBe('explicit');
    expect(flow.provenance.extraction.method).toBe('heuristic');
    expect(flow.provenance.evidence.map((span) => span.locator)).toEqual([
      `event:${explicitEvent.event.id}`,
    ]);
    expect(testCommand.provenance.extraction.method).toBe('heuristic');
    expect(testCommand.provenance.evidence.map((span) => span.locator)).toEqual([
      `event:${testRunOne.event.id}`,
      `event:${testRunTwo.event.id}`,
    ]);

    // --- phase 3: code refs against the real fixture repository ---------------------------
    const snapshot = await captureSnapshot(repoRoot);
    const repository = await storage.codeMemory.ensureRepository({
      project_id: project.id,
      root_path: snapshot.root_path,
    });
    await storage.codeMemory.saveSnapshot(repository.id, snapshot);
    // The real symbol-table path, in the pipeline's own order (snapshot FIRST, then symbols —
    // saveSymbolTable anchors on the live worktree fingerprints the capture just wrote): the
    // real tree-sitter extraction over the fixture repo's real files. The auth module's three
    // files carry exactly their real symbols; the auth test file legitimately declares none
    // (describe/test are calls, not declarations — the file is still covered, with an empty
    // table); package.json is outside the symbol domain by design.
    const symbolTable = await extractSymbolTable(repoRoot);
    await storage.codeMemory.saveSymbolTable(repository.id, { files: symbolTable.files });
    const symbolsOf = (path: string): string[] => {
      const file = symbolTable.files.find((entry) => entry.path === path);
      if (!file) throw new Error(`the fixture symbol table does not cover ${path}`);
      return file.symbols.map((entry) => entry.name);
    };
    expect(symbolsOf('src/auth/login.ts')).toEqual(['Credentials', 'verifyCredentials']);
    expect(symbolsOf('src/auth/session.ts')).toEqual(['createSession']);
    expect(symbolsOf('src/auth/middleware.ts')).toEqual(['requireAuth']);
    expect(symbolsOf(COMMAND_PATH)).toEqual([]);
    const blobOf = (path: string): string => {
      const file = snapshot.files.find((entry) => entry.tier === 'worktree' && entry.path === path);
      if (!file) throw new Error(`the fixture snapshot has no worktree fingerprint for ${path}`);
      return file.blob_sha;
    };
    await storage.codeMemory.recordCodeRefs({
      memory_id: flow.id,
      repository_id: repository.id,
      refs: FLOW_PATHS.map((path) => ({ path, blob_sha: blobOf(path) })),
    });
    await storage.codeMemory.recordCodeRefs({
      memory_id: testCommand.id,
      repository_id: repository.id,
      refs: [{ path: COMMAND_PATH, blob_sha: blobOf(COMMAND_PATH) }],
    });
    const recordedRefs = await storage.codeMemory.listCodeRefs(repository.id);
    expect(recordedRefs.filter((ref) => ref.memory_id === flow.id).map((ref) => ref.path).sort())
      .toEqual([...FLOW_PATHS].sort());
    expect(recordedRefs.filter((ref) => ref.memory_id === testCommand.id).map((ref) => ref.path))
      .toEqual([COMMAND_PATH]);

    // --- phase 4: the DoD query through the real retrieval engine --------------------------
    const engine = createRetrievalEngine(storage, {
      now: () => new Date('2026-10-03T09:05:00.000Z'),
    });
    for (const [index, query] of QUERIES.entries()) {
      const response = await engine.search({
        query,
        project_id: project.id,
        explain: true,
      });
      // "how does" / "procedure for" / "how can" all route to the how_to intent.
      expect(response.query_understanding.intent).toBe('how_to');

      const top = response.memories[0];
      expect(top?.id).toBe(flow.id);
      expect(top?.type).toBe('procedural');
      expect(top?.content?.startsWith('Authentication procedure:')).toBe(true);
      expect(top?.provenance.source_kind).toBe('explicit');
      if (top === undefined) throw new Error('the DoD query returned no memories');

      // The intent×type affinity boost is visible in explain.
      const affinity = top.explain.find((entry) => entry.factor === 'type_affinity');
      expect(affinity?.detail).toBe("intent 'how_to' favors type 'procedural'");

      // Default token budget (no max_tokens in the request), never exceeded.
      expect(response.tokens.budget).toBe(engine.config.packing.defaultMaxTokens);
      expect(response.tokens.used).toBeLessThanOrEqual(response.tokens.budget);

      // THE DOD's "with code refs" HALF, asserted over the ACTUAL search result (M4g2 closed
      // finding F5): the retrieval response now exposes the persisted code refs — every
      // returned item carries the field, and the top procedure's three refs arrive complete.
      // The wire schema validated them (`MemorySearchResponseSchema` — the engine parses its
      // responses through it), and the values are checked against the real fixture below.
      expect(Object.keys(top).some((key) => /code_?ref/i.test(key))).toBe(true);
      expect(response.memories.every((memory) => Array.isArray(memory.codeRefs))).toBe(true);
      const flowRefs = top.codeRefs;
      expect(flowRefs.map((ref) => ref.repoId)).toEqual(
        flowRefs.map(() => repository.id),
      );
      expect(flowRefs.map((ref) => ref.path).sort()).toEqual([...FLOW_PATHS].sort());
      for (const ref of flowRefs) {
        // The capture's HEAD: the commit under which the cited worktree blob was last observed.
        expect(ref.commitSha).toBe(head);
        // The evidence blob the procedure rests on — the real captured worktree blob.
        expect(ref.evidence).toBe(blobOf(ref.path));
      }
      // Symbol attribution: the procedure's own content names verifyCredentials, createSession,
      // and requireAuth — exactly the cited files' content-named symbols (word-boundary,
      // document order; the `Credentials` interface, a substring of `verifyCredentials`, never
      // matches as a whole word). Never fabricated.
      const symbolByPath = new Map(flowRefs.map((ref) => [ref.path, ref.symbol]));
      expect(symbolByPath.get('src/auth/login.ts')).toBe('verifyCredentials');
      expect(symbolByPath.get('src/auth/session.ts')).toBe('createSession');
      expect(symbolByPath.get('src/auth/middleware.ts')).toBe('requireAuth');
      // The serialized response now carries each cited path's real captured blob — the consumer
      // of this query receives the cited files WITH the answer (the whole point of the DoD).
      for (const path of FLOW_PATHS) {
        expect(JSON.stringify(response)).toContain(blobOf(path));
      }

      // STORAGE-LEVEL CROSS-CHECK: the surfaced refs equal the persisted `listCodeRefs` rows —
      // same paths, same evidence blobs — so the response's refs are the persisted ones, not a
      // parallel construction.
      const topRefs = recordedRefs.filter((ref) => ref.memory_id === flow.id);
      expect(topRefs.map((ref) => ref.path).sort()).toEqual(flowRefs.map((ref) => ref.path).sort());
      for (const ref of topRefs) {
        expect(ref.blob_sha).toBe(blobOf(ref.path));
        expect(flowRefs.some((entry) => entry.path === ref.path && entry.evidence === ref.blob_sha))
          .toBe(true);
      }
      // The recurring-command procedure, when the query returns it, surfaces its own ref with
      // NO symbol — its content names no symbol (the honest negative case, never fabricated).
      const command = response.memories.find((memory) => memory.id === testCommand.id);
      if (command !== undefined) {
        expect(command.codeRefs.map((ref) => ref.path)).toEqual([COMMAND_PATH]);
        expect(command.codeRefs[0]?.symbol).toBeUndefined();
        expect(command.codeRefs[0]?.evidence).toBe(blobOf(COMMAND_PATH));
      }

      // The zero-network default profile honestly reports the vector channel is off.
      if (index === 0) {
        expect(response.warnings.some((warning) => warning.includes('vector channel unavailable')))
          .toBe(true);
      }
    }
  } finally {
    await storage?.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
    guard.restore();
  }
}, 60_000);
