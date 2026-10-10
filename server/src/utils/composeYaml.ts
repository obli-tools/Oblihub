import yaml from 'js-yaml';

/**
 * Compose-specific YAML helpers shared by every module that reads or writes compose files.
 *
 * Reading: compose files may use the Compose Spec merge tags `!reset` / `!override`. Plain js-yaml
 * throws on unknown tags, which used to make callers silently skip a stack (proxy wiring, volume
 * placement). The read schema accepts them and returns the tagged value as-is.
 */
const composeTag = (tag: string) => (['scalar', 'sequence', 'mapping'] as const)
  .map((kind) => new yaml.Type(tag, { kind, construct: (data: unknown) => data }));
export const COMPOSE_YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([...composeTag('!reset'), ...composeTag('!override')]);

/** A sequence that must REPLACE the base file's sequence when compose merges `-f` files. */
export class OverrideSeq {
  constructor(public items: unknown[]) {}
}

// Compose APPENDS sequences when merging `-f` files, so a base `count: all` device request would
// still expose every GPU next to our restricted one. `!override` (compose >= 2.24.4) replaces the
// sequence instead. Emitting the tag through a typed node anchors it to exactly the value we wrap —
// a service literally named `devices`, or a service-level `devices:` list, is never tagged (the old
// whole-text regex tagged any `devices:` key it found). js-yaml 4.2 dumps it as
// `devices: !override` + a block sequence, or `devices: !override []` when empty.
const overrideSeqType = new yaml.Type('!override', {
  kind: 'sequence',
  instanceOf: OverrideSeq,
  represent: (o) => (o as OverrideSeq).items,
  construct: (d) => new OverrideSeq((d as unknown[]) || []),
});
export const COMPOSE_DUMP_SCHEMA = yaml.DEFAULT_SCHEMA.extend([overrideSeqType]);

export interface ComposeServiceDef {
  image?: string;
  build?: unknown;
  runtime?: string;
  network_mode?: string;
  networks?: string[] | Record<string, unknown>;
  environment?: string[] | Record<string, string | number | boolean | null>;
  deploy?: { resources?: { limits?: Record<string, unknown>; reservations?: { devices?: unknown[] } } };
  gpus?: unknown;
  devices?: unknown[];
  privileged?: boolean;
  ipc?: string;
  volumes?: unknown[];
  container_name?: string;
  profiles?: string[];
  [k: string]: unknown;
}

export interface ComposeDoc {
  services?: Record<string, ComposeServiceDef | null>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
  [k: string]: unknown;
}

export function parseComposeYaml(text: string): { doc: ComposeDoc | null; error: string | null } {
  try {
    const doc = yaml.load(text, { schema: COMPOSE_YAML_SCHEMA });
    if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) return { doc: null, error: 'not a mapping' };
    return { doc: doc as ComposeDoc, error: null };
  } catch (err) {
    return { doc: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function dumpComposeYaml(doc: unknown): string {
  return yaml.dump(doc, { schema: COMPOSE_DUMP_SCHEMA, noRefs: true, lineWidth: 120 });
}

/** Compose interpolates `$` in override files too: values Oblihub generates must never be
 *  re-interpolated (a `$` in a value would otherwise pull in a variable or break the command). */
export function escapeComposeDollars(value: string): string {
  return value.replace(/\$/g, '$$$$');
}
