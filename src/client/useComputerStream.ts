import { useCallback, useEffect, useRef, useState } from 'react';
import {
  computerStreamPath,
  type ComputerStreamEndReason,
  type ComputerStreamInput,
  type ComputerStreamMessage,
  type ComputerStreamTicket,
} from '../shared/computer-types';
import { api, ApiError } from './api';
import { parseStreamMessage } from './computer-input';

export type StreamPhase =
  /** Opening the first time. */
  | { phase: 'connecting' }
  /** Frames are arriving. */
  | { phase: 'live' }
  /** Was live and is opening again. The last frame is still on screen. */
  | { phase: 'reconnecting' }
  /** Closed on purpose while the browser tab was in the background. Reopens when it comes back. */
  | { phase: 'paused' }
  /** Closed by the server for a reason that opening again will not change, such as another viewer. */
  | { phase: 'ended'; reason: ComputerStreamEndReason; message: string }
  /** Could not be opened, or kept dropping. The caller should fall back to snapshots. */
  | { phase: 'failed'; message: string };

export type StreamFrame = Extract<ComputerStreamMessage, { type: 'frame' }>;

const MAX_FAILURES = 4;
const BACKGROUND_GRACE_MS = 15_000;

/**
 * The live screen for one Dot, for as long as the component using it is mounted.
 *
 * Remount it (change its `key`) to start over. It reconnects with a short backoff, gives up after
 * a few failures in a row so the caller can show snapshots instead, and does not hold a socket open
 * for a tab nobody is looking at.
 */
export function useComputerStream({
  dotId,
  onFrame,
  onNotice,
}: {
  dotId: string;
  onFrame: (frame: StreamFrame) => void;
  onNotice: (message: string) => void;
}) {
  const [state, setState] = useState<StreamPhase>({ phase: 'connecting' });
  const socket = useRef<WebSocket | undefined>(undefined);
  const handlers = useRef({ onFrame, onNotice });
  useEffect(() => {
    handlers.current = { onFrame, onNotice };
  });
  useEffect(() => {
    let cancelled = false;
    let paused = false;
    let everLive = false;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const waiting = () =>
      setState({ phase: everLive ? 'reconnecting' : 'connecting' });
    const retry = (message: string) => {
      failures += 1;
      if (failures > MAX_FAILURES) {
        setState({ phase: 'failed', message });
        return;
      }
      waiting();
      retryTimer = setTimeout(
        () => void connect(),
        Math.min(15_000, 500 * 2 ** (failures - 1)),
      );
    };
    const connect = async () => {
      retryTimer = undefined;
      let ticket: ComputerStreamTicket;
      try {
        ticket = await api<ComputerStreamTicket>(
          `/dots/${encodeURIComponent(dotId)}/computer/stream`,
          'POST',
          {},
          controller.signal,
        );
      } catch (cause) {
        if (cancelled || paused) return;
        // The server said no (permission, unknown Dot): trying again will not change that.
        if (cause instanceof ApiError && cause.status < 500) {
          setState({ phase: 'failed', message: cause.message });
          return;
        }
        retry('Could not reach the server.');
        return;
      }
      if (cancelled || paused) return;
      const ws = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${computerStreamPath(dotId)}?ticket=${encodeURIComponent(ticket.ticket)}`,
      );
      socket.current = ws;
      let announced = false;
      let ended: Extract<ComputerStreamMessage, { type: 'ended' }> | undefined;
      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string' || socket.current !== ws) return;
        const message = parseStreamMessage(event.data);
        if (!message) return;
        if (message.type === 'frame') {
          if (!announced) {
            announced = true;
            everLive = true;
            failures = 0;
            setState({ phase: 'live' });
          }
          handlers.current.onFrame(message);
        } else if (message.type === 'error')
          handlers.current.onNotice(message.error);
        else ended = message;
      };
      ws.onclose = () => {
        if (socket.current === ws) socket.current = undefined;
        else return;
        if (cancelled || paused) return;
        if (ended?.reason === 'superseded' || ended?.reason === 'permission') {
          setState({
            phase: 'ended',
            reason: ended.reason,
            message: ended.message,
          });
          return;
        }
        retry(ended?.message ?? 'The live screen disconnected.');
      };
    };
    const onVisibility = () => {
      if (document.hidden) {
        backgroundTimer ??= setTimeout(() => {
          backgroundTimer = undefined;
          paused = true;
          clearTimeout(retryTimer);
          retryTimer = undefined;
          socket.current?.close();
          setState({ phase: 'paused' });
        }, BACKGROUND_GRACE_MS);
        return;
      }
      clearTimeout(backgroundTimer);
      backgroundTimer = undefined;
      if (paused) {
        paused = false;
        failures = 0;
        waiting();
        void connect();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (document.hidden) onVisibility();
    void connect();
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(retryTimer);
      clearTimeout(backgroundTimer);
      controller.abort();
      const open = socket.current;
      socket.current = undefined;
      open?.close();
    };
  }, [dotId]);
  const send = useCallback((input: ComputerStreamInput) => {
    const open = socket.current;
    if (open?.readyState !== WebSocket.OPEN || open.bufferedAmount > 1_000_000)
      return false;
    open.send(JSON.stringify(input));
    return true;
  }, []);
  return { state, send };
}
