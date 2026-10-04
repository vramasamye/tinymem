/**
 * Pattern coverage + redaction engine tests. Every fixture secret is SYNTHETIC (prefix + a
 * repeated character) — never a real credential.
 */

import { describe, expect, test } from 'bun:test';

import {
  PATTERN_GROUPS,
  PATTERN_GROUP_IDS,
  RedactorConfigError,
  createRedactor,
  isRedactionMarker,
  redactValue,
  redactionMarker,
} from './index';

const A = (n: number, char = 'a'): string => char.repeat(n);

interface Row {
  readonly group: string;
  readonly kind: 'api-key' | 'password' | 'token' | 'private-key' | 'connection-string';
  readonly secret: string;
  readonly text: string;
  readonly length: number;
}

/** The coverage table: group -> synthetic example -> detected with kind + exact length. */
const COVERAGE: readonly Row[] = [
  { group: 'openai-key', kind: 'api-key', secret: `sk-${A(40)}`, text: `call with sk-${A(40)} please`, length: 43 },
  { group: 'anthropic-key', kind: 'api-key', secret: `sk-ant-${A(40, 'b')}`, text: `key sk-ant-${A(40, 'b')} ok`, length: 47 },
  { group: 'github-token', kind: 'token', secret: `ghp_${A(36)}`, text: `ghp_${A(36)} in output`, length: 40 },
  { group: 'github-token', kind: 'token', secret: `github_pat_${A(40, 'A')}`, text: `github_pat_${A(40, 'A')}`, length: 51 },
  { group: 'aws-access-key', kind: 'api-key', secret: `AKIA${A(16, 'B')}`, text: `export AWS_KEY=AKIA${A(16, 'B')} now`, length: 20 },
  { group: 'google-api-key', kind: 'api-key', secret: `AIza${A(35, 'c')}`, text: `AIza${A(35, 'c')}`, length: 39 },
  { group: 'slack-token', kind: 'token', secret: `xoxb-${A(24, 'd')}-${A(24, 'e')}`, text: `slack: xoxb-${A(24, 'd')}-${A(24, 'e')}`, length: 54 },
  { group: 'bearer-token', kind: 'token', secret: A(32, 'f'), text: `Authorization: Bearer ${A(32, 'f')}`, length: 32 },
  {
    group: 'basic-auth',
    kind: 'password',
    secret: Buffer.from('user:password123').toString('base64'),
    text: `Authorization: Basic ${Buffer.from('user:password123').toString('base64')}`,
    length: Buffer.from('user:password123').toString('base64').length,
  },
  { group: 'jwt', kind: 'token', secret: `eyJ${A(20, 'g')}.${A(20, 'h')}.${A(20, 'i')}`, text: `token here: eyJ${A(20, 'g')}.${A(20, 'h')}.${A(20, 'i')}. done`, length: 65 },
  {
    group: 'private-key',
    kind: 'private-key',
    secret: `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${A(100, 'A')}\n-----END RSA PRIVATE KEY-----`,
    text: `signing key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow${A(100, 'A')}\n-----END RSA PRIVATE KEY-----\nthanks`,
    length: `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${A(100, 'A')}\n-----END RSA PRIVATE KEY-----`.length,
  },
  {
    group: 'private-key',
    kind: 'private-key',
    secret: `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk${A(40, 'A')}`,
    text: `truncated digest: -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk${A(40, 'A')}`,
    length: `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk${A(40, 'A')}`.length,
  },
  {
    group: 'connection-string',
    kind: 'connection-string',
    secret: 'postgres://admin:secretpw@db.internal:5432/app',
    text: 'DATABASE_URL=postgres://admin:secretpw@db.internal:5432/app',
    length: 'postgres://admin:secretpw@db.internal:5432/app'.length,
  },
  { group: 'password-assignment', kind: 'password', secret: 'hunter2', text: 'curl "https://api.io/login?password=hunter2&other=1"', length: 7 },
  { group: 'password-assignment', kind: 'password', secret: 'hunter2', text: 'psql --password hunter2 --host x', length: 7 },
  { group: 'password-assignment', kind: 'password', secret: 'hunter2', text: 'PASSWORD: hunter2', length: 7 },
  { group: 'env-assignment', kind: 'api-key', secret: 'abc123def456ghi789', text: 'API_KEY=abc123def456ghi789', length: 18 },
  { group: 'env-assignment', kind: 'token', secret: `ghp_${A(36)}`, text: `GITHUB_TOKEN="ghp_${A(36)}"`, length: 42 },
  { group: 'env-assignment', kind: 'password', secret: 't0ps3cretval', text: 'export SUPER_SECRET=t0ps3cretval', length: 12 },
  { group: 'session-cookie', kind: 'token', secret: A(24, 's'), text: `Cookie: sessionid=${A(24, 's')}; theme=dark`, length: 24 },
  { group: 'session-cookie', kind: 'token', secret: `s%3A${A(24, 'u')}`, text: `connect.sid=s%3A${A(24, 'u')}`, length: 28 },
  { group: 'session-cookie', kind: 'token', secret: A(24, 'p'), text: `PHPSESSID=${A(24, 'p')}`, length: 24 },
];

