import { useMemo, useState } from 'react';
import { CheckCircle2, XCircle, Loader2, FlaskConical, UserSearch } from 'lucide-react';
import {
  buildVolumeCreate, maskVolumeOptions, normalizeCifsShare, RCLONE_INSTALL_HINT,
  type VolumeKind, type VolumeSpec, type VolumeTestResult,
} from '@oblihub/shared';
import { dockerApi } from '@/api/docker.api';
import { apiErrorMessage } from '@/utils/apiError';

/**
 * Structured "Add volume" form (Volumes page + stack editor): Local / SMB-CIFS / NFS / S3 fields,
 * uid/gid detection from a service image, live preview of the driver options and a mount test
 * that creates nothing.
 */

export function emptyVolumeSpec(name = ''): VolumeSpec {
  return { name, kind: 'local', local: {}, cifs: { share: '' }, nfs: { server: '', path: '' }, s3: { bucket: '', accessKeyId: '', secretAccessKey: '' } };
}

const KINDS: { kind: VolumeKind; label: string }[] = [
  { kind: 'local', label: 'Local' },
  { kind: 'cifs', label: 'SMB / CIFS' },
  { kind: 'nfs', label: 'NFS' },
  { kind: 's3', label: 'S3' },
];

const inputCls = 'w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent';
const monoCls = `${inputCls} font-mono`;

function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="text-xs text-text-muted block mb-1">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-text-muted block mt-1">{hint}</span>}
    </label>
  );
}

/** '' → null, digits → number, anything else → undefined (keystroke ignored). */
function idOrNull(v: string): number | null | undefined {
  const t = v.trim();
  if (t === '') return null;
  return /^\d{1,10}$/.test(t) ? Number(t) : undefined;
}

export interface VolumeFormProps {
  spec: VolumeSpec;
  onChange: (spec: VolumeSpec) => void;
  /** Engine the volume will be created on (null = local). */
  engineId: number | null;
  /** Images the uid/gid can be detected from (e.g. the stack's services). Free text otherwise. */
  imageChoices?: { label: string; image: string }[];
  /** Hide the name field (the caller renders its own). */
  hideName?: boolean;
}

