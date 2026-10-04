import { afterEach, expect, it } from 'vitest';
import { computerTools } from '../src/server/computer-tools.js';
import { withoutBinary } from '../src/server/computer-agent.js';
import {
  computerFixture,
  page,
  type FakeElement,
} from './fixtures/fake-computer.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Result = Record<string, any>;
const fixtures: ReturnType<typeof computerFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.workspace.close();
});

function setup() {
  const f = computerFixture();
  fixtures.push(f);
  const tools = computerTools(
    f.service,
    f.id,
    () => undefined,
    new AbortController().signal,
    {
      settleMs: 0,
    },
  );
  const run = async (name: string, input: unknown) =>
    (await tools
      .find((tool) => tool.name === `computer_${name}`)!
      .execute?.(input as never)) as Result;
  return { ...f, tools, run };
}

const form: FakeElement[] = [
  { ref: 'e1', role: 'textbox', name: 'Name' },
  { ref: 'e2', role: 'button', name: 'Submit' },
];

it('returns a fresh page with every browser action so the agent needs no extra snapshot', async () => {
  const f = setup();
  f.fake.pages['https://form.test/'] = page('Form', form);
  f.fake.onClick = (ref, computer) => {
    if (ref === 'e2')
      computer.show(
        page('Thanks', [{ ref: 'e9', role: 'link', name: 'Home' }]),
      );
  };
  const nav = await f.run('navigate', { url: 'https://form.test/' });
  expect(nav.text).toBe('Page text');
  expect(nav.page).toEqual({
    snapshotId: f.fake.snapshotId,
    url: 'https://form.test/',
    title: 'Form',
    elements: form,
  });
  const typed = await f.run('type', {
    ref: 'e1',
    snapshotId: nav.page.snapshotId,
    text: 'Ada',
  });
  expect(typed).toMatchObject({
    action: 'type',
    characters: 3,
    // The chat card names the field from this.
    element: { role: 'textbox', name: 'Name' },
  });
  expect(typed.page.elements[0]).toMatchObject({ ref: 'e1', value: 'Ada' });
  const clicked = await f.run('click', {
    ref: 'e2',
    snapshotId: typed.page.snapshotId,
  });
  expect(clicked.page).toMatchObject({
    title: 'Thanks',
    elements: [{ ref: 'e9', role: 'link', name: 'Home' }],
  });
  for (const name of ['key', 'scroll']) {
    const result = await f.run(
      name,
      name === 'key' ? { key: 'Tab' } : { deltaY: 400 },
    );
    expect(result.page.snapshotId).toBe(f.fake.snapshotId);
  }
  expect(f.fake.calls).toEqual([
    'navigate',
    'snapshot',
    'type',
    'snapshot',
    'click',
    'snapshot',
    'key',
    'snapshot',
    'scroll',
    'snapshot',
  ]);
  // The owner sees one audited action per tool call, not an extra snapshot after each.
  expect(f.workspace.computers.audit(f.id)).toHaveLength(5);
});

it('trims the page to 150 elements with short names and hides values of secret fields', async () => {
  const f = setup();
  f.fake.pages['https://big.test/'] = page('Big', [
    ...Array.from({ length: 200 }, (_, index) => ({
      ref: `e${index}`,
      role: 'link',
      name: `Link ${index} ${'x'.repeat(300)}`,
    })),
    { ref: 'p', role: 'textbox', name: 'Password', value: 'hunter2' },
  ]);
  const nav = await f.run('navigate', { url: 'https://big.test/' });
  expect(nav.page.elements).toHaveLength(150);
  expect(nav.page).toMatchObject({ truncated: true, omitted: 51 });
  for (const element of nav.page.elements)
    expect(Array.from(element.name).length).toBeLessThanOrEqual(80);
  // The snapshot tool still describes the whole page.
  const snapshot = await f.run('snapshot', {});
  expect(snapshot.elements).toHaveLength(201);
  const small = setup();
  small.fake.pages['https://login.test/'] = page('Login', [
    { ref: 'p', role: 'textbox', name: 'Password', value: 'hunter2' },
  ]);
  const login = await small.run('navigate', { url: 'https://login.test/' });
  expect(login.page.elements[0].value).toBe('[hidden]');
  expect(JSON.stringify(login)).not.toContain('hunter2');
});

