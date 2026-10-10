import {
  MAINTENANCE_CONFIG_KEY, DEFAULT_MAINTENANCE_WINDOW,
  effectiveMaintenance, maintenanceAllowsNow, nextWindowOpening, validateGlobalMaintenance, validateStackMaintenance, isValidTimezone,
  type GlobalMaintenance, type StackMaintenance, type EffectiveMaintenance,
} from '@oblihub/shared';
import { db } from '../db';
import { appConfigService } from './appConfig.service';
import { logger } from '../utils/logger';

/**
 * Maintenance windows: gate for AUTOMATIC update work only (scheduled checks, auto-apply, git
 * auto-pull). Manual Check / Update / Pull from the UI are never blocked.
 */

function defaultTimezone(): string {
  const tz = process.env.TZ?.trim();
  return tz && isValidTimezone(tz) ? tz : 'UTC';
}

export function defaultGlobalMaintenance(): GlobalMaintenance {
  return { enabled: false, window: { ...DEFAULT_MAINTENANCE_WINDOW }, timezone: defaultTimezone() };
}

/** Lenient read of a stored stack value: a broken row means "inherit", never "blocked forever". */
export function parseStackMaintenance(raw: unknown): StackMaintenance {
  if (raw == null) return null;
  try {
    return validateStackMaintenance(typeof raw === 'string' ? JSON.parse(raw) : raw);
  } catch {
    return null;
  }
}

export const maintenanceService = {
  async getGlobal(): Promise<GlobalMaintenance> {
    const raw = await appConfigService.get(MAINTENANCE_CONFIG_KEY);
    if (!raw) return defaultGlobalMaintenance();
    try {
      return validateGlobalMaintenance(JSON.parse(raw));
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Invalid maintenance_window setting ignored (updates allowed at any time)');
      return defaultGlobalMaintenance();
    }
  },

  async effectiveFor(stackMaintenance: StackMaintenance): Promise<EffectiveMaintenance> {
    return effectiveMaintenance(await this.getGlobal(), stackMaintenance);
  },

  /** Discovered stack by id. Unknown stack = global rule. */
  async allowsStack(stackId: number, now: Date = new Date()): Promise<boolean> {
    const row = await db('stacks').where({ id: stackId }).first('maintenance_window') as { maintenance_window: unknown } | undefined;
    return maintenanceAllowsNow(await this.effectiveFor(parseStackMaintenance(row?.maintenance_window)), now);
  },

  /**
   * Managed stack (git auto-pull): the window of its discovery row on the same daemon when one
   * exists (that's where the operator sets it), else the global one.
   */
  async allowsManagedStack(composeProject: string, engineId: number | null, now: Date = new Date()): Promise<boolean> {
    const q = db('stacks').where({ compose_project: composeProject });
    if (engineId == null) {
      // A managed stack without engine runs on the local socket, whose discovery rows carry a
      // local-type engine id (legacy rows: NULL).
      const localIds = await db('docker_engines').where({ type: 'local' }).pluck('id') as number[];
      q.where((w) => { w.whereNull('engine_id'); if (localIds.length > 0) w.orWhereIn('engine_id', localIds); });
    } else {
      q.where({ engine_id: engineId });
    }
    const row = await q.first('maintenance_window') as { maintenance_window: unknown } | undefined;
    return maintenanceAllowsNow(await this.effectiveFor(parseStackMaintenance(row?.maintenance_window)), now);
  },

  /** For the UI: rule in force for a stack, open now or not, next opening. */
  async statusFor(stackMaintenance: StackMaintenance, now: Date = new Date()) {
    const eff = await this.effectiveFor(stackMaintenance);
    const open = maintenanceAllowsNow(eff, now);
    return { effective: eff, allowedNow: open, nextOpening: open ? null : nextWindowOpening(eff, now)?.toISOString() ?? null };
  },
};
