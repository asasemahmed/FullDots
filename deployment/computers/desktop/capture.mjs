import { spawn } from 'node:child_process';

export const WIDTH = 1280;
export const HEIGHT = 800;
export const MAX_JPEG = 4 * 1024 * 1024;

/** One bounded MJPEG decoder shared by live viewers and explicit captures. */
export class JpegFrames {
  constructor(accept) {
    this.accept = accept;
    this.pending = Buffer.alloc(0);
  }
  push(chunk) {
    if (chunk.length + this.pending.length > MAX_JPEG * 2)
      throw new Error('Desktop capture exceeded its buffer limit.');
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length) {
      const start = this.pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        this.pending = this.pending.subarray(-1);
        return;
      }
      if (start) this.pending = this.pending.subarray(start);
      const end = this.pending.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (end < 0) {
        if (this.pending.length > MAX_JPEG)
          throw new Error('Desktop frame exceeded its size limit.');
        return;
      }
      if (end + 2 > MAX_JPEG)
        throw new Error('Desktop frame exceeded its size limit.');
      this.accept(Buffer.from(this.pending.subarray(0, end + 2)));
      this.pending = this.pending.subarray(end + 2);
    }
  }
}

export class DesktopCapture {
  constructor(start = spawn) {
    this.start = start;
    this.listeners = new Set();
    this.waiters = new Set();
  }
  ensure() {
    if (this.process) return;
    const child = this.start(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'x11grab',
        '-draw_mouse',
        '1',
        '-framerate',
        '2',
        '-video_size',
        `${WIDTH}x${HEIGHT}`,
        '-i',
        process.env.DISPLAY || ':0',
        '-an',
        '-threads',
        '1',
        '-filter_threads',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    this.process = child;
    const fail = () => {
      if (this.process !== child) return;
      this.process = undefined;
      for (const waiter of [...this.waiters])
        waiter.reject(new Error('Desktop capture stopped.'));
      child.kill();
      for (const listener of this.listeners) {
        try {
          listener({
            type: 'error',
            error: 'Desktop capture stopped. Reconnecting.',
          });
        } catch {
          /* Viewer closed. */
        }
      }
      clearTimeout(this.retry);
      if (this.listeners.size)
        this.retry = setTimeout(() => this.ensure(), 1000).unref();
    };
    const parser = new JpegFrames((jpeg) => {
      const frame = {
        type: 'frame',
        data: jpeg.toString('base64'),
        width: WIDTH,
        height: HEIGHT,
      };
      for (const listener of this.listeners) {
        try {
          listener(frame);
        } catch {
          /* A closed viewer cannot stop the shared capture. */
        }
      }
      for (const waiter of [...this.waiters]) waiter.resolve(frame);
    });
    child.stdout.on('data', (chunk) => {
      try {
        parser.push(chunk);
      } catch {
        fail();
      }
    });
    child.once('error', fail);
    child.once('exit', fail);
  }
  subscribe(listener) {
    this.ensure();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  next(signal) {
    signal?.throwIfAborted();
    this.ensure();
    if (this.waiters.size >= 16)
      return Promise.reject(new Error('Desktop capture is busy.'));
    return new Promise((resolve, reject) => {
      const finish = (result, failed) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.waiters.delete(waiter);
        if (failed) reject(result);
        else resolve(result);
      };
      const waiter = {
        resolve: (frame) => finish(frame, false),
        reject: (error) => finish(error, true),
      };
      const abort = () =>
        waiter.reject(new Error('Desktop capture cancelled.'));
      const timer = setTimeout(
        () => waiter.reject(new Error('Desktop capture timed out.')),
        5000,
      );
      this.waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  close() {
    clearTimeout(this.retry);
    const child = this.process;
    this.process = undefined;
    child?.kill();
    for (const waiter of [...this.waiters])
      waiter.reject(new Error('Desktop capture stopped.'));
    this.listeners.clear();
  }
}

export const capture = new DesktopCapture();
process.once('exit', () => capture.close());