it('keeps owner actions as they were and reports a failed refresh without failing the action', async () => {
  const f = setup();
  f.fake.pages['https://form.test/'] = page('Form', form);
  await f.run('navigate', { url: 'https://form.test/' });
  const before = f.fake.calls.length;
  const owner = (await f.service.action(
    f.id,
    'click',
    { ref: 'e2', snapshotId: f.fake.snapshotId },
    'owner',
  )) as Record<string, unknown>;
  expect(owner).not.toHaveProperty('page');
  expect(f.fake.calls.slice(before)).toEqual(['click']);
  f.fake.failSnapshots = 2;
  const result = await f.run('key', { key: 'Enter' });
  expect(result).toMatchObject({ action: 'key', key: 'Enter' });
  expect(result.pageError).toMatch(/computer_snapshot/);
  expect(result).not.toHaveProperty('page');
});

it('refreshes and retries navigation and keys when the computer asks for a new snapshot', async () => {
  const f = setup();
  f.fake.pages['https://form.test/'] = page('Form', form);
  f.fake.resumeSnapshotRequired = true;
  const nav = await f.run('navigate', { url: 'https://form.test/' });
  expect(nav.page.title).toBe('Form');
  expect(f.fake.calls).toEqual([
    'navigate',
    'snapshot',
    'navigate',
    'snapshot',
  ]);
  f.fake.calls.length = 0;
  f.fake.resumeSnapshotRequired = true;
  await f.run('key', { key: 'Enter' });
  expect(f.fake.calls).toEqual(['key', 'snapshot', 'key', 'snapshot']);
  expect(
    f.workspace.computers.audit(f.id).every((a) => a.outcome === 'succeeded'),
  ).toBe(true);
});

it('stops retrying when a refresh does not clear the request', async () => {
  const f = setup();
  f.fake.resumeSnapshotRequired = true;
  f.fake.stickyResume = true;
  await expect(
    f.run('navigate', { url: 'https://form.test/' }),
  ).rejects.toThrow(/still asks for a refresh/);
  expect(f.fake.calls).toEqual([
    'navigate',
    'snapshot',
    'navigate',
    'snapshot',
  ]);
});

it('hands the fresh page back instead of clicking or typing with refs from before a handback', async () => {
  const f = setup();
  f.fake.pages['https://form.test/'] = page('Form', form);
  const nav = await f.run('navigate', { url: 'https://form.test/' });
  f.fake.resumeSnapshotRequired = true;
  f.fake.calls.length = 0;
  const result = await f.run('click', {
    ref: 'e2',
    snapshotId: nav.page.snapshotId,
  });
  expect(result).toMatchObject({ retry: true });
  expect(result.error).toMatch(/Nothing was clicked/);
  expect(result.page.snapshotId).toBe(f.fake.snapshotId);
  expect(f.fake.calls).toEqual(['click', 'snapshot']);
  const typed = await f.run('type', {
    ref: 'e1',
    snapshotId: result.page.snapshotId,
    text: 'x',
  });
  expect(typed).not.toHaveProperty('error');
});

it('never works around the owner holding control', async () => {
  const f = setup();
  f.fake.pages['https://form.test/'] = page('Form', form);
  const nav = await f.run('navigate', { url: 'https://form.test/' });
  f.fake.holder = 'human';
  f.fake.calls.length = 0;
  await expect(
    f.run('navigate', { url: 'https://other.test/' }),
  ).rejects.toThrow(
    /owner currently has control[\s\S]*Do not retry[\s\S]*waiting for them/,
  );
  await expect(
    f.run('click', { ref: 'e2', snapshotId: nav.page.snapshotId }),
  ).rejects.toThrow(/owner currently has control/);
  await expect(f.run('exec', { command: 'ls' })).rejects.toThrow(
    /owner currently has control/,
  );
  // One refused call each: no snapshot, no retry.
  expect(f.fake.calls).toEqual(['navigate', 'click', 'exec']);
});

