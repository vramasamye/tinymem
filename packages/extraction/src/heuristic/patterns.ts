/**
 * Heuristic language patterns for the no-LLM extractor (memory-model.md §8 stage 4, the
 * "fully-local no-LLM mode" clause of event-memory-schemas.md §3): explicit preference/decision
 * language, error+resolution pairs, recurring commands, stack names, versioned facts.
 *
 * Everything here is deterministic and dependency-free. Patterns are intentionally narrow: a
 * missed candidate costs recall (the LLM extractor covers that when configured), while a false
 * positive pollutes durable memory (risk R6).
 */

/** Canonical tech names → aliases that identify them in prose. */
const TECH_ALIASES: Record<string, string[]> = {
  PostgreSQL: ['postgres', 'postgresql', 'psql', 'pglite'],
  pgvector: ['pgvector'],
  SQLite: ['sqlite', 'sqlite-vec'],
  MySQL: ['mysql', 'mariadb'],
  Redis: ['redis'],
  Docker: ['docker', 'dockerfile', 'compose'],
  Kubernetes: ['kubernetes', 'k8s', 'helm'],
  Node: ['node', 'nodejs', 'node.js'],
  Bun: ['bun'],
  Deno: ['deno'],
  TypeScript: ['typescript', 'tsc'],
  JavaScript: ['javascript'],
  Python: ['python', 'pytest'],
  Go: ['golang'],
  Rust: ['rust', 'cargo'],
  React: ['react', 'reactjs'],
  'Next.js': ['next.js', 'nextjs'],
  Vue: ['vue', 'vuejs'],
  Svelte: ['svelte', 'sveltekit'],
  Tailwind: ['tailwind', 'tailwindcss'],
  Vite: ['vite'],
  Vitest: ['vitest'],
  Jest: ['jest'],
  ESLint: ['eslint'],
  Biome: ['biome'],
  Drizzle: ['drizzle'],
  Prisma: ['prisma'],
  Kysely: ['kysely'],
  Hono: ['hono'],
  Fastify: ['fastify'],
  Express: ['express'],
  Zod: ['zod'],
  GraphQL: ['graphql'],
  tRPC: ['trpc'],
  REST: ['rest', 'openapi', 'swagger'],
  gRPC: ['grpc'],
  Kafka: ['kafka'],
  RabbitMQ: ['rabbitmq'],
  Temporal: ['temporal'],
  Terraform: ['terraform'],
  AWS: ['aws', 's3', 'lambda', 'ec2', 'cloudrun', 'cloud-run'],
  GCP: ['gcp', 'google-cloud', 'bigquery'],
  Azure: ['azure'],
  Ollama: ['ollama'],
  LMStudio: ['lm studio', 'lmstudio'],
  llama: ['llama.cpp', 'llamacpp'],
  vLLM: ['vllm'],
  pgBoss: ['pg-boss', 'pgboss'],
  TreeSitter: ['tree-sitter', 'treesitter'],
  WebAuthn: ['webauthn'],
  OAuth: ['oauth', 'oauth2'],
  JWT: ['jwt'],
};

const ALIAS_TO_TECH = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(TECH_ALIASES)) {
  ALIAS_TO_TECH.set(canonical.toLowerCase(), canonical);
  for (const alias of aliases) ALIAS_TO_TECH.set(alias, canonical);
}

