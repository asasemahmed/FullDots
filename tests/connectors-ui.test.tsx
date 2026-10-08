import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
}));
import {
  ConnectorsSettings,
  draftToBody,
  emptyDraft,
  secretNameMessage,
  validateDraft,
  type ConnectorsData,
} from '../src/client/ConnectorsSettings';
import {
  ApprovalModeField,
  DotConnectorGrants,
  toggleTool,
  type GrantInput,
} from '../src/client/DotConnectorGrants';
import { WorkspaceDialog } from '../src/client/WorkspaceDialog';
import { connectorPresets } from '../src/shared/connector-presets';
import type {
  ConnectorToolInfo,
  ConnectorView,
  State,
  WorkspaceState,
} from '../src/shared/types';

const SECRET_VALUE = 'ghp_PLANTEDSECRETVALUE1234567890abcdef';

const tool = (
  name: string,
  extra: Partial<ConnectorToolInfo> = {},
): ConnectorToolInfo => ({
  name,
  toolName: `mcp__github__${name}`,
  description: '',
  readOnly: false,
  destructive: false,
  inputSchema: {},
  ...extra,
});

function connector(
  name: string,
  status: ConnectorView['status'],
  extra: Partial<ConnectorView> = {},
): ConnectorView {
  return {
    id: `id-${name}`,
    name,
    transport: 'http',
    url: 'https://example.com/mcp',
    command: null,
    args: [],
    cwd: null,
    headers: {},
    env: {},
    callTimeoutMs: 30_000,
    enabled: true,
    presetId: null,
    createdAt: 1,
    updatedAt: 1,
    status,
    ...extra,
  };
}

const data = (
  connectors: ConnectorView[],
  allowStdio = true,
): ConnectorsData => ({ connectors, presets: connectorPresets, allowStdio });

