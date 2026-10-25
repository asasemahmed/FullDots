import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
}));
import {
  ConnectorSheet,
  validateDraft,
  type SheetTarget,
} from '../src/client/ConnectorSheet';
import { AddAction, RegistryCard } from '../src/client/RegistryDiscover';
import {
  LOCAL_PROGRAMS_DOCS_URL,
  connectorNameFor,
  draftCommandLine,
  registryAddPlan,
  type RegistryAdd,
} from '../src/client/registry-connector';
import { connectorPresets } from '../src/shared/connector-presets';
import type { RegistryServer } from '../src/shared/registry';
import type { ConnectorAuthController } from '../src/client/useConnectorAuth';

// Nothing in this file may reach the network or save a connector.
afterEach(() => {
  vi.restoreAllMocks();
});

const server = (extra: Partial<RegistryServer> = {}): RegistryServer => ({
  name: 'io.github.example/notes',
  title: 'Notes',
  description: 'Read and write notes',
  version: '1.2.3',
  remotes: [],
  packages: [],
  ...extra,
});

const npmPackage = {
  registryType: 'npm',
  identifier: '@example/notes',
  version: '1.2.3',
  transport: 'stdio',
  envNames: ['NOTES_TOKEN', 'NOTES_REGION'],
};

const remote = (url: string, type = 'streamable-http') => [{ type, url }];

function expectDraft(plan: RegistryAdd) {
  if (plan.kind !== 'draft')
    throw new Error(`expected a draft, got ${plan.kind}`);
  return plan.draft;
}

describe('connectorNameFor', () => {
  it('uses the title when there is one, else the last part of the registry name', () => {
    expect(connectorNameFor(server())).toBe('Notes');
    expect(connectorNameFor(server({ title: undefined }))).toBe('notes');
  });

  it('keeps the name inside the form rules', () => {
    expect(
      connectorNameFor(
        server({
          title:
            '  --Weather: Forecasts & Alerts for every city in the world--  ',
        }),
      ),
    ).toMatch(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/);
    expect(connectorNameFor(server({ title: '!!!' }))).toBe('Registry server');
  });
});

describe('registryAddPlan: remote servers', () => {
  it('prefills an http connector with the name, URL and no rows', () => {
    const draft = expectDraft(
      registryAddPlan(
        server({ remotes: remote('https://notes.example/mcp') }),
        false,
      ),
    );
    expect(draft).toEqual({
      name: 'Notes',
      transport: 'http',
      url: 'https://notes.example/mcp',
      command: '',
      args: '',
      cwd: '',
      rows: [],
    });
  });

  it('accepts a server-sent-events endpoint as an http connector', () => {
    const draft = expectDraft(
      registryAddPlan(
        server({ remotes: remote('https://notes.example/sse', 'sse') }),
        false,
      ),
    );
    expect(draft.transport).toBe('http');
    expect(draft.url).toBe('https://notes.example/sse');
  });

  it('refuses an address with credentials in it', () => {
    const plan = registryAddPlan(
      server({ remotes: remote('https://user:secret@notes.example/mcp') }),
      false,
    );
    expect(plan.kind).toBe('unsupported');
    expect(plan.kind === 'unsupported' && plan.reason).toContain('refused');
  });

  it('refuses an address that is not http or https', () => {
    const plan = registryAddPlan(
      server({ remotes: remote('ftp://notes.example/mcp') }),
      false,
    );
    expect(plan.kind).toBe('unsupported');
  });

  it('refuses an address with a placeholder that needs a value', () => {
    const plan = registryAddPlan(
      server({ remotes: remote('https://{region}.notes.example/mcp') }),
      false,
    );
    expect(plan.kind === 'unsupported' && plan.reason).toContain('placeholder');
  });

  it('prefers the hosted endpoint over a local package', () => {
    const plan = registryAddPlan(
      server({
        remotes: remote('https://notes.example/mcp'),
        packages: [npmPackage],
      }),
      true,
    );
    expect(expectDraft(plan).transport).toBe('http');
  });
});

