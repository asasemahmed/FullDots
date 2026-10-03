import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { ComputerStreamInput } from '../shared/computer-types';
import './computer-screen.css';
import {
  chunkText,
  keyInput,
  modifierMask,
  mouseButton,
  pointInFrame,
  wheelPixels,
  type Frame,
  type KeyEventLike,
} from './computer-input';
import {
  useComputerStream,
  type StreamFrame,
  type StreamPhase,
} from './useComputerStream';

const MOVE_INTERVAL_MS = 33;

interface MouseLike {
  clientX: number;
  clientY: number;
  button: number;
  detail: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

// Events are copied field by field: spreading a DOM event copies nothing, its fields live on the prototype.
const snapshot = (event: MouseLike): MouseLike => ({
  clientX: event.clientX,
  clientY: event.clientY,
  button: event.button,
  detail: event.detail,
  altKey: event.altKey,
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
  shiftKey: event.shiftKey,
});

/**
 * A Dot's browser screen, live.
 *
 * Frames arrive over a WebSocket as Chrome produces them and are painted on a canvas. While the
 * owner holds control, pointer and keyboard input travels back over the same socket. Without
 * control the screen is only watched; the computer refuses input then, and says so.
 *
 * Keyboard input goes through a hidden text field rather than the canvas, because only a text field
 * receives paste, input-method composition and a phone's on-screen keyboard.
 */
export function ComputerScreen({
  dotId,
  dotName,
  interactive,
  typeChars,
  onPhase,
  onFrameSize,
  overlay,
}: {
  dotId: string;
  dotName: string;
  interactive: boolean;
  typeChars: number;
  onPhase: (phase: StreamPhase) => void;
  onFrameSize: (size: Frame | undefined) => void;
  /** Labels laid over the screen by the panel; they are shown and hidden with it. */
  overlay?: ReactNode;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const size = useRef<Frame | undefined>(undefined);
  const painting = useRef<{ busy: boolean; next?: StreamFrame }>({
    busy: false,
  });
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [notice, setNotice] = useState('');
  const paint = useCallback(
    (frame: StreamFrame) => {
      // Only the newest frame is worth drawing: decoding is slower than the socket can deliver.
      painting.current.next = frame;
      if (painting.current.busy) return;
      painting.current.busy = true;
      void (async () => {
        while (painting.current.next) {
          const next = painting.current.next;
          painting.current.next = undefined;
          const image = new Image();
          image.src = `data:image/jpeg;base64,${next.data}`;
          try {
            await image.decode();
          } catch {
            continue;
          }
          const target = canvas.current;
          if (!target) break;
          if (target.width !== next.width || target.height !== next.height) {
            target.width = next.width;
            target.height = next.height;
            size.current = { width: next.width, height: next.height };
            onFrameSize(size.current);
          }
          target
            .getContext('2d')
            ?.drawImage(image, 0, 0, target.width, target.height);
        }
        painting.current.busy = false;
      })();
    },
    [onFrameSize],
  );
  const tell = useCallback((message: string) => {
    setNotice(message);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 5000);
  }, []);
  const { state, send } = useComputerStream({
    dotId,
    onFrame: paint,
    onNotice: tell,
  });
  useEffect(() => onPhase(state), [state, onPhase]);
  useEffect(
    () => () => {
      clearTimeout(noticeTimer.current);
      onFrameSize(undefined);
    },
    [onFrameSize],
  );

  const pointOf = useCallback((clientX: number, clientY: number) => {
    const element = canvas.current;
    const frame = size.current;
    if (!element || !frame) return undefined;
    return pointInFrame(
      { x: clientX, y: clientY },
      element.getBoundingClientRect(),
      frame,
    );
  }, []);
  const mouse = useCallback(
    (event: 'pressed' | 'released' | 'moved', source: MouseLike) => {
      const point = pointOf(source.clientX, source.clientY);
      if (!point) return;
      const button = mouseButton(source.button);
      const input: ComputerStreamInput = {
        type: 'mouse',
        event,
        ...point,
        ...(event !== 'moved' && button
          ? {
              button,
              clickCount: Math.min(3, Math.max(1, source.detail || 1)),
            }
          : {}),
        ...(modifierMask(source) ? { modifiers: modifierMask(source) } : {}),
      };
      send(input);
    },
    [pointOf, send],
  );

  // Pointer moves are sent at most every 33 ms, with the last one held back so the pointer ends
  // where it stopped.
  const moves = useRef<{
    last: number;
    timer?: ReturnType<typeof setTimeout>;
    held?: MouseLike;
  }>({ last: 0 });
  const dropHeldMove = () => {
    clearTimeout(moves.current.timer);
    moves.current.timer = undefined;
    moves.current.held = undefined;
  };
  const move = (source: MouseLike) => {
    const state = moves.current;
    const wait = MOVE_INTERVAL_MS - (performance.now() - state.last);
    if (wait <= 0) {
      state.last = performance.now();
      mouse('moved', source);
      return;
    }
    state.held = snapshot(source);
    state.timer ??= setTimeout(() => {
      state.timer = undefined;
      state.last = performance.now();
      if (state.held) mouse('moved', state.held);
      state.held = undefined;
    }, wait);
  };
  const dragging = useRef<(() => void) | undefined>(undefined);
  useEffect(
    () => () => {
      // Control ended or the screen went away in the middle of a drag.
      dragging.current?.();
      clearTimeout(moves.current.timer);
    },
    [interactive],
  );

  const down = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!interactive || !mouseButton(event.button)) return;
    // Keeps the page from selecting the canvas, and moves focus to the keyboard field instead.
    event.preventDefault();
    keys.current?.focus({ preventScroll: true });
    dropHeldMove();
    dragging.current?.();
    const { button, detail } = event;
    let last = snapshot(event);
    mouse('pressed', last);
    const onMove = (next: globalThis.MouseEvent) => {
      last = snapshot(next);
      move(last);
    };
    const onUp = (next: globalThis.MouseEvent) => {
      if (next.button !== button) return;
      stop();
      mouse('released', { ...snapshot(next), button, detail });
    };
    const stop = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      dropHeldMove();
      dragging.current = undefined;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // If the drag is abandoned, the page still gets to see the button come up.
    dragging.current = () => {
      stop();
      mouse('released', { ...last, button, detail });
    };
  };
  const hover = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (interactive && !dragging.current) move(event);
  };

  useEffect(() => {
    const element = canvas.current;
    if (!element || !interactive) return;
    let held:
      | { x: number; y: number; deltaX: number; deltaY: number; mods: number }
      | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clamp = (value: number) => Math.max(-10000, Math.min(10000, value));
    const flush = () => {
      timer = undefined;
      if (!held) return;
      const { x, y, deltaX, deltaY, mods } = held;
      held = undefined;
      send({
        type: 'wheel',
        x,
        y,
        deltaX: clamp(deltaX),
        deltaY: clamp(deltaY),
        ...(mods ? { modifiers: mods } : {}),
      });
    };
    // Not a React handler: React registers wheel listeners as passive, which cannot stop the panel
    // from scrolling underneath the screen.
    const onWheel = (event: WheelEvent) => {
      const point = pointOf(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      const delta = wheelPixels(event, size.current?.height ?? 800);
      held = {
        ...point,
        deltaX: (held?.deltaX ?? 0) + delta.x,
        deltaY: (held?.deltaY ?? 0) + delta.y,
        mods: modifierMask(event),
      };
      timer ??= setTimeout(flush, MOVE_INTERVAL_MS);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', onWheel);
      clearTimeout(timer);
    };
  }, [interactive, pointOf, send]);

  const sendText = (value: string) => {
    for (const chunk of chunkText(value.replace(/\r\n?/g, '\n'), typeChars))
      send({ type: 'text', text: chunk });
  };
  const tap = (key: string, code: string, keyCode: number) => {
    for (const direction of ['down', 'up'] as const)
      send({
        type: 'key',
        event: direction,
        key,
        code,
        windowsVirtualKeyCode: keyCode,
      });
  };
  const keyLike = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): KeyEventLike => ({
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    isComposing: event.nativeEvent.isComposing,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    altGraph: event.getModifierState('AltGraph'),
  });
  const isPaste = (event: KeyboardEvent<HTMLTextAreaElement>) =>
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.key.toLowerCase() === 'v';
  const keyboard =
    (direction: 'down' | 'up') =>
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!interactive) return;
      // The way out: every other key belongs to the page being controlled, Tab included.
      if (event.shiftKey && event.key === 'Escape') {
        if (direction === 'down') event.currentTarget.blur();
        event.preventDefault();
        return;
      }
      // The text of a paste arrives as a paste event; sending the key too would paste twice.
      if (isPaste(event)) return;
      const input = keyInput(keyLike(event), direction);
      if (!input) return;
      event.preventDefault();
      send(input);
    };
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!interactive) return;
    event.preventDefault();
    sendText(event.clipboardData.getData('text'));
  };
  const typed = (event: FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as InputEvent;
    const field = event.currentTarget;
    if (interactive && !native.isComposing) {
      if (native.inputType === 'deleteContentBackward')
        tap('Backspace', 'Backspace', 8);
      else if (native.inputType === 'insertLineBreak')
        tap('Enter', 'Enter', 13);
      else if (native.data) sendText(native.data);
    }
    field.value = '';
  };

  const shown =
    state.phase === 'live' ||
    state.phase === 'reconnecting' ||
    state.phase === 'paused';
  return (
    <>
      <div
        className={`computer-screen computer-screen-live${interactive ? ' computer-screen-interactive' : ''}`}
        hidden={!shown}
      >
        <canvas
          ref={canvas}
          role="img"
          aria-label={`Live browser screen for ${dotName}`}
          onMouseDown={down}
          onMouseMove={hover}
          onContextMenu={(event) => interactive && event.preventDefault()}
        />
        {interactive && (
          <textarea
            ref={keys}
            className="computer-keys"
            aria-label={`Keyboard for ${dotName}'s computer screen`}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            rows={1}
            onKeyDown={keyboard('down')}
            onKeyUp={keyboard('up')}
            onPaste={paste}
            onInput={typed}
            onCompositionEnd={(event) => {
              if (!interactive) return;
              if (event.data) sendText(event.data);
              event.currentTarget.value = '';
            }}
          />
        )}
        {overlay}
        {shown && notice && (
          <div className="computer-screen-toast" role="status">
            {notice}
          </div>
        )}
      </div>
      {!shown && notice && (
        <p className="cp-alert" role="status">
          {notice}
        </p>
      )}
    </>
  );
}