describe('ConnectorsSettings', () => {
  it('renders a status pill for every state', () => {
    const html = renderToStaticMarkup(
      <ConnectorsSettings
        initial={data([
          connector('alpha', {
            state: 'connected',
            tools: [tool('get_issue', { readOnly: true }), tool('make')],
          }),
          connector('bravo', {
            state: 'error',
            error: 'Server said no (401)',
            tools: [],
          }),
          connector('charlie', {
            state: 'missing_env',
            missing: ['GITHUB_TOKEN', 'OTHER_VAR'],
            tools: [],
          }),
          connector(
            'delta',
            { state: 'disabled', tools: [] },
            { enabled: false },
          ),
          connector('echo', { state: 'connecting', tools: [] }),
        ])}
      />,
    );
    expect(html).toContain('cn-pill-ok');
    expect(html).toContain('data-state="connected"');
    expect(html).toContain('cn-pill-bad');
    expect(html).toContain('Server said no (401)');
    expect(html).toContain('cn-pill-warn');
    expect(html).toContain('GITHUB_TOKEN');
    expect(html).toContain('OTHER_VAR');
    expect(html).toContain('data-state="disabled"');
    expect(html).toContain('data-state="connecting"');
    expect(html).toContain('2 tools');
    expect(html).toContain('0 tools');
    // Disabled connectors offer Enable, enabled ones Disable.
    expect(html).toContain('>Enable<');
    expect(html).toContain('>Disable<');
    for (const action of ['Reload', 'Test', 'Edit', 'Delete'])
      expect(html).toContain(`>${action}<`);
  });

  it('shows header variable names but never a secret value', () => {
    const html = renderToStaticMarkup(
      <ConnectorsSettings
        initial={data([
          connector(
            'github',
            { state: 'connected', tools: [] },
            {
              headers: {
                Authorization: { env: 'GITHUB_TOKEN', set: true },
                'X-Api-Key': { literal: SECRET_VALUE },
                'Notion-Version': { literal: '2022-06-28' },
              },
              env: {
                MY_TOKEN: { env: 'MY_TOKEN', set: false },
                SESSION_COOKIE: { literal: SECRET_VALUE },
              },
            },
          ),
        ])}
      />,
    );
    expect(html).toContain('Authorization');
    expect(html).toContain('GITHUB_TOKEN');
    expect(html).toContain('not set');
    expect(html).toContain('X-Api-Key');
    expect(html).toContain('2022-06-28');
    expect(html).not.toContain(SECRET_VALUE);
    expect(html).not.toContain('PLANTEDSECRET');
  });

  it('disables stdio presets with the host-trust note when stdio is off', () => {
    const off = renderToStaticMarkup(
      <ConnectorsSettings initial={data([], false)} />,
    );
    expect(off).toContain(
      'Local program connectors are off. Set CONNECTORS_ALLOW_STDIO=true on the server to allow them.',
    );
    const filesystem = off
      .split('data-preset="filesystem"')[1]!
      .split('data-preset=')[0]!;
    expect(filesystem).toMatch(/<button[^>]*disabled=""[^>]*>Use</);
    const github = off
      .split('data-preset="github"')[1]!
      .split('data-preset=')[0]!;
    expect(github).not.toContain('disabled=""');
    expect(github).toContain('GITHUB_TOKEN');
    expect(github).toContain('Docs');

    const on = renderToStaticMarkup(
      <ConnectorsSettings initial={data([], true)} />,
    );
    expect(on).not.toContain('Local program connectors are off');
    expect(
      on.split('data-preset="filesystem"')[1]!.split('data-preset=')[0],
    ).not.toContain('disabled=""');
  });

  it('shows whether a preset variable is set when an existing connector tells us', () => {
    const html = renderToStaticMarkup(
      <ConnectorsSettings
        initial={data([
          connector(
            'gh',
            { state: 'connected', tools: [] },
            { headers: { Authorization: { env: 'GITHUB_TOKEN', set: true } } },
          ),
        ])}
      />,
    );
    const github = html
      .split('data-preset="github"')[1]!
      .split('data-preset=')[0]!;
    expect(github).toContain('cn-set');
  });

  it('blocks literals under secret-looking names with the server message', () => {
    const draft = {
      ...emptyDraft(),
      name: 'x',
      url: 'https://example.com/mcp',
      rows: [{ name: 'Authorization', kind: 'literal' as const, value: 'abc' }],
    };
    expect(validateDraft(draft)).toContain(secretNameMessage('Authorization'));
    expect(secretNameMessage('Authorization')).toBe(
      'Authorization must reference an environment variable (env:VAR_NAME); secrets are never stored.',
    );
    // An env row must hold a variable name, never a credential.
    const credential = {
      ...draft,
      rows: [
        { name: 'Authorization', kind: 'env' as const, value: SECRET_VALUE },
      ],
    };
    expect(validateDraft(credential).join(' ')).toContain('NAME');
    const ok = {
      ...draft,
      rows: [
        { name: 'Authorization', kind: 'env' as const, value: 'GITHUB_TOKEN' },
        { name: 'Notion-Version', kind: 'literal' as const, value: '2022' },
      ],
    };
    expect(validateDraft(ok)).toEqual([]);
    expect(draftToBody(ok)).toEqual({
      name: 'x',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: {
        Authorization: { env: 'GITHUB_TOKEN' },
        'Notion-Version': { literal: '2022' },
      },
    });
  });

  it('builds a stdio body with one argument per line', () => {
    expect(
      draftToBody({
        ...emptyDraft(),
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: '-y\n@modelcontextprotocol/server-filesystem\n\n/tmp',
        presetId: 'filesystem',
        rows: [{ name: 'HOME_DIR', kind: 'env', value: 'HOME' }],
      }),
    ).toEqual({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { HOME_DIR: { env: 'HOME' } },
      presetId: 'filesystem',
    });
  });
});

