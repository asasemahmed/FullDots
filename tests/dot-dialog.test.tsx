import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
}));
import { WorkspaceDialog, type Dialog } from '../src/client/WorkspaceDialog';
import type { Dot, State, WorkspaceState } from '../src/shared/types';

const workspace = {
  spaces: [
    { id: 's1', name: 'Everyday' },
    { id: 's2', name: 'Research' },
  ],
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
const dot = {
  id: 'dot-1',
  name: 'Scout',
  instructions: 'Find things and report back.',
  spaceId: 's1',
  spaceIds: ['s1'],
  researchAllowed: true,
  memoryAllowed: false,
  model: null,
  approvalMode: 'sensitive',
} as unknown as Dot;

function render(dialog: Dialog) {
  return renderToStaticMarkup(
    <WorkspaceDialog
      dialog={dialog}
      state={state}
      workspace={workspace}
      onClose={() => {}}
      mutate={async () => true}
    />,
  );
}

describe('Dot dialog', () => {
  it('keeps the dialog semantics and a header, scrolling body and footer', () => {
    const html = render({ type: 'dot', spaceId: 's1' });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="dialog-title"');
    expect(html).toContain('id="dialog-title"');
    expect(html).toContain('Meet your next specialist.');
    expect(html).toContain('class="dlg-header"');
    expect(html).toContain('class="dlg-body"');
    expect(html).toContain('class="dlg-footer"');
    expect(html).toContain('aria-label="Close dialog"');
  });

  it('labels the primary action for create and edit', () => {
    const created = render({ type: 'dot', spaceId: 's1' });
    expect(created).toContain('Create Dot');
    expect(created).not.toContain('Save changes');
    const edited = render({ type: 'dot', dot, spaceId: 's1' });
    expect(edited).toContain('Make this Dot yours.');
    expect(edited).toContain('Save changes');
    expect(edited).not.toContain('Create Dot');
    expect(edited).toContain('>Cancel</button>');
  });

  it('groups the form into titled sections', () => {
    const html = render({ type: 'dot', dot, spaceId: 's1' });
    for (const section of [
      'Identity',
      'Model',
      'Connectors',
      'Approvals',
      'Access',
    ])
      expect(html).toContain(`>${section}</h3>`);
    expect(html).not.toContain('<fieldset');
    expect(html).not.toContain('<legend');
  });

  it('previews the Dot with its name and a role instruction counter', () => {
    const html = render({ type: 'dot', dot, spaceId: 's1' });
    expect(html).toContain('Scout is idle');
    expect(html).toContain('value="Scout"');
    expect(html).toContain('Each Dot keeps its own colour.');
    expect(html).toContain('28 / 2000');
    expect(html).toContain('maxLength="2000"');
    expect(render({ type: 'dot', spaceId: 's1' })).toContain('New Dot is idle');
  });

  it('lists Spaces as checkbox rows and offers the default destination', () => {
    const html = render({ type: 'dot', dot, spaceId: 's1' });
    expect(html).toContain('Everyday');
    expect(html).toContain('Research');
    expect(html.match(/class="dlg-check-row"/g)).toHaveLength(2);
    expect(html).toContain('Default destination for saved pages');
    expect(html).toContain('id="default-space"');
    // Only the first Space is granted.
    expect(
      html.match(/dlg-check-row"><input type="checkbox" checked=""/g),
    ).toHaveLength(1);
  });

  it('renders the two permissions as real switches', () => {
    const html = render({ type: 'dot', dot, spaceId: 's1' });
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html).toContain('Public-page research');
    expect(html).toContain('Use saved memories');
    const research = html.match(/<input[^>]*role="switch"[^>]*>/g)!;
    expect(research[0]).toContain('checked=""');
    // memoryAllowed is false for this Dot.
    expect(research[1]).not.toContain('checked=""');
  });

  it('shows the model picker with the default model on its trigger', () => {
    const html = render({ type: 'dot', spaceId: 's1' });
    expect(html).toContain('id="dot-model"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('Default · acme/model-1');
  });
});

describe('shared dialog shell', () => {
  it('uses the plain Save label for the other dialogs', () => {
    for (const dialog of [
      { type: 'space' },
      { type: 'memory' },
      { type: 'schedule', threadId: 't1' },
    ] as Dialog[]) {
      const html = render(dialog);
      expect(html).toContain('class="dlg-footer"');
      expect(html).toContain('>Save</button>');
      expect(html).toContain('>Cancel</button>');
    }
  });

  it('shows the Settings footer on the General tab only', () => {
    const general = render({ type: 'settings', tab: 'general' });
    expect(general).toContain('modal-settings');
    expect(general).toContain('class="dlg-footer"');
    expect(general).toContain('>Save</button>');
    const connectors = render({ type: 'settings', tab: 'connectors' });
    expect(connectors).toContain('role="tablist"');
    expect(connectors).not.toContain('class="dlg-footer"');
    const about = render({ type: 'settings', tab: 'about' });
    expect(about).not.toContain('class="dlg-footer"');
  });
});