export function VolumeForm({ spec, onChange, engineId, imageChoices, hideName }: VolumeFormProps) {
  const [detectImage, setDetectImage] = useState(imageChoices?.[0]?.image ?? '');
  const [detecting, setDetecting] = useState(false);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<VolumeTestResult | null>(null);

  const set = (patch: Partial<VolumeSpec>) => { setTestResult(null); onChange({ ...spec, ...patch }); };
  const setCifs = (patch: Partial<NonNullable<VolumeSpec['cifs']>>) => set({ cifs: { share: '', ...spec.cifs, ...patch } });
  const setNfs = (patch: Partial<NonNullable<VolumeSpec['nfs']>>) => set({ nfs: { server: '', path: '', ...spec.nfs, ...patch } });
  const setS3 = (patch: Partial<NonNullable<VolumeSpec['s3']>>) => set({ s3: { bucket: '', accessKeyId: '', secretAccessKey: '', ...spec.s3, ...patch } });

  const preview = useMemo(() => {
    try {
      return { ok: true as const, value: maskVolumeOptions(buildVolumeCreate(spec)) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [spec]);

  const owner = spec.kind === 'cifs' ? spec.cifs : spec.kind === 's3' ? spec.s3 : null;
  const testUser = owner && owner.uid != null ? `${owner.uid}${owner.gid != null ? `:${owner.gid}` : ''}` : null;

  const detect = async () => {
    if (!detectImage.trim()) return;
    setDetecting(true); setDetectMsg(null);
    try {
      const id = await dockerApi.imageIdentity(detectImage.trim(), engineId);
      if (id.known && id.uid != null) {
        const patch = { uid: id.uid, gid: id.gid };
        if (spec.kind === 'cifs') setCifs(patch); else if (spec.kind === 's3') setS3(patch);
        setDetectMsg(`${detectImage} runs as ${id.user || 'root'} → uid ${id.uid}, gid ${id.gid}`);
      } else {
        setDetectMsg(id.message || 'Could not determine the uid of this image');
      }
    } catch (err) {
      setDetectMsg(apiErrorMessage(err, 'Detection failed'));
    } finally { setDetecting(false); }
  };

  const runTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      setTestResult(await dockerApi.testVolume(spec, engineId, testUser));
    } catch (err) {
      setTestResult({ ok: false, message: apiErrorMessage(err, 'Test failed') });
    } finally { setTesting(false); }
  };

  const ownerFields = (owner && (spec.kind === 'cifs' || spec.kind === 's3')) && (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="text-xs text-text-secondary">
        File owner — {spec.kind === 'cifs' ? 'SMB' : 'S3'} has no real Unix ownership: every file belongs to this uid/gid.
        Set it to the user the service runs as, or a non-root service can't write.
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="uid">
          <input value={owner.uid ?? ''} onChange={e => { const v = idOrNull(e.target.value); if (v === undefined) return; if (spec.kind === 'cifs') setCifs({ uid: v }); else setS3({ uid: v }); }} placeholder="0 (root)" className={monoCls} />
        </Field>
        <Field label="gid">
          <input value={owner.gid ?? ''} onChange={e => { const v = idOrNull(e.target.value); if (v === undefined) return; if (spec.kind === 'cifs') setCifs({ gid: v }); else setS3({ gid: v }); }} placeholder="0 (root)" className={monoCls} />
        </Field>
      </div>
      <div className="flex gap-2 items-center">
        {imageChoices && imageChoices.length > 0 ? (
          <select value={detectImage} onChange={e => setDetectImage(e.target.value)} className={inputCls}>
            {imageChoices.map(c => <option key={`${c.label}-${c.image}`} value={c.image}>{c.label} ({c.image})</option>)}
          </select>
        ) : (
          <input value={detectImage} onChange={e => setDetectImage(e.target.value)} placeholder="Image of the service, e.g. myorg/app-server:latest" className={monoCls} />
        )}
        <button type="button" onClick={() => void detect()} disabled={detecting || !detectImage.trim()}
          className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover disabled:opacity-50 whitespace-nowrap">
          {detecting ? <Loader2 size={14} className="animate-spin" /> : <UserSearch size={14} />} Detect
        </button>
      </div>
      {detectMsg && <div className="text-[11px] text-text-muted">{detectMsg}</div>}
    </div>
  );

  return (
    <div className="space-y-3">
      {!hideName && (
        <Field label="Volume name">
          <input value={spec.name} onChange={e => set({ name: e.target.value })} placeholder="my_volume" className={monoCls} />
        </Field>
      )}

      <div className="flex bg-bg-tertiary rounded-lg p-0.5 w-fit">
        {KINDS.map(k => (
          <button key={k.kind} type="button" onClick={() => set({ kind: k.kind })}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${spec.kind === k.kind ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'}`}>
            {k.label}
          </button>
        ))}
      </div>

      {spec.kind === 'local' && (
        <Field label="Host folder (optional)" hint="Empty = Docker-managed volume. A path binds that folder of the Docker host.">
          <input value={spec.local?.hostPath ?? ''} onChange={e => set({ local: { hostPath: e.target.value } })} placeholder="/mnt/data/myapp" className={monoCls} />
        </Field>
      )}

      {spec.kind === 'cifs' && spec.cifs && (
        <>
          <Field label="Share" hint="The Windows form \\server\share (as shown by Hetzner, a NAS…) is accepted and converted.">
            <input value={spec.cifs.share} onChange={e => setCifs({ share: e.target.value })}
              onBlur={() => spec.cifs?.share && setCifs({ share: normalizeCifsShare(spec.cifs.share) })}
              placeholder="//server/share" className={monoCls} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Username"><input value={spec.cifs.username ?? ''} onChange={e => setCifs({ username: e.target.value })} className={monoCls} autoComplete="off" /></Field>
            <Field label="Password"><input type="password" value={spec.cifs.password ?? ''} onChange={e => setCifs({ password: e.target.value })} className={monoCls} autoComplete="new-password" /></Field>
          </div>
          {ownerFields}
          <details className="text-xs">
            <summary className="cursor-pointer text-text-muted">Advanced</summary>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <Field label="SMB version"><input value={spec.cifs.version ?? ''} onChange={e => setCifs({ version: e.target.value })} placeholder="3.0" className={monoCls} /></Field>
              <Field label="Domain"><input value={spec.cifs.domain ?? ''} onChange={e => setCifs({ domain: e.target.value })} className={monoCls} /></Field>
              <Field label="File mode"><input value={spec.cifs.fileMode ?? ''} onChange={e => setCifs({ fileMode: e.target.value })} placeholder="0660" className={monoCls} /></Field>
              <Field label="Dir mode"><input value={spec.cifs.dirMode ?? ''} onChange={e => setCifs({ dirMode: e.target.value })} placeholder="0770" className={monoCls} /></Field>
              <Field label="Server IP" hint="Only if the host name can't be resolved."><input value={spec.cifs.addr ?? ''} onChange={e => setCifs({ addr: e.target.value })} className={monoCls} /></Field>
              <Field label="Extra options"><input value={spec.cifs.extraOptions ?? ''} onChange={e => setCifs({ extraOptions: e.target.value })} placeholder="seal,nobrl" className={monoCls} /></Field>
            </div>
          </details>
        </>
      )}

      {spec.kind === 'nfs' && spec.nfs && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Server"><input value={spec.nfs.server} onChange={e => setNfs({ server: e.target.value })} placeholder="192.168.1.20" className={monoCls} /></Field>
            <Field label="Export path"><input value={spec.nfs.path} onChange={e => setNfs({ path: e.target.value })} placeholder="/exports/data" className={monoCls} /></Field>
            <Field label="NFS version"><input value={spec.nfs.version ?? ''} onChange={e => setNfs({ version: e.target.value })} placeholder="4" className={monoCls} /></Field>
            <Field label="Extra options"><input value={spec.nfs.extraOptions ?? ''} onChange={e => setNfs({ extraOptions: e.target.value })} placeholder="soft,timeo=30" className={monoCls} /></Field>
          </div>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input type="checkbox" checked={!!spec.nfs.readOnly} onChange={e => setNfs({ readOnly: e.target.checked })} /> Read-only
          </label>
          <div className="text-[11px] text-text-muted">NFS keeps the server's Unix ownership: the service's uid must be allowed to write on the export.</div>
        </>
      )}

      {spec.kind === 's3' && spec.s3 && (
        <>
          <div className="text-[11px] text-text-muted p-2 bg-bg-tertiary rounded-lg">
            S3 volumes go through the rclone Docker volume plugin, installed once per engine:
            <code className="block mt-1 bg-bg-secondary px-1 rounded break-all">{RCLONE_INSTALL_HINT}</code>
            Fine for files and uploads; not for databases (no real POSIX locking, latency).
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Bucket"><input value={spec.s3.bucket} onChange={e => setS3({ bucket: e.target.value })} className={monoCls} /></Field>
            <Field label="Folder in bucket (optional)"><input value={spec.s3.path ?? ''} onChange={e => setS3({ path: e.target.value })} className={monoCls} /></Field>
            <Field label="Access key"><input value={spec.s3.accessKeyId} onChange={e => setS3({ accessKeyId: e.target.value })} className={monoCls} autoComplete="off" /></Field>
            <Field label="Secret key"><input type="password" value={spec.s3.secretAccessKey} onChange={e => setS3({ secretAccessKey: e.target.value })} className={monoCls} autoComplete="new-password" /></Field>
            <Field label="Endpoint (non-AWS)" hint="e.g. https://fsn1.your-objectstorage.com"><input value={spec.s3.endpoint ?? ''} onChange={e => setS3({ endpoint: e.target.value })} className={monoCls} /></Field>
            <Field label="Region"><input value={spec.s3.region ?? ''} onChange={e => setS3({ region: e.target.value })} placeholder="eu-central-1" className={monoCls} /></Field>
          </div>
          {ownerFields}
          <details className="text-xs">
            <summary className="cursor-pointer text-text-muted">Advanced</summary>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <Field label="Provider (rclone)"><input value={spec.s3.provider ?? ''} onChange={e => setS3({ provider: e.target.value })} placeholder="AWS / Minio / Cloudflare / Other" className={monoCls} /></Field>
              <Field label="Plugin name"><input value={spec.s3.pluginAlias ?? ''} onChange={e => setS3({ pluginAlias: e.target.value })} placeholder="rclone" className={monoCls} /></Field>
            </div>
          </details>
        </>
      )}

      <div className="rounded-lg bg-[#0d1117] border border-border p-2 font-mono text-[11px] text-text-secondary break-all">
        {preview.ok
          ? <>driver: {preview.value.driver}{Object.entries(preview.value.driverOpts).map(([k, v]) => <div key={k}>{k}: {v}</div>)}</>
          : <span className="text-status-down">{preview.error}</span>}
      </div>

      {spec.kind !== 'local' || spec.local?.hostPath ? (
        <div className="space-y-2">
          <button type="button" onClick={() => void runTest()} disabled={testing || !preview.ok}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-accent text-accent hover:bg-accent/10 disabled:opacity-50">
            {testing ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />}
            Test mount{testUser ? ` (write as uid ${testUser})` : ''}
          </button>
          {testResult && (
            <div className={`rounded-lg border p-2 text-xs ${testResult.ok ? 'border-status-up/40 text-status-up' : 'border-status-down/40 text-status-down'}`}>
              <div className="flex items-center gap-1.5 font-medium">
                {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {testResult.message}
              </div>
              {testResult.hint && <div className="mt-1 text-text-secondary">{testResult.hint}</div>}
              {testResult.detail && <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] text-text-muted">{testResult.detail}</pre>}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
