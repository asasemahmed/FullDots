import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
}));
import { ConnectorGallery } from '../src/client/ConnectorGallery';
import {
  RegistryCard,
  RegistryDiscover,
  discoverReducer,
  initialDiscover,
  registryBadges,
  registryTitle,
  type DiscoverState,
} from '../src/client/RegistryDiscover';
import { connectorPresets } from '../src/shared/connector-presets';
import type { RegistryServer } from '../src/shared/registry';

const server = (extra: Partial<RegistryServer> = {}): RegistryServer => ({
  name: 'io.github.example/notes',
  description: 'Read and write notes',
  version: '0.4.1',
  remotes: [],
  packages: [],
  ...extra,
});

describe('registry badges and titles', () => {
  it('shows Remote for a hosted endpoint and Local program for a package', () => {
    expect(
      registryBadges(
        server({
          remotes: [{ type: 'sse', url: 'https://notes.example/sse' }],
        }),
      ),
    ).toEqual(['Remote']);
    expect(
      registryBadges(
        server({
          packages: [{ registryType: 'npm', transport: 'stdio', envNames: [] }],
        }),
      ),
    ).toEqual(['Local program']);
    expect(
      registryBadges(
        server({
          remotes: [{ type: 'sse', url: 'https://notes.example/sse' }],
          packages: [
            { registryType: 'pypi', transport: 'stdio', envNames: [] },
          ],
        }),
      ),
    ).toEqual(['Remote', 'Local program']);
    expect(registryBadges(server())).toEqual([]);
  });

  it('uses the title when there is one, and the name otherwise', () => {
    expect(registryTitle(server({ title: 'Notes' }))).toBe('Notes');
    expect(registryTitle(server())).toBe('io.github.example/notes');
  });
});

describe('discoverReducer', () => {
  const page: DiscoverState = discoverReducer(initialDiscover, {
    type: 'search',
    query: 'notes',
  });

  it('starts a search with an empty list', () => {
    expect(page).toEqual({
      query: 'notes',
      servers: [],
      phase: 'searching',
    });
  });

  it('replaces the list on a new search and keeps the cursor only when there is one', () => {
    const first = discoverReducer(page, {
      type: 'result',
      result: { servers: [server()], nextCursor: 'next' },
      append: false,
    });
    expect(first).toMatchObject({
      phase: 'done',
      nextCursor: 'next',
      servers: [server()],
    });
    const replaced = discoverReducer(first, {
      type: 'search',
      query: 'other',
    });
    expect(replaced.servers).toEqual([]);
    expect(replaced.nextCursor).toBeUndefined();
  });

  it('appends the next page to the list and drops the cursor on the last page', () => {
    const first = discoverReducer(page, {
      type: 'result',
      result: { servers: [server()], nextCursor: 'next' },
      append: false,
    });
    const more = discoverReducer(first, { type: 'more' });
    expect(more.phase).toBe('loading-more');
    const last = discoverReducer(more, {
      type: 'result',
      result: { servers: [server({ name: 'io.github.example/two' })] },
      append: true,
    });
    expect(last.servers.map((item) => item.name)).toEqual([
      'io.github.example/notes',
      'io.github.example/two',
    ]);
    expect(last).not.toHaveProperty('nextCursor');
    expect(last.phase).toBe('done');
  });

  it('keeps the list and shows the message when a page fails', () => {
    const first = discoverReducer(page, {
      type: 'result',
      result: { servers: [server()], nextCursor: 'next' },
      append: false,
    });
    const failed = discoverReducer(first, {
      type: 'fail',
      message: 'The MCP registry could not be reached.',
    });
    expect(failed).toMatchObject({
      phase: 'error',
      error: 'The MCP registry could not be reached.',
      servers: [server()],
    });
  });
});

describe('RegistryDiscover', () => {
  it('explains how to turn the search on while it is off, and shows no search box', () => {
    const markup = renderToStaticMarkup(<RegistryDiscover enabled={false} />);
    expect(markup).toContain('CONNECTORS_REGISTRY_SEARCH=true');
    expect(markup).toContain('registry.modelcontextprotocol.io');
    expect(markup).not.toContain('type="search"');
  });

  it('says where a search goes, that names are matched, and that nothing installs', () => {
    const markup = renderToStaticMarkup(<RegistryDiscover enabled />);
    expect(markup).toContain('registry.modelcontextprotocol.io');
    expect(markup).toContain('Search by server name');
    expect(markup).toContain('nothing is saved until you choose Save');
    // It sits inside the Settings form: a nested <form> would reload the page on search.
    expect(markup).not.toContain('<form');
    expect(markup).toContain('role="search"');
    expect(markup).not.toMatch(/>Install</);
  });

  it('renders a result with its badges, version and repository link', () => {
    const markup = renderToStaticMarkup(
      <RegistryCard
        server={server({
          title: 'Notes',
          repository: { url: 'https://github.com/example/notes' },
          remotes: [{ type: 'sse', url: 'https://notes.example/sse' }],
        })}
      />,
    );
    expect(markup).toContain('Notes');
    expect(markup).toContain('io.github.example/notes');
    expect(markup).toContain('Remote');
    expect(markup).toContain('v0.4.1');
    expect(markup).toContain('href="https://github.com/example/notes"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });
});

describe('ConnectorGallery Discover tab', () => {
  const gallery = (registrySearch?: boolean) =>
    renderToStaticMarkup(
      <ConnectorGallery
        connectors={[]}
        presets={connectorPresets}
        allowStdio={false}
        {...(registrySearch === undefined ? {} : { registrySearch })}
        onOpenConnector={() => {}}
        onConnect={() => {}}
        onOpenPreset={() => {}}
        onCustom={() => {}}
      />,
    );

  it('offers the Connectors and Discover tabs, with Connectors selected first', () => {
    const markup = gallery();
    expect(markup).toContain('>Connectors<');
    expect(markup).toContain('>Discover<');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('Search connectors');
    expect(markup).not.toContain('Discover servers');
  });

  it('keeps the existing connector list on the Connectors tab, whatever the flag', () => {
    expect(gallery(true)).toContain('Add a connector');
    expect(gallery(false)).toContain('Add a connector');
  });
});
