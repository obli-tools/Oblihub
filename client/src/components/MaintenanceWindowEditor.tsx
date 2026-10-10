import { WEEKDAY_LABELS, parseHHMM, type MaintenanceWindow } from '@oblihub/shared';

/**
 * Start / end hours + days of a maintenance window. `start > end` spans midnight (18:00 → 08:00),
 * `start === end` is the whole day. No day selected = every day.
 */
export function MaintenanceWindowEditor({ value, onChange, disabled }: {
  value: MaintenanceWindow;
  onChange: (w: MaintenanceWindow) => void;
  disabled?: boolean;
}) {
  const days = value.days ?? [];
  const toggleDay = (d: number) => {
    const next = days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort();
    onChange({ ...value, days: next.length === 0 || next.length === 7 ? undefined : next });
  };
  const start = parseHHMM(value.start);
  const end = parseHHMM(value.end);
  const overnight = start != null && end != null && start > end;
  const allDay = start != null && start === end;
  const inputCls = 'rounded-md border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-sm text-text-secondary">
        <span>From</span>
        <input type="time" value={value.start} disabled={disabled} onChange={e => onChange({ ...value, start: e.target.value })} className={inputCls} />
        <span>to</span>
        <input type="time" value={value.end} disabled={disabled} onChange={e => onChange({ ...value, end: e.target.value })} className={inputCls} />
        {overnight && <span className="text-xs text-text-muted">(overnight, ends the next day)</span>}
        {allDay && <span className="text-xs text-text-muted">(whole day)</span>}
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        {WEEKDAY_LABELS.map((label, d) => {
          const on = days.length === 0 || days.includes(d);
          return (
            <button key={label} type="button" disabled={disabled} onClick={() => toggleDay(d)}
              className={`px-2 py-0.5 text-xs rounded-md border transition-colors disabled:opacity-50 ${on && days.length > 0 ? 'bg-accent text-white border-accent' : on ? 'border-accent/50 text-text-secondary' : 'border-border text-text-muted'}`}>
              {label}
            </button>
          );
        })}
        <span className="text-[11px] text-text-muted ml-1">{days.length === 0 ? 'every day' : 'days the window starts on'}</span>
      </div>
    </div>
  );
}
