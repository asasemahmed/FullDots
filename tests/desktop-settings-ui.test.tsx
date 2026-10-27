import { afterEach, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ModelProviderPage,
  type ModelProviderPageProps,
} from '../src/client/ModelProviderPage';
import { SettingsSheet } from '../src/client/computer-panel/SettingsSheet';
import { ScreenStage } from '../src/client/computer-panel/ScreenStage';
import {
  modelPresets,
  type ModelProviderView,
} from '../src/shared/model-presets';
import type { Dot } from '../src/shared/types';
import type { ComputerStatus } from '../src/shared/computer-types';
vi.mock('../src/client/api', () => ({ authHeaders: () => ({}), api: vi.fn() }));
const noop = () => {};
const dot: Dot = {
  id: 'desktop-dot',
  name: 'Fixture',
  spaceId: 'space',
  spaceIds: ['space'],
  instructions: '',
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 0,
};
const status: ComputerStatus = {
  configured: true,
  state: 'stopped',
  permissions: { enabled: true, browser: false, files: false, shell: false },
  audit: [],
};
const sheet = (state = status) =>
  renderToStaticMarkup(
    <SettingsSheet
      id="desktop-settings"
      dot={dot}
      status={state}
      optimistic={{}}
      notes={{}}
      busy={false}
      hidden={false}
      onSetPermission={noop}
      onStart={noop}
      onStop={noop}
      onClose={noop}
    />,
  );
it('defaults the kind selector to browser and refuses changing it while running', () => {
  const stopped = sheet();
  expect(stopped).toContain('<option value="browser" selected="">');
  expect(
    stopped.match(/<select[^>]*aria-label="Computer kind"[^>]*>/)?.[0],
  ).not.toContain('disabled');
  expect(
    stopped.match(/<input[^>]*id="desktop-settings-desktop"[^>]*>/)?.[0],
  ).not.toContain('checked');
  const running = sheet({
    ...status,
    state: 'running',
    permissions: { ...status.permissions, kind: 'desktop', desktop: true },
  });
  expect(
    running.match(/<select[^>]*aria-label="Computer kind"[^>]*>/)?.[0],
  ).toContain('disabled');
  expect(running).toContain('Stop the computer before changing its kind.');
});
it('shows desktop terminal note only when currentKind is desktop or desktop permission is on', () => {
  const noteText =
    'Full desktop includes a terminal. The Dot can run commands in its own computer through it, even with Terminal off. Every key press and typed text still asks you first.';

  const browserOff = sheet({
    ...status,
    permissions: { ...status.permissions, kind: 'browser', desktop: false },
  });
  expect(browserOff).not.toContain(noteText);

  const desktopKind = sheet({
    ...status,
    permissions: { ...status.permissions, kind: 'desktop', desktop: false },
  });
  expect(desktopKind).toContain(noteText);

  const desktopPermOn = sheet({
    ...status,
    permissions: { ...status.permissions, kind: 'browser', desktop: true },
  });
  expect(desktopPermOn).toContain(noteText);

  const optimisticOn = renderToStaticMarkup(
    <SettingsSheet
      id="desktop-settings"
      dot={dot}
      status={{
        ...status,
        permissions: { ...status.permissions, kind: 'browser', desktop: false },
      }}
      optimistic={{ desktop: true }}
      notes={{}}
      busy={false}
      hidden={false}
      onSetPermission={noop}
      onStart={noop}
      onStop={noop}
      onClose={noop}
    />,
  );
  expect(optimisticOn).toContain(noteText);

  const optimisticOff = renderToStaticMarkup(
    <SettingsSheet
      id="desktop-settings"
      dot={dot}
      status={{
        ...status,
        permissions: { ...status.permissions, kind: 'browser', desktop: true },
      }}
      optimistic={{ desktop: false }}
      notes={{}}
      busy={false}
      hidden={false}
      onSetPermission={noop}
      onStart={noop}
      onStop={noop}
      onClose={noop}
    />,
  );
  expect(optimisticOff).not.toContain(noteText);
});
it('shows a live desktop independently of browser permission and accepts ISO fallback timestamps', () => {
  const html = renderToStaticMarkup(
    <ScreenStage
      dotId={dot.id}
      dotName={dot.name}
      screenAvailable
      isDesktop
      browser={false}
      human
      typeChars={16000}
      streamKey={0}
      stream={{ phase: 'live' }}
      snapshot={{
        base64: 'fixture',
        width: 1280,
        height: 800,
        capturedAt: '2026-10-27T00:00:00Z',
        mimeType: 'image/jpeg',
      }}
      snapshotError=""
      busy={false}
      onPhase={noop}
      onFrameSize={noop}
      onRetryStream={noop}
      onClickSnapshot={noop}
      onOpenSettings={noop}
    />,
  );
  expect(html).toContain('data-stage="live"');
  expect(html).not.toContain('The browser is turned off');
});

