import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { redactForStorage } from '../src/server/privacy.js';

// Every secret below is built at run time from a seed, so no key-shaped text sits in the source
// (the repository's secret scan would rightly flag it) and none of it is real.
const alnum = (seed: string, length: number) => {
  let out = '';
  for (let round = 0; out.length < length; round += 1)
    out += createHash('sha256')
      .update(`${seed}:${round}`)
      .digest('base64url')
      .replace(/[^A-Za-z0-9]/g, '');
  return out.slice(0, length);
};
const hex = (seed: string, length: number) =>
  createHash('sha256').update(seed).digest('hex').repeat(2).slice(0, length);
const b64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const jwt = [
  b64url({ alg: 'HS256', typ: 'JWT' }),
  b64url({ sub: 'fake-user', name: 'Fake Person', iat: 1700000000 }),
  alnum('jwt-signature', 43),
].join('.');
const pem = (kind: string, lines = 4) =>
  [
    `-----BEGIN ${kind}-----`,
    ...Array.from({ length: lines }, (_, i) => alnum(`pem-${kind}-${i}`, 64)),
    `-----END ${kind}-----`,
  ].join('\n');

const secrets: [string, string][] = [
  ['OpenAI key', `sk-${alnum('openai', 48)}`],
  ['OpenAI project key', `sk-proj-${alnum('proj', 40)}_${alnum('proj2', 20)}`],
  ['Anthropic key', `sk-ant-api03-${alnum('anthropic', 80)}-${alnum('a2', 6)}`],
  ['OpenRouter key', `sk-or-v1-${hex('openrouter', 64)}`],
  ['Stripe secret key', `sk_live_${alnum('stripe', 24)}`],
  ['Stripe restricted key', `rk_test_${alnum('stripe-rk', 24)}`],
  ['Stripe webhook secret', `whsec_${alnum('whsec', 32)}`],
  ['GitHub classic token', `ghp_${alnum('ghp', 36)}`],
  ['GitHub OAuth token', `gho_${alnum('gho', 36)}`],
  ['GitHub app token', `ghs_${alnum('ghs', 36)}`],
  [
    'GitHub fine-grained token',
    `github_pat_${alnum('pat', 22)}_${alnum('pat2', 59)}`,
  ],
  ['GitLab token', `glpat-${alnum('gitlab', 20)}`],
  ['Slack bot token', `xoxb-1234567890-${alnum('slack', 24)}`],
  ['Slack user token', `xoxp-1234567890-1234567890-${alnum('slack2', 24)}`],
  ['Slack app token', `xapp-1-A0123456789-1234567890-${alnum('slack3', 32)}`],
  [
    'Slack webhook',
    `https://hooks.slack.com/services/T0123ABCD/B0123ABCD/${alnum('hook', 24)}`,
  ],
  ['Google API key', `AIza${alnum('google', 35)}`],
  ['Google OAuth token', `ya29.${alnum('ya29', 60)}`],
  ['AWS access key id', `AKIA${alnum('aws', 16).toUpperCase()}`],
  ['AWS temporary key id', `ASIA${alnum('aws2', 16).toUpperCase()}`],
  ['SendGrid key', `SG.${alnum('sg1', 22)}.${alnum('sg2', 43)}`],
  ['npm token', `npm_${alnum('npm', 36)}`],
  ['Hugging Face token', `hf_${alnum('hf', 34)}`],
  ['Groq key', `gsk_${alnum('groq', 52)}`],
  ['Perplexity key', `pplx-${alnum('pplx', 48)}`],
  ['Telegram bot token', `123456789:${alnum('telegram', 35)}`],
  ['JWT', jwt],
  ['RSA private key', pem('RSA PRIVATE KEY')],
  ['OpenSSH private key', pem('OPENSSH PRIVATE KEY', 6)],
  ['PGP private key', pem('PGP PRIVATE KEY BLOCK', 3)],
  ['bearer token', `Bearer ${alnum('bearer', 40)}`],
  [
    'basic credentials',
    `Basic ${Buffer.from('fake-user:fake-pass-1234').toString('base64')}`,
  ],
  ['authorization header', `Authorization: Bearer ${alnum('authz', 36)}`],
  ['API key header', `x-api-key: ${alnum('header', 40)}`],
  [
    'password in a URL',
    `postgres://app:${alnum('dbpass', 18)}@db.internal:5432/app`,
  ],
  [
    'key in a query string',
    `https://api.example.com/v1/items?key=${alnum('query', 24)}&page=2`,
  ],
  ['high-entropy token', alnum('random', 44)],
  ['base64 secret with padding', `${alnum('padded', 42)}==`],
  [
    'AWS-style secret access key',
    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEX' + alnum('secret', 8),
  ],
  ['value after an equals sign', `API_KEY=${alnum('envfile', 40)}`],
];