/** Tech names mentioned in a text, canonicalized, ordered by first mention. */
export function extractTechMentions(text: string): string[] {
  const lower = text.toLowerCase();
  const positions = new Map<string, number>();
  for (const [alias, canonical] of ALIAS_TO_TECH) {
    // Word-ish boundary that tolerates punctuation inside names (`next.js`, `node.js`).
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias)}([^a-z0-9]|$)`, 'i');
    const match = pattern.exec(lower);
    if (!match) continue;
    const position = match.index + match[1]!.length;
    const existing = positions.get(canonical);
    if (existing === undefined || position < existing) positions.set(canonical, position);
  }
  return [...positions.entries()].sort((a, b) => a[1] - b[1]).map(([canonical]) => canonical);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface PatternMatch {
  /** The full match. */
  match: string;
  /** Capture groups (1-based order). */
  captures: string[];
}

/** First matching pattern from an ordered list (most specific first). */
export function firstMatch(text: string, patterns: readonly RegExp[]): PatternMatch | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return { match: match[0], captures: match.slice(1).filter((value) => value !== undefined) };
    }
  }
  return null;
}

/**
 * All matches of an ordered pattern list, up to `limit` (M3b uses it to collect several rejected
 * options around one decision). Patterns are re-compiled with the global flag; a zero-length match
 * cannot stall the loop.
 */
export function matchAll(
  text: string,
  patterns: readonly RegExp[],
  limit: number,
): PatternMatch[] {
  const found: PatternMatch[] = [];
  if (limit <= 0) return found;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const global = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = global.exec(text)) !== null) {
      found.push({ match: match[0], captures: match.slice(1).filter((value) => value !== undefined) });
      if (found.length >= limit) return found;
      if (match.index === global.lastIndex) global.lastIndex += 1;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Decision language
// ---------------------------------------------------------------------------

export const DECISION_PATTERNS: readonly RegExp[] = [
  /\b(?:we|i)\s+(?:have\s+)?decided\s+(?:to\s+)?([^.!?\n]{5,200})/i,
  /\b(?:we|i)\s+(?:chose|choose|picked|selected|went\s+with|going\s+with)\s+([^.!?\n]{2,120}?)\s+over\s+([^.!?\n]{2,120})/i,
  /\b(?:we|i)\s+(?:settled\s+on|settle\s+on)\s+([^.!?\n]{2,160})/i,
  /\blet'?s\s+(?:go\s+with|use)\s+([^.!?\n]{2,160})/i,
  /\bdecision:\s*([^.!?\n]{5,300})/i,
  /\bthe\s+decision\s+is\s+([^.!?\n]{5,200})/i,
];

/** Statements that look like decisions but are not (kept as noise). */
export const DECISION_NOISE_PATTERNS: readonly RegExp[] = [
  /\bdecided\s+(?:to\s+)?(?:skip|stop|wait|sleep|eat|take\s+a\s+break)\b/i,
];

// ---------------------------------------------------------------------------
// Decision enrichment (M3b): alternatives + rationale
// ---------------------------------------------------------------------------

/**
 * Connectives that introduce a rationale. One list, two uses: `DECISION_RATIONALE_SPLIT` cuts an
 * option phrase from its rationale when a `DECISION_PATTERNS` capture swallowed both
 * ("chose X over Y because Z" → capture 2 is "Y because Z"), and `DECISION_RATIONALE_PATTERNS`
 * finds the clause in the sentence that follows the decision.
 */
export const DECISION_RATIONALE_CONNECTIVES: readonly string[] = [
  'because',
  'since',
  'due\\s+to',
  'owing\\s+to',
  'given\\s+that',
  'so\\s+that',
];

const RATIONALE_CONNECTIVE_SOURCE = DECISION_RATIONALE_CONNECTIVES.join('|');

/** Splits a decision/option phrase from its rationale (`"X because Y"` → `"X"` + `"Y"`). */
export const DECISION_RATIONALE_SPLIT = new RegExp(
  `\\s+(?:${RATIONALE_CONNECTIVE_SOURCE})\\s+`,
  'i',
);

/**
 * Where a decision/option phrase ends and the next clause begins. Used to keep a capture from
 * swallowing a following clause ("chose X over Y, and we excluded Z because W") and to decide
 * whether a rationale still belongs to the decision's own clause.
 */
export const DECISION_CLAUSE_BREAK = /[,;]\s+(?:and|but|so|then|while|plus)\b|[,;]|—/i;

/**
 * Rationale clauses. Matched against the remainder of the sentence carrying the decision, so the
 * rationale is attributed to the decision it belongs to, never to an unrelated earlier "because".
 */
export const DECISION_RATIONALE_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\b(?:${RATIONALE_CONNECTIVE_SOURCE})\\s+([^.!?\\n]{3,200})`, 'i'),
];

/**
 * Options explicitly ruled out next to a decision ("we ruled out SQLite because …"). The optional
 * `because` clause becomes the alternative's `why_rejected` (the `decisions.alternatives` column
 * pair).
 */
export const DECISION_REJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:rejected|ruled\s+out|decided\s+against|dropped|excluded|avoided)\s+([^.!?\n]{2,120}?)(?:\s+because\s+([^.!?\n]{3,200}))?(?:[.!?\n]|$)/i,
];

/** Words that make an "option" a pronoun rather than a real alternative. */
export const DECISION_OPTION_NOISE: readonly string[] = [
  'it',
  'this',
  'that',
  'them',
  'those',
  'these',
  'both',
  'either',
  'neither',
  'nothing',
  'anything',
  'the other',
  'the alternative',
  'something else',
];

// ---------------------------------------------------------------------------
// Preference language
// ---------------------------------------------------------------------------