const provider: ModelProviderView = {
  id: 'env',
  presetId: 'custom',
  name: 'Default fixture',
  baseUrl: 'https://model.invalid',
  key: { kind: 'env', envName: 'FIXTURE_MODEL_KEY', set: true },
  enabled: true,
  builtIn: true,
  createdAt: 0,
  updatedAt: 0,
  lastTestedAt: null,
  lastError: null,
};
const roots: ReactTestRenderer[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function modelPage(
  options: {
    enabled?: boolean;
    invalidResponse?: boolean;
    failedList?: boolean;
  } = {},
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('document', {
    activeElement: null,
    addEventListener: noop,
    removeEventListener: noop,
  });
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path: input, method, body });
      if (method === 'PUT')
        return Response.json(options.invalidResponse ? {} : body);
      if (input.includes('/images'))
        return Response.json({
          modelImages: options.enabled ? { 'env:fixture-model': true } : {},
        });
      return Response.json({ models: [{ id: 'fixture-model', images: true }] });
    }),
  );
  const changed = vi.fn();
  const props: ModelProviderPageProps = {
    target: { kind: 'provider', id: provider.id },
    providers: [provider],
    presets: modelPresets,
    defaultModel: null,
    modelImages: options.enabled ? { 'env:fixture-model': true } : {},
    onModelImagesChange: changed,
    onClose: noop,
    onSaved: noop,
    onDeleted: noop,
    onDefaultChanged: noop,
    onReload: noop,
    onCount: noop,
    initialModels: options.failedList
      ? { models: [], error: 'Fixture list unavailable.' }
      : { models: [{ id: 'fixture-model', images: true }] },
  };
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<ModelProviderPage {...props} />);
  });
  roots.push(root);
  return { root, calls, changed };
}
it('shows image input off by default even for a stale model listing and a read-only provider', async () => {
  const { root } = await modelPage();
  const checkbox = root.root.findByProps({
    'aria-label': 'Image input for fixture-model',
  });
  expect(checkbox.props.checked).toBe(false);
  expect(checkbox.props.disabled).toBe(false);
});
it('saves only the confirmed image flag and keeps false despite stale model metadata', async () => {
  const { root, calls, changed } = await modelPage({ enabled: true });
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Image input for fixture-model' })
      .props.onChange({ target: { checked: false } }),
  );
  expect(calls.filter((call) => call.method === 'PUT')).toEqual([
    {
      path: '/api/model-providers/images',
      method: 'PUT',
      body: { providerId: 'env', model: 'fixture-model', images: false },
    },
  ]);
  expect(
    root.root.findByProps({ 'aria-label': 'Image input for fixture-model' })
      .props.checked,
  ).toBe(false);
  expect(changed).toHaveBeenCalledWith({ 'env:fixture-model': false });
});
it('does not claim an image setting was saved when the response is invalid', async () => {
  const { root, changed } = await modelPage({ invalidResponse: true });
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Image input for fixture-model' })
      .props.onChange({ target: { checked: true } }),
  );
  expect(
    root.root.findByProps({ 'aria-label': 'Image input for fixture-model' })
      .props.checked,
  ).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  expect(
    root.root
      .findAllByProps({ role: 'alert' })
      .some((node) => node.children.join('').includes('not confirmed')),
  ).toBe(true);
});
it('saves image input for a manually entered model when its list is unavailable', async () => {
  const { root, calls } = await modelPage({ failedList: true });
  const field = root.root.findByProps({
    placeholder: 'llama-3.3-70b-versatile',
  });
  await act(async () =>
    field.props.onChange({ target: { value: 'manual-model' } }),
  );
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Image input' })
      .props.onChange({ target: { checked: true } }),
  );
  const save = root.root
    .findAllByType('button')
    .find((node) => node.children.join('') === 'Save image setting');
  expect(save?.props.disabled).toBe(false);
  await act(async () => save?.props.onClick());
  expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
    providerId: 'env',
    model: 'manual-model',
    images: true,
  });
});
