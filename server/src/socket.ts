import type { Server as HttpServer } from 'http';
import { Readable, Duplex } from 'stream';
import { Server as SocketIOServer, Socket } from 'socket.io';
import cookieParser from 'cookie-parser';
import { SOCKET_EVENTS } from '@oblihub/shared';
import { dockerService } from './services/docker.service';
// Static on purpose: nothing composeRunner imports imports this module, so there is no cycle.
import { COMPOSE_ADMINS_ROOM } from './services/composeRunner.service';
import { config } from './config';
import { logger } from './utils/logger';

// express-session's default cookie name: app.ts sets no `name`, so both sides must agree on this one.
const SESSION_COOKIE = 'connect.sid';
const INT4_MAX = 2_147_483_647;
/**
 * Backstop period of revalidateSocketAccess. Callers that revoke access trigger it right away; this
 * catches the paths that do not (SSO team sync, discovery dropping a stacks row and its team links,
 * an expired session), so a revoked socket keeps compose output for at most this long.
 */
const SOCKET_REVALIDATE_MS = 60_000;

let socketServer: SocketIOServer | null = null;

// Track active streams per socket to clean up on disconnect
interface SocketState {
  logStreams: Map<string, Readable>;
  // We track engineId alongside the exec stream so resize requests target the same daemon —
  // dockerode's resize call has to go to whichever engine owns the exec id.
  execStreams: Map<string, { stream: Duplex; execId: string; engineId: number | null }>;
  /** managedStackId → compose room joined for it. Kept per id because the room follows the stack's
   *  daemon: a resubscribe after an engine move must leave the old room, not re-resolve the new one. */
  composeRooms: Map<number, string>;
  /** managedStackId → token of the latest subscribe or re-check. A check still awaiting its access
   *  query when an unsubscribe (or a newer subscribe or re-check) arrives must not act afterwards. */
  composeWanted: Map<number, number>;
}

let composeSubscribeSeq = 0;

/** Set by the handshake. `sessionId` lets revalidateSocketAccess and logout find the socket's session again. */
interface SocketIdentity { userId?: number; userRole?: string; sessionId?: string }

function socketUser(socket: Socket): SocketIdentity {
  return socket as unknown as SocketIdentity;
}

/**
 * The session id of a signed express-session cookie, or null. The signature is checked with the
 * session secret, as express-session does: the old regex took any `connect.sid=s%3A<sid>` at face
 * value, so knowing a session id (the session table stores them in clear) was enough without the
 * signature. An unsigned value is refused, as express-session ignores it too. First occurrence
 * wins, like the `cookie` parser.
 */
function sessionIdFromCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try { value = decodeURIComponent(value); } catch { return null; }
    // signedCookie() returns an unprefixed value unchanged, so the prefix must be required here.
    if (!value.startsWith('s:')) return null;
    const sid = cookieParser.signedCookie(value, config.sessionSecret);
    return typeof sid === 'string' && sid.length > 0 ? sid : null;
  }
  return null;
}

/**
 * The signed-in user of session `sid`, or null when the session is gone (logout), expired, or its
 * user is deactivated or deleted. Shared by the handshake and revalidateSocketAccess, so a socket
 * opened before any of these ends with them. Throws on a database error: callers tell "unknown"
 * from "revoked".
 */
async function loadSessionUser(sid: string): Promise<{ userId: number; role: string } | null> {
  const { db } = await import('./db');
  // Same filter as connect-pg-simple's get(): a row past `expire` is a dead session that its
  // prune has not removed yet.
  const sessionRow = await db('session').where('sid', sid).andWhere('expire', '>=', new Date()).select('sess').first();
  const raw = sessionRow?.sess;
  const sess = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { userId?: unknown; role?: unknown } | null | undefined;
  if (!sess || typeof sess.userId !== 'number') return null;
  // Deactivating a user does not destroy their sessions; refuse a live socket to them anyway.
  const user = await db('users').where({ id: sess.userId }).select('is_active').first() as { is_active: boolean } | undefined;
  if (!user?.is_active) return null;
  return { userId: sess.userId, role: typeof sess.role === 'string' && sess.role ? sess.role : 'user' };
}

