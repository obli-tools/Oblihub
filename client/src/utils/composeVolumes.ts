import { parseDocument, isMap, isSeq, isScalar, type Document } from 'yaml';

/**
 * Compose edits for "Add volume", on the `yaml` Document API so the operator's comments and layout
 * survive (js-yaml would drop every comment).
 */

export interface ServiceInfo { name: string; image: string | null }

/** `${VAR:-default}` → default, `${VAR}` → 'latest' when it is the tag, else dropped. */
function resolveImageRef(image: string): string {
  return image
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}/g, '$1')
    .replace(/:\$\{[^}]*\}$/, ':latest')
    .replace(/\$\{[^}]*\}/g, '');
}

export function listServices(doc: Document): ServiceInfo[] {
  const services = doc.get('services');
  if (!isMap(services)) return [];
  return services.items.map((pair) => {
    const name = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    const def = pair.value;
    const image = isMap(def) ? def.get('image') : null;
    return { name, image: typeof image === 'string' && image.trim() ? resolveImageRef(image.trim()) : null };
  });
}

/** Container path of a short-syntax mount: `src:target[:mode]`, `${VAR:-x}` sources included. */
function shortMountTarget(entry: string): string | null {
  const parts = entry.replace(/\$\{[^}]*\}/g, 'X').split(':');
  return parts.length >= 2 ? parts[1] : null;
}

export interface ComposeVolumeEdit { content: string; replaced: string | null }

/** Mounts `volume` at `target` in `service`, declares it at the top level. Throws on bad YAML. */
export function addVolumeToCompose(content: string, service: string, volume: string, target: string, external: boolean, readOnly = false): ComposeVolumeEdit {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) throw new Error(`The compose has a YAML error: ${doc.errors[0].message}`);
  const svc = doc.getIn(['services', service]);
  if (!isMap(svc)) throw new Error(`Service "${service}" not found in the compose`);
  const entry = `${volume}:${target}${readOnly ? ':ro' : ''}`;
  let replaced: string | null = null;
  const mounts = svc.get('volumes');
  if (isSeq(mounts)) {
    const idx = mounts.items.findIndex((item) => {
      if (isScalar(item) && typeof item.value === 'string') return shortMountTarget(item.value) === target;
      if (isMap(item)) return item.get('target') === target;
      return false;
    });
    if (idx >= 0) {
      const old = mounts.items[idx];
      replaced = isScalar(old) ? String(old.value) : JSON.stringify(isMap(old) ? old.toJSON() : old);
      mounts.set(idx, doc.createNode(entry));
    } else {
      mounts.add(doc.createNode(entry));
    }
  } else {
    svc.set('volumes', doc.createNode([entry]));
  }
  if (!isMap(doc.get('volumes'))) doc.set('volumes', doc.createNode({}));
  doc.setIn(['volumes', volume], doc.createNode(external ? { external: true } : null));
  return { content: doc.toString({ nullStr: '', lineWidth: 0 }), replaced };
}

