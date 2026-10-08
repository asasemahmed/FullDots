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
  selectAllReads,
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
    auth: 'none',
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
  it('renders a card with a status pill for every state', () => {
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
    for (const state of [
      'connected',
      'error',
      'missing_env',
      'disabled',
      'connecting',
    ])
      expect(html).toContain(`data-state="${state}"`);
    expect(html).toContain('Server said no (401)');
    expect(html).toContain('GITHUB_TOKEN');
    expect(html).toContain('OTHER_VAR');
    expect(html).toContain('2 tools');
    expect(html).toContain('0 tools');
    // Every connector card carries its logo tile.
    expect(html.split('connector-logo').length - 1).toBeGreaterThanOrEqual(5);
  });

  it('never renders a secret value on the cards', () => {
    const html = renderToStaticMarkup(
      <ConnectorsSettings
        initial={data([
          connector(
            'github',
            { state: 'connected', tools: [] },
            {
              auth: 'token',
              headers: {
                Authorization: { env: 'GITHUB_TOKEN', set: true },
                'X-Api-Key': { literal: SECRET_VALUE },
              },
              env: { SESSION_COOKIE: { literal: SECRET_VALUE } },
            },
          ),
        ])}
      />,
    );
    expect(html).not.toContain(SECRET_VALUE);
    expect(html).not.toContain('PLANTEDSECRET');
  });

  it('disables local-program presets with the host-trust note when stdio is off', () => {
    const off = renderToStaticMarkup(
      <ConnectorsSettings initial={data([], false)} />,
    );
    expect(off).toContain(
      'Local program connectors are off. Set CONNECTORS_ALLOW_STDIO=true on the server to allow them.',
    );
    const filesystem = off
      .split('data-preset="filesystem"')[1]!
      .split('data-preset=')[0]!;
    expect(filesystem).toContain('disabled=""');
    const github = off
      .split('data-preset="github"')[1]!
      .split('data-preset=')[0]!;
    expect(github).not.toContain('disabled=""');

    const on = renderToStaticMarkup(
      <ConnectorsSettings initial={data([], true)} />,
    );
    expect(on).not.toContain('Local program connectors are off');
    expect(
      on.split('data-preset="filesystem"')[1]!.split('data-preset=')[0],
    ).not.toContain('disabled=""');
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
  const github = connector(
    'github',
    {
      state: 'connected',
      tools: [
        tool('get_issue', { readOnly: true }),
        tool('create_issue'),
        tool('delete_repo', { destructive: true }),
      ],
    },
    { presetId: 'github' },
  );
  const render = (
    connectors: ConnectorView[],
    value: GrantInput[] = [],
  ): string =>
    renderToStaticMarkup(
      <DotConnectorGrants
        connectors={connectors}
        value={value}
        onChange={() => {}}
      />,
    );
  const input = (html: string, name: string) =>
    html.match(
      new RegExp(
        `<input[^>]*>(?=<span class="dp-tool-text"><code>${name}</code>)`,
      ),
    )?.[0] ?? '';

  it('ticks read-only tools by default and leaves write tools unticked with a warning', () => {
    const html = render([github], [{ connectorId: github.id, tools: '*' }]);
    expect(input(html, 'get_issue')).toContain('checked=""');
    expect(input(html, 'create_issue')).not.toContain('checked');
    expect(input(html, 'delete_repo')).not.toContain('checked');
    expect(html).toContain('Reads');
    expect(html).toContain('Changes data');
    expect(html).toContain('Destructive');
    expect(html).toContain('This can change things outside FullDots');
    expect(html).toContain('dp-dot-writes');
    expect(html).toContain('dp-dot-destructive');
    expect(html).toContain('Use this connector');
    // The reads group carries no warning.
    const reads = html.split('Changes data')[0]!;
    expect(reads).toContain('get_issue');
    expect(reads).not.toContain('outside FullDots');
    // Everything read-only is ticked, so there is nothing to select.
    expect(html).not.toContain('Select all reads');
  });

  it('offers "Select all reads" once a read-only tool is unticked', () => {
    const html = render([github], [{ connectorId: github.id, tools: [] }]);
    expect(html).toContain('Select all reads');
    expect(input(html, 'get_issue')).not.toContain('checked');
  });

  it('renders a logo tile per connector and a switch that starts off', () => {
    const notion = connector('notion', { state: 'connected', tools: [] });
    const html = render([github, notion]);
    expect(html.match(/class="connector-logo"/g)).toHaveLength(2);
    expect(html).toContain('role="switch"');
    expect(html).not.toMatch(/role="switch"[^>]*checked/);
    expect(html).toContain('Off');
    // Tools only appear once the connector is switched on.
    expect(html).not.toContain('get_issue');
  });

  it('shows the not-connected hint for a connector that is not connected', () => {
    const html = render([
      connector('notion', { state: 'missing_env', missing: ['X'], tools: [] }),
    ]);
    expect(html).toContain('Not connected — tools appear once it is connected');
  });

  it('shows an empty state without connectors and skips disabled ones', () => {
    expect(render([])).toContain(
      'No connectors yet. Add one in Settings → Connectors.',
    );
    const off = connector(
      'off',
      { state: 'disabled', tools: [] },
      { enabled: false },
    );
    const html = render([off]);
    expect(html).not.toContain('data-connector');
    expect(html).toContain('Settings → Connectors');
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

  it('selects all reads without dropping ticked write tools', () => {
    const tools = github.status.tools;
    expect(
      selectAllReads({ connectorId: github.id, tools: [] }, tools).tools,
    ).toBe('*');
    expect(
      selectAllReads({ connectorId: github.id, tools: ['create_issue'] }, tools)
        .tools,
    ).toEqual(['create_issue', 'get_issue']);
  });
});

describe('ApprovalModeField', () => {
  it('shows three option cards with titles and descriptions as a radio group', () => {
    const html = renderToStaticMarkup(
      <ApprovalModeField value="sensitive" onChange={() => {}} />,
    );
    expect(html).toContain('id="dot-approval-mode"');
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html.match(/class="dp-option"/g)).toHaveLength(3);
    expect(html).toContain('Ask before sensitive actions');
    expect(html).toContain('Ask before any change');
    expect(html).toContain('Never ask');
    expect(html).toContain(
      'Sending, paying, deleting and destructive commands wait for you.',
    );
    expect(html).toContain('Anything that changes data waits for you.');
    expect(html).toContain(
      'The Dot acts without asking. Password and code steps still come to you.',
    );
  });

  it('marks the recommended mode and checks only the selected card', () => {
    const html = renderToStaticMarkup(
      <ApprovalModeField value="writes" onChange={() => {}} />,
    );
    expect(html.match(/Recommended/g)).toHaveLength(1);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toMatch(/checked="" value="writes"/);
    expect(html).toContain('data-selected="true"');
  });

  it('warns in red only for "off"', () => {
    const off = renderToStaticMarkup(
      <ApprovalModeField value="off" onChange={() => {}} />,
    );
    expect(off).toContain(
      'The Dot will send, pay, delete and publish without asking. Handoff for passwords and codes still applies.',
    );
    expect(off).toContain('dp-warning');
    const sensitive = renderToStaticMarkup(
      <ApprovalModeField value="sensitive" onChange={() => {}} />,
    );
    expect(sensitive).not.toContain('dp-warning');
    expect(sensitive).not.toContain('will send, pay, delete');
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
    expect(html).toContain('role="tab"');
    for (const tab of ['General', 'Connectors', 'About'])
      expect(html).toContain(tab);
    expect(html).toContain('Service setup');
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
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/checked="" value="sensitive"/);
    expect(html).not.toContain('will send, pay, delete');
  });
});