/**
 * Look up the engine id for a given Docker container id. Returns null when the container is
 * unknown OR explicitly on the local engine, so callers can pass the result straight to the
 * dockerService methods (null = local).
 */
async function resolveEngineIdForContainer(dockerId: string): Promise<number | null> {
  try {
    const { db } = await import('./db');
    const row = await db('containers').where({ docker_id: dockerId }).select('engine_id').first();
    return (row?.engine_id as number | undefined) ?? null;
  } catch {
    return null;
  }
}

const socketStates = new Map<string, SocketState>();

function getState(socket: Socket): SocketState {
  let state = socketStates.get(socket.id);
  if (!state) {
    state = { logStreams: new Map(), execStreams: new Map(), composeRooms: new Map(), composeWanted: new Map() };
    socketStates.set(socket.id, state);
  }
  return state;
}

/** Strip the 8-byte Docker multiplexed stream header from each frame */
function stripDockerHeader(buf: Buffer): string {
  const chunks: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    if (offset + 8 + size > buf.length) {
      // Incomplete frame — output remainder as-is
      chunks.push(buf.slice(offset).toString('utf8'));
      break;
    }
    chunks.push(buf.slice(offset + 8, offset + 8 + size).toString('utf8'));
    offset += 8 + size;
  }
  if (offset < buf.length && chunks.length === 0) {
    // No valid headers found — treat as raw TTY output
    return buf.toString('utf8');
  }
  return chunks.join('');
}

async function checkContainerAccess(socket: Socket, dockerId: string): Promise<boolean> {
  const { userId, userRole } = socketUser(socket);
  if (!userId) return false;
  if (userRole === 'admin') return true;
  // Find container by dockerId and check team access
  try {
    const { db } = await import('./db');
    const container = await db('containers').where({ docker_id: dockerId }).first();
    if (!container) return false;
    const { teamService } = await import('./services/team.service');
    return teamService.userHasAccess(userId, 'container', container.id);
  } catch { return false; }
}

