import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { WIDTH, HEIGHT } from './capture.mjs';

const exec = promisify(execFile);
const buttons = { left: 1, middle: 2, right: 3 };
const aliases = {
  Control: 'Control_L',
  ctrl: 'Control_L',
  Alt: 'Alt_L',
  alt: 'Alt_L',
  Shift: 'Shift_L',
  shift: 'Shift_L',
  Meta: 'Super_L',
  super: 'Super_L',
  Enter: 'Return',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ' ': 'space',
  '+': 'plus',
  '-': 'minus',
  '=': 'equal',
  ';': 'semicolon',
  ':': 'colon',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  '?': 'question',
  '\\': 'backslash',
  '|': 'bar',
  "'": 'apostrophe',
  '"': 'quotedbl',
  '[': 'bracketleft',
  ']': 'bracketright',
  '{': 'braceleft',
  '}': 'braceright',
  '`': 'grave',
  '~': 'asciitilde',
  '!': 'exclam',
  '@': 'at',
  '#': 'numbersign',
  $: 'dollar',
  '%': 'percent',
  '^': 'asciicircum',
  '&': 'ampersand',
  '*': 'asterisk',
  '(': 'parenleft',
  ')': 'parenright',
  _: 'underscore',
  '<': 'less',
  '>': 'greater',
};
const named = new Set([
  'Control_L',
  'Control_R',
  'Alt_L',
  'Alt_R',
  'Shift_L',
  'Shift_R',
  'Super_L',
  'Super_R',
  'Return',
  'Tab',
  'Escape',
  'BackSpace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'Prior',
  'Next',
  'Page_Up',
  'Page_Down',
  'Left',
  'Right',
  'Up',
  'Down',
  'Caps_Lock',
  'space',
  ...Object.values(aliases),
]);
export function keyName(value) {
  const key = aliases[value] ?? value;
  if (
    typeof key !== 'string' ||
    !(
      named.has(key) ||
      /^[A-Za-z0-9]$/.test(key) ||
      /^F([1-9]|1[0-9]|2[0-4])$/.test(key)
    )
  )
    throw new Error('Unsupported desktop key.');
  return key;
}
export function keyCombo(value) {
  if (typeof value !== 'string' || value.length > 100)
    throw new Error('Invalid desktop keys.');
  const parts = value === '+' ? ['plus'] : value.split('+');
  if (!parts.length || parts.length > 5)
    throw new Error('Invalid desktop keys.');
  return parts.map(keyName).join('+');
}
const point = (value) => {
  if (
    !value ||
    !Number.isInteger(value.x) ||
    !Number.isInteger(value.y) ||
    value.x < 0 ||
    value.x >= WIDTH ||
    value.y < 0 ||
    value.y >= HEIGHT
  )
    throw new Error('Use desktop coordinates within 1280x800.');
  return value;
};
const object = (value, keys) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('Invalid desktop input.');
  return value;
};
export function parseDesktopInput(action, input) {
  if (action === 'screenshot') return object(input, []);
  if (action === 'click') {
    const value = point(object(input, ['x', 'y', 'button', 'double']));
    if (value.button !== undefined && !Object.hasOwn(buttons, value.button))
      throw new Error('Invalid desktop button.');
    if (value.double !== undefined && typeof value.double !== 'boolean')
      throw new Error('Invalid desktop click.');
    return {
      ...value,
      button: value.button ?? 'left',
      double: value.double ?? false,
    };
  }
  if (action === 'drag') {
    const value = object(input, ['from', 'to']);
    point(object(value.from, ['x', 'y']));
    point(object(value.to, ['x', 'y']));
    return value;
  }
  if (action === 'type') {
    const value = object(input, ['text']);
    if (typeof value.text !== 'string' || value.text.length > 16000)
      throw new Error('Desktop text is too long.');
    return value;
  }
  if (action === 'key') {
    const value = object(input, ['keys']);
    return { keys: keyCombo(value.keys) };
  }
  if (action === 'scroll') {
    const value = point(object(input, ['x', 'y', 'dx', 'dy']));
    for (const key of ['dx', 'dy'])
      if (
        value[key] !== undefined &&
        (!Number.isFinite(value[key]) || Math.abs(value[key]) > 10000)
      )
        throw new Error('Invalid desktop scroll.');
    return { ...value, dx: value.dx ?? 0, dy: value.dy ?? 0 };
  }
  throw new Error('Unknown desktop action.');
}
let pending = Promise.resolve();
let queued = 0;
export function serial(operation) {
  if (queued >= 64) return Promise.reject(new Error('Desktop input is busy.'));
  queued++;
  const next = pending
    .catch(() => {})
    .then(operation)
    .finally(() => {
      queued--;
    });
  pending = next;
  return next;
}
async function run(args, signal) {
  try {
    await exec('xdotool', args, { timeout: 5000, maxBuffer: 4096, signal });
  } catch {
    throw new Error('Desktop input could not be applied.');
  }
}
async function paste(text, signal) {
  signal?.throwIfAborted();
  const child = spawn('xclip', ['-selection', 'clipboard', '-in'], {
    stdio: ['pipe', 'ignore', 'ignore'],
    signal,
  });
  child.stdin.on('error', () => {});
  child.stdin.end(text);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Desktop paste timed out.'));
    }, 5000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Desktop paste failed.'));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Desktop paste failed.'));
    });
  });
  await run(['key', '--clearmodifiers', 'Control_L+v'], signal);
}
export async function releaseKeys() {
  await run([
    'keyup',
    'Control_L',
    'Control_R',
    'Shift_L',
    'Shift_R',
    'Alt_L',
    'Alt_R',
    'Super_L',
    'Super_R',
  ]).catch(() => {});
  for (const button of ['1', '2', '3'])
    await run(['mouseup', button]).catch(() => {});
}
export async function input(action, value, signal) {
  signal?.throwIfAborted();
  if (action === 'type') {
    await paste(value.text, signal);
    return;
  }
  if (action === 'key') {
    try {
      await run(['key', '--clearmodifiers', value.keys], signal);
    } finally {
      await releaseKeys();
    }
    return;
  }
  if (action === 'click') {
    await run(
      [
        'mousemove',
        String(value.x),
        String(value.y),
        'click',
        '--repeat',
        value.double ? '2' : '1',
        '--delay',
        '100',
        String(buttons[value.button]),
      ],
      signal,
    );
    return;
  }
  if (action === 'drag') {
    try {
      await run(
        [
          'mousemove',
          String(value.from.x),
          String(value.from.y),
          'mousedown',
          '1',
          'mousemove',
          '--sync',
          String(value.to.x),
          String(value.to.y),
        ],
        signal,
      );
    } finally {
      await run(['mouseup', '1']).catch(() => {});
    }
    return;
  }
  if (action === 'scroll') {
    await run(['mousemove', String(value.x), String(value.y)], signal);
    for (const [delta, positive, negative] of [
      [value.dx, '7', '6'],
      [value.dy, '5', '4'],
    ])
      if (delta)
        await run(
          [
            'click',
            '--repeat',
            String(Math.min(100, Math.ceil(Math.abs(delta) / 80))),
            delta > 0 ? positive : negative,
          ],
          signal,
        );
  }
}
export async function ownerInput(message) {
  if (message.type === 'text') return paste(message.text);
  if (message.type === 'key')
    return run([
      message.event === 'down' ? 'keydown' : 'keyup',
      keyName(message.key),
    ]);
  if (message.type === 'wheel')
    return input(
      'scroll',
      parseDesktopInput('scroll', {
        x: Math.round(message.x),
        y: Math.round(message.y),
        dx: message.deltaX,
        dy: message.deltaY,
      }),
    );
  const at = point({ x: Math.round(message.x), y: Math.round(message.y) });
  const args = ['mousemove', String(at.x), String(at.y)];
  if (message.event !== 'moved')
    args.push(
      message.event === 'pressed' ? 'mousedown' : 'mouseup',
      String(buttons[message.button ?? 'left']),
    );
  await run(args);
}