describe('redactForStorage: things that must be hidden', () => {
  it.each(secrets)('hides a %s', (name, secret) => {
    const out = redactForStorage(`Staging notes: ${secret} is what I use.`);
    expect(out, name).toContain('[redacted]');
    expect(out).not.toContain(secret);
    // Whatever label stays, no long piece of the secret does.
    for (const piece of secret
      .split(/[\s:=?&/@]+/)
      .filter((part) => part.length >= 20))
      expect(out).not.toContain(piece);
    expect(out).toMatch(/^Staging notes: [\s\S]*is what I use\.$/);
  });

  it('hides a whole private key block, header and footer included', () => {
    const out = redactForStorage(`before\n${pem('RSA PRIVATE KEY')}\nafter`);
    expect(out).toBe('before\n[redacted]\nafter');
  });

  it('hides a private key that was cut off before its END line', () => {
    const cut = pem('EC PRIVATE KEY').split('\n').slice(0, 3).join('\n');
    expect(redactForStorage(`key: ${cut}`)).toBe('key: [redacted]');
  });

  it('keeps the label of a credential and hides only its value', () => {
    const password = alnum('dbpass2', 18);
    expect(
      redactForStorage(`postgres://app:${password}@db.internal:5432/app`),
    ).toBe('postgres://app:[redacted]@db.internal:5432/app');
    expect(
      redactForStorage(`Authorization: Bearer ${alnum('authz2', 36)}`),
    ).toBe('Authorization: Bearer [redacted]');
    expect(
      redactForStorage(`https://x.example/?q=cats&token=${alnum('tok', 30)}`),
    ).toBe('https://x.example/?q=cats&token=[redacted]');
  });

  it('hides every secret in a text, and counts them without saying what they were', () => {
    const counted = vi.fn();
    const out = redactForStorage(
      `one ghp_${alnum('m1', 36)}, two AIza${alnum('m2', 35)}, three ${jwt}`,
      counted,
    );
    expect(out).toBe('one [redacted], two [redacted], three [redacted]');
    expect(counted).toHaveBeenCalledTimes(1);
    expect(counted).toHaveBeenCalledWith(3);
  });

  it('does not report when nothing was hidden', () => {
    const counted = vi.fn();
    expect(redactForStorage('I like short answers.', counted)).toBe(
      'I like short answers.',
    );
    expect(counted).not.toHaveBeenCalled();
  });

  it('gives the same result when it runs twice', () => {
    for (const [, secret] of secrets) {
      const once = redactForStorage(`x ${secret} y`);
      expect(redactForStorage(once)).toBe(once);
    }
  });
});

const ordinary: [string, string][] = [
  ['a plain sentence', 'I prefer short answers with the summary first.'],
  ['a note with a name and a city', 'Asem lives in Cairo and works in UTC+2.'],
  [
    'a GitHub URL',
    'See https://github.com/asasemahmed/FullDots/pull/51 for details.',
  ],
  [
    'a long URL with an id in the path',
    'https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit',
  ],
  [
    'a URL with a query',
    'https://example.com/search?q=penguins&page=2&sort=new',
  ],
  ['a short git SHA', 'Fixed in ce63613, see the log.'],
  ['a full git SHA', `Merged ${hex('commit', 40)} into main.`],
  ['a SHA-256 digest', `image digest sha256:${hex('digest', 64)}`],
  ['a UUID', 'Dot id 75845234-5b56-4e8c-9c9c-7e33a76a445b is the boss.'],
  [
    'a Windows path',
    String.raw`C:\Users\User\AppData\Local\Temp\claude\P--work-tools-opensource-contributions-FullDots\d2ec1361-c280-4125-8795-6a3cf8911e0e`,
  ],
  [
    'a POSIX path',
    '/home/node/projects/fulldots/src/server/dot-notes-service-with-a-long-name.ts',
  ],
  [
    'a relative path with numbers',
    'src/server/v2/handlers/user-profile-settings-page-2024/index.ts',
  ],
  [
    'a long camelCase identifier',
    'call computerAutomationBrowserSessionLifecycleManager now',
  ],
  [
    'a long snake_case identifier',
    'set test_account_balance_2024_q1_report_final_version = 1',
  ],
  [
    'an upper-case constant',
    'use MAXIMUM_NUMBER_OF_CONCURRENT_BACKGROUND_TURNS',
  ],
  [
    'an environment variable',
    'set COMPUTER_MEMORY_BYTES=2147483648 and COMPUTER_CPUS=2',
  ],
  [
    'a code line',
    'const resolved = computerCpus(process.env.COMPUTER_CPUS, cpus().length);',
  ],
  [
    'words that contain sk-',
    'The task-runner has a risk-averse disk-usage and desk-check mode.',
  ],
  [
    'the word bearer',
    'A bearer of bad news; Bearer authentication is described in RFC 6750.',
  ],
  [
    'the word basic',
    'Basic authentication-related configuration is explained below.',
  ],
  [
    'a mention of authorization',
    'Authorization: required for every route except /health.',
  ],
  ['a package integrity hash', `integrity sha512-${alnum('integrity', 86)}`],
  [
    'hashed file names',
    'dist/assets/index-3f9a8b7c.js and main.d41d8cd98f00b204e9800998ecf8427e.css',
  ],
  ['an email address', 'Write to asem.abdallah@example.com about it.'],
  [
    'semantic versions',
    'Requires node 24.19.0 or newer, zod 4.6.7 and vitest 4.1.11.',
  ],
  ['the placeholder itself', 'Already [redacted] once.'],
  ['non-English text', 'يفضل المالك الإجابات القصيرة مع ملخص في البداية.'],
  ['an empty string', ''],
];

describe('redactForStorage: ordinary text that must stay as written', () => {
  it.each(ordinary)('keeps %s', (_name, text) => {
    expect(redactForStorage(text)).toBe(text);
  });

  it('keeps a long note of ordinary prose', () => {
    const prose =
      'Prefers answers in plain English. Works on FullDots, an open-source app of AI coworkers. ' +
      'Uses Windows 11 with Git Bash, node 24 and Docker Desktop. '.repeat(40);
    expect(redactForStorage(prose)).toBe(prose);
  });
});

describe('redactForStorage: cost', () => {
  it('stays fast on long hostile input', () => {
    const started = Date.now();
    redactForStorage('-----BEGIN PRIVATE KEY-----\n'.repeat(2000));
    redactForStorage(`Bearer ${'a1'.repeat(20000)}`);
    redactForStorage('sk-'.repeat(20000));
    redactForStorage('x'.repeat(200000));
    redactForStorage('postgres://' + 'u:'.repeat(20000));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