function setupLogHandlers(socket: Socket) {
  socket.on(SOCKET_EVENTS.CONTAINER_LOGS_SUBSCRIBE, async (data: { dockerId: string; tail?: number }) => {
    const state = getState(socket);
    const { dockerId, tail = 100 } = data;

    // Check access
    if (!await checkContainerAccess(socket, dockerId)) {
      socket.emit(SOCKET_EVENTS.CONTAINER_LOGS_ERROR, { dockerId, error: 'Access denied' });
      return;
    }

    // Clean up existing log stream for this container
    const existing = state.logStreams.get(dockerId);
    if (existing) {
      existing.destroy();
      state.logStreams.delete(dockerId);
    }

    try {
      // Route to the right daemon for remote engines. Falls back to local if the container
      // isn't tracked in our DB (shouldn't happen in practice, but defends against races).
      const engineId = await resolveEngineIdForContainer(dockerId);
      const stream = await dockerService.getContainerLogs(dockerId, tail, engineId);
      state.logStreams.set(dockerId, stream);

      stream.on('data', (chunk: Buffer) => {
        const text = stripDockerHeader(chunk);
        if (text) {
          socket.emit(SOCKET_EVENTS.CONTAINER_LOGS_DATA, { dockerId, data: text });
        }
      });

      stream.on('end', () => {
        state.logStreams.delete(dockerId);
      });

      stream.on('error', (err: Error) => {
        logger.error({ dockerId, err }, 'Log stream error');
        socket.emit(SOCKET_EVENTS.CONTAINER_LOGS_ERROR, { dockerId, error: err.message });
        state.logStreams.delete(dockerId);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      socket.emit(SOCKET_EVENTS.CONTAINER_LOGS_ERROR, { dockerId, error: msg });
    }
  });

  socket.on(SOCKET_EVENTS.CONTAINER_LOGS_UNSUBSCRIBE, (data: { dockerId: string }) => {
    const state = getState(socket);
    const stream = state.logStreams.get(data.dockerId);
    if (stream) {
      stream.destroy();
      state.logStreams.delete(data.dockerId);
    }
  });
}

function setupExecHandlers(socket: Socket) {
  socket.on(SOCKET_EVENTS.CONTAINER_EXEC_START, async (data: { dockerId: string; cols?: number; rows?: number }) => {
    if (!config.allowConsole) {
      socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_ERROR, { dockerId: data.dockerId, error: 'Console access is disabled. Set ALLOW_CONSOLE=true to enable.' });
      return;
    }

    // Check access
    if (!await checkContainerAccess(socket, data.dockerId)) {
      socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_ERROR, { dockerId: data.dockerId, error: 'Access denied' });
      return;
    }

    const state = getState(socket);
    const { dockerId, cols = 80, rows = 24 } = data;

    // Clean up existing exec for this container
    const existing = state.execStreams.get(dockerId);
    if (existing) {
      existing.stream.destroy();
      state.execStreams.delete(dockerId);
    }

    try {
      const engineId = await resolveEngineIdForContainer(dockerId);
      const { exec, stream } = await dockerService.execContainer(dockerId, cols, rows, engineId);
      state.execStreams.set(dockerId, { stream, execId: exec.id, engineId });

      stream.on('data', (chunk: Buffer) => {
        socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_OUTPUT, { dockerId, data: chunk.toString('utf8') });
      });

      stream.on('end', () => {
        state.execStreams.delete(dockerId);
        socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_ERROR, { dockerId, error: 'Session ended' });
      });

      stream.on('error', (err: Error) => {
        logger.error({ dockerId, err }, 'Exec stream error');
        socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_ERROR, { dockerId, error: err.message });
        state.execStreams.delete(dockerId);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_ERROR, { dockerId, error: msg });
    }
  });

  socket.on(SOCKET_EVENTS.CONTAINER_EXEC_INPUT, (data: { dockerId: string; data: string }) => {
    const state = getState(socket);
    const entry = state.execStreams.get(data.dockerId);
    if (entry) {
      entry.stream.write(data.data);
    }
  });

  socket.on(SOCKET_EVENTS.CONTAINER_EXEC_RESIZE, async (data: { dockerId: string; cols: number; rows: number }) => {
    const state = getState(socket);
    const entry = state.execStreams.get(data.dockerId);
    if (entry) {
      try {
        await dockerService.execResize(entry.execId, data.cols, data.rows, entry.engineId);
      } catch (err) {
        logger.warn({ dockerId: data.dockerId, err }, 'Failed to resize exec');
      }
    }
  });

  socket.on(SOCKET_EVENTS.CONTAINER_EXEC_STOP, (data: { dockerId: string }) => {
    const state = getState(socket);
    const entry = state.execStreams.get(data.dockerId);
    if (entry) {
      entry.stream.destroy();
      state.execStreams.delete(data.dockerId);
    }
  });
}

/**
 * The same gate as GET /api/managed-stacks/:id: stack management enabled, stacks.view, and the
 * per-id team check (canAccessManagedStack, which also covers stacks sharing the stack folder).
 * Compose output quotes .env values, so the room is as private as the stack's own page — for as
 * long as the socket stays in it, which is why syncComposeSubscription re-runs this on every
 * revalidateSocketAccess and not only on subscribe.
 */
