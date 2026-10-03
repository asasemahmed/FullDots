import { expect, it } from 'vitest';
import {
  chunkText,
  keyInput,
  modifierMask,
  mouseButton,
  parseStreamMessage,
  pointInFrame,
  wheelPixels,
} from '../src/client/computer-input';
import { computerStreamInputSchema } from '../src/shared/computer-types';

const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
const schema = computerStreamInputSchema({ typeChars: 16000 });

it('maps a point on the scaled screen back to the page and keeps drags inside it', () => {
  const rect = { left: 100, top: 50, width: 640, height: 400 };
  const frame = { width: 1280, height: 800 };
  expect(pointInFrame({ x: 100, y: 50 }, rect, frame)).toEqual({ x: 0, y: 0 });
  expect(pointInFrame({ x: 420, y: 250 }, rect, frame)).toEqual({
    x: 640,
    y: 400,
  });
  expect(pointInFrame({ x: 9999, y: -9999 }, rect, frame)).toEqual({
    x: 1279,
    y: 0,
  });
  expect(
    pointInFrame({ x: 1, y: 1 }, { ...rect, width: 0 }, frame),
  ).toBeUndefined();
});

it('builds Chrome modifier masks and ignores AltGr', () => {
  expect(modifierMask({ ...none, shiftKey: true, ctrlKey: true })).toBe(10);
  expect(modifierMask({ ...none, altKey: true, metaKey: true })).toBe(5);
  expect(
    modifierMask({ ...none, altKey: true, ctrlKey: true, altGraph: true }),
  ).toBe(0);
});

it('translates keys the way the computer expects', () => {
  const key = (init: object) => ({
    key: 'a',
    code: 'KeyA',
    keyCode: 65,
    ...none,
    ...init,
  });
  expect(keyInput(key({}), 'down')).toEqual({
    type: 'key',
    event: 'down',
    key: 'a',
    code: 'KeyA',
    text: 'a',
    windowsVirtualKeyCode: 65,
  });
  // Text only on the way down, and never for a shortcut.
  expect(keyInput(key({}), 'up')).not.toHaveProperty('text');
  expect(keyInput(key({ ctrlKey: true }), 'down')).toMatchObject({
    modifiers: 2,
  });
  expect(keyInput(key({ ctrlKey: true }), 'down')).not.toHaveProperty('text');
  expect(
    keyInput(key({ key: 'Enter', code: 'Enter', keyCode: 13 }), 'down'),
  ).not.toHaveProperty('text');
  expect(
    keyInput(
      key({
        key: '€',
        code: 'Digit4',
        keyCode: 52,
        altGraph: true,
        ctrlKey: true,
        altKey: true,
      }),
      'down',
    ),
  ).toMatchObject({ text: '€' });
  // An empty code and a keyCode of zero still make a message the computer accepts.
  expect(keyInput(key({ code: '', keyCode: 0 }), 'down')).toMatchObject({
    code: 'Unidentified',
  });
  expect(
    schema.safeParse(keyInput(key({ code: '', keyCode: 0 }), 'down')).success,
  ).toBe(true);
  // Composition arrives as text instead.
  expect(keyInput(key({ isComposing: true }), 'down')).toBeUndefined();
  expect(
    keyInput(key({ key: 'Process', keyCode: 229 }), 'down'),
  ).toBeUndefined();
  expect(
    keyInput(key({ key: 'Unidentified', keyCode: 229 }), 'down'),
  ).toBeUndefined();
});

it('turns wheel units into pixels, and buttons into names', () => {
  expect(wheelPixels({ deltaX: 0, deltaY: 100, deltaMode: 0 }, 800)).toEqual({
    x: 0,
    y: 100,
  });
  expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 800)).toEqual({
    x: 0,
    y: 120,
  });
  expect(wheelPixels({ deltaX: 0, deltaY: 2, deltaMode: 2 }, 800)).toEqual({
    x: 0,
    y: 1600,
  });
  expect(wheelPixels({ deltaX: 0, deltaY: 1e9, deltaMode: 0 }, 800).y).toBe(
    10000,
  );
  expect([0, 1, 2, 3].map(mouseButton)).toEqual([
    'left',
    'middle',
    'right',
    undefined,
  ]);
});

it('splits a paste without cutting characters in half', () => {
  expect(chunkText('abcde', 2)).toEqual(['ab', 'cd', 'e']);
  expect(chunkText('😀😀😀', 2)).toEqual(['😀😀', '😀']);
  expect(chunkText('', 2)).toEqual([]);
});

it('accepts only the messages the server sends, with sane frame sizes', () => {
  expect(
    parseStreamMessage(
      '{"type":"frame","data":"abc","width":1280,"height":800}',
    ),
  ).toEqual({
    type: 'frame',
    data: 'abc',
    width: 1280,
    height: 800,
  });
  for (const bad of [
    '{"type":"frame","data":"abc","width":0,"height":800}',
    '{"type":"frame","data":"abc","width":100000,"height":800}',
    '{"type":"frame","data":1,"width":10,"height":10}',
    '{"type":"frame","data":"a","width":1.5,"height":10}',
    '{"type":"ended","reason":"nope","message":"x"}',
    '{"type":"other"}',
    'null',
    'not json',
  ])
    expect(parseStreamMessage(bad)).toBeUndefined();
  expect(
    parseStreamMessage('{"type":"ended","reason":"superseded","message":"m"}'),
  ).toEqual({
    type: 'ended',
    reason: 'superseded',
    message: 'm',
  });
  expect(parseStreamMessage('{"type":"error","error":"e"}')).toEqual({
    type: 'error',
    error: 'e',
  });
});

it('produces only input the server schema accepts', () => {
  const key = keyInput(
    { key: 'A', code: 'KeyA', keyCode: 65, ...none, shiftKey: true },
    'down',
  );
  expect(schema.safeParse(key).success).toBe(true);
  expect(
    schema.safeParse({ type: 'text', text: 'x'.repeat(16001) }).success,
  ).toBe(false);
  expect(
    schema.safeParse({ type: 'mouse', event: 'moved', x: 1, y: 2, extra: true })
      .success,
  ).toBe(false);
});
