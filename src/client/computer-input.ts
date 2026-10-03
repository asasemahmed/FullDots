import type {
  ComputerStreamEndReason,
  ComputerStreamInput,
  ComputerStreamMessage,
} from '../shared/computer-types';

/** Chrome's modifier bit mask, which is what the computer forwards to the page. */
const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

export interface ModifierState {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** AltGr reports as Control and Alt together on Windows, but means neither to the page. */
  altGraph?: boolean;
}

export function modifierMask(state: ModifierState): number {
  const graph = !!state.altGraph;
  return (
    (state.altKey && !graph ? ALT : 0) |
    (state.ctrlKey && !graph ? CTRL : 0) |
    (state.metaKey ? META : 0) |
    (state.shiftKey ? SHIFT : 0)
  );
}

export interface Frame {
  width: number;
  height: number;
}

/**
 * Where a pointer is in the page being shown, in the page's own pixels.
 *
 * The image is scaled to fit the panel, so a position on screen is a fraction of the shown size
 * applied to the page's size. Clamped, because a drag that leaves the screen still needs an end.
 */
export function pointInFrame(
  client: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  frame: Frame,
): { x: number; y: number } | undefined {
  if (!(rect.width > 0) || !(rect.height > 0)) return undefined;
  const scale = (offset: number, shown: number, size: number) =>
    Math.min(size - 1, Math.max(0, Math.round((offset / shown) * size)));
  return {
    x: scale(client.x - rect.left, rect.width, frame.width),
    y: scale(client.y - rect.top, rect.height, frame.height),
  };
}

export function mouseButton(
  button: number,
): 'left' | 'middle' | 'right' | undefined {
  return button === 0
    ? 'left'
    : button === 1
      ? 'middle'
      : button === 2
        ? 'right'
        : undefined;
}

/** How far a wheel turn moves the page, whatever unit the browser reports it in. */
export function wheelPixels(
  event: { deltaX: number; deltaY: number; deltaMode: number },
  pageHeight: number,
): { x: number; y: number } {
  const factor =
    event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? pageHeight : 1;
  const clamp = (value: number) =>
    Math.max(-10000, Math.min(10000, Math.round(value * factor)));
  return { x: clamp(event.deltaX), y: clamp(event.deltaY) };
}

export interface KeyEventLike extends ModifierState {
  key: string;
  code: string;
  keyCode: number;
  isComposing?: boolean;
}

/**
 * One key going down or up, as the computer wants it.
 *
 * Returns nothing for keys the keyboard is still composing (an input method, or a phone keyboard
 * that reports `Unidentified`), because those arrive as text instead and sending both would type
 * everything twice.
 */
export function keyInput(
  event: KeyEventLike,
  direction: 'down' | 'up',
): ComputerStreamInput | undefined {
  if (
    event.isComposing ||
    event.key === 'Process' ||
    event.key === 'Dead' ||
    (event.key === 'Unidentified' && event.keyCode === 229)
  )
    return undefined;
  const modifiers = modifierMask(event);
  // A character is only text when nothing is turning it into a shortcut.
  const typed =
    direction === 'down' &&
    [...event.key].length === 1 &&
    !(modifiers & (CTRL | META));
  return {
    type: 'key',
    event: direction,
    key: event.key,
    code: event.code || 'Unidentified',
    ...(typed ? { text: event.key } : {}),
    ...(event.keyCode >= 1 && event.keyCode <= 255
      ? { windowsVirtualKeyCode: event.keyCode }
      : {}),
    ...(modifiers ? { modifiers } : {}),
  };
}

/** Splits at code points so a paste larger than one message never cuts a character in half. */
export function chunkText(value: string, size: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let count = 0;
  for (const character of value) {
    if (count === size) {
      chunks.push(current);
      current = '';
      count = 0;
    }
    current += character;
    count += 1;
  }
  if (current) chunks.push(current);
  return chunks;
}

const END_REASONS: ComputerStreamEndReason[] = [
  'superseded',
  'stopped',
  'unavailable',
  'permission',
  'shutdown',
];

/** What came over the socket, or nothing when it is not a message this panel understands. */
export function parseStreamMessage(
  raw: string,
): ComputerStreamMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const message = value as Record<string, unknown>;
  if (message.type === 'frame') {
    const { data, width, height } = message;
    // Bounded, because the numbers size a canvas.
    if (
      typeof data !== 'string' ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      (width as number) < 1 ||
      (width as number) > 8192 ||
      (height as number) < 1 ||
      (height as number) > 8192
    )
      return undefined;
    return {
      type: 'frame',
      data,
      width: width as number,
      height: height as number,
    };
  }
  if (message.type === 'error' && typeof message.error === 'string')
    return { type: 'error', error: message.error };
  if (
    message.type === 'ended' &&
    typeof message.message === 'string' &&
    END_REASONS.includes(message.reason as ComputerStreamEndReason)
  )
    return {
      type: 'ended',
      reason: message.reason as ComputerStreamEndReason,
      message: message.message,
    };
  return undefined;
}