async function checkManagedStackAccess(socket: Socket, managedStackId: number): Promise<boolean> {
  const { userId, userRole } = socketUser(socket);
  if (!userId || !config.allowStack) return false;
  if (userRole === 'admin') return true;
  const { permissionService } = await import('./services/permission.service');
  if (!(await permissionService.hasPermission(userRole || 'user', 'stacks.view'))) return false;
  const { db } = await import('./db');
  const row = await db('managed_stacks').where({ id: managedStackId })
    .select('compose_project', 'engine_id').first() as { compose_project: string; engine_id: number | null } | undefined;
  if (!row) return false;
  const { canAccessManagedStack } = await import('./services/managed-stack.service');
  return canAccessManagedStack(userId, { id: managedStackId, composeProject: row.compose_project, engineId: row.engine_id ?? null });
}

/** Leaves the room joined for `managedStackId`, unless another subscription of this socket uses it. */
function leaveComposeRoom(socket: Socket, state: SocketState, managedStackId: number): void {
  const room = state.composeRooms.get(managedStackId);
  if (!room) return;
  state.composeRooms.delete(managedStackId);
  for (const other of state.composeRooms.values()) if (other === room) return;
  void socket.leave(room);
}

function parseManagedStackId(data: unknown): number | null {
  const id = (data as { managedStackId?: unknown } | null)?.managedStackId;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= INT4_MAX ? id : null;
}

/**
 * Puts the socket in the room of the stack's CURRENT (daemon, project) while its user may see the
 * stack, and takes it out once they may not or the stack is gone. Runs on subscribe and again on
 * every revalidateSocketAccess: the room is keyed by project name, not by stack id, so a member
 * checked only once would keep the output of a stack it lost access to, or of whichever stack
 * takes the name after a delete or rename. A check that fails (database error) changes nothing:
 * a subscribe does not join, and a joined socket stays until a later check succeeds. `token` must
 * still be the latest for this id when the check ends, else an unsubscribe or a newer check decides.
 */
async function syncComposeSubscription(socket: Socket, state: SocketState, managedStackId: number, token: number): Promise<void> {
  let allowed = false;
  let room: string | null = null;
  try {
    allowed = await checkManagedStackAccess(socket, managedStackId);
    if (allowed) {
      const { composeRunner } = await import('./services/composeRunner.service');
      const target = await composeRunner.resolveTarget({ managedStackId });
      if (target) room = composeRunner.composeRoom(target.daemonKey, target.projectName);
    }
  } catch (err) {
    logger.warn({ err, managedStackId }, 'Compose log subscription check failed');
    return;
  }
  if (state.composeWanted.get(managedStackId) !== token || !socket.connected) return;
  if (room == null) {
    if (!allowed) {
      const msg = state.composeRooms.has(managedStackId) ? 'Compose log subscription revoked' : 'Compose log subscribe denied';
      logger.warn({ userId: socketUser(socket).userId, managedStackId }, msg);
    }
    // Dropped rather than kept for the next check: ids a client may not see never cost a re-check.
    // The editor subscribes again when it is reopened or the socket reconnects.
    state.composeWanted.delete(managedStackId);
    leaveComposeRoom(socket, state, managedStackId);
    return;
  }
  if (state.composeRooms.get(managedStackId) === room) return;
  leaveComposeRoom(socket, state, managedStackId);
  state.composeRooms.set(managedStackId, room);
  void socket.join(room);
}

/**
 * COMPOSE_* events go to a per-(daemon, project) room (composeRunner.composeRoom), never to every
 * socket. Admin sockets are also put in COMPOSE_ADMINS_ROOM at connect, which receives every
 * COMPOSE_* event, only for the previous client bundle (it never subscribes; see the connection
 * handler). The current bundle relies on the per-stack subscribe below, admins included: its first
 * subscribe takes the socket out of the admins room. The client resubscribes on every reconnect (a
 * new socket starts with no room) and after an engine move (new daemon, new room);
 * revalidateSocketAccess also moves or drops subscriptions server side when the stack or access changes.
 *
 * The subscribe takes an optional ack, called once on every path with whether the socket is now in
 * the stack's room. The editor waits for it (its value is ignored) before a deploy that follows a
 * move or rename, so the first lines of that deploy reach the room it just joined.
 */