describe('DotConnectorGrants', () => {
  const github = connector('github', {
    state: 'connected',
    tools: [
      tool('get_issue', { readOnly: true }),
      tool('create_issue'),
      tool('delete_repo', { destructive: true }),
    ],
  });
  const input = (html: string, name: string) =>
    html.match(new RegExp(`<input[^>]*>(?=<span><code>${name}</code>)`))?.[0] ??
    '';

  it('ticks read-only tools by default and leaves write tools unticked with a warning', () => {
    const grants: GrantInput[] = [{ connectorId: github.id, tools: '*' }];
    const html = renderToStaticMarkup(
      <DotConnectorGrants
        connectors={[github]}
        value={grants}
        onChange={() => {}}
      />,
    );
    expect(input(html, 'get_issue')).toContain('checked=""');
    expect(input(html, 'create_issue')).not.toContain('checked');
    expect(input(html, 'delete_repo')).not.toContain('checked');
    expect(html).toContain('This can change things outside FullDots');
    expect(html.match(/This can change things outside FullDots/g)).toHaveLength(
      2,
    );
    expect(html).toContain('destructive');
    expect(html).toContain('Use this connector');
    // The read-only tool carries no warning.
    const readOnlyLabel = html
      .split('<code>get_issue</code>')[1]!
      .split('</label>')[0]!;
    expect(readOnlyLabel).not.toContain('outside FullDots');
  });

  it('shows the connect hint for a connector that is not connected', () => {
    const html = renderToStaticMarkup(
      <DotConnectorGrants
        connectors={[
          connector('notion', {
            state: 'missing_env',
            missing: ['X'],
            tools: [],
          }),
        ]}
        value={[]}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('Connect it in Settings to choose tools');
  });

  it('skips disabled connectors and renders nothing without connectors', () => {
    const off = connector(
      'off',
      { state: 'disabled', tools: [] },
      { enabled: false },
    );
    expect(
      renderToStaticMarkup(
        <DotConnectorGrants
          connectors={[off]}
          value={[]}
          onChange={() => {}}
        />,
      ),
    ).toBe('');
  });

  it('turns "*" into an explicit list when a write tool is ticked, and back again', () => {
    const tools = github.status.tools;
    const ticked = toggleTool(
      {
        connectorId: github.id,
        tools: '*',
        overrides: { create_issue: 'ask' },
      },
      tools,
      'create_issue',
      true,
    );
    expect(ticked.tools).toEqual(['get_issue', 'create_issue']);
    expect(ticked.overrides).toEqual({ create_issue: 'ask' });
    const back = toggleTool(ticked, tools, 'create_issue', false);
    expect(back.tools).toBe('*');
    const without = toggleTool(back, tools, 'get_issue', false);
    expect(without.tools).toEqual([]);
  });
});

describe('ApprovalModeField', () => {
  it('lists the three modes and warns in red only for "off"', () => {
    const off = renderToStaticMarkup(
      <ApprovalModeField value="off" onChange={() => {}} />,
    );
    expect(off).toContain('id="dot-approval-mode"');
    expect(off).toContain('Ask before sensitive actions (recommended)');
    expect(off).toContain('Ask before anything that changes data');
    expect(off).toContain('Never ask');
    expect(off).toContain(
      'The Dot will send, pay, delete and publish without asking. Handoff for passwords and codes still applies.',
    );
    expect(off).toContain('cn-approval-warning');
    const sensitive = renderToStaticMarkup(
      <ApprovalModeField value="sensitive" onChange={() => {}} />,
    );
    expect(sensitive).not.toContain('without asking');
  });
});

describe('WorkspaceDialog', () => {
  const workspace = {
    spaces: [],
    dots: [],
    setup: { missing: [], search: false, browser: false, voice: false },
  } as unknown as WorkspaceState;
  const state = {
    settings: { researchAllowed: true, memoryAllowed: true },
  } as unknown as State;

  it('renders a Connectors section in the settings dialog', () => {
    const html = renderToStaticMarkup(
      <WorkspaceDialog
        dialog={{ type: 'settings' }}
        state={state}
        workspace={workspace}
        onClose={() => {}}
        mutate={async () => true}
      />,
    );
    expect(html).toContain('Service setup');
    expect(html).toContain('Connectors');
    expect(html.indexOf('Service setup')).toBeLessThan(
      html.indexOf('Connectors'),
    );
  });

  it('puts the approval mode in the Dot form, defaulting to sensitive', () => {
    const html = renderToStaticMarkup(
      <WorkspaceDialog
        dialog={{ type: 'dot', spaceId: 's1' }}
        state={state}
        workspace={workspace}
        onClose={() => {}}
        mutate={async () => true}
      />,
    );
    expect(html).toContain('id="dot-approval-mode"');
    expect(html).toMatch(/<option value="sensitive" selected="">/);
    expect(html).not.toContain('without asking');
  });
});
