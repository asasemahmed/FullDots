// Field selection and the connection body follow OpenBot (MIT).
// Composio's catalogue is mostly apps that ask for a secret the person already
// holds. `connectedAccounts.initiate` takes `{ config: { authScheme, val } }`,
// and each scheme's `val` allows the app's own field names. `status` is set
// after the values so a field cannot replace it. The values exist only for
// this call.
import type { ComposioConnectField } from '../shared/composio.js';

const REDIRECTING = new Set(['OAUTH1', 'OAUTH2']);
const FIELD_SCHEMES = [
  'API_KEY',
  'BASIC',
  'BEARER_TOKEN',
  'BASIC_WITH_JWT',
] as const;
const FIELD_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TOOLKIT = /^[a-z0-9_]{1,64}$/;
const ACCOUNT_ID = /^[a-zA-Z0-9_-]{1,80}$/;

export type FieldScheme = (typeof FIELD_SCHEMES)[number];

export type ConnectionKind =
  | { kind: 'none' }
  | { kind: 'link' }
  | { kind: 'fields'; scheme: FieldScheme; fields: ComposioConnectField[] }
  | { kind: 'unsupported' };

interface AuthField {
  name?: string;
  type?: string;
  description?: string;
  displayName?: string;
  required?: boolean;
  isSecret?: boolean;
  userVisible?: boolean;
}

interface AuthDetail {
  mode?: string;
  fields?: {
    connectedAccountInitiation?: {
      required?: AuthField[];
      optional?: AuthField[];
    };
  };
}

export interface ToolkitAuth {
  composioManagedAuthSchemes?: string[];
  authConfigDetails?: AuthDetail[];
}

/** The slice of `@composio/core` 0.27 this feature calls. */
export interface FieldConnectClient {
  toolkits: { get(slug: string): Promise<ToolkitAuth> };
  tools: {
    getRawComposioToolBySlug(
      slug: string,
    ): Promise<{ toolkit?: { slug?: string } }>;
  };
  authConfigs: {
    list(query: { toolkit?: string }): Promise<{
      items: Array<{
        id: string;
        status?: string;
        authScheme?: string;
        isComposioManaged?: boolean;
      }>;
    }>;
    create(
      toolkit: string,
      body: {
        type: 'use_custom_auth';
        authScheme: FieldScheme;
        name: string;
        credentials: Record<string, never>;
      },
    ): Promise<{ id: string }>;
  };
  connectedAccounts: {
    initiate(
      userId: string,
      authConfigId: string,
      options: {
        allowMultiple?: boolean;
        config: { authScheme: FieldScheme; val: Record<string, string> };
      },
    ): Promise<{ id: string; status: string }>;
    list(query: { userIds?: string[]; limit?: number }): Promise<{
      items: Array<{
        id: string;
        status: string;
        toolkit?: { slug?: string };
      }>;
    }>;
    delete(id: string): Promise<unknown>;
  };
}

/** A refusal we wrote. The message is a fixed sentence and never a field value. */
export class ConnectRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectRefusal';
  }
}

function connectionFields(
  details: AuthDetail[],
  scheme: string,
): ComposioConnectField[] | undefined {
  const detail = details.find((item) => item.mode === scheme);
  const initiation = detail?.fields?.connectedAccountInitiation;
  if (!initiation) return undefined;
  const drawn: ComposioConnectField[] = [];
  for (const list of [
    { items: initiation.required ?? [], required: true },
    { items: initiation.optional ?? [], required: false },
  ]) {
    for (const field of list.items) {
      if (field.userVisible === false) continue;
      if (
        !field.name ||
        field.name === 'status' ||
        !FIELD_NAME.test(field.name)
      )
        return undefined;
      const type = field.type || 'string';
      if (type !== 'string' && type !== 'text') return undefined;
      drawn.push({
        name: field.name,
        label: (field.displayName || field.name).slice(0, 120),
        help: (field.description || '').slice(0, 400),
        secret: field.isSecret === true,
        required: list.required || field.required === true,
      });
    }
  }
  if (!drawn.some((field) => field.required)) return undefined;
  return drawn;
}

/**
 * How an app connects. A Composio-managed consent screen wins over a key,
 * because an app can publish both and the consent screen asks for nothing.
 * An OAuth app that is not managed and not self-registering is the operator
 * case, which is not offered.
 */