describe('pattern coverage table', () => {
  for (const row of COVERAGE) {
    test(`${row.group} detects ${row.kind} (len ${row.length})`, () => {
      const { value, redactions } = redactValue(row.text);

      expect(value).toBeString();
      expect(value as string).not.toContain(row.secret);
      expect(value as string).toContain(redactionMarker(row.kind));
      expect(redactions.length).toBe(1);

      const record = redactions[0]!;
      expect(record.kind).toBe(row.kind);
      expect(record.location).toBe('$');
      expect(record.length).toBe(row.length);
      // §7 redaction invariant: the record serializes without the secret.
      expect(JSON.stringify(redactions)).not.toContain(row.secret);
    });
  }

  test('every pattern group id has at least one covered fixture', () => {
    const covered = new Set(COVERAGE.map((row) => row.group));
    for (const id of PATTERN_GROUP_IDS) {
      expect(covered.has(id)).toBe(true);
    }
  });

  test('PATTERN_GROUPS metadata matches the catalog (ids unique, kinds declared)', () => {
    expect(PATTERN_GROUPS.length).toBe(PATTERN_GROUP_IDS.length);
    expect(new Set(PATTERN_GROUPS.map((group) => group.id)).size).toBe(PATTERN_GROUPS.length);
    for (const group of PATTERN_GROUPS) {
      expect(PATTERN_GROUP_IDS).toContain(group.id);
      expect(group.patterns.length).toBeGreaterThan(0);
    }
  });
});

describe('embedded secret contexts', () => {
  test('provider credentials embedded after tool-name separators are redacted', () => {
    const cases = [
      {
        text: `Read_sk-ant-${A(40, 'b')}`,
        expected: 'Read_[REDACTED:api-key]',
      },
      {
        text: `mcp__srv__sk-${A(40)}`,
        expected: 'mcp__srv__[REDACTED:api-key]',
      },
      {
        text: `x-sk-ant-${A(40, 'b')}`,
        expected: 'x-[REDACTED:api-key]',
      },
      {
        text: `mcp__srv__ghp_${A(36)}`,
        expected: 'mcp__srv__[REDACTED:token]',
      },
    ];

    for (const { text, expected } of cases) {
      const { value, redactions } = redactValue(text);
      expect(value).toBe(expected);
      expect(redactions).toHaveLength(1);

      const repeated = redactValue(value);
      expect(repeated.value).toBe(expected);
      expect(repeated.redactions).toHaveLength(0);
    }
  });

  test('secret inside a URL inside a terminal output digest', () => {
    const secret = `sk-${A(48)}`;
    const input = {
      kind: 'terminal.output',
      command: 'curl -s https://api.openai.com/v1/models | head -5',
      output_digest: `curl -s https://api.openai.com/v1/models?key=${secret} | head -5`,
    };
    const { value, redactions } = redactValue(input);

    const payload = value as typeof input;
    expect(payload.output_digest).not.toContain(secret);
    expect(payload.output_digest).toContain('[REDACTED:api-key]');
    expect(payload.command).not.toContain('[REDACTED'); // clean strings untouched
    expect(redactions).toEqual([{ kind: 'api-key', location: '$.output_digest', length: secret.length }]);
  });

  test('multiline .env payload: every credential assignment redacted, comments preserved', () => {
    const envFile = [
      '# local development',
      'NODE_ENV=development',
      'API_KEY=abcdef0123456789abcdef',
      'GITHUB_TOKEN=gho_' + A(36, 'a'),
      'DATABASE_PASSWORD=p4ssw0rd-here',
      'PORT=3000',
    ].join('\n');

    const { value, redactions } = redactValue(envFile);
    const lines = (value as string).split('\n');

    expect(lines[0]).toBe('# local development');
    expect(lines[1]).toBe('NODE_ENV=development'); // no credential keyword: untouched
    expect(lines[2]).toBe('API_KEY=[REDACTED:api-key]');
    expect(lines[3]).toBe('GITHUB_TOKEN=[REDACTED:token]');
    expect(lines[4]).toBe('DATABASE_PASSWORD=[REDACTED:password]');
    expect(lines[5]).toBe('PORT=3000');
    expect(redactions.length).toBe(3);
  });

  test('header form with hyphens (x-api-key: value)', () => {
    const { value, redactions } = redactValue('x-api-key: abcdef0123456789abcdef012345');
    expect(value).toBe('x-api-key: [REDACTED:api-key]');
    expect(redactions.length).toBe(1);
  });
});