it('addresses several actions sent from one snapshot to the element they meant', async () => {
  const f = setup();
  f.fake.pages['https://form.test/'] = page('Form', form);
  const nav = await f.run('navigate', { url: 'https://form.test/' });
  const id = nav.page.snapshotId;
  await f.run('type', { ref: 'e1', snapshotId: id, text: 'Ada' });
  // The page moved on to a newer snapshot, but e2 is the same button the agent saw.
  const second = await f.run('click', { ref: 'e2', snapshotId: id });
  expect(second).not.toHaveProperty('error');
  expect(f.fake.bodies.click?.at(-1)).toMatchObject({
    ref: 'e2',
    snapshotId: f.fake.snapshotId - 1,
  });
  expect(f.fake.calls.filter((call) => call === 'click')).toHaveLength(1);
});

it('follows an element whose ref was renumbered by a later snapshot', async () => {
  const f = setup();
  f.fake.pages['https://form.test/'] = page('Form', form);
  const nav = await f.run('navigate', { url: 'https://form.test/' });
  const id = nav.page.snapshotId;
  // Like the real computer, typing re-renders the page and every ref gets a new name.
  f.fake.onType = (_ref, _text, computer) =>
    computer.show(
      page('Form', [
        { ref: 'f9e1', role: 'textbox', name: 'Name' },
        { ref: 'f9e2', role: 'button', name: 'Submit' },
      ]),
    );
  await f.run('type', { ref: 'e1', snapshotId: id, text: 'Ada' });
  f.fake.onType = undefined;
  const click = await f.run('click', { ref: 'e2', snapshotId: id });
  expect(click).not.toHaveProperty('error');
  expect(f.fake.bodies.click?.at(-1)).toMatchObject({ ref: 'f9e2' });
  expect(f.fake.calls.filter((call) => call === 'click')).toHaveLength(1);
});

it('does not follow a renumbered element when its name is ambiguous', async () => {
  const f = setup();
  f.fake.pages['https://form.test/'] = page('Form', [
    { ref: 'e1', role: 'textbox', name: 'Name' },
    { ref: 'e2', role: 'button', name: 'Remove' },
  ]);
  const nav = await f.run('navigate', { url: 'https://form.test/' });
  const id = nav.page.snapshotId;
  f.fake.onType = (_ref, _text, computer) =>
    computer.show(
      page('Form', [
        { ref: 'g1', role: 'textbox', name: 'Name' },
        { ref: 'g2', role: 'button', name: 'Remove' },
        { ref: 'g3', role: 'button', name: 'Remove' },
      ]),
    );
  await f.run('type', { ref: 'e1', snapshotId: id, text: 'Ada' });
  f.fake.onType = undefined;
  const click = await f.run('click', { ref: 'e2', snapshotId: id });
  expect(click).toMatchObject({ retry: true });
  expect(f.fake.calls.filter((call) => call === 'click')).toHaveLength(1);
});

it('does not guess when the element changed under an old ref', async () => {
  const f = setup();
  f.fake.pages['https://form.test/'] = page('Form', form);
  const nav = await f.run('navigate', { url: 'https://form.test/' });
  const id = nav.page.snapshotId;
  f.fake.onClick = (_ref, computer) =>
    computer.show(
      page('Next', [{ ref: 'e2', role: 'button', name: 'Delete everything' }]),
    );
  await f.run('click', { ref: 'e1', snapshotId: id });
  f.fake.onClick = undefined;
  const clicks = f.fake.calls.filter((call) => call === 'click').length;
  const stale = await f.run('click', { ref: 'e2', snapshotId: id });
  expect(stale).toMatchObject({ retry: true });
  expect(stale.error).toMatch(/out of date/);
  expect(stale.page.elements).toEqual([
    { ref: 'e2', role: 'button', name: 'Delete everything' },
  ]);
  // The refused click was tried once and never repeated against the different element.
  expect(f.fake.calls.filter((call) => call === 'click')).toHaveLength(
    clicks + 1,
  );
});

