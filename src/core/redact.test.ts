import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactText, DEFAULT_MAX_LENGTH } from './redact.js';

/**
 * These tests are the guarantee behind the privacy claim in the README.
 * A regression here writes live credentials to disk, so every case that has
 * ever been found leaking should get a line in the vendor table below.
 */

/**
 * Builds a fake credential from its parts.
 *
 * GitHub's push protection scans for credential-shaped *literals*, and these
 * fixtures - though entirely fake - match the Slack and Stripe patterns
 * closely enough to block a push. Assembling them at runtime keeps the test
 * data identical while leaving no complete pattern in the source. Clicking
 * the "allow this secret" bypass instead would train us to wave through real
 * warnings, which is exactly the habit this project should not build.
 */
const fake = (prefix: string, body: string): string => prefix + body;

/**
 * [rule name, sample text, the exact substring that must NOT survive].
 * Naming the secret explicitly beats inferring it from the sample: the
 * inference version passed while a real credential was still leaking next
 * to a redacted one.
 */
const LEAKY: ReadonlyArray<readonly [string, string, string]> = [
  ['aws-access-key-id', 'aws configure set key AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
  [
    'anthropic-api-key',
    'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
  ],
  [
    'openai-api-key',
    'curl -H "x: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"',
    'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
  ],
  [
    'github-token',
    'git remote add o https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  ],
  ['gitlab-token', 'export X=glpat-abcdefghijklmnopqrstuv', 'glpat-abcdefghijklmnopqrstuv'],
  [
    'slack-token',
    fake('xoxb', '-1234567890-abcdefghijklmnop'),
    fake('xoxb', '-1234567890-abcdefghijklmnop'),
  ],
  [
    'stripe-key',
    fake('sk_live', '_abcdefghijklmnopqrstuvwx'),
    fake('sk_live', '_abcdefghijklmnopqrstuvwx'),
  ],
  ['resend-key', 'RESEND_API_KEY=re_abcdefghijklmnopqrst', 're_abcdefghijklmnopqrst'],
  [
    'google-api-key',
    'key=AIzaSyA1234567890abcdefghijklmnopqrstuvw',
    'AIzaSyA1234567890abcdefghijklmnopqrstuvw',
  ],
  [
    'npm-token',
    'npm_abcdefghijklmnopqrstuvwxyz0123456789',
    'npm_abcdefghijklmnopqrstuvwxyz0123456789',
  ],
  [
    'jwt',
    'Cookie: s=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  ],
];

for (const [ruleName, sample, secret] of LEAKY) {
  test(`redacts ${ruleName}`, () => {
    const result = redact(sample);
    assert.ok(
      result.redactions.includes(ruleName),
      `expected rule ${ruleName} to fire, got [${result.redactions}]: ${result.text}`,
    );
    assert.ok(
      !result.text.includes(secret),
      `secret survived redaction for ${ruleName}: ${result.text}`,
    );
    // Guards against a rule wrapping an already-inserted marker, which
    // produced the unreadable "[REDACTED:[REDACTED:url-credentials]".
    assert.ok(
      !result.text.includes('[REDACTED:[REDACTED:'),
      `nested redaction marker for ${ruleName}: ${result.text}`,
    );
  });
}



test('redacts generic KEY=value assignments', () => {
  const r = redact('DB_PASSWORD=hunter2xyz DATABASE_URL=ok');
  assert.ok(!r.text.includes('hunter2xyz'), r.text);
});

test('redacts quoted JSON secret values but keeps benign fields', () => {
  const r = redact({ api_key: 'abcdef123456789', model: 'claude-opus-5' });
  assert.ok(!r.text.includes('abcdef123456789'), r.text);
  // Redaction that eats everything is useless for debugging - the whole
  // point of the summary is telling which model/tool was involved.
  assert.ok(r.text.includes('claude-opus-5'), r.text);
});

test('redacts CLI flag secrets while keeping the command readable', () => {
  const r = redact('curl --api-key abcdef1234567890 https://x.test');
  assert.ok(!r.text.includes('abcdef1234567890'), r.text);
  assert.ok(r.text.includes('https://x.test'), 'URL should survive');
});

test('redacts Authorization bearer headers', () => {
  // Regression: "Authorization" matches the sensitive-name pattern, so a
  // naive assignment rule consumed the word "Bearer" as the value and left
  // the actual token in the clear. auth-header must run first.
  const r = redact('Authorization: Bearer abcdefghijklmnop1234');
  assert.ok(!r.text.includes('abcdefghijklmnop1234'), r.text);
});

test('redacts credentials embedded in a URL', () => {
  const r = redact('psql postgres://admin:s3cr3tpass@db.internal:5432/app');
  assert.ok(!r.text.includes('s3cr3tpass'), r.text);
  // Host must survive - knowing which DB was touched is the point of the log.
  assert.ok(r.text.includes('db.internal'), r.text);
});

test('redacts a PEM private key block', () => {
  const pem =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----';
  const r = redact(pem);
  assert.ok(!r.text.includes('MIIEowIBAAKCAQEA1234'), r.text);
});

test('redacts before truncating, so no partial secret survives', () => {
  // Truncate-first would slice a credential in half, leaving a fragment that
  // matches no pattern but is still sensitive.
  const padding = 'x'.repeat(DEFAULT_MAX_LENGTH - 20);
  const r = redact(`${padding} AKIAIOSFODNN7EXAMPLE trailing`);
  assert.ok(!r.text.includes('AKIAIOSFODNN7EXAMPLE'), r.text);
  assert.ok(r.redactions.includes('aws-access-key-id'));
});

test('truncates to the requested length with a visible marker', () => {
  const r = redact('a'.repeat(1000), 100);
  assert.ok(r.text.startsWith('a'.repeat(100)));
  assert.ok(r.text.includes('+900 chars'), r.text);
});

test('leaves ordinary tool input untouched', () => {
  const input = 'npm run build && git status';
  assert.equal(redactText(input), input);
});

test('handles null, undefined and circular objects without throwing', () => {
  // The logging layer must never be what crashes the agent it observes.
  assert.equal(redactText(null), '');
  assert.equal(redactText(undefined), '');
  const cyclic: Record<string, unknown> = { name: 'x' };
  cyclic.self = cyclic;
  assert.ok(redactText(cyclic).includes('Circular'));
});

test('is not stateful across calls (regex lastIndex reset)', () => {
  // A /g regex reused without resetting lastIndex silently misses matches
  // near the start of the next string - the classic bug this guards.
  const s = 'AKIAIOSFODNN7EXAMPLE';
  for (let i = 0; i < 5; i++) {
    assert.ok(redact(s).redactions.includes('aws-access-key-id'), `failed on call ${i}`);
  }
});
