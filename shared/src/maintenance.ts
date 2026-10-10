/**
 * Maintenance windows: when AUTOMATIC update work may run (scheduled registry checks, auto-apply,
 * git auto-pull + redeploy). Outside the window nothing automatic happens; manual actions always work.
 *
 * A window is a daily time range in the configured time zone. `start > end` spans midnight
 * (18:00 → 08:00). `start === end` means the whole day. `days` (0 = Sunday … 6 = Saturday) lists
 * the days a window STARTS on: with 18:00 → 08:00 and days = [5] (Friday), Saturday 03:00 is inside.
 */

export interface MaintenanceWindow {
  /** HH:MM, 24 h. */
  start: string;
  /** HH:MM, 24 h. */
  end: string;
  /** Days the window starts on; absent or empty = every day. */
  days?: number[];
}

/** Global setting (app_config `maintenance_window`). */
export interface GlobalMaintenance {
  /** Off = updates allowed at any time (unless a stack sets its own window). */
  enabled: boolean;
  window: MaintenanceWindow;
  /** IANA zone the hours are read in, e.g. Europe/Paris. */
  timezone: string;
}

/** Per-stack setting: null = inherit the global one. */
export type StackMaintenance =
  | null
  | { mode: 'always' }
  | { mode: 'custom'; window: MaintenanceWindow };

export interface EffectiveMaintenance {
  restricted: boolean;
  source: 'global' | 'stack' | 'none';
  window: MaintenanceWindow | null;
  timezone: string;
}

export const MAINTENANCE_CONFIG_KEY = 'maintenance_window';
export const DEFAULT_MAINTENANCE_WINDOW: MaintenanceWindow = { start: '18:00', end: '08:00' };
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHHMM(v: string): number | null {
  const m = HHMM_RE.exec(v?.trim?.() ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Throws an Error with an operator-facing message. Returns a normalised copy. */
export function validateMaintenanceWindow(raw: unknown): MaintenanceWindow {
  const w = raw as Partial<MaintenanceWindow> | null;
  if (!w || typeof w !== 'object') throw new Error('Maintenance window required');
  if (typeof w.start !== 'string' || parseHHMM(w.start) == null) throw new Error('Window start must be HH:MM (24 h)');
  if (typeof w.end !== 'string' || parseHHMM(w.end) == null) throw new Error('Window end must be HH:MM (24 h)');
  let days: number[] | undefined;
  if (w.days != null) {
    if (!Array.isArray(w.days) || w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Window days must be 0 (Sunday) … 6 (Saturday)');
    days = [...new Set(w.days)].sort();
    if (days.length === 0 || days.length === 7) days = undefined;
  }
  return { start: w.start.trim(), end: w.end.trim(), ...(days ? { days } : {}) };
}

export function validateGlobalMaintenance(raw: unknown): GlobalMaintenance {
  const g = raw as Partial<GlobalMaintenance> | null;
  if (!g || typeof g !== 'object') throw new Error('Invalid maintenance setting');
  const timezone = typeof g.timezone === 'string' && g.timezone.trim() ? g.timezone.trim() : 'UTC';
  if (!isValidTimezone(timezone)) throw new Error(`Unknown time zone "${timezone}"`);
  return { enabled: !!g.enabled, window: validateMaintenanceWindow(g.window ?? DEFAULT_MAINTENANCE_WINDOW), timezone };
}

export function validateStackMaintenance(raw: unknown): StackMaintenance {
  if (raw == null) return null;
  const s = raw as { mode?: unknown; window?: unknown };
  if (s.mode === 'always') return { mode: 'always' };
  if (s.mode === 'custom') return { mode: 'custom', window: validateMaintenanceWindow(s.window) };
  throw new Error('Stack maintenance mode must be inherit (null), "always" or "custom"');
}

export function effectiveMaintenance(global: GlobalMaintenance, stack: StackMaintenance): EffectiveMaintenance {
  if (stack?.mode === 'always') return { restricted: false, source: 'stack', window: null, timezone: global.timezone };
  if (stack?.mode === 'custom') return { restricted: true, source: 'stack', window: stack.window, timezone: global.timezone };
  if (global.enabled) return { restricted: true, source: 'global', window: global.window, timezone: global.timezone };
  return { restricted: false, source: 'none', window: null, timezone: global.timezone };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Minute of day and weekday of `date` in `tz`. */
export function localClock(date: Date, tz: string): { minutes: number; weekday: number } {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' });
    formatters.set(tz, f);
  }
  let hour = 0, minute = 0, weekday = 0;
  for (const p of f.formatToParts(date)) {
    if (p.type === 'hour') hour = Number(p.value) % 24;
    else if (p.type === 'minute') minute = Number(p.value);
    else if (p.type === 'weekday') weekday = WEEKDAY_INDEX[p.value] ?? 0;
  }
  return { minutes: hour * 60 + minute, weekday };
}

export function isWithinWindow(window: MaintenanceWindow, date: Date, tz: string): boolean {
  const start = parseHHMM(window.start);
  const end = parseHHMM(window.end);
  if (start == null || end == null) return true; // a broken window never blocks updates forever
  const { minutes, weekday } = localClock(date, tz);
  const dayOk = (d: number) => !window.days || window.days.length === 0 || window.days.includes(d);
  if (start === end) return dayOk(weekday);
  if (start < end) return minutes >= start && minutes < end && dayOk(weekday);
  // Spans midnight: the evening part belongs to today, the morning part to yesterday's window.
  if (minutes >= start) return dayOk(weekday);
  if (minutes < end) return dayOk((weekday + 6) % 7);
  return false;
}

/** True when automatic update work may run now. */
export function maintenanceAllowsNow(eff: EffectiveMaintenance, date: Date = new Date()): boolean {
  return !eff.restricted || !eff.window || isWithinWindow(eff.window, date, eff.timezone);
}

/** Next time the window opens (minute precision, within 8 days), or null when open now / never. */
export function nextWindowOpening(eff: EffectiveMaintenance, from: Date = new Date()): Date | null {
  if (maintenanceAllowsNow(eff, from) || !eff.window) return null;
  const t = new Date(Math.ceil(from.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    if (isWithinWindow(eff.window, t, eff.timezone)) return t;
    t.setTime(t.getTime() + 60_000);
  }
  return null;
}

export function describeWindow(window: MaintenanceWindow): string {
  const days = window.days && window.days.length > 0 ? ` (${window.days.map((d) => WEEKDAY_LABELS[d]).join(', ')})` : '';
  return window.start === window.end ? `all day${days}` : `${window.start} → ${window.end}${days}`;
}
