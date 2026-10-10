import type { StackMaintenance } from './maintenance';
// ── User types ──
export type UserRole = 'admin' | 'user';

export type AppTheme = 'obli-operator' | 'obli-daylight' | 'obli-dim' | 'modern' | 'neon';

export interface UserPreferences {
  preferredTheme?: AppTheme;
}

export interface User {
  id: number;
  username: string;
  displayName: string | null;
  role: UserRole;
  isActive: boolean;
  email: string | null;
  preferredLanguage: string;
  foreignSource: string | null;
  foreignId: number | null;
  avatar: string | null;
  preferences: UserPreferences;
  createdAt: string;
  updatedAt: string;
}

// ── Docker engines (multi-host) ──
export type DockerEngineType = 'local' | 'ssh' | 'https-apikey' | 'tls';

/** Policy for the small labelled host-metrics agent container Oblihub may run on an engine.
 *  auto   = only on GPU-capable engines (nvidia runtime / CDI), or on the local engine when
 *           nvidia-smi is not usable inside oblihub-server. Hosts without GPUs never get one.
 *  always = on every reachable engine (full host CPU/RAM/disk even without GPUs). On an
 *           https-apikey engine this is also the explicit opt-in for privileged one-shot helpers.
 *  off    = never create containers: no agent AND no one-shot helpers (power limits then only work
 *           in-process on the local engine; no MPS probe). Default for https-apikey engines
 *           (plain-HTTP transport). */
export type HostAgentMode = 'auto' | 'always' | 'off';