describe('overlapping matches: longest/most-specific wins, counted once', () => {
  test('a JWT used as a bearer value yields exactly one redaction', () => {
    const jwt = `eyJ${A(16, 'j')}.${A(16, 'k')}.${A(16, 'l')}`;
    const { value, redactions } = redactValue(`Bearer ${jwt}`);

    expect(value).toBe('Bearer [REDACTED:token]');
    expect(redactions.length).toBe(1);
    expect(redactions[0]!.length).toBe(jwt.length);
  });

  test('password inside a connection string: the whole string wins as one redaction', () => {
    const url = 'postgres://admin:secretpw@db.internal:5432/app';
    const { value, redactions } = redactValue(`run psql with ${url} and go`);

    expect(value).toBe('run psql with [REDACTED:connection-string] and go');
    expect(redactions).toEqual([{ kind: 'connection-string', location: '$', length: url.length }]);
  });

  test('provider key as an env value: provider group wins the tie, one record', () => {
    const secret = `sk-ant-${A(40, 'b')}`;
    const { value, redactions } = redactValue(`ANTHROPIC_API_KEY=${secret}`);

    expect(value).toBe('ANTHROPIC_API_KEY=[REDACTED:api-key]');
    expect(redactions.length).toBe(1);
    expect(redactions[0]).toEqual({ kind: 'api-key', location: '$', length: secret.length });
  });

  test('distinct secrets in one string: each redacted, one record per secret, same location', () => {
    const openai = `sk-${A(40)}`;
    const aws = `AKIA${A(16, 'B')}`;
    const { value, redactions } = redactValue(`keys: ${openai} and ${aws} end`);

    expect(value).toBe('keys: [REDACTED:api-key] and [REDACTED:api-key] end');
    expect(redactions.length).toBe(2);
    expect(redactions[0]!.location).toBe('$');
    expect(redactions[1]!.location).toBe('$');
    expect(new Set(redactions.map((record) => record.length))).toEqual(new Set([openai.length, aws.length]));
  });
});

describe('deep walk', () => {
  test('nested objects, arrays, and path escapes', () => {
    const secret = `sk-${A(40)}`;
    const input = {
      payload: {
        content: 'clean',
        digests: [{ cmd: `use ${secret}` }],
        'weird key!': { deep: `also ${secret}` },
      },
    };

    const { value, redactions } = redactValue(input);
    const out = value as typeof input;

    expect(out.payload.content).toBe('clean');
    expect(out.payload.digests[0]!.cmd).toBe(`use [REDACTED:api-key]`);
    expect(out.payload['weird key!']!.deep).toBe('also [REDACTED:api-key]');

    const locations = redactions.map((record) => record.location);
    expect(locations).toContain('$.payload.digests[0].cmd');
    expect(locations).toContain('$.payload["weird key!"].deep');
  });

  test('non-string leaves and exotic objects pass through untouched; primitives root fine', () => {
    const date = new Date('2026-10-03T00:00:00.000Z');
    const input = { n: 42, b: true, nil: null, nested: { arr: [1, 2], date } };
    const { value, redactions } = redactValue(input);

    expect(value).toEqual(input);
    expect((value as typeof input).nested.date).toBe(date);
    expect(redactions).toEqual([]);
  });

  test('the input object is never mutated (deep copy on JSON-shaped values)', () => {
    const secret = `ghp_${A(36)}`;
    const input = { content: `token ${secret}` };
    const { value } = redactValue(input);

    expect(input.content).toBe(`token ${secret}`);
    expect((value as { content: string }).content).toBe('token [REDACTED:token]');
    expect(value).not.toBe(input);
  });
});