function setupComposeHandlers(socket: Socket) {
  socket.on(SOCKET_EVENTS.COMPOSE_SUBSCRIBE, async (data: unknown, ack?: unknown) => {
    const done = (ok: boolean): void => { if (typeof ack === 'function') ack(ok); };
    const managedStackId = parseManagedStackId(data);
    if (managedStackId == null) { done(false); return; }
    // Only the current bundle sends COMPOSE_SUBSCRIBE: its DeployLogPanel filters on projectName
    // alone, so staying in the catch-all admins room would mix a same-name project of another
    // daemon into the panel. Leaving it restores per-(daemon, project) isolation for this socket.
    void socket.leave(COMPOSE_ADMINS_ROOM);
    const state = getState(socket);
    const token = ++composeSubscribeSeq;
    state.composeWanted.set(managedStackId, token);
    try {
      await syncComposeSubscription(socket, state, managedStackId, token);
    } finally {
      done(state.composeRooms.has(managedStackId));
    }
  });

  socket.on(SOCKET_EVENTS.COMPOSE_UNSUBSCRIBE, (data: unknown) => {
    const managedStackId = parseManagedStackId(data);
    if (managedStackId == null) return;
    const state = getState(socket);
    state.composeWanted.delete(managedStackId);
    leaveComposeRoom(socket, state, managedStackId);
  });
}

function cleanupSocket(socket: Socket) {
  const state = socketStates.get(socket.id);
  if (!state) return;

  for (const stream of state.logStreams.values()) {
    stream.destroy();
  }
  for (const entry of state.execStreams.values()) {
    entry.stream.destroy();
  }
  socketStates.delete(socket.id);
}

async function revalidateSocket(socket: Socket): Promise<void> {
  const state = socketStates.get(socket.id);
  // Tokens are taken before the first await: a subscribe or unsubscribe arriving during the checks
  // replaces or removes them, and then decides instead.
  const checks = state
    ? [...state.composeWanted.keys()].map((id) => {
      const token = ++composeSubscribeSeq;
      state.composeWanted.set(id, token);
      return { id, token };
    })
    : [];
  const identity = socketUser(socket);
  try {
    const user = identity.sessionId ? await loadSessionUser(identity.sessionId) : null;
    if (!user) {
      logger.info({ socketId: socket.id, userId: identity.userId }, 'Socket session ended; disconnecting');
      socket.disconnect(true);
      return;
    }
    // The socket follows its session, as HTTP requests do (requireRole reads the session's role).
    identity.userId = user.userId;
    identity.userRole = user.role;
    // The admins room carries every stack's compose output: a demoted admin leaves it at once.
    if (user.role !== 'admin') void socket.leave(COMPOSE_ADMINS_ROOM);
  } catch (err) {
    // Unknown, not revoked: the socket keeps its identity until a later check succeeds.
    logger.warn({ err, socketId: socket.id }, 'Socket session re-check failed');
  }
  if (!state || !socket.connected) return;
  await Promise.all(checks.map(({ id, token }) => syncComposeSubscription(socket, state, id, token)));
}

/**
 * Re-checks connected sockets against the database: the session behind each one (gone, expired, or
 * a deactivated or deleted user disconnects it), then every compose subscription
 * (syncComposeSubscription: dropped when access is gone, moved when the stack was renamed or moved
 * to another daemon). Runs every SOCKET_REVALIDATE_MS as a backstop; await it right after a change
 * that can revoke access or re-key a room — managed stack delete, rename or engine move, team
 * members, team resources, role permissions — so a reused project name never reaches an old
 * subscriber. `userId` limits it to that user's sockets. Never throws.
 */