it('never returns a screenshot image to the model', async () => {
  const f = setup();
  f.fake.pages['https://form.test/'] = page('Form', form);
  await f.run('navigate', { url: 'https://form.test/' });
  const shot = await f.run('screenshot', {});
  expect(shot).toMatchObject({
    url: 'https://form.test/',
    title: 'Form',
    width: 1280,
    height: 800,
  });
  expect(shot.note).toMatch(/computer_read[\s\S]*computer_snapshot/);
  const text = JSON.stringify(shot);
  expect(text).not.toContain('iVBORw0KGgo');
  expect(text.length).toBeLessThan(1000);
  // The owner's own live panel still gets the image.
  const owner = (await f.service.action(f.id, 'screenshot', {}, 'owner')) as {
    base64: string;
  };
  expect(owner.base64.length).toBeGreaterThan(10_000);
});

it('replaces binary payloads but leaves ordinary long text alone', () => {
  const base64 = 'QUJDREVGRw=='.repeat(500);
  expect(withoutBinary({ base64, url: 'x' })).toEqual({
    base64: '[6000 characters of binary data omitted]',
    url: 'x',
  });
  expect(withoutBinary(`data:image/png;base64,${base64}`)).toMatch(/omitted/);
  expect(withoutBinary({ stdout: base64 })).toEqual({
    stdout: '[6000 characters of binary data omitted]',
  });
  const wrapped = base64.replace(/(.{76})/g, '$1\n');
  expect(withoutBinary(wrapped)).toMatch(/omitted/);
  const prose = 'The quick brown fox, jumping over lazy dogs. '.repeat(100);
  expect(withoutBinary(prose)).toBe(prose);
  const words = 'alpha beta gamma delta '.repeat(200);
  expect(withoutBinary({ nested: [{ words }] })).toEqual({
    nested: [{ words }],
  });
  expect(withoutBinary({ data: '{"a":1}'.repeat(60) })).toEqual({
    data: '{"a":1}'.repeat(60),
  });
});

it('passes file and shell results through without the command echo', async () => {
  const f = setup();
  expect(await f.run('files_read', { path: 'a.txt' })).toMatchObject({
    text: 'hello',
  });
  const exec = await f.run('exec', { command: 'echo ok' });
  expect(exec).toMatchObject({ stdout: 'ok', exitCode: 0 });
  expect(exec).not.toHaveProperty('command');
});

const country: FakeElement = {
  ref: 'e1',
  role: 'combobox',
  name: 'Country',
  value: '',
};

async function opened(f: ReturnType<typeof setup>, elements = [country]) {
  f.fake.pages['https://form.test/'] = page('Form', elements);
  return f.run('navigate', { url: 'https://form.test/' });
}

it('selects a custom dropdown option that appears once it is opened', async () => {
  const f = setup();
  const nav = await opened(f);
  f.fake.onClick = (ref, computer) => {
    if (ref === 'e1')
      computer.show(
        page('Form', [
          country,
          { ref: 'e10', role: 'option', name: 'France' },
          { ref: 'e11', role: 'option', name: 'Germany' },
        ]),
      );
    if (ref === 'e10')
      computer.show(page('Form', [{ ...country, value: 'France' }]));
  };
  f.fake.calls.length = 0;
  const result = await f.run('select', {
    ref: 'e1',
    snapshotId: nav.page.snapshotId,
    option: ' france ',
  });
  expect(result).toMatchObject({
    action: 'select',
    method: 'option',
    chosen: 'France',
    selected: true,
    element: { role: 'combobox', name: 'Country' },
  });
  expect(result.page.elements).toEqual([
    { ref: 'e1', role: 'combobox', name: 'Country', value: 'France' },
  ]);
  expect(f.fake.calls).toEqual(['click', 'snapshot', 'click', 'snapshot']);
  // One audited action, however many calls it took.
  expect(f.workspace.computers.audit(f.id)[0]).toMatchObject({
    action: 'select',
    outcome: 'succeeded',
  });
});

