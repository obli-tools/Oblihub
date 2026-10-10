/**
 * Docker volume specs for the "Add volume" form (Volumes page + stack editor).
 *
 * The operator fills structured fields (server, share, credentials…); `buildVolumeCreate` turns them
 * into the driver + driver_opts Docker expects, with the options that make each kind work out of the
 * box (CIFS uid/gid so a non-root service can write, NFS addr, rclone VFS cache for S3).
 * Shared so the client can preview the options and the server builds the very same ones.
 */

export type VolumeKind = 'local' | 'cifs' | 'nfs' | 's3';

export interface LocalVolumeFields {
  /** Optional host folder to bind (`type=none,o=bind`). Empty = plain Docker-managed volume. */
  hostPath?: string;
}

export interface CifsVolumeFields {
  /** `//server/share[/sub]`, or the Windows form `\\server\share` (converted). */
  share: string;
  username?: string;
  password?: string;
  domain?: string;
  /** SMB protocol version (`vers=`), default 3.0. */
  version?: string;
  /** Owner of every file on the mount: the service's uid/gid, or it can't write (CIFS has no real
   *  Unix ownership). Null = root. */
  uid?: number | null;
  gid?: number | null;
  fileMode?: string;
  dirMode?: string;
  /** Server IP, only needed when the daemon can't resolve the host name. */
  addr?: string;
  /** Extra comma-separated mount options, appended as-is. */
  extraOptions?: string;
}

export interface NfsVolumeFields {
  server: string;
  /** Exported path, e.g. `/exports/data`. */
  path: string;
  version?: string;
  readOnly?: boolean;
  extraOptions?: string;
}

export interface S3VolumeFields {
  bucket: string;
  /** Sub-folder inside the bucket. */
  path?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Custom endpoint for non-AWS providers (MinIO, Hetzner, Scaleway, R2…). */
  endpoint?: string;
  region?: string;
  /** rclone `s3-provider` (AWS, Minio, Ceph, Cloudflare, Scaleway, Other…). */
  provider?: string;
  uid?: number | null;
  gid?: number | null;
  /** Name under which the rclone volume plugin was installed (`--alias`). Default `rclone`. */
  pluginAlias?: string;
}

export interface VolumeSpec {
  name: string;
  kind: VolumeKind;
  local?: LocalVolumeFields;
  cifs?: CifsVolumeFields;
  nfs?: NfsVolumeFields;
  s3?: S3VolumeFields;
}

export interface VolumeCreateOptions {
  driver: string;
  driverOpts: Record<string, string>;
}

export const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export const DEFAULT_RCLONE_ALIAS = 'rclone';
export const RCLONE_INSTALL_HINT =
  'mkdir -p /var/lib/docker-plugins/rclone/config /var/lib/docker-plugins/rclone/cache && '
  + 'docker plugin install rclone/docker-volume-rclone:amd64 args="-v" --alias rclone --grant-all-permissions';

/** `\\server\share\sub` → `//server/share/sub`; trims; leaves an already-Unix form untouched. */
export function normalizeCifsShare(share: string): string {
  return share.trim().replace(/\\/g, '/');
}

/** Host part of a `//server/share` path, or null when malformed. */
export function cifsShareHost(share: string): string | null {
  const m = /^\/\/([^/\s]+)\/[^/\s]/.exec(normalizeCifsShare(share));
  return m ? m[1] : null;
}

/** A mount option value must not break the comma-separated list it goes into. */
function assertOptionValue(label: string, value: string): void {
  if (/[,\s]/.test(value)) throw new Error(`${label} must not contain commas or spaces`);
}

function isUnixId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 4294967294;
}

