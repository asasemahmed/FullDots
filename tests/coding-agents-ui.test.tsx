import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api, authHeaders: () => ({}) }));
vi.mock('../src/client/theme', () => ({
  useThemePreference: () => ({ preference: 'system', setPreference: () => {} }),
}));
vi.mock('../src/client/Mascot', async (original) => ({
  ...(await original<typeof import('../src/client/Mascot')>()),
  Mascot: () => null,
}));
vi.mock('../src/client/DotNotes', () => ({ DotNotes: () => null }));
vi.mock('../src/client/ModelPicker', async (original) => ({
  ...(await original<typeof import('../src/client/ModelPicker')>()),
  ModelPicker: () => null,
}));
import { WorkspaceDialog, type Dialog } from '../src/client/WorkspaceDialog';
import { CodingAgentsField } from '../src/client/CodingAgentsField';
import type { Dot, State, WorkspaceState } from '../src/shared/types';

const workspace = {
  spaces: [{ id: 's1', name: 'General' }],
  dots: [],
  setup: { missing: [], search: false, browser: false, voice: false },
} as unknown as WorkspaceState;
const state = {
  settings: { researchAllowed: true, memoryAllowed: true },
} as unknown as State;
const dot = {
  id: 'dot-1',
  name: 'Builder',
  instructions: 'Build features.',
  spaceId: 's1',
  spaceIds: ['s1'],
  researchAllowed: true,
  memoryAllowed: false,
  model: null,
  approvalMode: 'sensitive',
} as Dot;
const roots: ReactTestRenderer[] = [];
beforeEach(() => {
  api.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('document', {
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  vi.unstubAllGlobals();
});

async function fixture(
  options: {
    existing?: boolean;
    loadError?: boolean;
    enabled?: boolean;
    provider?: string;
    failSave?: boolean;
  } = {},
) {
  let fail = options.failSave ?? false;
  api.mockImplementation(async (path: string, method?: string) => {
    if (path === '/dots' && method === 'POST') return { id: 'created-dot' };
    if (path.endsWith('/coding-agents')) {
      if (options.loadError) throw new Error('Fixture load failed');
      return {
        enabled: options.enabled ?? false,
        provider: options.provider ?? 'claude',
      };
    }
    if (path === '/connectors') return { connectors: [] };
    if (path.endsWith('/connectors')) return { grants: [] };
    if (path.endsWith('/team')) return { delegateIds: [], implied: [] };
    if (path.endsWith('/rules')) return { rules: {} };
    return {};
  });
  const mutate = vi.fn(
    async (path: string, _method: string, _body?: unknown) => {
      if (path.endsWith('/coding-agents') && fail) {
        fail = false;
        return false;
      }
      return true;
    },
  );
  const onClose = vi.fn();
  const dialog: Dialog = {
    type: 'dot',
    spaceId: 's1',
    ...(options.existing ? { dot } : {}),
  };
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(
      <WorkspaceDialog
        dialog={dialog}
        state={state}
        workspace={workspace}
        mutate={mutate}
        onClose={onClose}
      />,
    );
  });
  roots.push(root);
  const field = () => root.root.findByType(CodingAgentsField);
  const change = async (enabled: boolean) => {
    await act(async () => field().props.onChange(enabled));
  };
  const submit = async () => {
    await act(async () =>
      root.root.findByType('form').props.onSubmit({ preventDefault() {} }),
    );
  };
  return { root, field, change, submit, mutate, onClose };
}

it('defaults off and saves the loaded preference only after submitting', async () => {
  const fresh = await fixture();
  expect(fresh.field().props.enabled).toBe(false);
  const existing = await fixture({ existing: true, enabled: true });
  expect(existing.field().props.enabled).toBe(true);
  await existing.change(false);
  expect(existing.mutate).not.toHaveBeenCalled();
  await existing.submit();
  expect(existing.mutate).toHaveBeenCalledWith(
    '/dots/dot-1/coding-agents',
    'PUT',
    { enabled: false, provider: 'claude' },
  );
  expect(existing.onClose).toHaveBeenCalledOnce();
});

it('preserves coding settings after load failure while allowing unrelated edits', async () => {
  const f = await fixture({ existing: true, loadError: true });
  expect(f.field().props.error).toContain('load failed');
  expect(f.field().findByType('input').props.disabled).toBe(true);
  await f.submit();
  expect(f.mutate).toHaveBeenCalledWith(
    '/dots/dot-1',
    'PUT',
    expect.anything(),
  );
  expect(
    f.mutate.mock.calls.some(([path]) => path.endsWith('/coding-agents')),
  ).toBe(false);
});

it('retries a failed save using the new Dot id without creating another Dot', async () => {
  const f = await fixture({ failSave: true });
  await f.change(true);
  await f.submit();
  expect(f.onClose).not.toHaveBeenCalled();
  expect(
    api.mock.calls.filter(
      ([path, method]) => path === '/dots' && method === 'POST',
    ),
  ).toHaveLength(1);
  await f.submit();
  expect(
    api.mock.calls.filter(
      ([path, method]) => path === '/dots' && method === 'POST',
    ),
  ).toHaveLength(1);
  expect(
    f.mutate.mock.calls.filter(([path]) => path.endsWith('/coding-agents')),
  ).toHaveLength(2);
  expect(f.onClose).toHaveBeenCalledOnce();
});

it('saves the final off choice after a failed enable response and reuses the created Dot', async () => {
  const f = await fixture({ failSave: true });
  await f.change(true);
  await f.submit();
  await f.change(false);
  await f.submit();
  expect(
    api.mock.calls.filter(
      ([path, method]) => path === '/dots' && method === 'POST',
    ),
  ).toHaveLength(1);
  expect(f.mutate).toHaveBeenLastCalledWith(
    '/dots/created-dot/coding-agents',
    'PUT',
    { enabled: false, provider: 'claude' },
  );
  expect(f.onClose).toHaveBeenCalledOnce();
});

it('keeps Retry outside the switch label', async () => {
  const f = await fixture({ existing: true, loadError: true });
  const field = f.field();
  expect(field.findByType('label').findAllByType('button')).toHaveLength(0);
  const retry = field.findByType('button');
  expect(retry.props.type).toBe('button');
  api.mockResolvedValue({ enabled: true });
  await act(async () => retry.props.onClick());
  expect(f.field().props.enabled).toBe(true);
  expect(f.field().props.error).toBeNull();
});

it('shows the saved agent choice and saves a change to Codex', async () => {
  const f = await fixture({ existing: true, enabled: true });
  expect(f.field().props.provider).toBe('claude');
  const select = () => f.field().findByType('select');
  expect(select().props.value).toBe('claude');
  expect(
    select()
      .findAllByType('option')
      .map((option) => option.props.value),
  ).toEqual(['claude', 'codex']);
  await act(async () =>
    select().props.onChange({ target: { value: 'codex' } }),
  );
  expect(select().props.value).toBe('codex');
  expect(f.mutate).not.toHaveBeenCalled();
  await f.submit();
  expect(f.mutate).toHaveBeenCalledWith('/dots/dot-1/coding-agents', 'PUT', {
    enabled: true,
    provider: 'codex',
  });
});

it('loads Codex as the saved choice and hides the choice while the switch is off', async () => {
  const on = await fixture({
    existing: true,
    enabled: true,
    provider: 'codex',
  });
  expect(on.field().findByType('select').props.value).toBe('codex');
  const off = await fixture({ existing: true, enabled: false });
  expect(off.field().findAllByType('select')).toHaveLength(0);
});