describe('registryAddPlan: local programs', () => {
  it('pins the npm version and lists the env names empty, when stdio is allowed', () => {
    const draft = expectDraft(
      registryAddPlan(server({ packages: [npmPackage] }), true),
    );
    expect(draft.transport).toBe('stdio');
    expect(draft.command).toBe('npx');
    expect(draft.args).toBe('-y\n@example/notes@1.2.3');
    expect(draft.auth).toBe('none');
    expect(draft.rows).toEqual([
      { name: 'NOTES_TOKEN', kind: 'env', value: '' },
      { name: 'NOTES_REGION', kind: 'env', value: '' },
    ]);
    expect(draftCommandLine(draft)).toBe('npx -y @example/notes@1.2.3');
  });

  it('pins the PyPI version with uvx', () => {
    const draft = expectDraft(
      registryAddPlan(
        server({
          packages: [
            {
              ...npmPackage,
              registryType: 'pypi',
              identifier: 'notes-mcp',
              version: '0.3.0',
              envNames: [],
            },
          ],
        }),
        true,
      ),
    );
    expect(draftCommandLine(draft)).toBe('uvx notes-mcp==0.3.0');
    expect(draft.rows).toEqual([]);
  });

  it('says why it cannot be added while CONNECTORS_ALLOW_STDIO is off', () => {
    const plan = registryAddPlan(server({ packages: [npmPackage] }), false);
    expect(plan.kind).toBe('local-off');
    expect(plan.kind === 'local-off' && plan.reason).toContain(
      'CONNECTORS_ALLOW_STDIO=true',
    );
    expect(LOCAL_PROGRAMS_DOCS_URL).toContain(
      'docs/CONNECTORS.md#local-programs-stdio-and-host-trust',
    );
  });

  it('says so for an unsupported package type', () => {
    const plan = registryAddPlan(
      server({
        packages: [
          {
            ...npmPackage,
            registryType: 'oci',
            identifier: 'ghcr.io/x/notes',
            version: '1.2.3',
          },
        ],
      }),
      true,
    );
    expect(plan.kind).toBe('unsupported');
    expect(plan.kind === 'unsupported' && plan.reason).toContain('oci');
  });

  it('refuses a package that runs its own web server', () => {
    const plan = registryAddPlan(
      server({ packages: [{ ...npmPackage, transport: 'streamable-http' }] }),
      true,
    );
    expect(plan.kind === 'unsupported' && plan.reason).toContain(
      'runs its own streamable-http server',
    );
  });

  it('refuses a package with no version, rather than using latest', () => {
    const plan = registryAddPlan(
      server({ packages: [{ ...npmPackage, version: undefined }] }),
      true,
    );
    expect(plan.kind === 'unsupported' && plan.reason).toContain('pinned');
  });

  it('refuses "latest" and version ranges, even though the registry sent them', () => {
    for (const version of ['latest', '^1.2.3', '1.x', '>=1.0.0']) {
      const plan = registryAddPlan(
        server({ packages: [{ ...npmPackage, version }] }),
        true,
      );
      expect(plan.kind, version).toBe('unsupported');
    }
  });

  it('refuses a package name that would read as a flag to npx', () => {
    const plan = registryAddPlan(
      server({ packages: [{ ...npmPackage, identifier: '--yes-anything' }] }),
      true,
    );
    expect(plan.kind).toBe('unsupported');
  });

  it('prefers an npm or PyPI package over an unsupported one listed first', () => {
    const draft = expectDraft(
      registryAddPlan(
        server({
          packages: [{ ...npmPackage, registryType: 'oci' }, npmPackage],
        }),
        true,
      ),
    );
    expect(draftCommandLine(draft)).toBe('npx -y @example/notes@1.2.3');
  });
});