export function connectionKind(toolkit: ToolkitAuth): ConnectionKind {
  const details = toolkit.authConfigDetails ?? [];
  const modes = details
    .map((detail) => detail.mode)
    .filter((mode): mode is string => !!mode);
  const managed = toolkit.composioManagedAuthSchemes ?? [];
  if (modes.length === 1 && modes[0] === 'NO_AUTH') return { kind: 'none' };
  if (managed.some((scheme) => REDIRECTING.has(scheme)))
    return { kind: 'link' };
  if (modes.includes('DCR_OAUTH') || modes.includes('CIMD_OAUTH'))
    return { kind: 'link' };
  const scheme = FIELD_SCHEMES.find((name) => modes.includes(name));
  if (!scheme) return { kind: 'unsupported' };
  const fields = connectionFields(details, scheme);
  if (!fields) return { kind: 'unsupported' };
  return { kind: 'fields', scheme, fields };
}

export async function toolkitConnection(
  client: FieldConnectClient,
  toolSlug: string,
): Promise<{ toolkit: string; kind: ConnectionKind } | undefined> {
  const tool = await client.tools.getRawComposioToolBySlug(toolSlug);
  const toolkit = tool.toolkit?.slug?.toLowerCase() ?? '';
  if (!TOOLKIT.test(toolkit)) return undefined;
  return { toolkit, kind: connectionKind(await client.toolkits.get(toolkit)) };
}

export async function connectWithFields(
  client: FieldConnectClient,
  userId: string,
  toolkit: string,
  values: Record<string, string>,
): Promise<void> {
  const kind = connectionKind(await client.toolkits.get(toolkit));
  if (kind.kind !== 'fields')
    throw new ConnectRefusal('This app does not connect with a key.');
  const allowed = new Map(kind.fields.map((field) => [field.name, field]));
  if (Object.keys(values).some((name) => !allowed.has(name)))
    throw new ConnectRefusal('This app does not ask for that.');
  const sent: Record<string, string> = {};
  for (const field of kind.fields) {
    const value = values[field.name]?.trim() ?? '';
    if (field.required && !value)
      throw new ConnectRefusal('Fill in every required field.');
    if (value) sent[field.name] = value;
  }
  const listed = await client.authConfigs.list({ toolkit });
  const existing = listed.items.find(
    (item) =>
      item.status === 'ENABLED' &&
      item.authScheme === kind.scheme &&
      item.isComposioManaged !== true,
  );
  const authConfigId =
    existing?.id ??
    (
      await client.authConfigs.create(toolkit, {
        type: 'use_custom_auth',
        authScheme: kind.scheme,
        name: `FullDots ${toolkit}`.slice(0, 64),
        // The key belongs on the connection, not on the shared config.
        credentials: {},
      })
    ).id;
  const account = await client.connectedAccounts.initiate(
    userId,
    authConfigId,
    {
      allowMultiple: true,
      config: {
        authScheme: kind.scheme,
        val: { ...sent, status: 'ACTIVE' },
      },
    },
  );
  if (account.status !== 'ACTIVE')
    throw new ConnectRefusal('Composio did not mark the app connected.');
}

export interface ConnectedApp {
  id: string;
  toolkit: string;
  status: string;
}

export async function listConnectedApps(
  client: FieldConnectClient,
  userId: string,
): Promise<ConnectedApp[]> {
  const listed = await client.connectedAccounts.list({
    userIds: [userId],
    limit: 50,
  });
  const accounts: ConnectedApp[] = [];
  for (const item of listed.items) {
    const toolkit = item.toolkit?.slug ?? '';
    if (!ACCOUNT_ID.test(item.id) || !TOOLKIT.test(toolkit)) continue;
    if (!/^[A-Z_]{1,32}$/.test(item.status)) continue;
    accounts.push({ id: item.id, toolkit, status: item.status });
  }
  return accounts;
}

export async function disconnectApp(
  client: FieldConnectClient,
  id: string,
): Promise<void> {
  if (!ACCOUNT_ID.test(id))
    throw new ConnectRefusal('That connected app was not found.');
  await client.connectedAccounts.delete(id);
}