export async function revalidateSocketAccess(filter: { userId?: number } = {}): Promise<void> {
  const io = socketServer;
  if (!io) return;
  try {
    const sockets = [...io.of('/').sockets.values()]
      .filter((s) => filter.userId == null || socketUser(s).userId === filter.userId);
    await Promise.all(sockets.map((s) => revalidateSocket(s)));
  } catch (err) {
    logger.warn({ err }, 'Socket access revalidation failed');
  }
}

/**
 * Disconnects every socket of `userId` now: for a deactivated or deleted user. The client does not
 * reconnect after a server-side disconnect (useSocket only retries refused handshakes), so this is
 * not the tool for a team or role change — revalidateSocketAccess keeps the socket and drops only
 * what the user may no longer see.
 */
export function disconnectUserSockets(userId: number): void {
  if (!socketServer) return;
  const sockets = [...socketServer.of('/').sockets.values()].filter((s) => socketUser(s).userId === userId);
  for (const s of sockets) s.disconnect(true);
}

/**
 * Ids of the sockets whose subscription to `managedStackId` is currently in `room`. For a compose run
 * that must also reach them outside that room (runner `mirrorTo`): an engine move deploys on the
 * target daemon while the editor still sits in the source room. A socket id is a room of its own in
 * socket.io, and a mirror lasts for that one run only, unlike a join, which nothing would undo.
 */
export function composeSubscriberIds(managedStackId: number, room: string): string[] {
  const ids: string[] = [];
  for (const [socketId, state] of socketStates) {
    if (state.composeRooms.get(managedStackId) === room) ids.push(socketId);
  }
  return ids;
}

/** Disconnects every socket opened with session `sessionId` now: for logout (req.sessionID). */
export function disconnectSessionSockets(sessionId: string): void {
  if (!socketServer) return;
  const sockets = [...socketServer.of('/').sockets.values()].filter((s) => socketUser(s).sessionId === sessionId);
  for (const s of sockets) s.disconnect(true);
}

let revalidateSweepRunning = false;

async function revalidateSweep(): Promise<void> {
  // A slow database must not pile sweeps up; explicit revalidateSocketAccess calls are not skipped.
  if (revalidateSweepRunning) return;
  revalidateSweepRunning = true;
  try {
    await revalidateSocketAccess();
  } finally {
    revalidateSweepRunning = false;
  }
}

export function createSocketServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173', credentials: true },
  });

  // Authenticate Socket.IO connections via the signed session cookie. A socket without a signed-in
  // session is refused outright: it used to be let in without a user, and every io.emit reached it.
  // The client reconnects after a refusal (useSocket), e.g. once the user has signed in.
  io.use(async (socket, next) => {
    const sid = sessionIdFromCookie(socket.handshake.headers.cookie);
    if (!sid) return next(new Error('Authentication required'));
    try {
      const user = await loadSessionUser(sid);
      if (!user) return next(new Error('Authentication required'));
      const target = socketUser(socket);
      target.userId = user.userId;
      target.userRole = user.role;
      target.sessionId = sid;
    } catch (err) {
      logger.warn({ err }, 'Socket session lookup failed');
      return next(new Error('Authentication required'));
    }
    next();
  });

  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, 'Socket connected');

    setupLogHandlers(socket);
    setupExecHandlers(socket);
    setupComposeHandlers(socket);
    // Keeps the deploy log of the previous client bundle working for admins across a server-only
    // self-update: that bundle never sends COMPOSE_SUBSCRIBE (see COMPOSE_ADMINS_ROOM). The current
    // bundle's first subscribe takes the socket back out.
    if (socketUser(socket).userRole === 'admin') void socket.join(COMPOSE_ADMINS_ROOM);

    socket.on('disconnect', () => {
      logger.info({ socketId: socket.id }, 'Socket disconnected');
      cleanupSocket(socket);
    });
  });

  socketServer = io;
  // unref: the backstop timer alone must not keep the process alive at shutdown.
  setInterval(() => { void revalidateSweep(); }, SOCKET_REVALIDATE_MS).unref();

  return io;
}
