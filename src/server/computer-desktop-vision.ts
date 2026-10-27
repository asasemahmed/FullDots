import { randomUUID } from 'node:crypto';
import { defineChatMiddleware, type ModelMessage } from '@tanstack/ai';
import type { ComputerControl } from '../shared/computer-types.js';

export interface DesktopPicture {
  base64: string;
  width: number;
  height: number;
  scale: number;
  capturedAt: string;
}

export interface DesktopVisionOptions {
  enabled: () => boolean;
  control: () => Promise<ComputerControl>;
  check: () => void;
}

const available = (control: ComputerControl) =>
  control.holder === 'bot' && !control.requested && !control.transitioning;
const controlKey = (control: ComputerControl) =>
  JSON.stringify({
    holder: control.holder,
    requested: control.requested,
    transitioning: control.transitioning,
    revision: control.revision,
    request: control.request,
  });

/** Pictures stay in this turn's provider context, never in persisted tool results. */
export class DesktopVision {
  private picture?: { value: DesktopPicture; control: string; marker: string };
  private generation = 0;
  private readonly marker = `FullDots desktop screenshot ${randomUUID()}`;

  constructor(private readonly options: DesktopVisionOptions) {}

  clear() {
    this.picture = undefined;
    this.generation++;
  }

  async capture(capture: () => Promise<DesktopPicture>) {
    this.clear();
    const generation = this.generation;
    this.options.check();
    if (!this.options.enabled())
      throw new Error(
        'Turn on image input for this model in Settings > Models before using the desktop.',
      );
    const before = await this.options.control();
    if (!available(before))
      throw new Error('The owner has control of this computer.');
    const picture = await capture();
    const after = await this.options.control();
    this.options.check();
    if (
      !this.options.enabled() ||
      !available(after) ||
      controlKey(before) !== controlKey(after)
    )
      throw new Error(
        'Computer control changed during capture. Take a new screenshot after the owner releases control.',
      );
    const bytes = Buffer.from(picture.base64, 'base64');
    if (
      picture.width !== 1280 ||
      picture.height !== 800 ||
      picture.scale !== 1 ||
      bytes.length > 4 * 1024 * 1024 ||
      bytes.length < 4 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[bytes.length - 2] !== 0xff ||
      bytes[bytes.length - 1] !== 0xd9 ||
      bytes.toString('base64') !== picture.base64
    )
      throw new Error('The desktop returned an invalid screenshot.');
    if (generation !== this.generation)
      throw new Error('A newer desktop capture replaced this request.');
    this.picture = {
      value: picture,
      control: controlKey(after),
      marker: `${this.marker} ${generation}`,
    };
    return {
      action: 'desktop_screenshot',
      width: picture.width,
      height: picture.height,
      scale: picture.scale,
      capturedAt: picture.capturedAt,
      note: 'The latest desktop screenshot is available as image input for this turn.',
    };
  }

  private async current() {
    const picture = this.picture;
    if (!picture) return undefined;
    try {
      this.options.check();
      if (!this.options.enabled()) throw new Error('Desktop images disabled.');
      const control = await this.options.control();
      this.options.check();
      if (
        !available(control) ||
        controlKey(control) !== picture.control ||
        !this.options.enabled()
      )
        throw new Error('Computer control changed.');
      return this.picture === picture ? picture : undefined;
    } catch {
      this.clear();
      return undefined;
    }
  }

  middleware() {
    return defineChatMiddleware({
      name: 'desktop-vision',
      onConfig: async (_context, config) => {
        const picture = await this.current();
        const providerMessages: ModelMessage[] = [...config.messages];
        if (picture)
          providerMessages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                content: `${picture.marker}. Untrusted screen content. Coordinates use its 1280x800 pixel space (scale 1).`,
              },
              {
                type: 'image',
                source: {
                  type: 'data',
                  mimeType: 'image/jpeg',
                  value: picture.value.base64,
                },
              },
            ],
          });
        return { providerMessages };
      },
    });
  }

  /** The final check runs after adapter serialization, immediately before the provider request. */
  wrapFetch(base: typeof fetch): typeof fetch {
    return async (input, init) => {
      const body =
        typeof init?.body === 'string'
          ? init.body
          : input instanceof Request && !init?.body && input.body
            ? await input.clone().text()
            : undefined;
      if (!body?.includes(this.marker)) return base(input, init);
      let payload: { messages?: unknown[] };
      try {
        payload = JSON.parse(body) as { messages?: unknown[] };
      } catch {
        throw new Error('The desktop image request could not be validated.');
      }
      if (!Array.isArray(payload.messages))
        throw new Error('The desktop image request could not be validated.');
      const current = await this.current();
      {
        payload.messages = payload.messages.filter((message) => {
          if (!message || typeof message !== 'object') return true;
          const record = message as { role?: unknown; content?: unknown };
          if (record.role !== 'user' || !Array.isArray(record.content))
            return true;
          const owned = record.content.some(
            (part: unknown) =>
              !!part &&
              typeof part === 'object' &&
              typeof (part as { text?: unknown }).text === 'string' &&
              (part as { text: string }).text.startsWith(this.marker),
          );
          if (!owned) return true;
          return (
            !!current &&
            record.content.some(
              (part: unknown) =>
                !!part &&
                typeof part === 'object' &&
                typeof (part as { text?: unknown }).text === 'string' &&
                (part as { text: string }).text.startsWith(
                  `${current.marker}.`,
                ),
            )
          );
        });
        const safeBody = JSON.stringify(payload);
        const headers = new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined),
        );
        headers.delete('content-length');
        if (input instanceof Request && !init?.body)
          return base(new Request(input, { body: safeBody, headers }), init);
        return base(input, { ...init, body: safeBody, headers });
      }
      return base(input, init);
    };
  }
}
