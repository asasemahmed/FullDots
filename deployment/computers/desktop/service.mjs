import { capture, WIDTH, HEIGHT } from './capture.mjs';
import {
  input,
  ownerInput,
  parseDesktopInput,
  releaseKeys,
  serial,
} from './input.mjs';

let currentControl;
export function bindDesktopControl(control) {
  currentControl = control;
}
const privateControl = (control) => {
  const state = control.get();
  return state.holder === 'human' || state.requested || state.transitioning;
};

export async function desktopRequest(request, control) {
  const path = new URL(request.url).pathname;
  const human = path.startsWith('/human/');
  const action = path.slice(human ? '/human/'.length : '/desktop/'.length);
  if (
    !(
      human
        ? ['click', 'type', 'key', 'scroll']
        : ['screenshot', 'click', 'drag', 'type', 'key', 'scroll']
    ).includes(action)
  )
    return Response.json({ error: 'Unknown desktop action.' }, { status: 400 });
  if (request.method !== (action === 'screenshot' ? 'GET' : 'POST'))
    return Response.json(
      { error: 'Unsupported desktop method.' },
      { status: 405 },
    );
  let release;
  try {
    const ownerCapture =
      action === 'screenshot' &&
      request.headers.get('x-fulldots-computer-actor') === 'owner';
    if (human) {
      if (!control.humanMayDrive())
        return Response.json({ error: 'Take control first.' }, { status: 409 });
    } else if (!ownerCapture)
      release = control.admitBotAction(action !== 'screenshot');
    const raw = action === 'screenshot' ? {} : await request.json();
    const parsed = human
      ? parseHuman(action, raw)
      : parseDesktopInput(action, raw);
    if (action === 'screenshot') {
      const before = control.get();
      if (!ownerCapture && privateControl(control))
        return Response.json(
          { error: 'The owner has control.' },
          { status: 409 },
        );
      const frame = await capture.next(request.signal);
      const after = control.get();
      if (
        !ownerCapture &&
        (privateControl(control) || before.request?.id !== after.request?.id)
      )
        return Response.json(
          { error: 'Computer control changed during capture.' },
          { status: 409 },
        );
      if (!ownerCapture) control.snapshotTaken();
      return Response.json({
        action: 'desktop_screenshot',
        base64: frame.data,
        mimeType: 'image/jpeg',
        width: WIDTH,
        height: HEIGHT,
        scale: 1,
        capturedAt: new Date().toISOString(),
      });
    }
    await serial(async () => {
      request.signal.throwIfAborted();
      if (human) {
        if (!control.humanMayDrive()) throw new Error('Take control first.');
      } else control.assertBotMayAct(true);
      await input(action, parsed, request.signal);
    });
    return Response.json({
      action: `${human ? 'human' : 'desktop'}_${action}`,
      ...(action === 'type' ? { characters: parsed.text.length } : {}),
    });
  } catch (error) {
    if (['ControlError', 'SnapshotRequiredError'].includes(error?.name))
      throw error;
    return Response.json(
      {
        error: 'Desktop input was invalid, cancelled or could not be applied.',
      },
      { status: 400 },
    );
  } finally {
    release?.();
  }
}

function parseHuman(action, raw) {
  if (action === 'click')
    return parseDesktopInput(action, { ...raw, button: 'left', double: false });
  if (action === 'key') {
    if (!raw || Object.keys(raw).some((key) => key !== 'key'))
      throw new Error('Invalid key.');
    return parseDesktopInput(action, { keys: raw.key });
  }
  if (action === 'scroll') {
    if (!raw || Object.keys(raw).some((key) => key !== 'deltaY'))
      throw new Error('Invalid scroll.');
    return parseDesktopInput(action, {
      x: WIDTH / 2,
      y: HEIGHT / 2,
      dx: 0,
      dy: raw.deltaY,
    });
  }
  return parseDesktopInput(action, raw);
}

export async function startScreencast(_page, onFrame) {
  const stop = capture.subscribe(onFrame);
  return {
    async stop() {
      stop();
      await serial(releaseKeys);
    },
    send(message) {
      return serial(async () => {
        if (!currentControl?.humanMayDrive())
          throw new Error('Take control first.');
        await ownerInput(message);
      });
    },
  };
}