/** Throws an Error with an operator-facing message when the spec is incomplete or unsafe. */
export function buildVolumeCreate(spec: VolumeSpec): VolumeCreateOptions {
  if (!spec.name || !VOLUME_NAME_RE.test(spec.name)) {
    throw new Error('Volume name: letters, digits, "_", "." and "-" only, starting with a letter or digit');
  }
  switch (spec.kind) {
    case 'local': {
      const hostPath = spec.local?.hostPath?.trim();
      if (!hostPath) return { driver: 'local', driverOpts: {} };
      if (!hostPath.startsWith('/')) throw new Error('Host path must be absolute (start with /)');
      return { driver: 'local', driverOpts: { type: 'none', o: 'bind', device: hostPath } };
    }
    case 'cifs': {
      const f = spec.cifs;
      if (!f?.share) throw new Error('SMB share required (//server/share)');
      const device = normalizeCifsShare(f.share);
      if (!cifsShareHost(device)) throw new Error('SMB share must look like //server/share');
      const opts: string[] = [];
      if (f.username) { assertOptionValue('Username', f.username); opts.push(`username=${f.username}`); }
      // The kernel CIFS parser reads ",," as a literal comma in a password: no need to refuse one.
      if (f.password) opts.push(`password=${f.password.replace(/,/g, ',,')}`);
      if (f.domain) { assertOptionValue('Domain', f.domain); opts.push(`domain=${f.domain}`); }
      const version = f.version?.trim() || '3.0';
      assertOptionValue('SMB version', version);
      opts.push(`vers=${version}`);
      if (f.uid != null) { if (!isUnixId(f.uid)) throw new Error('uid must be a number'); opts.push(`uid=${f.uid}`); }
      if (f.gid != null) { if (!isUnixId(f.gid)) throw new Error('gid must be a number'); opts.push(`gid=${f.gid}`); }
      const fileMode = f.fileMode?.trim() || '0660';
      const dirMode = f.dirMode?.trim() || '0770';
      if (!/^0?[0-7]{3,4}$/.test(fileMode) || !/^0?[0-7]{3,4}$/.test(dirMode)) throw new Error('File/dir modes must be octal (e.g. 0660)');
      opts.push(`file_mode=${fileMode}`, `dir_mode=${dirMode}`);
      if (f.addr?.trim()) { assertOptionValue('Server IP', f.addr.trim()); opts.push(`addr=${f.addr.trim()}`); }
      if (f.extraOptions?.trim()) opts.push(f.extraOptions.trim().replace(/^,+|,+$/g, ''));
      return { driver: 'local', driverOpts: { type: 'cifs', device, o: opts.join(',') } };
    }
    case 'nfs': {
      const f = spec.nfs;
      if (!f?.server?.trim()) throw new Error('NFS server required');
      if (!f.path?.trim().startsWith('/')) throw new Error('NFS export path must start with /');
      assertOptionValue('NFS server', f.server.trim());
      const version = f.version?.trim() || '4';
      assertOptionValue('NFS version', version);
      const opts = [`addr=${f.server.trim()}`, `nfsvers=${version}`, f.readOnly ? 'ro' : 'rw'];
      if (f.extraOptions?.trim()) opts.push(f.extraOptions.trim().replace(/^,+|,+$/g, ''));
      return { driver: 'local', driverOpts: { type: 'nfs', device: `:${f.path.trim()}`, o: opts.join(',') } };
    }
    case 's3': {
      const f = spec.s3;
      if (!f?.bucket?.trim()) throw new Error('S3 bucket required');
      if (!f.accessKeyId || !f.secretAccessKey) throw new Error('S3 access key and secret required');
      const sub = f.path?.trim().replace(/^\/+|\/+$/g, '');
      const opts: Record<string, string> = {
        type: 's3',
        path: sub ? `${f.bucket.trim()}/${sub}` : f.bucket.trim(),
        's3-provider': f.provider?.trim() || (f.endpoint?.trim() ? 'Other' : 'AWS'),
        's3-access-key-id': f.accessKeyId,
        's3-secret-access-key': f.secretAccessKey,
        // Apps open files read-write and seek: without a write cache rclone refuses most writes.
        'vfs-cache-mode': 'writes',
        'allow-other': 'true',
      };
      if (f.endpoint?.trim()) opts['s3-endpoint'] = f.endpoint.trim();
      if (f.region?.trim()) opts['s3-region'] = f.region.trim();
      if (f.uid != null) { if (!isUnixId(f.uid)) throw new Error('uid must be a number'); opts.uid = String(f.uid); }
      if (f.gid != null) { if (!isUnixId(f.gid)) throw new Error('gid must be a number'); opts.gid = String(f.gid); }
      const alias = f.pluginAlias?.trim() || DEFAULT_RCLONE_ALIAS;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(alias)) throw new Error('Invalid rclone plugin name');
      return { driver: alias, driverOpts: opts };
    }
    default:
      throw new Error(`Unknown volume kind "${(spec as { kind?: unknown }).kind}"`);
  }
}

/** Driver options with secrets masked, for previews and logs. */
export function maskVolumeOptions(opts: VolumeCreateOptions): VolumeCreateOptions {
  const driverOpts: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.driverOpts)) {
    if (/secret|password/i.test(k)) driverOpts[k] = '********';
    else if (k === 'o') driverOpts[k] = v.replace(/(password=)(?:[^,]|,,)*/i, '$1********');
    else driverOpts[k] = v;
  }
  return { driver: opts.driver, driverOpts };
}

/** Result of the pre-creation mount test. */
export interface VolumeTestResult {
  ok: boolean;
  /** Short operator-facing verdict ("Mounted and writable as uid 1000", or the failure). */
  message: string;
  /** Likely cause + fix when it failed. */
  hint?: string;
  /** Raw output (df of the mount, or the daemon error). */
  detail?: string;
}

/** uid/gid a container of this image runs as. `known: false` = could not be determined. */
export interface ImageIdentity {
  known: boolean;
  uid: number | null;
  gid: number | null;
  user: string | null;
  source: 'config' | 'probe' | 'default-root' | 'unknown';
  message?: string;
}