describe('idempotency', () => {
  test('a second pass records nothing and changes nothing', () => {
    const first = redactValue(`use sk-${A(40)} and PASSWORD: hunter2 now`);
    expect(first.redactions.length).toBe(2);

    const second = redactValue(first.value);
    expect(second.redactions).toEqual([]);
    expect(second.value).toBe(first.value);
  });

  test('marker helpers', () => {
    expect(redactionMarker('password')).toBe('[REDACTED:password]');
    expect(redactionMarker('private-key')).toBe('[REDACTED:private-key]');
    expect(isRedactionMarker('[REDACTED:api-key]')).toBe(true);
    expect(isRedactionMarker('[REDACTED:bogus]')).toBe(false);
    expect(isRedactionMarker('sk-not-a-marker')).toBe(false);
  });
});

describe('configuration', () => {
  test('disabling one group keeps the rest active', () => {
    const jwt = `eyJ${A(16)}.${A(16)}.${A(16)}`;
    const openai = `sk-${A(40)}`;
    const text = `jwt ${jwt} and key ${openai}`;

    const result = redactValue(text, { groups: { jwt: false } });
    // jwt group off: the JWT survives untouched; everything else still redacts.
    expect(result.value).toBe(`jwt ${jwt} and key [REDACTED:api-key]`);
    expect(result.redactions.length).toBe(1);

    const enabled = redactValue(text);
    expect(enabled.value).toBe(`jwt [REDACTED:token] and key [REDACTED:api-key]`);
    expect(enabled.redactions.length).toBe(2);
  });

  test('all groups can be disabled (detector is a no-op)', () => {
    const result = redactValue(`sk-${A(40)}`, {
      groups: Object.fromEntries(PATTERN_GROUP_IDS.map((id) => [id, false])),
    });
    expect(result.value).toBe(`sk-${A(40)}`);
    expect(result.redactions).toEqual([]);
  });

  test('unknown group ids are rejected loudly (typo protection)', () => {
    expect(() => redactValue('x', { groups: { 'does-not-exist': false } })).toThrow(RedactorConfigError);
    try {
      redactValue('x', { groups: { 'does-not-exist': false } });
    } catch (error) {
      const configError = error as RedactorConfigError;
      expect(configError.issues.length).toBe(1);
      expect(configError.issues[0]!.path).toBe('groups');
      expect(configError.issues[0]!.message).toContain('unknown pattern group id');
    }
  });

  test('user-supplied extra patterns redact with their own kind', () => {
    const config = {
      extraPatterns: [
        { id: 'internal-token', kind: 'token' as const, pattern: 'om-[0-9]{6,}' },
      ],
    };
    const { value, redactions } = redactValue('server token om-123456789 expired', config);

    expect(value).toBe('server token [REDACTED:token] expired');
    expect(redactions).toEqual([{ kind: 'token', location: '$', length: 12 }]);
  });

  test('extra patterns with flags, validation, and duplicate-id rejection', () => {
    expect(redactValue('OM-123456', {
      extraPatterns: [{ id: 'x', kind: 'other', pattern: 'om-[0-9]{6,}', flags: 'i' }],
    }).redactions.length).toBe(1);

    expect(() => redactValue('x', { extraPatterns: [{ id: 'x', kind: 'other', pattern: '(' }] })).toThrow(
      RedactorConfigError,
    );
    expect(() => redactValue('x', { extraPatterns: [{ id: 'x', kind: 'other', pattern: 'a*' }] })).toThrow(
      RedactorConfigError,
    );
    expect(() => redactValue('x', { extraPatterns: [{ id: 'x', kind: 'other', pattern: 'a+', flags: 'q' }] })).toThrow(
      RedactorConfigError,
    );
    expect(() =>
      redactValue('x', {
        extraPatterns: [
          { id: 'dup', kind: 'other', pattern: 'a+' },
          { id: 'dup', kind: 'other', pattern: 'b+' },
        ],
      }),
    ).toThrow(RedactorConfigError);
  });

  test('createRedactor implements the async core port and compiles config once', async () => {
    const redactor = createRedactor();
    const result = await redactor.redact(`key sk-${A(40)}`);
    expect(result.value).toBe('key [REDACTED:api-key]');
    expect(result.redactions.length).toBe(1);

    const sync = createRedactor({ groups: { jwt: false } }).redactSync(`jwt eyJ${A(16)}.${A(16)}.${A(16)}`);
    expect(sync.value).toContain('eyJ'); // group off: untouched
  });
});
