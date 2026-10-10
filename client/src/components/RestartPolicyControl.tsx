import { useMemo } from 'react';
import yaml from 'js-yaml';

type RestartPolicy = 'no' | 'always' | 'unless-stopped' | 'on-failure';

const POLICIES: { value: RestartPolicy; label: string; hint: string }[] = [
  { value: 'no',              label: 'no',              hint: 'Never restart. Container stays down after exit.' },
  { value: 'on-failure',      label: 'on-failure',      hint: 'Restart only on non-zero exit code (crash). Not on manual stop or daemon restart of a successfully exited container.' },
  { value: 'unless-stopped',  label: 'unless-stopped',  hint: 'Restart on daemon reboot / container crash, BUT stay down after an explicit `docker stop`. Common default; can leave containers stranded after a `docker pull`+swap.' },
  { value: 'always',          label: 'always',          hint: 'Restart in every case — including after `docker stop`. Best for critical services you never want to see down.' },
];

/**
 * Regex sweep of every `restart:` line in a compose YAML string. Preserves exact indentation,
 * comments and formatting (no YAML round-trip). Only touches services that ALREADY declare a
 * restart directive — services without one are unaffected (compose default = "no"). A callback
 * receives the count of matches so the caller can toast "N services updated" or warn if 0.
 */
function rewriteRestart(compose: string, next: RestartPolicy): { text: string; touched: number } {
  let touched = 0;
  const rx = /^([ \t]+)restart:[ \t]*(?:"[^"]*"|'[^']*'|[^\r\n#]+)/gm;
  const text = compose.replace(rx, (_full, indent: string) => {
    touched++;
    return `${indent}restart: ${next}`;
  });
  return { text, touched };
}

/** Return "uniform" policy if all services declare the same restart, else "mixed" or "none". */
type ComposeDoc = { services?: Record<string, { restart?: string } | null | undefined> };

function detectCurrentPolicy(compose: string): { kind: 'uniform'; value: RestartPolicy } | { kind: 'mixed'; values: RestartPolicy[] } | { kind: 'none' } {
  let doc: ComposeDoc | null = null;
  try { doc = yaml.load(compose) as ComposeDoc | null; } catch { return { kind: 'none' }; }
  const services = doc?.services || {};
  const values = new Set<string>();
  let servicesWithoutRestart = 0;
  for (const svc of Object.values(services)) {
    const r = (svc as { restart?: string } | null | undefined)?.restart;
    if (r) values.add(String(r).trim());
    else servicesWithoutRestart++;
  }
  if (values.size === 0) return { kind: 'none' };
  if (values.size === 1 && servicesWithoutRestart === 0) return { kind: 'uniform', value: [...values][0] as RestartPolicy };
  return { kind: 'mixed', values: [...values] as RestartPolicy[] };
}

interface Props {
  compose: string;
  onChange: (newCompose: string, appliedTo: number) => void;
}

/**
 * Segmented control that rewrites every `restart:` line in the compose to the picked policy.
 * Shows the current uniform policy highlighted, or a "Mixed" indicator when services declare
 * different policies. Pick a different value → immediate rewrite + parent notified.
 *
 * Rationale for existing: `unless-stopped` is a common footgun for stacks that get updated by
 * a `docker pull` + swap flow — the swap does `docker stop`, which `unless-stopped` treats as
 * intentional, so the container stays down after the pull. `always` recovers from this. Being
 * able to flip the policy for every service at once (instead of hand-editing N `restart:` lines)
 * is the sane operator experience.
 */
export function RestartPolicyControl({ compose, onChange }: Props) {
  const state = useMemo(() => detectCurrentPolicy(compose), [compose]);
  const current = state.kind === 'uniform' ? state.value : null;

  const handlePick = (next: RestartPolicy) => {
    if (current === next) return;
    const { text, touched } = rewriteRestart(compose, next);
    if (touched === 0) {
      // No `restart:` lines matched — nothing to do; the operator would need to add them by hand.
      // Silently no-op so we don't corrupt the compose.
      onChange(compose, 0);
      return;
    }
    onChange(text, touched);
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[11px] text-text-muted whitespace-nowrap">Restart policy:</span>
      <div className="inline-flex rounded-md bg-bg-tertiary p-0.5">
        {POLICIES.map(p => {
          const active = current === p.value;
          return (
            <button
              key={p.value}
              onClick={() => handlePick(p.value)}
              title={p.hint}
              className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                active
                  ? 'bg-accent text-white font-semibold'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {state.kind === 'mixed' && (
        <span className="text-[10px] uppercase tracking-wider text-status-pending font-semibold" title={`Services declare: ${state.values.join(', ')}. Pick one to unify.`}>
          mixed
        </span>
      )}
      {state.kind === 'none' && (
        <span className="text-[10px] text-text-muted italic" title="No service in the compose declares a restart policy. Pick one to add restart directives to services (only touches services that already have a `restart:` line — add manually otherwise).">
          not set
        </span>
      )}
    </div>
  );
}