it('asks for the full option text instead of guessing between similar options', async () => {
  const f = setup();
  const nav = await opened(f);
  f.fake.onClick = (ref, computer) => {
    if (ref === 'e1')
      computer.show(
        page('Form', [
          country,
          { ref: 'e10', role: 'option', name: 'New York' },
          { ref: 'e11', role: 'option', name: 'New Jersey' },
        ]),
      );
  };
  f.fake.calls.length = 0;
  const result = await f.run('select', {
    ref: 'e1',
    snapshotId: nav.page.snapshotId,
    option: 'new',
  });
  expect(result.error).toMatch(
    /Several options match[\s\S]*New York, New Jersey/,
  );
  expect(result.options).toEqual(['New York', 'New Jersey']);
  expect(f.fake.calls).toEqual(['click', 'snapshot']);
});

it('types into an editable combobox and picks the suggestion that appears', async () => {
  const f = setup();
  const nav = await opened(f);
  f.fake.onType = (_ref, text, computer) =>
    computer.show(
      page('Form', [
        { ...country, value: text },
        { ref: 'e20', role: 'option', name: 'Spain' },
      ]),
    );
  f.fake.onClick = (ref, computer) => {
    if (ref === 'e20')
      computer.show(page('Form', [{ ...country, value: 'Spain' }]));
  };
  f.fake.calls.length = 0;
  const result = await f.run('select', {
    ref: 'e1',
    snapshotId: nav.page.snapshotId,
    option: 'Spain',
  });
  expect(result).toMatchObject({
    method: 'type',
    selected: true,
    chosen: 'Spain',
  });
  expect(f.fake.calls).toEqual([
    'click',
    'snapshot',
    'type',
    'snapshot',
    'click',
    'snapshot',
  ]);
});

it('confirms a typed option with Enter only when no list is showing', async () => {
  const f = setup();
  const nav = await opened(f);
  f.fake.onKey = (key, computer) => {
    if (key === 'Enter')
      computer.show(page('Form', [{ ...country, value: 'Portugal' }]));
  };
  const result = await f.run('select', {
    ref: 'e1',
    snapshotId: nav.page.snapshotId,
    option: 'Portugal',
  });
  expect(result).toMatchObject({ method: 'type+enter', selected: true });
  expect(f.fake.bodies.key).toEqual([{ key: 'Enter' }]);

  // A plain text field is never confirmed with Enter: that could submit the form.
  const plain = setup();
  const start = await opened(plain, [
    { ref: 'e1', role: 'textbox', name: 'City' },
  ]);
  plain.fake.calls.length = 0;
  const refused = await plain.run('select', {
    ref: 'e1',
    snapshotId: start.page.snapshotId,
    option: 'Lisbon',
  });
  expect(refused).toMatchObject({ selected: false });
  expect(refused.error).toMatch(/No option matching "Lisbon"/);
  expect(plain.fake.calls).not.toContain('key');

  // Nor when other options are listed: the highlighted one would be the wrong one.
  const listed = setup();
  const begin = await opened(listed);
  listed.fake.onType = (_ref, _text, computer) =>
    computer.show(
      page('Form', [country, { ref: 'e30', role: 'option', name: 'Italy' }]),
    );
  const other = await listed.run('select', {
    ref: 'e1',
    snapshotId: begin.page.snapshotId,
    option: 'Portugal',
  });
  expect(other).toMatchObject({ selected: false, options: ['Italy'] });
  expect(listed.fake.calls).not.toContain('key');
});

it('falls back to typing the text key by key on a native select whose options cannot be clicked', async () => {
  const f = setup();
  const nav = await opened(f, [
    {
      ref: 'e1',
      role: 'combobox',
      name: 'Colour',
      value: 'Choose',
      native: true,
    },
    { ref: 'e5', role: 'option', name: 'Red' },
    { ref: 'e6', role: 'option', name: 'Green' },
  ]);
  f.fake.clickFails = new Set(['e5', 'e6']);
  f.fake.onKey = (key, computer) => {
    if (key === 'Enter')
      computer.show(
        page('Form', [
          {
            ref: 'e1',
            role: 'combobox',
            name: 'Colour',
            value: 'Green',
            native: true,
          },
        ]),
      );
  };
  const result = await f.run('select', {
    ref: 'e1',
    snapshotId: nav.page.snapshotId,
    option: 'Green',
  });
  expect(result).toMatchObject({ method: 'keyboard', selected: true });
  expect(f.fake.bodies.key).toEqual(
    ['G', 'r', 'e', 'e', 'n', 'Enter'].map((key) => ({ key })),
  );
});