describe('registryAddPlan: nothing to add', () => {
  it('says so when the entry lists no endpoint or package', () => {
    const plan = registryAddPlan(server(), true);
    expect(plan.kind).toBe('unsupported');
  });
});

describe('a prefilled local program needs its env values before Save', () => {
  it('reports each env name that has no value', () => {
    const draft = expectDraft(
      registryAddPlan(server({ packages: [npmPackage] }), true),
    );
    const errors = validateDraft(draft);
    expect(errors.some((error) => error.startsWith('NOTES_TOKEN:'))).toBe(true);
    expect(errors.some((error) => error.startsWith('NOTES_REGION:'))).toBe(
      true,
    );
  });
});

describe('the Add control', () => {
  it('only opens the form: one click calls onAdd with the draft and fetches nothing', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onAdd = vi.fn();
    const element = AddAction({
      server: server({ remotes: remote('https://notes.example/mcp') }),
      allowStdio: false,
      onAdd,
    });
    const button = findButtons(element)[0];
    expect(button?.props.disabled).toBeFalsy();
    (button!.props.onClick as () => void)();
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0]?.[0]).toMatchObject({
      name: 'Notes',
      url: 'https://notes.example/mcp',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is disabled and explains the setting while local programs are off', () => {
    const markup = renderToStaticMarkup(
      <RegistryCard
        server={server({ packages: [npmPackage] })}
        allowStdio={false}
        onAdd={vi.fn()}
      />,
    );
    expect(markup).toContain('disabled');
    expect(markup).toContain('CONNECTORS_ALLOW_STDIO=true');
    expect(markup).toContain('#local-programs-stdio-and-host-trust');
  });

  it('shows the reason and no button for an unsupported entry', () => {
    const markup = renderToStaticMarkup(
      <RegistryCard
        server={server({
          packages: [{ ...npmPackage, registryType: 'oci' }],
        })}
        allowStdio
        onAdd={vi.fn()}
      />,
    );
    expect(markup).toContain('cannot be added from here yet');
    expect(markup).not.toContain('<button');
  });

  it('is not shown at all where no add handler is given', () => {
    const markup = renderToStaticMarkup(
      <RegistryCard
        server={server({ remotes: remote('https://notes.example/mcp') })}
      />,
    );
    expect(markup).not.toContain('<button');
  });
});

describe('the connector sheet for a registry server', () => {
  const idle: ConnectorAuthController = {
    state: { phase: 'idle' },
    start: () => {},
    cancel: () => {},
    reset: () => {},
  };
  const render = (target: SheetTarget, allowStdio = true) =>
    renderToStaticMarkup(
      <ConnectorSheet
        target={target}
        connectors={[]}
        presets={connectorPresets}
        allowStdio={allowStdio}
        auth={idle}
        onClose={() => {}}
        onSaved={() => {}}
        onDeleted={() => {}}
      />,
    );

  it('shows the exact pinned command and the run sentence above Save, and saves nothing', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const draft = expectDraft(
      registryAddPlan(server({ packages: [npmPackage] }), true),
    );
    const markup = render({ kind: 'registry', draft });
    expect(markup).toContain('npx -y @example/notes@1.2.3');
    expect(markup).toContain(
      'This program will run on this machine when a Dot uses the connector.',
    );
    expect(markup).toContain('value="Notes"');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows the URL and no run sentence for a remote server', () => {
    const draft = expectDraft(
      registryAddPlan(
        server({ remotes: remote('https://notes.example/mcp') }),
        false,
      ),
    );
    const markup = render({ kind: 'registry', draft }, false);
    expect(markup).toContain('value="https://notes.example/mcp"');
    expect(markup).not.toContain('will run on this machine');
  });
});

/** Every button element in a React element tree (not rendering it). */
function findButtons(node: unknown): { props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap(findButtons);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as { type: unknown; props: Record<string, unknown> };
  const own = element.type === 'button' ? [element] : [];
  return [...own, ...findButtons(element.props.children)];
}
