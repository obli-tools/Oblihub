import type { Server as SocketIOServer } from 'socket.io';

/**
 * The Socket.io server used for stream-mode compose events (COMPOSE_STARTED / LOG / FINISHED).
 * It lives here rather than in compose.service or composeRunner because compose.service imports
 * the runner: keeping the holder in a leaf module avoids a require cycle between the two.
 * compose.service still exports `setComposeServiceIO` as a forwarder so index.ts is unchanged.
 */
let io: SocketIOServer | null = null;

export function setComposeIo(server: SocketIOServer): void {
  io = server;
}

export function getComposeIo(): SocketIOServer | null {
  return io;
}
