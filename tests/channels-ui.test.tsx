import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));
import { ChannelsSettings } from '../src/client/ChannelsSettings';
import type { ChannelSettings, ChannelInput } from '../src/shared/channels';
import type { Dot } from '../src/shared/types';
const roots: ReactTestRenderer[] = [];
beforeEach(() => {
  api.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function settings(provider: 'slack' | 'telegram'): ChannelSettings {
  return {
    provider,
    enabled: false,
    dotId: 'dot',
    workspaceId: 'T123',
    ownerUserIds: provider === 'slack' ? ['U123'] : ['111'],
    chatId: '',
    revision: 1,
    botTokenSet: true,
    appTokenSet: true,
    status: 'disabled',
    failure: null,
    ignored: 0,
  };
}
async function fixture() {
  const list = [settings('slack'), settings('telegram')];
  api.mockImplementation(
    async (_path: string, method?: string, body?: ChannelInput) =>
      method === 'PUT'
        ? { ...list[0], ...body, botToken: undefined, appToken: undefined }
        : list,
  );
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(
      <ChannelsSettings dots={[{ id: 'dot', name: 'Builder' } as Dot]} />,
    );
  });
  roots.push(root);
  const field = (id: string) => root.root.findByProps({ id });
  const button = (text: string) =>
    root.root
      .findAllByType('button')
      .find((item) => item.children.includes(text))!;
  const change = async (id: string, value: string) =>
    act(async () => field(id).props.onChange({ target: { value } }));
  return { root, field, button, change, list };
}
it('keeps credentials empty and omits unchanged tokens from independent saves', async () => {
  const f = await fixture();
  expect(f.field('slack-bot-token-input').props.value).toBe('');
  expect(f.field('telegram-bot-token-input').props.value).toBe('');
  await f.change('slack-owner-user-ids-input', 'U123, U456\nU789');
  await act(async () => f.button('Save Slack').props.onClick());
  const body = api.mock.calls.find((call) => call[1] === 'PUT')![2];
  expect(body.ownerUserIds).toEqual(['U123', 'U456', 'U789']);
  expect(body).not.toHaveProperty('botToken');
  expect(body).not.toHaveProperty('appToken');
  const secret = ['fixture', randomUUID()].join('-');
  await f.change('slack-bot-token-input', secret);
  await act(async () => f.button('Save Slack').props.onClick());
  expect(f.field('slack-bot-token-input').props.value).toBe('');
  expect(JSON.stringify(f.root.toJSON())).not.toContain(secret);
});
it('preserves dirty inputs during status polling and validates Telegram owners before sending', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.change('slack-workspace-id-input', 'UNSAVED');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(f.field('slack-workspace-id-input').props.value).toBe('UNSAVED');
  await f.change('telegram-owner-user-ids-input', 'invalid-owner');
  await act(async () => f.button('Save Telegram').props.onClick());
  expect(api.mock.calls.filter((call) => call[1] === 'PUT')).toHaveLength(0);
  expect(JSON.stringify(f.root.toJSON())).toContain(
    'Telegram owner user IDs must be numeric',
  );
});
it('locks only the channel being saved until its response arrives', async () => {
  const f = await fixture();
  let finish!: (value: ChannelSettings) => void;
  api.mockImplementation(async (_path: string, method?: string) =>
    method === 'PUT'
      ? new Promise<ChannelSettings>((resolve) => {
          finish = resolve;
        })
      : f.list,
  );
  await f.change('slack-workspace-id-input', 'UPDATED');
  await act(async () => f.button('Save Slack').props.onClick());
  const fieldsets = f.root.root.findAllByType('fieldset');
  expect(fieldsets.map((item) => item.props.disabled)).toEqual([true, false]);
  await act(async () => finish({ ...f.list[0], workspaceId: 'UPDATED' }));
  expect(
    f.root.root.findAllByType('fieldset').map((item) => item.props.disabled),
  ).toEqual([false, false]);
});
