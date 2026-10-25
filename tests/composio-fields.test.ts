import { describe, expect, it } from 'vitest';
import {
  connectionKind,
  type ToolkitAuth,
} from '../src/server/composio-fields.js';

const key = (extra?: Record<string, unknown>): ToolkitAuth => ({
  authConfigDetails: [
    {
      mode: 'API_KEY',
      fields: {
        connectedAccountInitiation: {
          required: [
            {
              name: 'api_key',
              type: 'string',
              displayName: 'API key',
              description: 'From the vendor.',
              required: true,
              isSecret: true,
              ...extra,
            },
          ],
          optional: [
            {
              name: 'subdomain',
              type: 'string',
              displayName: 'Subdomain',
              description: 'The site prefix.',
              required: false,
              isSecret: false,
            },
          ],
        },
      },
    },
  ],
});

describe('connection kind', () => {
  it('draws the published fields, required first, and marks secrets', () => {
    expect(connectionKind(key())).toEqual({
      kind: 'fields',
      scheme: 'API_KEY',
      fields: [
        {
          name: 'api_key',
          label: 'API key',
          help: 'From the vendor.',
          secret: true,
          required: true,
        },
        {
          name: 'subdomain',
          label: 'Subdomain',
          help: 'The site prefix.',
          secret: false,
          required: false,
        },
      ],
    });
  });

  it('skips a hidden field and refuses a field that is not text', () => {
    const hidden = key();
    hidden.authConfigDetails![0]!.fields!.connectedAccountInitiation!.optional =
      [
        {
          name: 'internal',
          type: 'string',
          displayName: 'Internal',
          description: '',
          required: false,
          userVisible: false,
        },
      ];
    const drawn = connectionKind(hidden);
    expect(drawn.kind).toBe('fields');
    if (drawn.kind === 'fields')
      expect(drawn.fields.map((field) => field.name)).toEqual(['api_key']);

    const numbered = key({ type: 'number' });
    expect(connectionKind(numbered)).toEqual({ kind: 'unsupported' });
  });

  it('keeps a consent screen when the app also publishes a key', () => {
    const both = key();
    both.composioManagedAuthSchemes = ['OAUTH2'];
    both.authConfigDetails?.push({ mode: 'OAUTH2' });
    expect(connectionKind(both)).toEqual({ kind: 'link' });
  });

  it('treats a self-registering app as a link and an operator app as unsupported', () => {
    expect(
      connectionKind({ authConfigDetails: [{ mode: 'DCR_OAUTH' }] }),
    ).toEqual({ kind: 'link' });
    expect(connectionKind({ authConfigDetails: [{ mode: 'OAUTH2' }] })).toEqual(
      { kind: 'unsupported' },
    );
    expect(
      connectionKind({ authConfigDetails: [{ mode: 'NO_AUTH' }] }),
    ).toEqual({ kind: 'none' });
  });
});
