import { describe, expect, it } from 'vitest';
import {
  SECRET_NAME,
  connectorConfigSchema,
  connectorValueView,
  looksLikeCredential,
  validateConnectorConfig,
} from '../src/shared/connector-config.js';
import { connectorPresets } from '../src/shared/connector-presets.js';
import type { ConnectorConfig } from '../src/shared/types.js';

const http = (extra: Record<string, unknown> = {}) => ({
  name: 'github',
  transport: 'http',
  url: 'https://example.com/mcp',
  ...extra,
});
const stdio = (extra: Record<string, unknown> = {}) => ({
  name: 'files',
  transport: 'stdio',
  command: 'npx',
  ...extra,
});

describe('connector config schema', () => {
  const table: [string, unknown, boolean][] = [
    ['minimal http', http(), true],
    ['minimal stdio', stdio(), true],
    ['name with spaces and dashes', http({ name: 'My Notes_1-a' }), true],
    ['empty name', http({ name: '' }), false],
    ['name starting with a dash', http({ name: '-bad' }), false],
    ['name with a slash', http({ name: 'a/b' }), false],
    ['name of 41 chars', http({ name: 'a'.repeat(41) }), false],
    ['name of 40 chars', http({ name: 'a'.repeat(40) }), true],
    ['ftp url', http({ url: 'ftp://example.com/x' }), false],
    [
      'url with user:pass',
      http({ url: 'https://user:pass@example.com/' }),
      false,
    ],
    ['url with user only', http({ url: 'https://user@example.com/' }), false],
    [
      'url too long',
      http({ url: 'https://example.com/' + 'a'.repeat(2048) }),
      false,
    ],
    ['not a url', http({ url: 'nope' }), false],
    ['empty command', stdio({ command: '' }), false],
    ['unknown key', http({ extra: 1 }), false],
    ['unknown transport', http({ transport: 'sse' }), false],
    ['too many args', stdio({ args: Array(33).fill('x') }), false],
    ['32 args', stdio({ args: Array(32).fill('x') }), true],
    [
      'header env value',
      http({ headers: { Authorization: { env: 'GITHUB_TOKEN' } } }),
      true,
    ],
    [
      'lowercase env var name',
      http({ headers: { A: { env: 'github_token' } } }),
      false,
    ],
    [
      'env var name starting with digit',
      http({ headers: { A: { env: '1TOKEN' } } }),
      false,
    ],
    [
      'bad header key',
      http({ headers: { 'bad key': { literal: 'x' } } }),
      false,
    ],
    [
      'value with both keys',
      http({ headers: { A: { env: 'A', literal: 'x' } } }),
      false,
    ],
    [
      'value with unknown key',
      http({ headers: { A: { literal: 'x', extra: 1 } } }),
      false,
    ],
    [
      'literal too long',
      http({ headers: { A: { literal: 'x'.repeat(4001) } } }),
      false,
    ],
    ['timeout 999', http({ callTimeoutMs: 999 }), false],
    ['timeout 1000', http({ callTimeoutMs: 1000 }), true],
    ['timeout 600000', http({ callTimeoutMs: 600_000 }), true],
    ['timeout 600001', http({ callTimeoutMs: 600_001 }), false],
    ['fractional timeout', http({ callTimeoutMs: 1500.5 }), false],
    ['presetId null', http({ presetId: null }), true],
  ];
  it.each(table)('%s', (_label, input, ok) => {
    expect(connectorConfigSchema.safeParse(input).success).toBe(ok);
  });

  it('applies defaults', () => {
    const parsed = connectorConfigSchema.parse(http());
    expect(parsed.callTimeoutMs).toBe(30_000);
    expect(parsed.enabled).toBe(true);
  });
});

