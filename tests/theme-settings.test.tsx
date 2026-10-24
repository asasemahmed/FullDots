import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
}));
import { WorkspaceDialog } from '../src/client/WorkspaceDialog';
import type { State, WorkspaceState } from '../src/shared/types';

const workspace = {
  spaces: [{ id: 's1', name: 'Everyday' }],
  dots: [],
  setup: {
    missing: [],
    search: false,
    browser: false,
    voice: false,
    defaultModel: 'acme/model-1',
  },
} as unknown as WorkspaceState;
const state = {
  settings: { researchAllowed: true, memoryAllowed: true },
} as unknown as State;

const render = () =>
  renderToStaticMarkup(
    <WorkspaceDialog
      dialog={{ type: 'settings' }}
      state={state}
      workspace={workspace}
      onClose={() => {}}
      mutate={async () => true}
    />,
  );

describe('Appearance setting', () => {
  it('offers System, Light and Dark in Settings > General', () => {
    const html = render();
    expect(html).toContain('Appearance');
    expect(html).toContain('name="theme"');
    for (const label of ['System', 'Light', 'Dark'])
      expect(html).toContain(label);
    expect(html).toMatch(/checked="" value="system"/);
    expect(html).not.toMatch(/checked="" value="(light|dark)"/);
  });

  it('reports the theme that is actually in use', () => {
    expect(render()).toContain('Using the light theme.');
  });

  it('keeps the existing permission settings on General', () => {
    const html = render();
    expect(html).toContain('Public-page research');
    expect(html).toContain('Use saved memories');
  });
});
