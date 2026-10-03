import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComputerActivity } from '../src/client/ComputerActivity';
import {
  clipText,
  describeComputerStep,
  describeComputerSteps,
} from '../src/client/ComputerToolCard';

const call = (name: string, args: unknown = {}, id = name) => ({
  id,
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
});
const idle = { live: false };

it('shows a real exec failure and does not treat a nonzero exit as success', () => {
  const step = describeComputerStep(
    call('computer_exec', { command: 'cat missing.txt' }),
    JSON.stringify({ exitCode: 1, stdout: '', stderr: 'File not found' }),
    idle,
  );
  expect(step.state).toBe('failed');
  expect(step.message).toBe('File not found');
  expect(step.detail).toBe('cat missing.txt');
  expect(step.label).toBe('Running terminal command');
});

it('marks unfinished calls interrupted after a run ends and running while it is live', () => {
  const navigate = call('computer_navigate', { url: 'https://example.com' });
  const stale = describeComputerStep(navigate, undefined, idle);
  expect(stale.state).toBe('interrupted');
  expect(stale.detail).toBe('example.com');
  expect(describeComputerStep(navigate, undefined, { live: true }).state).toBe(
    'running',
  );
  expect(
    describeComputerStep(navigate, '{"url":"https://example.com"}', idle).state,
  ).toBe('done');
});

it.each([
  [
    {
      status: 'stopped',
      reason: 'stop_requested',
      message: 'The run was stopped.',
    },
    'interrupted',
  ],
  [
    {
      status: 'error',
      reason: 'missing_terminal_event',
      message: 'The tool never returned.',
    },
    'failed',
  ],
  [{ error: 'Element not found' }, 'failed'],
] as const)('recognizes runtime-finalized tool result %j', (result, state) => {
  const step = describeComputerStep(
    call('computer_navigate'),
    JSON.stringify(result),
    idle,
  );
  expect(step.state).toBe(state);
  expect(step.message).toBe(
    'message' in result ? result.message : result.error,
  );
});

it('describes steps with short details and never leaks base64', () => {
  const base64 = 'A'.repeat(5000);
  const screenshot = describeComputerStep(
    call('computer_screenshot'),
    JSON.stringify({ base64, url: 'https://www.example.com/a/b?q=1' }),
    idle,
  );
  expect(screenshot.state).toBe('done');
  expect(screenshot.detail).toBe('example.com/a/b?q=1');
  expect(JSON.stringify(screenshot)).not.toContain('AAAAAAAAAA');
  // Large results are not parsed on render but still classified.
  const huge = describeComputerStep(
    call('computer_screenshot'),
    `{"url":"https://example.com/","base64":"${'B'.repeat(1_100_000)}"}`,
    idle,
  );
  expect(huge.state).toBe('done');
  expect(huge.detail).toBe('example.com');
  expect(
    describeComputerStep(
      call('computer_exec', { command: 'echo data:image/png;base64,AAAA' }),
      '{}',
      idle,
    ).detail,
  ).toContain('echo');
  expect(clipText('data:image/png;base64,AAAA')).toBe('');
  expect(clipText(`x ${'Q'.repeat(300)}`)).toBe('x …');
  expect(clipText('word '.repeat(60), 40)).toHaveLength(40);
  expect(
    describeComputerStep(call('computer_scroll', { deltaY: -600 }), '{}', idle)
      .detail,
  ).toBe('Up 600px');
  expect(
    describeComputerStep(call('computer_key', { key: 'Enter' }), '{}', idle)
      .detail,
  ).toBe('Enter');
});

it('names clicked and typed elements from the preceding snapshot and masks secrets', () => {
  const steps = describeComputerSteps(
    [
      call('computer_snapshot', {}, 'snap'),
      call('computer_click', { ref: 'f1e2', snapshotId: 1 }, 'click'),
      call(
        'computer_type',
        { ref: 'f1e3', snapshotId: 1, text: 'Ahmed', submit: true },
        'type',
      ),
      call(
        'computer_type',
        { ref: 'f1e4', snapshotId: 1, text: 'hunter2' },
        'secret',
      ),
      call('computer_click', { ref: 'unknown', snapshotId: 1 }, 'unknown'),
    ],
    new Map([
      [
        'snap',
        JSON.stringify({
          snapshotId: 1,
          url: 'https://example.com/',
          title: 'Example sign in',
          elements: [
            { ref: 'f1e2', role: 'button', name: 'Sign in' },
            { ref: 'f1e3', role: 'textbox', name: 'First name' },
            { ref: 'f1e4', role: 'textbox', name: 'Password' },
          ],
        }),
      ],
      ['click', '{"action":"click"}'],
      ['type', '{"action":"type","submitted":true}'],
      ['secret', '{"action":"type"}'],
      ['unknown', '{"action":"click"}'],
    ]),
    false,
  );
  expect(steps[0].detail).toBe('Example sign in');
  expect(steps[1].detail).toBe('button “Sign in”');
  expect(steps[2].detail).toBe('“Ahmed” in textbox “First name” + Enter');
  expect(steps[3].detail).toBe('“••••••” in textbox “Password”');
  expect(JSON.stringify(steps[3])).not.toContain('hunter2');
  expect(steps[4].detail).toBe('element unknown');
});

const steps = describeComputerSteps(
  [
    call('computer_navigate', { url: 'https://example.com' }, 'a'),
    call('computer_type', { ref: 'r', snapshotId: 1, text: 'Hi' }, 'b'),
    call('computer_click', { ref: 'r', snapshotId: 1 }, 'c'),
  ],
  new Map([
    ['a', '{"url":"https://example.com"}'],
    ['b', '{"error":"Element is not editable"}'],
  ]),
  true,
);

it('shows a slim collapsed row with the current step and count while running', () => {
  const html = renderToStaticMarkup(
    <ComputerActivity
      steps={steps}
      live
      dotName="Scout"
      onViewLive={() => {}}
    />,
  );
  expect(html).toContain('Using the computer');
  expect(html).toContain('Clicking in browser');
  expect(html).toContain('3 steps');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('View live');
  expect(html).toContain('is-live');
  expect(html).not.toContain('chat-activity-steps');
  expect(html).not.toContain('Element is not editable');
});

it('summarises a finished block and expands to one line per step', () => {
  const finished = steps.map((step) =>
    step.state === 'running' ? { ...step, state: 'done' as const } : step,
  );
  const collapsed = renderToStaticMarkup(
    <ComputerActivity steps={finished} live={false} dotName="Scout" />,
  );
  expect(collapsed).toContain('Used the computer');
  expect(collapsed).toContain('3 steps');
  expect(collapsed).toContain('1 failed');
  expect(collapsed).not.toContain('View live');
  expect(collapsed).not.toContain('is-live');
  const expanded = renderToStaticMarkup(
    <ComputerActivity
      steps={finished}
      live={false}
      dotName="Scout"
      defaultExpanded
    />,
  );
  expect(expanded).toContain('aria-expanded="true"');
  expect(expanded.match(/<li /g)).toHaveLength(3);
  expect(expanded).toContain('Opening website');
  expect(expanded).toContain('example.com');
  expect(expanded).toContain('Element is not editable');
  expect(expanded).toContain('is-failed');
});