describe('validateConnectorConfig', () => {
  const on = { allowStdio: true };
  const off = { allowStdio: false };

  it('returns the parsed config without errors', () => {
    const result = validateConnectorConfig(http(), off);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.config.enabled).toBe(true);
  });

  it('returns readable schema errors and never throws', () => {
    const result = validateConnectorConfig({ name: '', transport: 'x' }, on);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.startsWith('name:'))).toBe(true);
    expect(() => validateConnectorConfig(null, on)).not.toThrow();
    expect(
      validateConnectorConfig(undefined, on).errors.length,
    ).toBeGreaterThan(0);
  });

  it('reports the path of a bad header value', () => {
    const result = validateConnectorConfig(
      http({ headers: { A: { env: 'lower' } } }),
      on,
    );
    expect(result.errors.some((e) => e.startsWith('headers.A'))).toBe(true);
  });

  it('requires url for http and command for stdio', () => {
    expect(
      validateConnectorConfig({ name: 'a', transport: 'http' }, on).errors,
    ).toContain('url: required for http connectors');
    expect(
      validateConnectorConfig({ name: 'a', transport: 'stdio' }, on).errors,
    ).toContain('command: required for stdio connectors');
  });

  it('rejects stdio without the flag and accepts it with the flag', () => {
    const blocked = validateConnectorConfig(stdio(), off);
    expect(blocked.errors).toEqual([
      'stdio connectors are off. Set CONNECTORS_ALLOW_STDIO=true on the server to allow a process on this host.',
    ]);
    expect(validateConnectorConfig(stdio(), on).errors).toEqual([]);
  });

  it.each([
    [
      'header Authorization',
      { headers: { Authorization: { literal: 'Bearer abc' } } },
      'Authorization',
    ],
    [
      'header X-Api-Key',
      { headers: { 'X-Api-Key': { literal: 'abc' } } },
      'X-Api-Key',
    ],
    [
      'env GITHUB_TOKEN',
      { env: { GITHUB_TOKEN: { literal: 'abc' } } },
      'GITHUB_TOKEN',
    ],
  ])('rejects a literal under a secret name: %s', (_label, extra, name) => {
    const result = validateConnectorConfig(http(extra), on);
    expect(result.errors).toEqual([
      `${name} must reference an environment variable (env:VAR_NAME); secrets are never stored.`,
    ]);
  });

  it('accepts env references under secret names', () => {
    const result = validateConnectorConfig(
      http({ headers: { Authorization: { env: 'GITHUB_TOKEN' } } }),
      on,
    );
    expect(result.errors).toEqual([]);
  });

  it('accepts a Notion-Version literal', () => {
    expect(SECRET_NAME.test('Notion-Version')).toBe(false);
    const result = validateConnectorConfig(
      http({ headers: { 'Notion-Version': { literal: '2022-06-28' } } }),
      on,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('warns on a credential-looking literal under a non-secret name', () => {
    const result = validateConnectorConfig(
      http({
        headers: { 'X-Custom': { literal: 'abcd1234efgh5678ijkl9012mnop' } },
      }),
      on,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      'X-Custom looks like a credential; store it as an env reference instead.',
    ]);
  });
});

describe('looksLikeCredential', () => {
  it.each([
    ['abcd1234efgh5678ijkl9012mnop', true],
    ['ghp_AbCdEf0123456789AbCdEf0123456789', true],
    ['2022-06-28', false],
    ['short1', false],
    ['abcdefghijklmnopqrstuvwxyz', false],
    ['0123456789012345678901234567', false],
    ['has some spaces 1234567890123456', false],
    ['/usr/local/share/data1/files', false],
    ['./relative/path/with/digits1', false],
    ['~/.gmail-mcp/credentials.json', false],
    ['https://example.com/a1b2c3d4e5f6', false],
    ['abcd1234efgh5678ijkl9012mnop!', false],
  ])('%s -> %s', (value, expected) => {
    expect(looksLikeCredential(value)).toBe(expected);
  });
});

describe('connectorValueView', () => {
  it('reports whether an env reference is set', () => {
    expect(connectorValueView({ env: 'A_TOKEN' }, { A_TOKEN: 'x' })).toEqual({
      env: 'A_TOKEN',
      set: true,
    });
    expect(connectorValueView({ env: 'A_TOKEN' }, {})).toEqual({
      env: 'A_TOKEN',
      set: false,
    });
    expect(connectorValueView({ env: 'A_TOKEN' }, { A_TOKEN: '' })).toEqual({
      env: 'A_TOKEN',
      set: false,
    });
  });

  it('never includes the env value', () => {
    const view = connectorValueView(
      { env: 'A_TOKEN' },
      { A_TOKEN: 'sekret-1234' },
    );
    expect(JSON.stringify(view)).not.toContain('sekret');
  });

  it('returns literals as they are', () => {
    expect(connectorValueView({ literal: '2022-06-28' }, {})).toEqual({
      literal: '2022-06-28',
    });
  });
});

describe('connector presets', () => {
  it('lists the six presets with unique ids', () => {
    expect(connectorPresets.map((p) => p.id)).toEqual([
      'github',
      'notion',
      'filesystem',
      'fetch',
      'google-drive',
      'gmail',
    ]);
  });

  it.each(connectorPresets)('$id passes validation', (preset) => {
    const config = {
      name: preset.name,
      transport: preset.transport,
      url: preset.url,
      command: preset.command,
      args: preset.args,
      headers: preset.headers,
      env: preset.env,
      presetId: preset.id,
    } satisfies ConnectorConfig;
    const clean = JSON.parse(JSON.stringify(config)) as unknown;
    const withStdio = validateConnectorConfig(clean, { allowStdio: true });
    expect(withStdio.errors).toEqual([]);
    expect(withStdio.warnings).toEqual([]);
    const without = validateConnectorConfig(clean, { allowStdio: false });
    expect(without.errors.length === 0).toBe(!preset.requiresStdio);
    expect(preset.transport === 'stdio').toBe(!!preset.requiresStdio);
    expect(preset.docsUrl).toMatch(/^https:\/\//);
  });

  it('github and notion reference env variables for Authorization', () => {
    expect(connectorPresets[0].headers?.Authorization).toEqual({
      env: 'GITHUB_TOKEN',
    });
    expect(connectorPresets[1].headers?.['Notion-Version']).toEqual({
      literal: '2022-06-28',
    });
    expect(connectorPresets[1].requiredEnv[0].name).toBe('NOTION_TOKEN');
  });
});
