import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
}));
import {
  ConnectorGallery,
  STDIO_OFF_NOTE,
  authCaption,
  connectorTitle,
  filterConnectors,
  filterPresets,
  groupPresets,
  prettyName,
} from '../src/client/ConnectorGallery';
import {
  ConnectorForm,
  ConnectorSheet,
  connectorToDraft,
  draftToBody,
  emptyDraft,
  groupTools,
  nameFromUrl,
  presetToDraft,
  tokenDraft,
  urlProblem,
  validateDraft,
  type SheetTarget,
} from '../src/client/ConnectorSheet';
import { ConnectorsSettings } from '../src/client/ConnectorsSettings';
import {
  AUTH_MESSAGE_TYPE,
  AuthorizeError,
  acceptAuthMessage,
  beginAuthorization,
  navigateAuthPopup,
  openAuthPopup,
  safeAuthUrl,
  type AuthDeps,
  type AuthState,
  type ConnectorAuthController,
  type PopupLike,
} from '../src/client/useConnectorAuth';
import { WorkspaceDialog, readStoredTab } from '../src/client/WorkspaceDialog';
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
  toolName: `mcp__x__${name}`,
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
    url: `https://${name}.example.com/mcp`,
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

const preset = (id: string) => connectorPresets.find((p) => p.id === id)!;
/** The card (or sheet section) markup for one preset id. */
const presetCard = (html: string, id: string) =>
  html.split(`data-preset="${id}"`)[1]!.split('data-preset=')[0]!;
const countOf = (html: string, needle: string) => html.split(needle).length - 1;

const noop = () => {};
function renderGallery(
  connectors: ConnectorView[],
  allowStdio = true,
  extra: Partial<Parameters<typeof ConnectorGallery>[0]> = {},
) {
  return renderToStaticMarkup(
    <ConnectorGallery
      connectors={connectors}
      presets={connectorPresets}
      allowStdio={allowStdio}
      onOpenConnector={noop}
      onConnect={noop}
      onOpenPreset={noop}
      onCustom={noop}
      {...extra}
    />,
  );
}

const idle: ConnectorAuthController = {
  state: { phase: 'idle' },
  start: noop,
  cancel: noop,
  reset: noop,
};
const authIn = (state: AuthState): ConnectorAuthController => ({
  ...idle,
  state,
});

function renderSheet(
  target: SheetTarget,
  connectors: ConnectorView[] = [],
  auth: ConnectorAuthController = idle,
  allowStdio = true,
) {
  return renderToStaticMarkup(
    <ConnectorSheet
      target={target}
      connectors={connectors}
      presets={connectorPresets}
      allowStdio={allowStdio}
      auth={auth}
      onClose={noop}
      onSaved={noop}
      onDeleted={noop}
    />,
  );
}