export const PREFERENCE_PATTERNS: readonly RegExp[] = [
  /\b(?:i|we)\s+prefer\s+([^.!?\n]{3,160})/i,
  /\bprefer\s+([^.!?\n]{2,120}?)\s+over\s+([^.!?\n]{2,120})/i,
  /\b(?:i|we)\s+always\s+([^.!?\n]{3,160})/i,
  /\b(?:i|we)\s+never\s+([^.!?\n]{3,160})/i,
  /\b(?:always|never)\s+(?:use|write|commit|push|run|name|prefer)\s+([^.!?\n]{2,160})/i,
  /\b(?:make\s+sure|be\s+sure|remember)\s+to\s+([^.!?\n]{3,160})/i,
  /\b(?:don'?t|do\s+not)\s+(?:ever\s+)?(?:use|commit|push|edit|touch|modify)\s+([^.!?\n]{2,160})/i,
];

/**
 * Preference-shaped statements with no future value ("I always forget…"). The future-value gate
 * discards these rather than storing noise.
 */
export const PREFERENCE_NOISE_PATTERNS: readonly RegExp[] = [
  /\b(?:always|never)\s+(?:forget|forgot|worry|worried|know|knew|think|thought|wanted|want|liked|like|seem|seemed|have|had|do|did)\b/i,
  /\bprefer\s+(?:to\s+)?(?:talk|discuss|think|say|hear)\b/i,
  /\b(?:make\s+sure|be\s+sure)\s+to\s+(?:have|be|do)\b/i,
];

// ---------------------------------------------------------------------------
// Versioned facts
// ---------------------------------------------------------------------------

export const VERSION_PATTERNS: readonly RegExp[] = [
  /\b(?:upgraded|downgraded|bumped|pinned|moved|switched)\s+(?:us\s+)?to\s+([A-Za-z][\w.+-]*(?:\s+v?\d[\w.+-]*)?)/i,
  /\b(?:now|currently)\s+(?:on|using|running)\s+([A-Za-z][\w.+-]*\s+v?\d[\w.+-]*)/i,
  /\b([A-Za-z][\w.+-]*)\s+(?:is\s+)?(?:now\s+)?(?:at|on)\s+v?(\d+\.\d+(?:\.\d+)?)\b/i,
];

/** Version mentions that are not durable facts about the project. */
export const VERSION_NOISE_PATTERNS: readonly RegExp[] = [
  /\bversion\s+\d+\s+of\s+the\s+docs?\b/i,
];

// ---------------------------------------------------------------------------
// Working-memory signals (session-scoped, not durable)
// ---------------------------------------------------------------------------

export const HYPOTHESIS_PATTERNS: readonly RegExp[] = [
  /\b(?:hypothesis|i\s+think\s+the\s+(?:issue|problem|cause)|maybe\s+the|my\s+guess\s+is)\b/i,
  /\blet\s+me\s+try\b/i,
];

export const TASK_PATTERNS: readonly RegExp[] = [
  /\b(?:next|now|then)\s+(?:i'?ll|we'?ll|let'?s)\s+([^.!?\n]{3,200})/i,
  /\b(?:todo|next\s+step):\s*([^.!?\n]{3,200})/i,
];

export const OPEN_QUESTION_PATTERNS: readonly RegExp[] = [
  /\b(?:should\s+we|how\s+do\s+we|why\s+(?:is|does)|what\s+if)\b[^.!?\n]{0,200}\?/i,
];

// ---------------------------------------------------------------------------
// Command repetition
// ---------------------------------------------------------------------------

/**
 * Commands that repeat for reasons unrelated to procedure: inspecting state, navigating, or
 * trivial output. Repetition of these is not a procedural memory.
 */
export const COMMAND_DENYLIST: readonly string[] = [
  'ls',
  'cd',
  'pwd',
  'cat',
  'echo',
  'which',
  'head',
  'tail',
  'open',
  'code',
  'clear',
  'export',
  'git status',
  'git diff',
  'git log',
  'git add',
  'git stash',
  'node -e',
];

export function isDeniedCommand(normalized: string): boolean {
  const value = normalized.trim().toLowerCase();
  if (value.length === 0) return true;
  return COMMAND_DENYLIST.some((denied) => value === denied || value.startsWith(`${denied} `));
}

// ---------------------------------------------------------------------------
// Success / failure signals
// ---------------------------------------------------------------------------

/** Significant tokens used to decide whether a success is "related" to an error. */
export function significantTokens(text: string): Set<string> {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'not', 'but', 'was', 'were', 'are',
    'is', 'it', 'in', 'on', 'to', 'of', 'a', 'an', 'error', 'failed', 'failure', 'command',
  ]);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_.\-/]+/)
    .filter((token) => token.length >= 3 && !stop.has(token));
  return new Set(tokens);
}

export function tokensOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) {
    if (b.has(token)) return true;
  }
  return false;
}

/** The executable token of a normalized command (`bun test` → `bun`). */
export function executableOf(normalizedCommand: string): string {
  return normalizedCommand.trim().split(/\s+/)[0] ?? '';
}

/** The sentence containing a match, for working-memory notes (bounded, whitespace-collapsed). */
export function sentenceAround(text: string, index: number, length: number, max = 300): string {
  const before = text.slice(0, index);
  const start = Math.max(
    before.lastIndexOf('.'),
    before.lastIndexOf('!'),
    before.lastIndexOf('?'),
    before.lastIndexOf('\n'),
  ) + 1;
  const after = text.slice(index + length);
  const ends = [after.indexOf('.'), after.indexOf('!'), after.indexOf('?'), after.indexOf('\n')]
    .filter((value) => value >= 0);
  const end = index + length + (ends.length > 0 ? Math.min(...ends) + 1 : after.length);
  const sentence = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return sentence.length > max ? sentence.slice(0, max) : sentence;
}
