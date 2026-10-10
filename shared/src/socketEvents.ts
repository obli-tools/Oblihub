export const SOCKET_EVENTS = {
  STACKS_UPDATED: 'stacks:updated',
  STACK_STATUS_CHANGED: 'stack:status_changed',
  CONTAINER_STATUS_CHANGED: 'container:status_changed',
  UPDATE_PROGRESS: 'update:progress',
  UPDATE_COMPLETE: 'update:complete',
  // Per-layer/per-step live output during a container update (pull progress lines, etc.).
  // Emitted by the update service alongside UPDATE_PROGRESS so the stack page can show a tail.
  UPDATE_LOG: 'update:log',
  DISCOVERY_COMPLETE: 'discovery:complete',

  // Container logs
  CONTAINER_LOGS_SUBSCRIBE: 'container:logs:subscribe',
  CONTAINER_LOGS_UNSUBSCRIBE: 'container:logs:unsubscribe',
  CONTAINER_LOGS_DATA: 'container:logs:data',
  CONTAINER_LOGS_ERROR: 'container:logs:error',

  // Container exec (console)
  CONTAINER_EXEC_START: 'container:exec:start',
  CONTAINER_EXEC_INPUT: 'container:exec:input',
  CONTAINER_EXEC_OUTPUT: 'container:exec:output',
  CONTAINER_EXEC_RESIZE: 'container:exec:resize',
  CONTAINER_EXEC_STOP: 'container:exec:stop',
  CONTAINER_EXEC_ERROR: 'container:exec:error',

  // Container stats
  CONTAINER_STATS_UPDATE: 'container:stats:update',

  // Managed stack compose deploy — live stdout/stderr stream + lifecycle
  COMPOSE_LOG: 'compose:log',         // { projectName, stream: 'stdout'|'stderr', chunk }
  COMPOSE_STARTED: 'compose:started', // { projectName, cmd }
  COMPOSE_FINISHED: 'compose:finished', // { projectName, exitCode, durationMs }
  // Client → server: join / leave a managed stack's compose room. COMPOSE_* events go to that room
  // only (compose output quotes .env values), and the server joins a socket after checking access.
  COMPOSE_SUBSCRIBE: 'compose:subscribe',     // { managedStackId }
  COMPOSE_UNSUBSCRIBE: 'compose:unsubscribe', // { managedStackId }
} as const;