describe('ConnectorGallery', () => {
  const mine = [
    connector(
      'linear',
      { state: 'needs_auth', tools: [] },
      { presetId: 'linear', auth: 'oauth', url: 'https://mcp.linear.app/mcp' },
    ),
    connector(
      'github',
      { state: 'connected', tools: [tool('a'), tool('b')] },
      { presetId: 'github', auth: 'token' },
    ),
    connector('mine', {
      state: 'error',
      error: 'Server said no (401)',
      tools: [],
    }),
  ];

  it('renders a card with a logo for every connector, preset and the custom card', () => {
    const html = renderGallery(mine);
    // The 4-space gap in the logo count: connectors + presets + custom.
    expect(html.match(/class="connector-logo[ "]/g)?.length ?? 0).toBe(
      mine.length + connectorPresets.length + 1,
    );
    for (const item of mine)
      expect(html).toContain(`data-connector="${item.name}"`);
    for (const item of connectorPresets)
      expect(html).toContain(`data-preset="${item.id}"`);
    expect(html).toContain('data-preset="custom"');
    expect(html).toContain('Custom connector');
    // Logos are 56px tiles.
    expect(html).toContain('width:56px;height:56px');
  });

  it('shows the header copy, search and the three filters', () => {
    const html = renderGallery(mine);
    expect(html).toContain('>Connectors<');
    expect(html).toContain(
      'Give your Dots access to the tools you use. Sign in with your browser — secrets stay on this computer.',
    );
    expect(html).toContain('type="search"');
    expect(html).toContain('>All<');
    expect(html).toContain('>Connected<');
    expect(html).toContain('Needs attention');
    expect(html).toContain('Your connectors');
    expect(html).toContain('Add a connector');
  });

  it('captions presets by how they sign in', () => {
    const html = renderGallery([]);
    expect(presetCard(html, 'linear')).toContain('Browser sign-in');
    expect(presetCard(html, 'github')).toContain('Token');
    expect(presetCard(html, 'cloudflare-docs')).toContain('No sign-in');
    expect(presetCard(html, 'filesystem')).toContain('Local program');
    expect(authCaption(preset('linear')).label).toBe('Browser sign-in');
    expect(authCaption(preset('github')).label).toBe('Token');
    expect(authCaption(preset('fetch')).label).toBe('Local program');
  });

  it('puts Connect on a needs_auth card, a Connected check on a connected one', () => {
    const html = renderGallery(mine);
    const linear = html
      .split('data-connector="linear"')[1]!
      .split('data-connector=')[0]!;
    expect(linear).toContain('>Connect<');
    expect(linear).toContain('data-state="needs_auth"');
    expect(linear).toContain('Not connected');
    const github = html
      .split('data-connector="github"')[1]!
      .split('data-connector=')[0]!;
    expect(github).not.toContain('>Connect<');
    expect(github).toContain('data-state="connected"');
    expect(github).toContain('cn-pill-ok');
    expect(github).toContain('2 tools');
    // The error reason is shown on its card.
    expect(html).toContain('Server said no (401)');
    expect(html).toContain('cn-pill-bad');
  });

  it('marks presets that are already added', () => {
    const html = renderGallery(mine);
    expect(presetCard(html, 'linear')).toContain('Added');
    expect(presetCard(html, 'github')).toContain('Added');
    expect(presetCard(html, 'notion')).not.toContain('Added');
  });

  it('disables local-program presets, with the note, when stdio is off', () => {
    const off = renderGallery([], false);
    expect(off).toContain(STDIO_OFF_NOTE);
    const filesystem = presetCard(off, 'filesystem');
    expect(filesystem).toMatch(/<button[^>]*disabled=""/);
    expect(filesystem).toContain('Off on this server');
    expect(presetCard(off, 'github')).not.toContain('disabled=""');
    const on = renderGallery([], true);
    expect(on).not.toContain(STDIO_OFF_NOTE);
    expect(presetCard(on, 'filesystem')).not.toContain('disabled=""');
  });

  it('groups presets under category headings', () => {
    const html = renderGallery([]);
    for (const heading of ['Work', 'Developer tools', 'Data', 'Files', 'Web'])
      expect(html).toContain(`>${heading}</h5>`);
    const groups = groupPresets(connectorPresets);
    expect(groups.map((g) => g.category)).toEqual([
      'work',
      'dev',
      'data',
      'files',
      'web',
    ]);
    expect(groups.flatMap((g) => g.presets)).toHaveLength(
      connectorPresets.length,
    );
  });

  it('filters by search text and by status', () => {
    expect(filterConnectors(mine, 'lin', 'all').map((c) => c.name)).toEqual([
      'linear',
    ]);
    expect(filterConnectors(mine, '', 'connected').map((c) => c.name)).toEqual([
      'github',
    ]);
    expect(filterConnectors(mine, '', 'attention').map((c) => c.name)).toEqual([
      'linear',
      'mine',
    ]);
    expect(
      filterPresets(connectorPresets, 'postgres').map((p) => p.id),
    ).toEqual(expect.arrayContaining(['supabase', 'neon']));
    expect(filterPresets(connectorPresets, 'zzzz')).toEqual([]);
    const html = renderGallery(mine, true, { initialQuery: 'supabase' });
    expect(html).toContain('data-preset="supabase"');
    expect(html).not.toContain('data-preset="notion"');
  });

  it('uses friendly names', () => {
    expect(prettyName('github')).toBe('GitHub');
    expect(prettyName('cloudflare-docs')).toBe('Cloudflare Docs');
    expect(prettyName('my-tool')).toBe('My Tool');
    expect(connectorTitle(mine[1]!)).toBe('GitHub');
    expect(connectorTitle(mine[2]!)).toBe('mine');
  });

  it('is what the Settings container renders', () => {
    const html = renderToStaticMarkup(
      <ConnectorsSettings
        initial={{
          connectors: mine,
          presets: connectorPresets,
          allowStdio: true,
        }}
      />,
    );
    expect(html).toContain('class="connector-logo"');
    expect(html).toContain('data-connector="linear"');
    expect(html).not.toContain('cs-page');
  });
});