it('reports what it could not select, and presses nothing, when a button offers no options', async () => {
  const f = setup();
  const nav = await opened(f, [
    { ref: 'e1', role: 'button', name: 'Pick a size' },
  ]);
  f.fake.calls.length = 0;
  const result = await f.run('select', {
    ref: 'e1',
    snapshotId: nav.page.snapshotId,
    option: 'Large',
  });
  expect(result).toMatchObject({ selected: false, action: 'select' });
  expect(result.error).toMatch(/No option matching "Large"/);
  expect(result.page.snapshotId).toBe(f.fake.snapshotId);
  expect(f.fake.calls).toEqual(['click', 'snapshot']);
});

it('does not continue a selection once the owner takes control', async () => {
  const f = setup();
  const nav = await opened(f);
  f.fake.onClick = (ref, computer) => {
    if (ref === 'e1') {
      computer.show(
        page('Form', [country, { ref: 'e10', role: 'option', name: 'France' }]),
      );
      computer.holder = 'human';
    }
  };
  await expect(
    f.run('select', {
      ref: 'e1',
      snapshotId: nav.page.snapshotId,
      option: 'France',
    }),
  ).rejects.toThrow(/owner currently has control/);
  expect(f.fake.calls.filter((call) => call === 'click')).toHaveLength(2);
  expect(f.fake.bodies.key).toBeUndefined();
});

it('gives the fresh page when the dropdown ref is out of date', async () => {
  const f = setup();
  await opened(f);
  const result = await f.run('select', {
    ref: 'e1',
    snapshotId: 999,
    option: 'France',
  });
  expect(result).toMatchObject({ action: 'select', retry: true });
  expect(result.page.elements[0]).toMatchObject({ ref: 'e1' });
});

it('offers a select tool alongside the others and describes the page contract', () => {
  const f = setup();
  const names = f.tools.map((tool) => tool.name);
  expect(names).toContain('computer_select');
  expect(names.some((name) => name.includes('human'))).toBe(false);
  const description = (name: string) =>
    f.tools.find((tool) => tool.name === name)!.description;
  expect(description('computer_click')).toMatch(
    /`page`[\s\S]*do not call computer_snapshot/,
  );
  expect(description('computer_screenshot')).toMatch(/NOT returned/);
  expect(description('computer_select')).toMatch(/dropdown/);
});

it('keeps addressing a long batch of actions sent from one snapshot', async () => {
  const f = setup();
  const fields: FakeElement[] = Array.from({ length: 10 }, (_, index) => ({
    ref: `e${index + 1}`,
    role: 'textbox',
    name: `Field ${index + 1}`,
  }));
  f.fake.pages['https://form.test/'] = page('Form', fields);
  const nav = await f.run('navigate', { url: 'https://form.test/' });
  const id = nav.page.snapshotId;
  for (const field of fields) {
    const result = await f.run('type', {
      ref: field.ref,
      snapshotId: id,
      text: 'x',
    });
    expect(result).not.toHaveProperty('error');
  }
  expect(f.fake.calls.filter((call) => call === 'type')).toHaveLength(10);
});

it('lets the owner open a page right after handing control back', async () => {
  const { service, fake, id, workspace } = computerFixture();
  fake.pages['https://form.test/'] = page('Form', form);
  fake.resumeSnapshotRequired = true;
  await service.action(id, 'navigate', { url: 'https://form.test/' }, 'owner');
  expect(fake.url).toBe('https://form.test/');
  expect(fake.calls.filter((call) => call === 'snapshot')).toHaveLength(1);
  // A click still refuses: its refs may belong to the page from before the handback.
  fake.resumeSnapshotRequired = true;
  await expect(
    service.action(id, 'click', { ref: 'e2', snapshotId: 1 }, 'owner'),
  ).rejects.toThrow();
  workspace.close();
});
