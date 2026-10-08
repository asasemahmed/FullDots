import { z } from 'zod';
import type {
  ConnectorConfig,
  ConnectorValue,
  ConnectorValueView,
} from './types.js';

/** Header or env names that must never hold a literal value. */
export const SECRET_NAME = /authorization|key|token|secret|password|cookie/i;

const valueSchema = z.union(
  [
    z.object({ env: z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/) }).strict(),
    z.object({ literal: z.string().max(4000) }).strict(),
  ],
  { error: 'must be { env: "VAR_NAME" } or { literal: "text" }' },
);
const valueRecord = z.record(
  z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  valueSchema,
);

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export const connectorConfigSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/),
    transport: z.enum(['http', 'stdio']),
    url: z
      .string()
      .url()
      .max(2048)
      .refine(httpUrl, {
        error: 'must be an http(s) URL without credentials',
      })
      .optional(),
    command: z.string().min(1).max(300).optional(),
    args: z.array(z.string().max(300)).max(32).optional(),
    cwd: z.string().max(1024).optional(),
    headers: valueRecord.optional(),
    env: valueRecord.optional(),
    callTimeoutMs: z.number().int().min(1000).max(600_000).default(30_000),
    enabled: z.boolean().default(true),
    presetId: z.string().nullable().optional(),
  })
  .strict();

// Compile-time check: the parsed output is a valid ConnectorConfig.
type Parsed = z.output<typeof connectorConfigSchema>;
const assertAssignable = (parsed: Parsed): ConnectorConfig => parsed;
void assertAssignable;

export interface ConnectorValidation {
  errors: string[];
  warnings: string[];
}

export function looksLikeCredential(value: string): boolean {
  return (
    value.length >= 24 &&
    !/\s/.test(value) &&
    !/^[./~]/.test(value) &&
    !/:\/\//.test(value) &&
    /^[A-Za-z0-9_\-.+=/]+$/.test(value) &&
    /[0-9]/.test(value) &&
    /[A-Za-z]/.test(value)
  );
}

export function connectorValueView(
  value: ConnectorValue,
  env: Record<string, string | undefined>,
): ConnectorValueView {
  if ('env' in value) return { env: value.env, set: !!env[value.env] };
  return value;
}

/**
 * Validates a connector config. Never throws. When parsing fails, `config` is
 * the raw input cast to `ConnectorConfig` and is NOT trustworthy: callers must
 * check `errors.length` before using it.
 */
export function validateConnectorConfig(
  input: unknown,
  options: { allowStdio: boolean },
): { config: ConnectorConfig } & ConnectorValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = connectorConfigSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String).join('.');
      errors.push(path ? `${path}: ${issue.message}` : issue.message);
    }
    return { config: input as ConnectorConfig, errors, warnings };
  }
  const config: ConnectorConfig = parsed.data;
  if (config.transport === 'stdio' && !options.allowStdio)
    errors.push(
      'stdio connectors are off. Set CONNECTORS_ALLOW_STDIO=true on the server to allow a process on this host.',
    );
  if (config.transport === 'http' && !config.url)
    errors.push('url: required for http connectors');
  if (config.transport === 'stdio' && !config.command)
    errors.push('command: required for stdio connectors');
  for (const record of [config.headers, config.env])
    for (const [name, value] of Object.entries(record ?? {})) {
      if (!('literal' in value)) continue;
      if (SECRET_NAME.test(name))
        errors.push(
          `${name} must reference an environment variable (env:VAR_NAME); secrets are never stored.`,
        );
      else if (looksLikeCredential(value.literal))
        warnings.push(
          `${name} looks like a credential; store it as an env reference instead.`,
        );
    }
  return { config, errors, warnings };
}
