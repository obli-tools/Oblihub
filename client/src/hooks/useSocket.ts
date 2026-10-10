import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

let sharedSocket: Socket | null = null;
let refCount = 0;
let teardownTimer: ReturnType<typeof setTimeout> | null = null;

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

interface RetryState {
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
}

// Retry state is kept per socket: a socket that is no longer the shared one must never hold, run
// or cancel the shared socket's pending retry.
const retries = new WeakMap<Socket, RetryState>();

function resetRetry(s: Socket): void {
  const retry = retries.get(s);
  if (!retry) return;
  if (retry.timer) clearTimeout(retry.timer);
  retry.timer = null;
  retry.attempt = 0;
}

function getSocket(): Socket {
  if (!sharedSocket) {
    const s = io({ transports: ['websocket', 'polling'] });
    const retry: RetryState = { timer: null, attempt: 0 };
    retries.set(s, retry);
    // The server refuses a handshake that carries no signed-in session, and socket.io never retries
    // a refusal by server middleware on its own (`active` is false then; transport errors keep it
    // true and use the built-in reconnection). A session can appear after the first attempt (sign-in
    // in another tab) or its lookup can fail once (database restart), so retry with a back-off.
    s.on('connect_error', () => {
      if (sharedSocket !== s || s.active || retry.timer) return;
      const delay = Math.min(RETRY_BASE_MS * 2 ** retry.attempt, RETRY_MAX_MS);
      retry.attempt++;
      retry.timer = setTimeout(() => {
        retry.timer = null;
        if (sharedSocket === s && !s.connected && !s.active) s.connect();
      }, delay);
    });
    s.on('connect', () => {
      // A socket that is no longer the shared one has no owner left to tear it down: close it
      // instead of keeping a session-authenticated connection open for the tab's lifetime.
      if (sharedSocket !== s) { s.disconnect(); return; }
      resetRetry(s);
    });
    sharedSocket = s;
  }
  return sharedSocket;
}

/** After sign-in: a socket refused while signed out reconnects now instead of after its back-off. */
export function reconnectSocket(): void {
  const s = sharedSocket;
  if (!s || s.connected || s.active) return;
  resetRetry(s);
  s.connect();
}

// Deferred to the next task: React renders the incoming page (which picks up the shared socket)
// before it runs the outgoing page's cleanup, so a synchronous teardown would disconnect the socket
// the new page is about to use. The new page's effect runs in the same flush, before this timer,
// and cancels it. StrictMode's mount/unmount/mount in dev takes the same path.
function scheduleTeardown(): void {
  if (teardownTimer) clearTimeout(teardownTimer);
  teardownTimer = setTimeout(() => {
    teardownTimer = null;
    const s = sharedSocket;
    if (refCount > 0 || !s) return;
    sharedSocket = null;
    resetRetry(s);
    s.disconnect();
  }, 0);
}

export function useSocket(): Socket {
  // Lazy initializer: resolved once per mount, not on every render (a re-render while no socket is
  // shared would otherwise open a new one).
  const [socket, setSocket] = useState<Socket>(getSocket);

  useEffect(() => {
    refCount++;
    if (teardownTimer) {
      clearTimeout(teardownTimer);
      teardownTimer = null;
    }
    // The socket picked at render can have been torn down before this effect ran (render and commit
    // are not always in the same task, e.g. behind Suspense). Never revive it: use the live shared
    // one, and re-render so consumers re-subscribe on it (same socket = no re-render).
    const s = getSocket();
    setSocket(s);
    if (!s.connected) s.connect();
    return () => {
      refCount = Math.max(0, refCount - 1);
      if (refCount === 0) scheduleTeardown();
    };
  }, []);

  return socket;
}
