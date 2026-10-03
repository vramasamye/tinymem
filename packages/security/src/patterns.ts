/**
 * The secret-detection pattern catalog (ADR-0007 §1: detect-and-redact at the earliest
 * boundary). One group per credential family; every group can be switched off, and users can
 * add extra regex patterns on top.
 *
 * Direction of error is deliberate (ADR-0007 Consequences): prose that merely *looks* like a
 * token gets redacted. A lost sentence costs nothing; a stored credential is a liability.
 *
 * Regex conventions:
 * - Every pattern is compiled with `g` (scan) + `d` (capture-group spans via `match.indices`).
 * - Patterns match the ENTIRE secret by default; `valueGroup` narrows the redacted span to one
 *   capture group (e.g. only the token after the word `Bearer`).
 * - `nameGroup` + `keywords` gate a match on the captured *name* (e.g. `.env` assignments must
 *   mention key/secret/token/…) before the value is redacted.
 * - Left boundaries are lookbehinds (`(?<!…)`), never consumed prefixes, so the character
 *   before a secret (an `=`, `(`, quote, …) survives into the marked string.
 */

import { z } from 'zod';
import { REDACTION_KINDS } from '@onememory/core';
import type { RedactionKind } from '@onememory/core';

/** A pattern group's `kind` is fixed, or derived from the matched assignment name. */
export type KindSource = RedactionKind | ((name: string) => RedactionKind);

export type PatternGroupId =
  | 'private-key'
  | 'connection-string'
  | 'anthropic-key'
  | 'openai-key'
  | 'github-token'
  | 'aws-access-key'
  | 'google-api-key'
  | 'slack-token'
  | 'jwt'
  | 'bearer-token'
  | 'basic-auth'
  | 'session-cookie'
  | 'password-assignment'
  | 'env-assignment';

/** Order = priority for overlapping matches (lower wins after start + length). */
export const PATTERN_GROUP_IDS: readonly PatternGroupId[] = [
  'private-key',
  'connection-string',
  'anthropic-key',
  'openai-key',
  'github-token',
  'aws-access-key',
  'google-api-key',
  'slack-token',
  'jwt',
  'bearer-token',
  'basic-auth',
  'session-cookie',
  'password-assignment',
  'env-assignment',
];

export interface SecretPattern {
  /** Global regex over the scanned string. `d` (hasIndices) is required when valueGroup is set. */
  readonly regex: RegExp;
  /** Redact only this capture group's span instead of the whole match. */
  readonly valueGroup?: number;
  /** Gate the match on this captured name containing one of `keywords` (lowercased). */
  readonly nameGroup?: number;
  /** Lowercased substrings the `nameGroup` capture must contain (when present). */
  readonly keywords?: readonly string[];
}

export interface PatternGroup {
  readonly id: PatternGroupId;
  readonly description: string;
  readonly kind: KindSource;
  /** Every kind this group can emit (for the doctor/coverage table). */
  readonly kinds: readonly RedactionKind[];
  readonly patterns: readonly SecretPattern[];
}

/** Kind of a `.env`-style assignment, derived from its variable name. */
function classifyAssignmentKind(name: string): RedactionKind {
  const n = name.toLowerCase();
  if (n.includes('key')) return 'api-key';
  if (n.includes('token')) return 'token';
  return 'password';
}

const ASSIGNMENT_KEYWORDS: readonly string[] = [
  'key',
  'secret',
  'token',
  'password',
  'passwd',
  'pwd',
  'credential',
  'passphrase',
];

/** Quoted-or-bare assignment value, capped to bound pathological input. */
const ASSIGN_VALUE = `("[^"\\n]{0,400}"|'[^'\\n]{0,400}'|[^\\s"'\\n\`;&]{1,400})`;

