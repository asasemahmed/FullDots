import type { CodingStatus } from './coding-sessions.js';

export interface CodingProgressSnapshot {
  codingSessionId: string;
  text: string;
  status: CodingStatus;
}

export function codingProgress(
  codingSessionId: string,
  emit: (value: CodingProgressSnapshot) => void,
) {
  let text = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const flush = (status: CodingStatus) => {
    clearTimeout(timer);
    timer = undefined;
    emit({ codingSessionId, text, status });
  };
  return {
    write(chunk: string) {
      if (closed || text.length >= 40_000) return;
      text = (text + chunk).slice(0, 40_000);
      timer ??= setTimeout(() => flush('running'), 1000);
      timer.unref();
    },
    finish(status: CodingStatus) {
      if (closed) return;
      closed = true;
      flush(status);
    },
  };
}
