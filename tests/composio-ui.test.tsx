import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
}));

import { WorkspaceDialog, type Dialog } from '../src/client/WorkspaceDialog';
import type { Dot, State, WorkspaceState } from '../src/shared/types';

const workspace = {
  spaces: [{ id: 's1', name: 'Everyday' }],
  dots: [],
  setup: { missing: [], search: false, browser: false, voice: false },
} as unknown as WorkspaceState;
const shown = {
  ...workspace,
  setup: { ...workspace.setup, composio: true },
} as WorkspaceState;
const state = {
  settings: { researchAllowed: true, memoryAllowed: true },
} as unknown as State;
const dot = {
  id: 'dot-1',
  name: 'Scout',
  instructions: 'Find things and report back.',
  spaceId: 's1',
  spaceIds: ['s1'],
  researchAllowed: true,
  memoryAllowed: false,
} as unknown as Dot;

function render(dialog: Dialog, current = workspace) {
  return renderToStaticMarkup(
    <WorkspaceDialog
      dialog={dialog}
      state={state}
      workspace={current}
      onClose={() => {}}
      mutate={async () => true}
    />,
  );
}

describe('Connected apps controls', () => {
  it('hides the switches and the warning when Composio is not configured', () => {
    const dotHtml = render({ type: 'dot', dot, spaceId: 's1' });
    const settings = render({ type: 'settings', tab: 'general' });
    for (const html of [dotHtml, settings]) {
      expect(html).not.toContain('Connected apps');
      expect(html).not.toContain('every toolkit in the Composio project');
      expect(html).not.toContain('id="composio-toolkits"');
    }
  });

  it('shows the workspace switch, the Dot switch and the blank-list warning', () => {
    const dotHtml = render({ type: 'dot', dot, spaceId: 's1' }, shown);
    expect(dotHtml).toContain('Connected apps');
    expect(dotHtml).toContain('id="composio-toolkits"');
    expect(dotHtml).toContain('every toolkit in the Composio project');
    expect(dotHtml).toContain('gmail, google_calendar');
    const settings = render({ type: 'settings', tab: 'general' }, shown);
    expect(settings).toContain('Connected apps');
    expect(settings).toContain('Each Dot');
  });
});