describe('ConnectorSheet', () => {
  const tools = [
    tool('get_issue', {
      readOnly: true,
      description: 'Read one issue.\nMore.',
    }),
    tool('list_issues', { readOnly: true }),
    tool('create_issue'),
    tool('delete_repo', { destructive: true }),
  ];

  it('an OAuth preset offers Connect with browser and shows no header rows', () => {
    const html = renderSheet({ kind: 'preset', preset: preset('linear') });
    // A page that replaces the gallery, with the way back and a sticky footer.
    expect(html).toContain('class="cs-page"');
    expect(html).toContain('Back to connectors');
    expect(html).toContain('cs-footer');
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain('Connect with browser');
    expect(html).toContain('Use a token instead');
    expect(html).toContain('class="connector-logo"');
    expect(html).toContain('width:56px;height:56px');
    expect(html).toContain('Docs');
    expect(html).not.toContain('cn-value-row');
    expect(html).not.toContain('>Headers<');
    expect(html).not.toContain('Authorization');
    // No token alternative for a provider without one.
    const notion = renderSheet({ kind: 'preset', preset: preset('notion') });
    expect(notion).toContain('Connect with browser');
    expect(notion).not.toContain('Use a token instead');
  });

  it('shows a provider caveat next to the button', () => {
    const html = renderSheet({ kind: 'preset', preset: preset('intercom') });
    expect(html).toContain('only allows localhost or 127.0.0.1');
  });

  it('a token preset shows the .env line and a Copy button', () => {
    const html = renderSheet({ kind: 'preset', preset: preset('github') });
    expect(html).toContain('GITHUB_TOKEN=');
    expect(html).toContain('Copy');
    expect(html).toContain('<ol');
    expect(html).toContain('Create a token');
    expect(html).toContain('Save and test');
    expect(html).not.toContain('Connect with browser');
  });

  it('token set status comes from an existing connector reference', () => {
    const gh = connector(
      'github',
      { state: 'connected', tools: [] },
      {
        presetId: 'github',
        auth: 'token',
        headers: { Authorization: { env: 'GITHUB_TOKEN', set: true } },
      },
    );
    const html = renderSheet({ kind: 'connector', id: gh.id }, [gh]);
    expect(html).toContain('cn-set');
    expect(html).toContain(' Set</span>');
    const unset = {
      ...gh,
      headers: { Authorization: { env: 'GITHUB_TOKEN', set: false } },
    };
    expect(renderSheet({ kind: 'connector', id: gh.id }, [unset])).toContain(
      'Not set',
    );
  });

  it('a connected connector groups its tools and offers the management actions', () => {
    const linear = connector(
      'linear',
      {
        state: 'connected',
        tools,
        account: 'alice@example.com',
        authorized: true,
        authorizedAt: Date.UTC(2026, 9, 8, 12),
      },
      { presetId: 'linear', auth: 'oauth', url: 'https://mcp.linear.app/mcp' },
    );
    const html = renderSheet({ kind: 'connector', id: linear.id }, [linear]);
    expect(html).toContain('Connected as alice@example.com');
    expect(html).toContain('since Oct 8, 2026');
    for (const group of ['Reads', 'Changes data', 'Destructive'])
      expect(html).toContain(group);
    expect(html).toContain('cs-dot-reads');
    expect(html).toContain('cs-dot-changes');
    expect(html).toContain('cs-dot-destructive');
    // Tools sit under their group, in order.
    expect(html.indexOf('get_issue')).toBeLessThan(
      html.indexOf('create_issue'),
    );
    expect(html.indexOf('create_issue')).toBeLessThan(
      html.indexOf('delete_repo'),
    );
    expect(html).toContain('Read one issue.');
    expect(html).not.toContain('More.');
    for (const action of ['Reload tools', 'Disconnect', 'Edit', 'Delete'])
      expect(html).toContain(action);
    expect(html).not.toContain('Connect with browser');
    expect(groupTools(tools).map((g) => [g.id, g.tools.length])).toEqual([
      ['reads', 2],
      ['changes', 1],
      ['destructive', 1],
    ]);
  });

  it('reconnect wording once a connector had access', () => {
    const lost = connector(
      'linear',
      { state: 'needs_auth', tools: [], authorizedAt: 5 },
      { presetId: 'linear', auth: 'oauth' },
    );
    const html = renderSheet({ kind: 'connector', id: lost.id }, [lost]);
    expect(html).toContain('Reconnect with browser');
    expect(html).not.toContain('Disconnect');
  });

  it('shows the waiting state, and a blocked pop-up as a link that never prints the URL', () => {
    const link = 'https://auth.example.com/authorize?state=SECRETSTATE123';
    const linear = connector(
      'linear',
      { state: 'needs_auth', tools: [] },
      { presetId: 'linear', auth: 'oauth' },
    );
    const target = { kind: 'connector', id: linear.id } as const;
    const blocked = renderSheet(
      target,
      [linear],
      authIn({
        phase: 'waiting',
        connectorId: linear.id,
        link,
        blocked: true,
      }),
    );
    expect(blocked).toContain('Waiting for the browser');
    expect(blocked).toContain('Your browser blocked the pop-up.');
    expect(blocked).toContain('Open the sign-in page');
    expect(blocked).toContain(`href="${link}"`);
    expect(blocked).toContain('target="_blank"');
    expect(blocked).toContain('rel="noopener"');
    expect(blocked.replace(/href="[^"]*"/g, '')).not.toContain('SECRETSTATE');
    expect(blocked.replace(/href="[^"]*"/g, '')).not.toContain('auth.example');
    const open = renderSheet(
      target,
      [linear],
      authIn({
        phase: 'waiting',
        connectorId: linear.id,
        link,
        blocked: false,
      }),
    );
    expect(open).toContain('Finish signing in in the window that opened');
    expect(open).toContain('Open the sign-in page again');
    expect(open).toContain('>Cancel<');
  });

  it('shows why a sign-in failed, with the token alternative and Try again', () => {
    const linear = connector(
      'linear',
      { state: 'needs_auth', tools: [] },
      { presetId: 'linear', auth: 'oauth' },
    );
    const html = renderSheet(
      { kind: 'connector', id: linear.id },
      [linear],
      authIn({
        phase: 'failed',
        connectorId: linear.id,
        message: 'This server does not support automatic registration.',
        hint: 'token',
      }),
    );
    expect(html).toContain(
      'This server does not support automatic registration.',
    );
    expect(html).toContain('Try again');
    expect(html).toContain('Use a token instead');
  });

  it('never prints a secret value, whatever the headers hold', () => {
    const gh = connector(
      'github',
      { state: 'connected', tools: [tool('a')] },
      {
        presetId: 'github',
        auth: 'token',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: {
          Authorization: { env: 'GITHUB_TOKEN', set: true },
          'X-Api-Key': { literal: SECRET_VALUE },
          Cookie: { literal: SECRET_VALUE },
          'Notion-Version': { literal: '2022-06-28' },
        },
        env: { SESSION_COOKIE: { literal: SECRET_VALUE } },
      },
    );
    const target = { kind: 'connector', id: gh.id } as const;
    const html = [
      renderSheet(target, [gh]),
      renderSheet({ kind: 'preset', preset: preset('github') }, [gh]),
      renderGallery([gh]),
    ].join('');
    expect(html).not.toContain(SECRET_VALUE);
    expect(html).not.toContain('PLANTEDSECRET');
    expect(html).toContain('GITHUB_TOKEN');
    expect(html).toContain('2022-06-28');
    // The edit form keeps the same rule.
    expect(
      renderSheet(target, [{ ...gh, headers: { ...gh.headers } }]),
    ).not.toContain('PLANTEDSECRET');
  });

  it('a custom connector is a set of numbered steps with a sign-in choice', () => {
    const custom = renderSheet({ kind: 'custom' });
    for (const step of [
      'Where does it run?',
      'Connection',
      'How does it sign in?',
    ])
      expect(custom).toContain(step);
    expect(custom).toContain('Remote server (URL)');
    expect(custom).toContain('Local program');
    expect(custom).toContain('https://example.com/mcp');
    expect(custom).toContain('Browser sign-in');
    expect(custom).toContain('>Token<');
    expect(custom).toContain('>None<');
    expect(custom).toContain('type="radio"');
    expect(custom).toContain('Advanced');
    expect(custom).toContain('Add connector');
    expect(custom).toContain('>Cancel<');
    // No native select, fieldset or amber note; the local option stays enabled.
    expect(custom).not.toContain('<select');
    expect(custom).not.toContain('<fieldset');
    expect(custom).not.toContain(STDIO_OFF_NOTE);
    expect(custom).not.toMatch(/<input[^>]*disabled=""[^>]*value="stdio"/);
    const stdio = renderSheet({ kind: 'preset', preset: preset('filesystem') });
    expect(stdio).toContain('Command');
    expect(stdio).toContain('server-filesystem');
    // A preset has its transport fixed: no "Where does it run?" step.
    expect(stdio).not.toContain('Where does it run?');
    const off = renderSheet(
      { kind: 'preset', preset: preset('filesystem') },
      [],
      idle,
      false,
    );
    expect(off).toContain(STDIO_OFF_NOTE);
  });

  it('locks the local option, with a muted explanation, when stdio is off', () => {
    const html = renderSheet({ kind: 'custom' }, [], idle, false);
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*value="stdio"/);
    expect(html).toContain(STDIO_OFF_NOTE);
    expect(html).toContain('cs-hint');
    expect(html).not.toContain('cn-note-warn');
  });

  it('shows the token fields, with the set state, once Token is chosen', () => {
    const gh = connector(
      'github',
      { state: 'connected', tools: [] },
      {
        presetId: 'github',
        auth: 'token',
        headers: { Authorization: { env: 'GITHUB_TOKEN', set: true } },
      },
    );
    const form = renderToStaticMarkup(
      <ConnectorForm
        draft={connectorToDraft(gh)}
        allowStdio
        busy={false}
        problems={[]}
        warnings={[]}
        envStatus={new Map([['GITHUB_TOKEN', true]])}
        onChange={noop}
        onSave={noop}
        onCancel={noop}
      />,
    );
    expect(form).toContain('Environment variable');
    expect(form).toContain('value="GITHUB_TOKEN"');
    expect(form).toContain('cn-set');
    expect(form).toContain('Change header');
    expect(form).toContain('<strong>Authorization</strong>');
    // The token row is edited above, not listed again under Advanced.
    expect(form).not.toContain('Remove row');
  });
});

describe('custom connector helpers', () => {
  it('names a connector after its host', () => {
    expect(nameFromUrl('https://mcp.linear.app/mcp')).toBe('linear');
    expect(nameFromUrl('https://api.example.com/v1')).toBe('example');
    expect(nameFromUrl('https://www.example.co.uk/mcp')).toBe('example');
    expect(nameFromUrl('http://localhost:3000/mcp')).toBe('localhost');
    expect(nameFromUrl('http://127.0.0.1:8080')).toBe('127-0-0-1');
    expect(nameFromUrl('not a url')).toBe('');
    expect(nameFromUrl('')).toBe('');
    // Always a name the server accepts.
    for (const url of [
      'https://mcp.linear.app/mcp',
      'http://127.0.0.1:8080',
      'https://my_tool.example.com',
    ])
      expect(
        validateDraft({ ...emptyDraft(), name: nameFromUrl(url), url }),
      ).toEqual([]);
  });

  it('asks for https, or http on localhost', () => {
    expect(urlProblem('')).toBe('');
    expect(urlProblem('https://example.com/mcp')).toBe('');
    expect(urlProblem('http://localhost:8787/mcp')).toBe('');
    expect(urlProblem('http://127.0.0.1/mcp')).toBe('');
    for (const bad of ['http://example.com/mcp', 'example.com', 'ftp://x.io'])
      expect(urlProblem(bad)).toBe('Use https:// (http only for localhost)');
  });
});

describe('connector drafts and bodies', () => {
  it('copies the preset auth into the create body', () => {
    const body = draftToBody({ ...presetToDraft(preset('linear')) });
    expect(body).toMatchObject({
      name: 'linear',
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      auth: 'oauth',
      presetId: 'linear',
      headers: {},
    });
    expect(draftToBody(presetToDraft(preset('github')))).toMatchObject({
      auth: 'token',
      headers: { Authorization: { env: 'GITHUB_TOKEN' } },
    });
    // A draft that never chose leaves auth to the server's default.
    expect('auth' in draftToBody({ ...emptyDraft(), name: 'x' })).toBe(false);
  });

  it('builds the token alternative from the preset tokenEnv', () => {
    const linear = preset('linear');
    const body = draftToBody(
      tokenDraft(presetToDraft(linear), linear.tokenEnv!),
    );
    expect(body.auth).toBe('token');
    expect(body.headers).toEqual({ Authorization: { env: 'LINEAR_API_KEY' } });
    const sentry = preset('sentry');
    expect(
      draftToBody(tokenDraft(presetToDraft(sentry), sentry.tokenEnv!)).headers,
    ).toEqual({ Authorization: { env: 'SENTRY_ACCESS_TOKEN' } });
    // The body never carries a secret, only a reference.
    expect(JSON.stringify(body)).not.toMatch(/ghp_|Bearer /);
  });

  it('rejects an Authorization header with browser sign-in', () => {
    const draft = {
      ...presetToDraft(preset('linear')),
      rows: [{ name: 'Authorization', kind: 'env' as const, value: 'X_TOKEN' }],
    };
    expect(validateDraft(draft).join(' ')).toContain('sets the Authorization');
    expect(validateDraft({ ...draft, auth: 'token' })).toEqual([]);
    expect(
      validateDraft({
        ...emptyDraft(),
        name: 'x',
        transport: 'stdio',
        command: 'npx',
        auth: 'oauth',
      }).join(' '),
    ).toContain('remote servers only');
  });
});

describe('browser sign-in message handling', () => {
  const origin = 'http://127.0.0.1:5174';
  const popup = { name: 'popup' };
  const good = { type: AUTH_MESSAGE_TYPE, connectorId: 'c1', ok: true };
  const expected = { origin, connectorId: 'c1', source: popup };

  it('accepts the right message from the right place', () => {
    expect(
      acceptAuthMessage({ origin, source: popup, data: good }, expected),
    ).toEqual({ ok: true, message: '' });
    expect(
      acceptAuthMessage(
        {
          origin,
          source: popup,
          data: { ...good, ok: false, message: 'denied' },
        },
        expected,
      ),
    ).toEqual({ ok: false, message: 'denied' });
    // Without a popup of our own (blocked), the source is not checked.
    expect(
      acceptAuthMessage(
        { origin, source: {}, data: good },
        { origin, connectorId: 'c1' },
      ),
    ).toEqual({ ok: true, message: '' });
  });

  it('rejects other origins, sources, types and connector ids', () => {
    const reject = (event: Parameters<typeof acceptAuthMessage>[0]) =>
      expect(acceptAuthMessage(event, expected)).toBeUndefined();
    reject({ origin: 'https://evil.example', source: popup, data: good });
    reject({ origin: 'http://127.0.0.1:5173', source: popup, data: good });
    reject({ origin, source: {}, data: good });
    reject({ origin, source: null, data: good });
    reject({ origin, source: popup, data: { ...good, type: 'other' } });
    reject({ origin, source: popup, data: { ...good, connectorId: 'c2' } });
    reject({
      origin,
      source: popup,
      data: { ...good, connectorId: undefined },
    });
    reject({ origin, source: popup, data: 'fulldots:connector-auth' });
    reject({ origin, source: popup, data: null });
  });

  it('only http(s) URLs may become the sign-in link', () => {
    expect(safeAuthUrl('https://a.example/x?y=1')).toBe(
      'https://a.example/x?y=1',
    );
    expect(safeAuthUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeAuthUrl('data:text/html,hi')).toBeUndefined();
    expect(safeAuthUrl('not a url')).toBeUndefined();
    expect(safeAuthUrl(undefined)).toBeUndefined();
  });
});

describe('starting the browser sign-in', () => {
  afterEach(() => vi.unstubAllGlobals());

  const makePopup = () => {
    const popup = {
      closed: false,
      close: vi.fn(),
      location: { replace: vi.fn() },
    };
    return popup satisfies PopupLike;
  };

  it('opens the popup before any request is made', async () => {
    const events: string[] = [];
    const popup = makePopup();
    const deps: AuthDeps = {
      open: (url, name, features) => {
        events.push(`open:${url}:${name}`);
        expect(features).toContain('popup=yes');
        return popup;
      },
      authorize: async (id) => {
        events.push(`authorize:${id}`);
        return { authorizationUrl: 'https://auth.example/authorize?state=s' };
      },
    };
    const pending = beginAuthorization(async () => {
      events.push('resolve');
      return 'c1';
    }, deps);
    // Synchronously, before the first await settles, the popup is already open
    // and the authorize request has not been sent.
    const sync = [...events];
    expect(sync[0]).toBe('open::fulldots-connector-auth');
    expect(sync).not.toContain('authorize:c1');
    const result = await pending;
    expect(events).toEqual([
      'open::fulldots-connector-auth',
      'resolve',
      'authorize:c1',
    ]);
    expect(popup.location.replace).toHaveBeenCalledWith(
      'https://auth.example/authorize?state=s',
    );
    expect(result).toEqual({
      id: 'c1',
      authorized: false,
      url: 'https://auth.example/authorize?state=s',
      blocked: false,
    });
  });

  it('calls window.open before the authorize request (default deps)', async () => {
    const events: string[] = [];
    const popup = makePopup();
    vi.stubGlobal('window', {
      open: (url: string, name: string) => {
        events.push(`window.open:${name}`);
        return popup;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init: RequestInit) => {
        events.push(`fetch:${init.method}:${path}`);
        return new Response(
          JSON.stringify({
            authorizationUrl: 'https://auth.example/a?state=z',
          }),
          { status: 200 },
        );
      }),
    );
    const pending = beginAuthorization(() => 'conn 1');
    expect(events).toEqual(['window.open:fulldots-connector-auth']);
    await pending;
    expect(events).toEqual([
      'window.open:fulldots-connector-auth',
      'fetch:POST:/api/connectors/conn%201/authorize',
    ]);
    expect(popup.location.replace).toHaveBeenCalledOnce();
  });

  it('falls back to a link when the pop-up is blocked', async () => {
    const deps: AuthDeps = {
      open: () => null,
      authorize: async () => ({ authorizationUrl: 'https://auth.example/a' }),
    };
    expect(await beginAuthorization(() => 'c1', deps)).toEqual({
      id: 'c1',
      authorized: false,
      url: 'https://auth.example/a',
      blocked: true,
    });
    // A popup that refuses navigation counts as blocked too.
    const broken = makePopup();
    broken.location.replace.mockImplementation(() => {
      throw new Error('closed');
    });
    expect(
      (
        await navigateAuthPopup(broken, () => 'c1', {
          ...deps,
          open: () => broken,
        })
      ).blocked,
    ).toBe(true);
  });

  it('closes the popup when the server cannot start the sign-in', async () => {
    const popup = makePopup();
    const deps: AuthDeps = {
      open: () => popup,
      authorize: async () => {
        throw new AuthorizeError('No registration endpoint.', 'token');
      },
    };
    await expect(beginAuthorization(() => 'c1', deps)).rejects.toMatchObject({
      message: 'No registration endpoint.',
      hint: 'token',
    });
    expect(popup.close).toHaveBeenCalledOnce();
    // Creating the connector can fail too, before any authorize request.
    const second = makePopup();
    const authorize = vi.fn();
    await expect(
      beginAuthorization(
        () => {
          throw new Error('name already used');
        },
        { open: () => second, authorize },
      ),
    ).rejects.toThrow('name already used');
    expect(authorize).not.toHaveBeenCalled();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('closes the popup when a stored refresh already authorized the connector', async () => {
    const popup = makePopup();
    const result = await beginAuthorization(() => 'c1', {
      open: () => popup,
      authorize: async () => ({ authorized: true }),
    });
    expect(result).toMatchObject({ id: 'c1', authorized: true });
    expect(popup.close).toHaveBeenCalledOnce();
    expect(popup.location.replace).not.toHaveBeenCalled();
  });

  it('refuses a non-http(s) authorization URL', async () => {
    const popup = makePopup();
    await expect(
      beginAuthorization(() => 'c1', {
        open: () => popup,
        authorize: async () => ({ authorizationUrl: 'javascript:alert(1)' }),
      }),
    ).rejects.toThrow();
    expect(popup.location.replace).not.toHaveBeenCalled();
  });

  it('openAuthPopup uses the injected opener with fixed features', () => {
    const open = vi.fn(() => null);
    openAuthPopup({ open, authorize: vi.fn() });
    expect(open).toHaveBeenCalledWith(
      '',
      'fulldots-connector-auth',
      'popup=yes,width=600,height=760',
    );
  });
});

describe('Settings dialog tabs', () => {
  const workspace = {
    spaces: [],
    dots: [],
    setup: { missing: [], search: false, browser: false, voice: false },
  } as unknown as WorkspaceState;
  const state = {
    settings: { researchAllowed: true, memoryAllowed: true },
  } as unknown as State;
  const render = (tab?: 'general' | 'models' | 'connectors' | 'about') =>
    renderToStaticMarkup(
      <WorkspaceDialog
        dialog={{ type: 'settings', ...(tab ? { tab } : {}) }}
        state={state}
        workspace={workspace}
        onClose={noop}
        mutate={async () => true}
      />,
    );

  it('renders the four tabs, General selected, with Save on General only', () => {
    const html = render();
    expect(html).toContain('modal modal-settings');
    expect(html).toContain('role="tablist"');
    expect(countOf(html, 'role="tab"')).toBe(4);
    for (const label of ['General', 'Models', 'Connectors', 'About'])
      expect(html).toContain(label);
    expect(html).toMatch(/id="settings-tab-general"[^>]*aria-selected="true"/);
    expect(html).toMatch(
      /id="settings-tab-connectors"[^>]*aria-selected="false"/,
    );
    // Roving tabindex: only the selected tab is in the tab order.
    expect(html).toMatch(/id="settings-tab-general"[^>]*tabindex="0"/);
    expect(html).toMatch(/id="settings-tab-about"[^>]*tabindex="-1"/);
    expect(html).toContain('Service setup');
    expect(html).toContain('>Save<');
    // Models and connectors mount lazily, so nothing loads until a tab is opened.
    expect(html).not.toContain('Loading connectors');
    expect(html).not.toContain('Loading models');
  });

  it('opens straight on the Connectors tab without a Save button', () => {
    const html = render('connectors');
    expect(html).toMatch(
      /id="settings-tab-connectors"[^>]*aria-selected="true"/,
    );
    expect(html).toContain('Loading connectors');
    expect(html).not.toContain('>Save<');
    // The about copy stays in its own (hidden) panel.
    expect(html).toMatch(/id="settings-panel-about"[^>]*hidden=""/);
  });

  it('remembers nothing, and does not throw, when storage is unavailable', () => {
    expect(readStoredTab()).toBe('general');
  });
});