export const PATTERN_GROUPS: readonly PatternGroup[] = [
  {
    id: 'private-key',
    description: 'PEM private key blocks (RSA / EC / OPENSSH / PKCS#8 / encrypted), full block',
    kind: 'private-key',
    kinds: ['private-key'],
    patterns: [
      // Complete block: BEGIN header … body … END footer.
      {
        regex: new RegExp(
          '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]{0,20000}?-----END [A-Z0-9 ]*PRIVATE KEY-----',
          'gd',
        ),
      },
      // Truncated block (digest cut the END footer off): BEGIN header + base64 body.
      // Overlap resolution keeps the longer full-block match when both fire.
      {
        regex: new RegExp('-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\\s+[A-Za-z0-9+/=\\s]{16,}', 'gd'),
      },
    ],
  },
  {
    id: 'connection-string',
    description: 'URI connection strings with embedded credentials (postgres://user:pass@…, mysql://…)',
    kind: 'connection-string',
    kinds: ['connection-string'],
    patterns: [
      {
        regex: new RegExp(
          '(?<![A-Za-z0-9])' +
            '(?:postgres(?:ql)?|mariadb|mongodb(?:\\+srv)?|mysql|rediss?|amqps?|ftps?|sftp|smtps?|imaps?|pops?|ldaps?|https?|wss?)' +
            ':\\/\\/[^\\s"\'<>@/]+:[^\\s"\'<>@/]+@[^\\s"\'<>]*',
          'gdi',
        ),
      },
    ],
  },
  {
    id: 'anthropic-key',
    description: 'Anthropic API keys (sk-ant-…)',
    kind: 'api-key',
    kinds: ['api-key'],
    patterns: [
      { regex: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/gd },
    ],
  },
  {
    id: 'openai-key',
    description: 'OpenAI API keys (sk-…, sk-proj-…; sk-ant- belongs to the anthropic group)',
    kind: 'api-key',
    kinds: ['api-key'],
    patterns: [
      { regex: /(?<![A-Za-z0-9_-])sk-(?!ant-)[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/gd },
    ],
  },
  {
    id: 'github-token',
    description: 'GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_ and github_pat_)',
    kind: 'token',
    kinds: ['token'],
    patterns: [
      { regex: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,}(?![A-Za-z0-9])/gd },
      { regex: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}(?![A-Za-z0-9_])/gd },
    ],
  },
  {
    id: 'aws-access-key',
    description: 'AWS access key IDs (AKIA…)',
    kind: 'api-key',
    kinds: ['api-key'],
    patterns: [{ regex: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/gd }],
  },
  {
    id: 'google-api-key',
    description: 'Google API keys (AIza…)',
    kind: 'api-key',
    kinds: ['api-key'],
    patterns: [{ regex: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/gd }],
  },
  {
    id: 'slack-token',
    description: 'Slack tokens (xoxb-/xoxp-/… and xapp-)',
    kind: 'token',
    kinds: ['token'],
    patterns: [
      { regex: /(?<![A-Za-z0-9-])(?:xox[a-z]|xapp)-[0-9A-Za-z-]{10,}(?![0-9A-Za-z-])/gd },
    ],
  },
  {
    id: 'jwt',
    description: 'JSON Web Tokens (three or more dot-separated base64url segments starting eyJ…)',
    kind: 'token',
    kinds: ['token'],
    patterns: [
      {
        // Greedy over the dot-separated segments so a trailing sentence period is NOT consumed
        // but additional segments ARE (never leave a partial signature behind).
        regex: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){2,}(?![A-Za-z0-9_-])/gd,
      },
    ],
  },
  {
    id: 'bearer-token',
    description: 'Generic bearer/token header values ("Bearer <value>", "Token <value>")',
    kind: 'token',
    kinds: ['token'],
    patterns: [
      { regex: /(?:[Bb]earer|[Tt]oken)\s+([A-Za-z0-9._~+/=-]{16,})/gd, valueGroup: 1 },
    ],
  },
  {
    id: 'basic-auth',
    description: 'HTTP Basic authorization credentials ("Basic <base64 user:pass>")',
    kind: 'password',
    kinds: ['password'],
    patterns: [{ regex: /(?:[Bb]asic)\s+([A-Za-z0-9+/=]{16,})/gd, valueGroup: 1 }],
  },
  {
    id: 'session-cookie',
    description: 'Session cookies and session identifiers (sessionid, PHPSESSID, connect.sid, …)',
    kind: 'token',
    kinds: ['token'],
    patterns: [
      {
        regex: new RegExp(
          '(?<![A-Za-z0-9_-])' +
            '((?:jsessionid|phpsessid|asp\\.net_sessionid|session[-_]?token|session(?:[-_]?id)?|connect\\.sid|sid|auth[-_]?token|remember[-_]?(?:me|token)))' +
            '\\s*=\\s*([A-Za-z0-9._~+/%=-]{8,})',
          'gdi',
        ),
        nameGroup: 1,
        valueGroup: 2,
      },
    ],
  },
  {
    id: 'password-assignment',
    description: 'password/passwd/pwd values in URLs, command lines, and prose assignments',
    kind: 'password',
    kinds: ['password'],
    patterns: [
      // password=… / PASSWORD: … (the flag prefix `-` is allowed as the preceding char: --password=…)
      {
        regex: new RegExp(`(?<![A-Za-z0-9_])(?:password|passwd|pwd)\\s*[=:]\\s*${ASSIGN_VALUE}`, 'gdi'),
        valueGroup: 1,
      },
      // space-separated CLI flag: --password hunter2 / --password 'hunter2'
      // (preceded by string start, whitespace, or a quote)
      {
        regex: new RegExp(`(?<![^\\s"'\\x60])--(?:password|passwd|pwd)\\s*[= ]\\s*${ASSIGN_VALUE}`, 'gdi'),
        valueGroup: 1,
      },
    ],
  },
  {
    id: 'env-assignment',
    description:
      '.env-style assignments whose variable name mentions key/secret/token/… (API_KEY=…, SECRET=…, GITHUB_TOKEN=…, x-api-key: …)',
    kind: classifyAssignmentKind,
    kinds: ['api-key', 'token', 'password'],
    patterns: [
      {
        regex: new RegExp(`(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]{0,60})\\s*[=:]\\s*${ASSIGN_VALUE}`, 'gd'),
        nameGroup: 1,
        keywords: ASSIGNMENT_KEYWORDS,
        valueGroup: 2,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Configuration (validated at the boundary — a typo'd group id must fail loudly, never
// silently leave a pattern on)
// ---------------------------------------------------------------------------

/**
 * A user-supplied extra regex. The WHOLE match is redacted (no capture-group semantics) and
 * must not match the empty string (guards the scanner against pathological patterns).
 */
export const ExtraPatternSchema = z
  .strictObject({
    id: z.string().min(1).max(64),
    kind: z.enum(REDACTION_KINDS),
    pattern: z.string().min(1).max(1000),
    flags: z.string().regex(/^[imsuv]*$/).optional(),
  })
  .refine(
    (value) => {
      let compiled: RegExp;
      try {
        compiled = new RegExp(value.pattern, 'gd' + (value.flags ?? ''));
      } catch {
        return false;
      }
      compiled.lastIndex = 0;
      return !compiled.test('');
    },
    { message: 'extra pattern must compile and must not match the empty string' },
  );
export type ExtraPatternInput = z.input<typeof ExtraPatternSchema>;

export const RedactorConfigSchema = z.strictObject({
  /** Pattern groups on/off. Defaults: all on. Unknown ids are rejected (typo protection). */
  groups: z
    .record(z.string(), z.boolean())
    .refine(
      (groups) => Object.keys(groups).every((id) => (PATTERN_GROUP_IDS as readonly string[]).includes(id)),
      {
        message: `unknown pattern group id (known groups: ${PATTERN_GROUP_IDS.join(', ')})`,
      },
    )
    .optional(),
  /** User-supplied patterns appended after the built-in groups. */
  extraPatterns: z
    .array(ExtraPatternSchema)
    .max(100)
    .refine(
      (patterns) => new Set(patterns.map((pattern) => pattern.id)).size === patterns.length,
      { message: 'extra pattern ids must be unique' },
    )
    .optional(),
});
export type RedactorConfig = z.input<typeof RedactorConfigSchema>;

export interface ConfigIssue {
  path: string;
  message: string;
}

/** Raised when redactor configuration fails validation — issues carry path + message only. */
export class RedactorConfigError extends Error {
  readonly issues: readonly ConfigIssue[];
  constructor(message: string, issues: readonly ConfigIssue[] = []) {
    super(message);
    this.name = 'RedactorConfigError';
    this.issues = issues;
  }
}

/** An extra user-supplied pattern bound into a synthetic group. */
export interface ExtraPattern {
  readonly id: string;
  readonly kind: RedactionKind;
  readonly regex: RegExp;
}

/** The compiled, ready-to-scan detector: active groups in priority order, extras last. */
export interface Detector {
  readonly groups: readonly PatternGroup[];
  readonly extraPatterns: readonly ExtraPattern[];
}

/**
 * Compile a detector from `config` (Zod-validated first). All groups default on; disabled ones
 * are dropped. Extra patterns are compiled once per detector and re-used across calls.
 */
export function compileDetector(config?: RedactorConfig): Detector {
  const parsed = RedactorConfigSchema.safeParse(config ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || '(root)',
      message: issue.message,
    }));
    throw new RedactorConfigError('invalid redactor configuration', issues);
  }

  const disabled = new Set(
    Object.entries(parsed.data.groups ?? {})
      .filter(([, enabled]) => !enabled)
      .map(([id]) => id as PatternGroupId),
  );
  const groups = PATTERN_GROUPS.filter((group) => !disabled.has(group.id));

  const extraPatterns: ExtraPattern[] = (parsed.data.extraPatterns ?? []).map((extra) => ({
    id: extra.id,
    kind: extra.kind,
    regex: new RegExp(extra.pattern, 'gd' + (extra.flags ?? '')),
  }));

  return { groups, extraPatterns };
}
