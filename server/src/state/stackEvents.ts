import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger';

/**
 * In-process events about stacks, so modules can react to each other without importing each other
 * (e.g. a resources apply deferred while the priority watchdog yields a stack runs on
 * `watchdog:resumed`). Listeners are wrapped: a throwing listener or a rejected promise is logged and
 * never reaches the emitter, so one broken subscriber cannot crash the watchdog loop that emits.
 */
export type StackEventMap = {
  'watchdog:yielded': { stackId: number; mode: 'pause' | 'stop'; reason: string };
  'watchdog:resumed': { stackId: number; reason: string };
};

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

function logListenerError(event: string, err: unknown): void {
  logger.warn({ event, err: err instanceof Error ? err.message : String(err) }, 'Stack event listener failed');
}

export const stackEvents: {
  emit<K extends keyof StackEventMap>(event: K, payload: StackEventMap[K]): void;
  on<K extends keyof StackEventMap>(event: K, listener: (p: StackEventMap[K]) => void | Promise<void>): () => void;
} = {
  emit(event, payload) {
    emitter.emit(event, payload);
  },

  on(event, listener) {
    const wrapped = (payload: StackEventMap[typeof event]): void => {
      try {
        const result = listener(payload);
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch((err: unknown) => logListenerError(event, err));
        }
      } catch (err) {
        logListenerError(event, err);
      }
    };
    emitter.on(event, wrapped);
    return () => { emitter.off(event, wrapped); };
  },
};
