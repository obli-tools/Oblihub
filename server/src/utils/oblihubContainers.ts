/**
 * Identity of Oblihub's own plumbing containers.
 *
 * Accepts both dockerode shapes: the LIST shape (`ContainerInfo`: Labels, Names, Image) and the
 * INSPECT shape (`ContainerInspectInfo`: Name, Image = image id, Config.Labels, Config.Image).
 */

export const OBLIHUB_INTERNAL_LABEL = 'oblihub.internal';
export const OBLIHUB_ROLE_LABEL = 'oblihub.role';
export const HOST_AGENT_NAME = 'oblihub-host-agent';
export const ONESHOT_NAME_PREFIX = 'oblihub-oneshot-';

const AZURE_SIDECAR_PREFIX = 'oblihub-azauth-';
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const SOCKET_PROXY_IMAGE_RE = /(^|\/)docker-socket-proxy([:@]|$)/;

export interface ContainerIdentity {
  Labels?: Record<string, string> | null;
  Names?: string[] | null;
  Name?: string | null;
  Image?: string | null;
  Config?: { Labels?: Record<string, string> | null; Image?: string | null } | null;
}

export function containerNameOf(info: ContainerIdentity): string {
  const name = info.Names?.[0] ?? info.Name ?? '';
  return name.startsWith('/') ? name.slice(1) : name;
}

export function labelsOf(info: ContainerIdentity): Record<string, string> {
  return info.Labels ?? info.Config?.Labels ?? {};
}

/** Config.Image ?? Image ?? ''. Config first: in an INSPECT result `Image` is the image id
 *  ('sha256:…') and `Config.Image` the reference; the LIST shape has no Config and `Image` is the reference. */
export function imageOf(info: ContainerIdentity): string {
  // Image first would never recognise the socket proxy on inspect results, which the
  // docker-update resources path works with.
  return info.Config?.Image ?? info.Image ?? '';
}

/** True when the container belongs to a compose project. Oblihub's own plumbing (host agent,
 *  one-shots, Azure sidecars) is created through dockerode and the socket proxy through `docker run`,
 *  so a compose project marks a tenant-controlled container whatever its name or labels say. */
export function hasComposeProject(labels: Record<string, string>): boolean {
  return !!labels[COMPOSE_PROJECT_LABEL];
}

/** Host agent and one-shots: label oblihub.internal=true AND name prefix, both required, and no
 *  compose project (a tenant can put any label on its own compose). Hidden from discovery, stats and
 *  project listings. */
export function isOblihubHiddenContainer(info: ContainerIdentity): boolean {
  const labels = labelsOf(info);
  // The label alone would let a tenant hide its own service from priority tiers and caps by adding
  // it in its compose. The names are not reserved either: compose sets any `container_name:`, so
  // label + name together still match a tenant's `oblihub-oneshot-miner`. Only the missing compose
  // project separates the real agent / one-shots (dockerode createContainer) from a copy.
  if (hasComposeProject(labels)) return false;
  if (labels[OBLIHUB_INTERNAL_LABEL] !== 'true') return false;
  const name = containerNameOf(info);
  return name === HOST_AGENT_NAME
    || name.startsWith(HOST_AGENT_NAME + '-')
    || name.startsWith(ONESHOT_NAME_PREFIX);
}

/** Plumbing Oblihub must never pause, stop, start or cap. Every reason applies only to containers
 *  WITHOUT a `com.docker.compose.project` label: the real ones are created by dockerode /
 *  `docker run`, while a tenant controls every label, name and image of its own compose.
 *  Oblihub's own container and compose project are checked separately (selfProjectService, async). */
export function oblihubInfraReason(
  info: ContainerIdentity,
): 'host-agent' | 'oneshot' | 'azure-sidecar' | 'socket-proxy' | null {
  const name = containerNameOf(info);
  if (isOblihubHiddenContainer(info)) {
    if (name.startsWith(HOST_AGENT_NAME)) return 'host-agent';
    if (name.startsWith(ONESHOT_NAME_PREFIX)) return 'oneshot';
  }

  const labels = labelsOf(info);
  // A tenant's compose can set `image: me/docker-socket-proxy`, `container_name: oblihub-azauth-x`
  // and `labels: { oblihub.managed: 'true' }`, which would exempt a miner from the watchdog,
  // compose-mode caps and docker update. The real Azure sidecars (azureAuth.service, dockerode
  // createContainer) and the quick-setup socket proxy (`docker run`) never carry a compose project.
  if (hasComposeProject(labels)) return null;

  if (labels['oblihub.managed'] === 'true' && name.startsWith(AZURE_SIDECAR_PREFIX)) return 'azure-sidecar';
  // The proxy that keeps Oblihub connected to an https-apikey engine often lives in that engine's
  // Standalone stack: the Engines page quick setup starts it with `docker run`.
  if (SOCKET_PROXY_IMAGE_RE.test(imageOf(info))) return 'socket-proxy';
  return null;
}