export interface DockerEngine {
  id: number;
  name: string;
  type: DockerEngineType;
  host: string | null;
  port: number | null;
  // Auth fields — secret values are NEVER returned by the API; only the presence flag is.
  sshUser: string | null;
  hasSshPrivateKey: boolean;
  sshKnownHost: string | null;
  hasApiKey: boolean;
  apiKeyHeader: string | null;
  tlsCa: string | null;
  tlsCert: string | null;
  hasTlsKey: boolean;
  isDefault: boolean;
  enabled: boolean;
  // Tailscale identity (optional). When set, proxy hosts targeting containers on this engine
  // resolve their upstream via this hostname instead of the public `host` field.
  tailscaleHostname: string | null;
  // CIDR list this engine's Tailscale node advertises (typically Docker bridge subnets).
  // When non-empty, the proxy can hit container bridge IPs directly — no published port needed.
  tailscaleAdvertisedRoutes: string | null;
  /** Optional only so older payloads still type-check; the server always sends it. */
  hostAgentMode?: HostAgentMode;
  lastPingAt: string | null;
  lastPingStatus: 'ok' | 'error' | null;
  lastPingMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Engine identity without host or secrets. Readable by every authenticated user through
 *  GET /api/engines/summary, and embedded in the Resources dashboard. */
export interface EngineSummary {
  id: number;
  name: string;
  type: DockerEngineType;
  isDefault: boolean;
  enabled: boolean;
  /** type === 'local': the daemon behind Oblihub's own socket. */
  isLocal: boolean;
}

// ── Tailscale ──
export interface TailscalePeer {
  id: string;            // stable Tailscale node ID
  hostname: string;      // short name (e.g. "unraid")
  dnsName: string;       // MagicDNS name (e.g. "unraid.tail-abcd12.ts.net.")
  ipv4: string | null;   // 100.x.y.z address
  online: boolean;
  os: string | null;
  advertisedRoutes: string[];
  primaryRoutes: string[]; // routes this peer is actively serving as subnet router
}

export interface TailscaleStatus {
  enabled: boolean;        // is the local tailscaled reachable
  selfHostname: string | null;
  selfDnsName: string | null;
  selfIpv4: string | null;
  tailnet: string | null;  // e.g. "tail-abcd12.ts.net"
  peers: TailscalePeer[];
  message?: string;        // populated when enabled=false to explain why
}

// ── Stack types ──
export type ContainerStatus = 'up_to_date' | 'update_available' | 'updating' | 'error' | 'unknown' | 'checking' | 'excluded' | 'stopped';

export type SleepMode = 'stop' | 'pause';
export type SleepState = 'awake' | 'sleeping' | 'waking' | 'wake_failed';

// ── Resource limits + priority tiers ──
export type StackPriority = 'critical' | 'normal' | 'opportunistic';
export type YieldMode = 'pause' | 'stop';
export type YieldSignalSource = 'nginx-traffic' | 'gpu-util' | 'webhook';

/** Opt-in NVIDIA MPS client settings. Admin only; Opportunistic, Oblihub-managed compose stacks on
 *  GPU-capable engines only. Oblihub never starts/stops the MPS daemon and never changes compute mode. The client
 *  settings are emitted only while Oblihub has seen a LIVE daemon answer in `pipeDirectory` within the
 *  last 60 s; otherwise nothing MPS-related is emitted (clients would silently run uncapped). */
export interface MpsSettings {
  enabled: boolean;
  /** CUDA_MPS_ACTIVE_THREAD_PERCENTAGE, integer 1-100. Can only lower the daemon's value. Changing it recreates the containers. */
  activeThreadPercentage: number | null;
  /** CUDA_MPS_PINNED_DEVICE_MEM_LIMIT per GPU UUID, in GB (one decimal): a hard VRAM cap per client. */
  pinnedMemLimitGb: Record<string, number> | null;
  /** '/tmp/nvidia-mps' | '/run/nvidia-mps' | '/var/run/nvidia-mps'. null = '/tmp/nvidia-mps' (the daemon's default). */
  pipeDirectory: string | null;
}

export interface ResourceLimits {
  priority: StackPriority;
  cpuPercent: number | null;
  ramPercent: number | null;
  cpuShares: number | null;
  visibleGpuIds: string[] | null;
  powerLimitWatts: Record<string, number> | null;
  yieldsToStackIds: number[] | null;
  yieldSignalSource: YieldSignalSource | null;
  yieldIdleTimeoutSeconds: number | null;
  yieldMode: YieldMode | null;
  /** Absent in rows saved before MPS support; the server normalises it to null. */
  mps?: MpsSettings | null;
}

export interface GpuInfo {
  index: string;
  name: string;
  memoryTotalMb: number;
  /** Power limit currently applied (nvidia-smi power.limit). Before the multi-engine work this held
   *  power.default_limit, so the UI's "applied" fallback was wrong. */
  powerLimitCurrentWatts: number;
  powerLimitMaxWatts: number;
  powerLimitMinWatts: number;
  /** Stable identity ('GPU-xxxxxxxx-…'). Indices can be renumbered; uuids cannot. */
  uuid?: string | null;
  powerLimitDefaultWatts?: number | null;
  /** 'Default' | 'Exclusive_Process' | 'Prohibited' (as printed by nvidia-smi). */
  computeMode?: string | null;
}

/** Live per-GPU sample from local nvidia-smi or from the engine's host agent. */
export interface GpuLiveStat {
  index: string;
  uuid?: string | null;
  utilizationGpuPercent: number;
  utilizationMemoryPercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  powerDrawWatts: number;
  powerLimitWatts: number;
  temperatureCelsius: number | null;
  /** Null on passively cooled datacenter cards (L40S, A100): means "no fan", not a failure. */
  fanSpeedPercent: number | null;
}

export interface Stack {
  id: number;
  name: string;
  composeProject: string | null;
  engineId: number | null;
  checkInterval: number;
  autoUpdate: boolean;
  enabled: boolean;
  url: string | null;
  notifyUpdateAvailable: boolean | null;
  notifyUpdateApplied: boolean | null;
  notifyDelay: number | null;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  containers: Container[];
  resourceLimits: ResourceLimits | null;
  /** Maintenance window override: null = inherit the global setting. */
  maintenanceWindow: StackMaintenance;
  createdAt: string;
  updatedAt: string;
}

export interface ContainerPort {
  hostPort: number | null;
  containerPort: number;
  protocol: string;
  hostIp?: string | null;
  /** Number of consecutive ports this entry covers: hostPort..hostPort+count-1 map to
   *  containerPort..containerPort+count-1. Absent means 1. Discovery compacts ranges so a
   *  10000-port UDP range is one entry instead of ten thousand. */
  count?: number;
}

export interface Container {
  id: number;
  stackId: number | null;
  engineId: number | null;
  dockerId: string;
  containerName: string;
  image: string;
  imageTag: string;
  currentDigest: string | null;
  latestDigest: string | null;
  status: ContainerStatus;
  errorMessage: string | null;
  excluded: boolean;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  ports: ContainerPort[];
  /** HostConfig.NetworkMode ('bridge', 'host', 'none', 'container:<id>', '<network>'). Host-mode
   *  containers publish no port list. Optional until discovery has seen the container. */
  networkMode?: string | null;
  // Sleep mode (per-container opt-in)
  sleepEnabled: boolean;
  sleepAfterSeconds: number;
  sleepMode: SleepMode;
  sleepState: SleepState;
  lastActiveAt: string | null;
  wakeStartedAt: string | null;
  wakeHealthPath: string | null;
  // Rolling history of the last 10 successful wake durations in milliseconds. The waking page
  // uses the average to render its progress bar; if a new wake exceeds the average it falls
  // back to "still working…" messaging instead of overshooting 100%.
  wakeDurationsMs: number[];
  createdAt: string;
  updatedAt: string;
}

export type UpdateStatus = 'pending' | 'pulling' | 'recreating' | 'success' | 'failed' | 'rolled_back';

export interface UpdateHistoryEntry {
  id: number;
  stackId: number | null;
  containerId: number | null;
  containerName: string;
  image: string;
  oldDigest: string | null;
  newDigest: string | null;
  status: UpdateStatus;
  errorMessage: string | null;
  triggeredBy: 'auto' | 'manual';
  startedAt: string;
  completedAt: string | null;
}

// ── Multi-engine host metrics ──
export type HostStatsSource = 'local-os' | 'agent' | 'containers-aggregate' | 'none';
export type GpuStatsSource = 'local-nvidia-smi' | 'agent' | 'none';
export type GpuStatus = 'ok' | 'no-gpu' | 'unsupported' | 'starting' | 'error' | 'disabled';
export type HostAgentState = 'disabled' | 'not-needed' | 'creating' | 'running' | 'error' | 'unsupported';

export interface EngineHostFacts {
  hostname: string | null;
  cpuCount: number | null;
  ramBytes: number | null;
  os: string | null;
  kernel: string | null;
  arch: string | null;
  dockerVersion: string | null;
  containersRunning: number | null;
  containersTotal: number | null;
  nvidiaRuntime: boolean;
  fetchedAt: string | null;
}

export interface EngineHostLive {
  source: HostStatsSource;
  cpuPercent: number | null;
  ramUsedBytes: number | null;
  ramPercent: number | null;
  loadAvg: [number, number, number] | null;
  disk: { usedBytes: number; totalBytes: number; percent: number | null } | null;
  cpuModel: string | null;
  cpuTemperatureCelsius: number | null;
  uptimeSeconds: number | null;
  measuredAt: string | null;
  /** True when the newest agent sample is older than max(15 s, 2.5 x OBLIHUB_AGENT_INTERVAL) (stream stalled or engine slow). */
  stale: boolean;
}

export interface EngineHostGpu {
  source: GpuStatsSource;
  status: GpuStatus;
  message: string | null;
  gpus: GpuInfo[];
  live: GpuLiveStat[];
  /** Host-wide limits Oblihub re-applies after a host reboot, keyed by GPU uuid (or 'idx:<n>'). */
  desiredPowerLimits: Record<string, number>;
  powerLimitEditable: boolean;
  measuredAt: string | null;
}

export interface EngineHostAgentInfo {
  mode: HostAgentMode;
  state: HostAgentState;
  message: string | null;
  gpuEnabled: boolean;
}

export interface EngineHostSnapshot {
  engine: EngineSummary;
  reachable: boolean;
  error: string | null;
  facts: EngineHostFacts;
  live: EngineHostLive;
  gpu: EngineHostGpu;
  agent: EngineHostAgentInfo;
}

export type DashStackState = 'running' | 'paused-by-watchdog' | 'stopped' | 'mixed';

export interface ResourcesDashStack {
  id: number;
  name: string;
  composeProject: string | null;
  /** The stack's own engine. null = orphaned row (its engine was deleted): shown under
   *  "Unknown engine", never under the local engine. */
  engineId: number | null;
  engineName: string | null;
  priority: StackPriority;
  state: DashStackState;
  containerCount: number;
  runningContainerCount: number;
  cpuCapPercent: number | null;
  ramCapPercent: number | null;
  cpuShares: number | null;
  visibleGpuIds: string[] | null;
  yieldSignalSource: YieldSignalSource | null;
  yieldsToStackIds: number[] | null;
  yieldIdleTimeoutSeconds: number | null;
  yieldMode: YieldMode | null;
  isBusyNow: boolean | null;
  conso: {
    /** Share (0-100) of the stack's OWN engine (NCPU / MemTotal from docker info). null when that engine's capacity is unknown (orphan, disabled engine, remote engine not reached yet). */
    cpuShareOfEngine: number | null;
    /** Share (0-100) of the stack's OWN engine (NCPU / MemTotal from docker info). null when that engine's capacity is unknown (orphan, disabled engine, remote engine not reached yet). */
    ramShareOfEngine: number | null;
    /** @deprecated kept numeric for pre-multi-engine clients during rollout: 0 when unknown; read cpuShareOfEngine / ramShareOfEngine. */
    cpuPercentOfHost: number;
    cpuPercentOfCap: number | null;
    ramBytes: number;
    /** @deprecated kept numeric for pre-multi-engine clients during rollout: 0 when unknown; read cpuShareOfEngine / ramShareOfEngine. */
    ramPercentOfHost: number;
    ramPercentOfCap: number | null;
    sampledAt: string | null;
  };
}

/** @deprecated for pre-multi-engine clients during rollout: the local engine's snapshot in the old
 *  shape (0 / [] when unknown or not visible). New clients read `hosts`. */
export interface ResourcesDashboardLegacyHost {
  cpuCount: number;
  ramBytes: number;
  ramGb: number;
  gpus: GpuInfo[];
  gpuLive: GpuLiveStat[];
  /** Applied limit per GPU index: the old GPU cards look it up by `index`. */
  currentPowerLimits: Record<string, number>;
  platform: string;
  arch: string;
  cpuModel: string | null;
  cpuTemperatureCelsius: number | null;
}

export interface ResourcesDashboard {
  /** Every ENABLED engine (non-admins: only engines hosting a stack visible to them) plus any
   *  DISABLED engine hosting a visible stack (enabled: false → "(disabled)" badge in All, no tab,
   *  no host card). Ordered by id. */
  engines: EngineSummary[];
  /** One snapshot per ENABLED engine of `engines`. */
  hosts: EngineHostSnapshot[];
  /** Team-filtered. */
  stacks: ResourcesDashStack[];
  /** Critical-stack busy timestamps (epoch ms) by stack id, only for the stacks in `stacks`. */
  activity: Record<number, number>;
  generatedAt: string;
  /** @deprecated see ResourcesDashboardLegacyHost */
  host: ResourcesDashboardLegacyHost;
}

export interface GpuPowerLimitResult {
  engineId: number;
  index: string;
  gpuUuid: string | null;
  requestedWatts: number | null;   // null = reset to default and forget the persisted value
  appliedWatts: number | null;     // null when not yet observed (a remote agent sample arrives within seconds)
  via: 'local-nvidia-smi' | 'oneshot-container' | 'none';
  persisted: boolean;
  message: string | null;
}

// ── Stack resources (per-stack tab) ──
export type ResourceApplyMode = 'compose' | 'docker-update' | 'none';

export interface StackResourceCapabilities {
  applyMode: ResourceApplyMode;
  /** Why the mode is not 'compose' (Standalone, not compose-manageable, https-apikey engine,
   *  Oblihub's own stack, engine disabled, engine deleted). */
  reason: string | null;
  cpuRamCaps: boolean;
  cpuShares: boolean;
  gpuVisibility: boolean;
  gpuVisibilityReason: string | null;
  mps: boolean;
  mpsReason: string | null;
  /** Standalone groups every container without a compose project on the engine; limits hit all of them. */
  standaloneWarning: boolean;
  /** true for Standalone stacks: only admins may set or clear limits/priority there. */
  requiresAdmin: boolean;
  /** Whether THIS viewer may save limits: false for an orphaned stack (engine deleted), Oblihub's own stack,
   *  or a Standalone stack viewed by a non-admin. A disabled engine stays editable (stored-only). */
  canEdit: boolean;
  canEditReason: string | null;
}

export interface ResourceApplyResult {
  mode: 'compose' | 'docker-update' | 'stored-only';
  ok: boolean;
  /** True when saved but applied later (the stack is currently yielded by the priority watchdog). */
  deferred: boolean;
  message: string;
  warnings: string[];
  details: string | null;
  /** skipped examples: 'excluded', 'Oblihub infrastructure', 'gone', 'paused — applies at its next recreate'. */
  containers: Array<{ dockerId: string; name: string; ok: boolean; error: string | null; skipped: string | null }>;
  appliedAt: string;
}

export interface CriticalStackRef {
  id: number;
  name: string;
  /** null = orphaned Critical stack (engine deleted). */
  engineId: number | null;
  engineName: string | null;
  sameEngine: boolean;
  signalSource: YieldSignalSource | null;
  visibleGpuIds: string[] | null;
}

export interface MpsEngineStatus {
  engineId: number;
  pipeDirectory: string;
  /** detected = a LIVE control daemon answered in this exact directory; not-detected = no socket,
   *  stale socket (daemon not answering) or directory missing; unknown = could not verify (probe
   *  refused/unsupported, liveness tool unavailable, engine unreachable). */
  daemon: 'detected' | 'not-detected' | 'unknown';
  message: string | null;
  checkedAt: string | null;
  gpus: Array<{ index: string; uuid: string | null; computeMode: string | null }>;
}

/** Restart visibility for MPS clients: a VRAM cap below the working set makes a miner crash-loop. */
export interface MpsClientInfo {
  dockerId: string;
  name: string;
  state: string;
  restartCount: number;
}

export interface StackResourcesInfo {
  limits: ResourceLimits | null;
  engine: EngineSummary | null;
  capacity: { cpuCount: number | null; ramBytes: number | null };
  hostGpus: GpuInfo[];
  gpuStatus: { source: GpuStatsSource; status: GpuStatus; message: string | null };
  currentPowerLimits: Record<string, number>;
  capabilities: StackResourceCapabilities;
  criticalStacks: CriticalStackRef[];
  pendingApply: boolean;
  mps: MpsEngineStatus | null;
  /** Filled only when limits.mps?.enabled (WP-40); null otherwise. */
  mpsClients: MpsClientInfo[] | null;
  /** Opportunistic stacks proven unable to use a GPU (GpuUtilPoller container probes): they never make gpu-util ambiguous. */
  gpuLessOpportunisticStackIds?: number[];
  /** Per yielding Opportunistic stack, the GPUs its containers were actually granted (GpuUtilPoller container probes; null or absent key = every GPU). Absent from older servers. */
  opportunisticGpuSets?: Record<number, string[] | null>;
  /** @deprecated for pre-multi-engine clients during rollout: capacity.cpuCount ?? 0 */
  hostCpuCount: number;
  /** @deprecated GiB, rounded */
  hostRamGb: number;
}

// ── Ports & proxy upstream ──
/** One entry of Docker's /containers/json `Ports`, or a binding rebuilt from inspect. */
export interface RawPortBinding {
  privatePort: number;
  publicPort?: number | null;
  type?: string | null;
  ip?: string | null;
}

export interface PortChipModel {
  key: string;
  kind: 'published' | 'internal';
  protocol: string;
  hostIp: string | null;
  loopback: boolean;
  hostStart: number | null;
  hostEnd: number | null;
  containerStart: number;
  containerEnd: number;
  label: string;   // '8080→80', '8000-8010', '53/udp', '127.0.0.1:15432→5432', '443'
  title: string;   // tooltip
}

/** Parsed compose `ports:` entry. hostStart null = no host port (container only) or an ephemeral host port. */
export interface ComposePortSpec {
  hostIp: string | null;
  hostStart: number | null;
  hostEnd: number | null;
  containerStart: number;
  containerEnd: number;
  protocol: string;
}

/** Body item for POST /managed-stacks/check-port-conflicts. */
export interface PortSpecInput {
  start: number;
  end?: number;
  protocol?: 'tcp' | 'udp' | 'sctp';
}

export interface PortConflictResult {
  port: number;
  range: [number, number] | null;
  protocol: string | null;
  stackName: string | null;
  /** null (with containerId null): the port is used by a stack the caller's teams cannot see, so
   *  the conflict is reported without naming it. */
  containerName: string | null;
  containerId: number | null;
}

export interface ContainerInspectResult {
  env: string[];
  /** HostConfig.PortBindings: what was configured. HostPort is '' for ephemeral ports. */
  ports: Record<string, { HostIp: string; HostPort: string }[]>;
  /** NetworkSettings.Ports: what is actually bound (every binding, including ephemeral ports). */
  publishedPorts: Record<string, { HostIp: string; HostPort: string }[]>;
  /** Config.ExposedPorts keys, e.g. '80/tcp' (image EXPOSE plus compose expose/ports). */
  exposedPorts: string[];
  networkMode: string | null;
  mounts: { Type: string; Source: string; Destination: string; Mode: string }[];
  networks: Record<string, { IPAddress: string; Gateway: string; NetworkID: string }>;
}

export type UpstreamVia =
  | 'local-docker-dns'
  | 'local-host-network'
  | 'tailscale-subnet-route'
  | 'tailscale-hostname-published-port'
  | 'engine-public-host';

export interface ResolvedUpstream {
  host: string;
  port: number;
  scheme: 'http' | 'https';
  via: UpstreamVia;
  hint: string;
  warnings: string[];
  containerPort: number;
  protocol: string;
  engineId: number | null;
  engineName: string | null;
  /** Local target that is NOT on the proxy network. Oblihub never attaches non-managed containers
   *  by itself: attach it (`docker network connect <net> <container>`) or deploy it as a managed
   *  stack. `hint` carries the exact advice; nginx returns 502 until then. */
  needsProxyNetwork: boolean;
}

/** 'proxy' = docker-compose.override.yml (Oblihub's proxy override, or the operator's own file under
 *  that name); 'operator' = the operator's own override under another compose default name
 *  (compose.override.yml / compose.override.yaml / docker-compose.override.yaml), listed only when
 *  it exists; 'resources' = docker-compose.override.oblihub.yml; 'volumes' = the volumes override. */
export type GeneratedComposeFileKind = 'proxy' | 'operator' | 'resources' | 'volumes';
/** Files Oblihub generates (or honours) next to a managed stack's compose. The first four fields
 *  are the pre-existing shape; the others are new. */
export interface GeneratedComposeFile {
  name: string;
  path: string;              // relative to the stack folder, forward slashes
  content: string | null;
  exists: boolean;
  kind: GeneratedComposeFileKind;
  /** 'oblihub' = written/rendered by Oblihub (header present); 'operator' = the operator's own file. */
  owner: 'oblihub' | 'operator';
  /** Whether every compose command passes this file with -f. */
  passedToCompose: boolean;
  /** Short explanation for the UI (why it is or isn't passed, render warnings). */
  note: string | null;
}

// ── Notification types ──
export type NotificationPluginType = 'telegram' | 'discord' | 'slack' | 'teams' | 'smtp' | 'webhook' | 'gotify' | 'ntfy' | 'pushover' | 'freemobile';

export interface NotificationChannel {
  id: number;
  name: string;
  type: NotificationPluginType;
  config: Record<string, unknown>;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type NotificationScope = 'global' | 'stack';
export type OverrideMode = 'merge' | 'replace' | 'exclude';

export interface NotificationBinding {
  id: number;
  channelId: number;
  scope: NotificationScope;
  scopeId: number | null;
  overrideMode: OverrideMode;
}

// ── Managed stack types ──
export type ManagedStackStatus = 'draft' | 'deploying' | 'deployed' | 'stopped' | 'error';

/** Where the source files for this stack come from.
 *   compose-only: legacy — just the docker-compose.yml + .env pasted/typed in the editor.
 *   zip:          tarball uploaded by the user; build can run from local Dockerfile contexts.
 *   git:          cloned from a remote repo; refreshable via `git pull` from the UI.
 */
export type ManagedStackSourceType = 'compose-only' | 'zip' | 'git';

/**
 * Per-stack credentials for a container registry. The API never returns the password / token in
 * cleartext — only the `hasPassword` flag so the UI can render "(set)" / "(empty)" without
 * shipping the secret to the browser. To set/rotate, send a non-empty `password` on update.
 */
export interface RegistryCredential {
  registry: string;          // e.g. "gitea.example.com" or "ghcr.io"
  username: string;
  hasPassword: boolean;
}

export interface ManagedStack {
  id: number;
  name: string;
  composeContent: string;
  envContent: string | null;
  status: ManagedStackStatus;
  composeProject: string;
  engineId: number | null;
  errorMessage: string | null;
  // Source pipeline — populated for stacks built from uploaded files or a git repo. Defaults
  // to 'compose-only' for stacks created via the legacy paste-compose-and-deploy flow.
  sourceType: ManagedStackSourceType;
  gitUrl: string | null;
  gitBranch: string | null;
  gitRef: string | null;
  lastSourceSyncAt: string | null;
  // Git deploy-token auth (Gitea / GitHub / GitLab). Injected at clone/pull time via URL
  // rewrite `https://<user>:<token>@host/...`. Only `hasGitToken` is returned by the API
  // (mirrors the SSH key + registry cred pattern) — the actual token is AES-GCM at rest.
  gitUsername: string | null;
  hasGitToken: boolean;
  // Path to the compose file INSIDE the repo/upload — e.g. `stack/docker-compose.yml`. When
  // set, both the source sync and the compose invocation use it, with the compose parent dir
  // becoming the working dir so relative build.context paths (`./api`) resolve correctly.
  composePath: string | null;
  // When true, deploy/redeploy run `docker compose up -d --build` so Dockerfiles in the source
  // are rebuilt. Off by default — pure-image stacks keep their fast pull-only redeploy.
  buildEnabled: boolean;
  // Poll the git remote every N seconds; if the branch HEAD moved, trigger pull + rebuild.
  // 0 = disabled (operator triggers manually). Uses the same worker pattern as registry checks.
  pollGitIntervalS: number;
  lastGitPollAt: string | null;
  // Per-stack registry auth. Used at deploy time to populate a temp DOCKER_CONFIG so the
  // `docker compose pull` running in this stack's directory can authenticate against private
  // registries (Gitea, GHCR, GitLab, Quay, Harbor, …) without touching the host-level
  // ~/.docker/config.json. Passwords are stored AES-256-GCM encrypted server-side.
  registryCredentials: RegistryCredential[];
  // Named volumes of stacks created after this feature live under `<stacks dir>/.volumes/<project>/`
  // instead of Docker's default location. False for stacks that pre-date it (never touched).
  volumesInStacksDir: boolean;
  // Where each named volume actually lives — decided at the first deploy that sees it.
  volumePlacements: ManagedStackVolumePlacement[];
  createdAt: string;
  updatedAt: string;
}

export interface ManagedStackVolumePlacement {
  volume: string;            // top-level compose volume key
  // 'bind'  = data in a host folder under `<stacks dir>/.volumes/`
  // 'plain' = Docker volume that already existed before the first deploy — left where it was
  mode: 'bind' | 'plain';
  hostPath: string | null;   // host folder when mode === 'bind'
}

/** Rollback timeline — one entry per successful deploy for a managed stack. */
export interface ManagedStackDeployHistoryEntry {
  id: number;
  managedStackId: number;
  sourceType: ManagedStackSourceType;
  gitUrl: string | null;
  gitBranch: string | null;
  gitRef: string | null;
  composePath: string | null;
  buildEnabled: boolean;
  success: boolean;
  notes: string | null;
  deployedAt: string;
  deployedByUserId: number | null;
}

// ── Docker resource types ──
export interface DockerImage {
  id: string;
  repoTags: string[];
  repoDigests: string[];
  size: number;
  created: number;
  containers: number;
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  attachable: boolean;
  ipam: { subnet?: string; gateway?: string }[];
  containers: { id: string; name: string; ipv4: string; ipv6: string }[];
  labels: Record<string, string>;
  composeProject: string | null;
  created: string;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
  labels: Record<string, string>;
  composeProject: string | null;
  created: string;
  usageSize: number | null;
  // Host folder when the volume is a local bind (e.g. a managed stack's `.volumes/` folder):
  // removing such a volume only drops the Docker reference — the data stays in the folder.
  bindDevice: string | null;
}

// ── Proxy types ──
export type CertificateProvider = 'letsencrypt' | 'custom' | 'selfsigned';
export type CertificateStatus = 'pending' | 'valid' | 'expired' | 'error';

export interface CertificateLogEntry {
  at: string;          // ISO timestamp
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface Certificate {
  id: number;
  domainNames: string[];
  provider: CertificateProvider;
  expiresAt: string | null;
  status: CertificateStatus;
  errorMessage: string | null;
  acmeEmail: string | null;
  // Live log appended during each LE request — lets the UI show the full play-by-play of
  // account creation / challenge / finalize so the operator can self-diagnose failures
  // (DNS not propagated, port 80 unreachable, rate limit, …).
  requestLog: CertificateLogEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface ProxyHost {
  id: number;
  domainNames: string[];
  forwardScheme: 'http' | 'https';
  forwardHost: string;
  forwardPort: number;
  certificateId: number | null;
  sslForced: boolean;
  http2Support: boolean;
  hstsEnabled: boolean;
  hstsSubdomains: boolean;
  blockExploits: boolean;
  cachingEnabled: boolean;
  websocketSupport: boolean;
  accessListId: number | null;
  advancedConfig: string | null;
  enabled: boolean;
  stackId: number | null;
  clientMaxBodySize: string | null;
  proxyConnectTimeout: number | null;
  proxySendTimeout: number | null;
  proxyReadTimeout: number | null;
  proxyBuffering: boolean | null;
  rateLimitRps: number | null;
  rateLimitBurst: number | null;
  gzipEnabled: boolean;
  corsEnabled: boolean;
  customResponseHeaders: { name: string; value: string; action: 'add' | 'remove' }[] | null;
  errorPageId: number | null;
  // List of all access lists attached to this host. The proxy enforces the UNION of their
  // allow rules and auth entries — i.e. a visitor is granted if their IP matches ANY list, or
  // if their basic-auth credentials live in ANY list's htpasswd.
  // `accessListId` (singular) is kept for backward compat with older API consumers; it shadows
  // the first id of `accessListIds`. New code should prefer the array.
  accessListIds: number[];
  wakeContainerId: number | null;
  // Additional containers to wake in parallel when this proxy_host receives a request while
  // the primary target is asleep. Useful for multi-container apps (front + back) where the
  // proxy fronts only the UI but the UI's backend services must also be running.
  wakeExtraContainerIds: number[];
  wakingPageId: number | null;
  autoMonitor: boolean;
  // Docker network the target service should be attached to for the reverse-proxy to reach it.
  // Null = Oblihub's own built-in `proxy` network (backward-compat default). Set to e.g.
  // `nginx-proxy-manager_default` or `traefik_default` to have Oblihub's auto-override wire
  // the container onto an EXTERNAL reverse proxy's network instead.
  dockerNetwork: string | null;
  // When set, nginx delegates authentication for this host to the Azure AD provider's
  // oauth2-proxy sidecar. Null = no forward-auth (Access Lists / basic-auth still apply).
  azureAuthProviderId: number | null;
  // Per-host Azure group restriction, layered ON TOP of the provider's global `allowed_groups`.
  // Null / empty = no per-host filter (provider-level filter still applies). When set, nginx
  // enforces an additional check on the X-Auth-Request-Groups header — a user authenticated by
  // the shared sidecar but not in any of these groups gets a 403 on THIS host only. Lets one
  // Azure app registration back several stacks with different group permissions.
  azureAuthAllowedGroups: string[] | null;
  // Per-host Azure email/domain restriction. Same AND-layering as azureAuthAllowedGroups: this
  // stacks on top of the provider's global email filter (never widens it) and is enforced by
  // nginx post-auth via `if ($auth_email !~ regex) { return 403; }`. Entries are matched as
  // full emails when they contain `@` (exact match), otherwise as domains (suffix `@domain`).
  // When BOTH per-host groups AND per-host emails are set, they combine with AND: a user must
  // satisfy both to reach this host.
  azureAuthAllowedEmails: string[] | null;
  // Honeypot: master switch + per-host defaults. When enabled, honeypot_paths for this host
  // become bait — any hit auto-bans the source IP globally. When honeypotBanAclViolations is
  // ALSO true, an IP that fails the access-list check (would normally get 403) also gets
  // banned via the same honeypot machinery. banDurationSeconds null = permanent (falls back to
  // the app_config default_honeypot_ban_duration_seconds — also null-by-default = permanent).
  honeypotEnabled: boolean;
  honeypotBanAclViolations: boolean;
  honeypotBanDurationSeconds: number | null;
  // Hydrated by the server on read paths. Server-side only — clients read/write via the
  // separate /honeypot-paths endpoints on the host.
  honeypotPaths?: { id: number; path: string; enabled: boolean }[];
  // Per-path sub-routes. nginx emits one `location <path_in>` per route BEFORE `location /` —
  // ordered by URI-prefix specificity so `/api/v3/` wins over `/api/` wins over `/`. Each
  // route can target a different container, exempt itself from forward-auth or access lists,
  // and optionally rewrite the URI prefix at the upstream boundary.
  routes: ProxyHostRoute[];
  certificate?: Certificate | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyHostRoute {
  id: number;
  proxyHostId: number;
  sortOrder: number;
  pathIn: string;
  // Empty / null = passthrough (URI unchanged). Non-empty = strip pathIn from the request URI
  // and prefix pathRewrite before forwarding to the upstream.
  pathRewrite: string | null;
  forwardScheme: 'http' | 'https';
  forwardHost: string;
  forwardPort: number;
  // 'inherit' = reuse host-level azureAuthProviderId; 'none' = public passthrough (auth_request
  // off); 'override' = swap in azureAuthProviderOverrideId for this route only.
  authMode: 'inherit' | 'none' | 'override';
  azureAuthProviderOverrideId: number | null;
  accessListMode: 'inherit' | 'none' | 'override';
  accessListOverrideIds: number[];
  // Null = fall back to host-level setting.
  websocketSupport: boolean | null;
  proxyBuffering: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomPage {
  id: number;
  name: string;
  description: string | null;
  errorCodes: number[];
  htmlContent: string;
  theme: string;
  isBuiltin: boolean;
  isWakingPage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RedirectionHost {
  id: number;
  domainNames: string[];
  forwardScheme: 'http' | 'https';
  forwardDomain: string;
  forwardPath: string;
  preservePath: boolean;
  certificateId: number | null;
  sslForced: boolean;
  http2Support: boolean;
  hstsEnabled: boolean;
  blockExploits: boolean;
  advancedConfig: string | null;
  enabled: boolean;
  certificate?: Certificate | null;
  createdAt: string;
  updatedAt: string;
}

export interface StreamHost {
  id: number;
  incomingPort: number;
  forwardingHost: string;
  forwardingPort: number;
  tcpForwarding: boolean;
  udpForwarding: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeadHost {
  id: number;
  domainNames: string[];
  certificateId: number | null;
  sslForced: boolean;
  http2Support: boolean;
  hstsEnabled: boolean;
  advancedConfig: string | null;
  enabled: boolean;
  certificate?: Certificate | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Azure AD (Entra ID) auth provider — one app registration + its auto-deployed oauth2-proxy
 * sidecar. `hasClientSecret` mirrors the pattern used for engine SSH keys and registry creds:
 * the raw ciphertext never crosses the API, only the presence flag.
 */
export interface AzureAuthProvider {
  id: number;
  name: string;
  tenantId: string;
  clientId: string;
  hasClientSecret: boolean;
  allowedEmails: string[] | null;
  allowedGroups: string[] | null;
  containerName: string | null;
  containerStatus: 'stopped' | 'running' | 'error' | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccessList {
  id: number;
  name: string;
  satisfyAny: boolean;
  passAuth: boolean;
  clients: AccessListClient[];
  auth: AccessListAuth[];
  createdAt: string;
  updatedAt: string;
}

export interface AccessListClient {
  id: number;
  address: string;
  directive: 'allow' | 'deny';
}

export interface AccessListAuth {
  id: number;
  username: string;
}

// ── Container stats types ──
export interface ContainerStats {
  dockerId: string;
  containerName: string;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRx: number;
  networkTx: number;
  timestamp: string;
}

export interface ResourceAlert {
  id: number;
  name: string;
  metric: 'cpu' | 'memory';
  threshold: number;
  operator: 'gt' | 'lt';
  stackId: number | null;
  enabled: boolean;
  cooldownMinutes: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Uptime monitoring types ──
export interface UptimeMonitor {
  id: number;
  name: string;
  url: string;
  type: 'http' | 'tcp' | 'keyword';
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: number;
  keyword: string | null;
  proxyHostId: number | null;
  enabled: boolean;
  currentStatus: 'up' | 'down' | 'pending';
  consecutiveFailures: number;
  uptimePercent?: number;
  avgResponseTime?: number;
  createdAt: string;
  updatedAt: string;
}

export interface UptimeHeartbeat {
  id: number;
  monitorId: number;
  status: 'up' | 'down';
  responseTimeMs: number | null;
  statusCode: number | null;
  message: string | null;
  timestamp: string;
}

export interface StatusPage {
  id: number;
  name: string;
  slug: string;
  isPublic: boolean;
  customCss: string | null;
  monitorIds: number[];
  createdAt: string;
  updatedAt: string;
}

// ── App template types ──
export interface AppTemplate {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  category: string;
  composeTemplate: string;
  envSchema: EnvSchemaField[];
  defaultProxyPort: number | null;
  documentationUrl: string | null;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EnvSchemaField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select';
  required: boolean;
  default: string;
  description: string;
  options?: string[];
}

// ── Team types ──
export interface Team {
  id: number;
  name: string;
  description: string | null;
  allResources: boolean;
  maxStacks: number | null;
  maxContainers: number | null;
  maxCertificates: number | null;
  maxProxyHosts: number | null;
  members: TeamMember[];
  resources: TeamResource[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamMember {
  id: number;
  userId: number;
  username: string;
  displayName: string | null;
}

export interface TeamResource {
  id: number;
  resourceType: 'stack' | 'container';
  resourceId: number;
  resourceName: string;
  excluded: boolean;
}

// ── Automation: SSH keys, workflow targets, workflows ──

export type SshKeyType = 'ed25519' | 'rsa';

export interface SshKey {
  id: number;
  name: string;
  description: string | null;
  teamId: number | null;
  ownerUserId: number | null;
  keyType: SshKeyType;
  publicKey: string;
  fingerprint: string;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowTargetType = 'sftp';

export interface WorkflowTarget {
  id: number;
  name: string;
  description: string | null;
  teamId: number | null;
  ownerUserId: number | null;
  targetType: WorkflowTargetType;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  sshKeyId: number | null;
  hostKeyFingerprint: string | null;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowActionType = 'ssl-export-sftp' | 'restart-stacks';
export type WorkflowTriggerType = 'on-cert-renew' | 'schedule-interval' | 'schedule-cron' | 'on-demand';
export type WorkflowRunStatus = 'running' | 'success' | 'failed' | 'skipped';
export type WorkflowRunTriggerSource = 'scheduler' | 'on-demand' | 'on-cert-renew' | 'external';

/** Discriminated union for action_config — the shape depends on action_type. */
export type WorkflowActionConfig =
  | { certificateId: number; targetId: number; alsoExportChain?: boolean } // ssl-export-sftp
  | { scope: 'stack' | 'team' | 'all'; stackId?: number; teamId?: number };  // restart-stacks

/** Discriminated union for trigger_config — the shape depends on trigger_type. */
export type WorkflowTriggerConfig =
  | { certificateId: number }                            // on-cert-renew
  | { intervalSeconds: number }                          // schedule-interval
  | { cron: string; timezone?: string }                  // schedule-cron
  | Record<string, never>;                               // on-demand — no config

export interface Workflow {
  id: number;
  name: string;
  description: string | null;
  teamId: number | null;
  ownerUserId: number | null;
  actionType: WorkflowActionType;
  actionConfig: WorkflowActionConfig;
  triggerType: WorkflowTriggerType;
  triggerConfig: WorkflowTriggerConfig;
  enabled: boolean;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  lastRunId: number | null;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface WorkflowRun {
  id: number;
  workflowId: number;
  startedAt: string;
  finishedAt: string | null;
  status: WorkflowRunStatus;
  triggerSource: WorkflowRunTriggerSource;
  outputLog: WorkflowRunLogEntry[];
  errorMessage: string | null;
  durationMs: number | null;
}

// ── Honeypot / IP ban ──

export type BanSourceType = 'honeypot-path' | 'honeypot-acl' | 'manual' | 'obliguard-sync';

export interface BannedIp {
  id: number;
  ip: string;
  bannedUntil: string | null; // null = permanent
  reason: string | null;
  sourceType: BanSourceType;
  sourceProxyHostId: number | null;
  firstSeenAt: string;
  lastHitAt: string;
  hitCount: number;
  sentToObliguardAt: string | null;
  obliguardError: string | null;
  isActive: boolean;
  bannedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
  // Enrichment (optional, populated by the /bans endpoint):
  geo?: {
    countryCode: string | null;
    countryName: string | null;
    city: string | null;
    org: string | null;
  } | null;
  sourceProxyHostDomain?: string | null;
}

export interface HoneypotPath {
  id: number;
  proxyHostId: number;
  path: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── API response wrapper ──
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
