import * as crypto from 'crypto';
import { db } from '../db';
import { encryptSecret, decryptSecret } from '../utils/crypto';
import type { SshKey, SshKeyType } from '@oblihub/shared';

/**
 * Managed SSH keypair store used by workflow actions that authenticate to a remote host
 * (SFTP export, remote command, ...). Private keys never leave the DB in plaintext — they're
 * AES-256-GCM encrypted with the app's data key (see utils/crypto). The public key + fingerprint
 * are the only things ever surfaced by the API. Callers that need the actual private key (i.e.
 * the workflow runner) go through `getPrivateKey(id)` internally.
 *
 * v1: ed25519 only. Shorter, faster, universally supported by modern SSH servers. RSA support
 * can be layered in later if the field asks for it — most legacy servers accept ed25519 now.
 */

function rowToSshKey(row: Record<string, unknown>): SshKey {
  return {
    id: row.id as number,
    name: row.name as string,
    description: (row.description as string) || null,
    teamId: (row.team_id as number) || null,
    ownerUserId: (row.owner_user_id as number) || null,
    keyType: row.key_type as SshKeyType,
    publicKey: row.public_key as string,
    fingerprint: row.fingerprint as string,
    createdByUserId: (row.created_by_user_id as number) || null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/**
 * Encode a length-prefixed string per the SSH wire format (RFC 4251 §5): 4-byte big-endian
 * length followed by the raw bytes. Used to build the OpenSSH-format public key blob and to
 * compute a fingerprint matching `ssh-keygen -l`.
 */
function ssh2String(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

/**
 * Generate an ed25519 keypair and return the OpenSSH-formatted public key + PKCS8 PEM private
 * key + `SHA256:xxx` fingerprint (padding-stripped, matches `ssh-keygen -l -E sha256 -f`).
 */
function generateEd25519Keypair(comment: string): { publicKey: string; privateKeyPem: string; fingerprint: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  // Extract the raw 32-byte public key from the JWK export — the SPKI DER wraps it and JWK
  // gives us `x` (base64url of the raw bytes) which is exactly what the wire format wants.
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('ed25519 public key export missing x — Node runtime mismatch');
  const rawPubKey = Buffer.from(jwk.x, 'base64url');

  // OpenSSH public key blob = <string("ssh-ed25519")><string(rawPubKey)>
  const typeString = 'ssh-ed25519';
  const blob = Buffer.concat([
    ssh2String(Buffer.from(typeString)),
    ssh2String(rawPubKey),
  ]);
  const b64 = blob.toString('base64');
  const publicKeyLine = `${typeString} ${b64} ${comment}`;

  // Fingerprint: sha256 of the blob, base64 without `=` padding, prefixed with `SHA256:` —
  // matches OpenSSH's canonical fingerprint format (RFC 4253 §6.6 + OpenSSH extension).
  const hash = crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  const fingerprint = `SHA256:${hash}`;

  return { publicKey: publicKeyLine, privateKeyPem, fingerprint };
}

export const sshKeyService = {
  async list(filter?: { teamIds?: number[]; ownerUserId?: number; includeGlobal?: boolean }): Promise<SshKey[]> {
    // Ownership filtering: caller passes the buckets the current user is allowed to see, we OR
    // them. A row with both team_id and owner_user_id NULL is "global" — only surfaced when
    // includeGlobal is true (typically for admins).
    const rows = await db('ssh_keys')
      .where(function () {
        if (filter?.teamIds?.length) this.orWhereIn('team_id', filter.teamIds);
        if (filter?.ownerUserId) this.orWhere({ owner_user_id: filter.ownerUserId });
        if (filter?.includeGlobal) {
          this.orWhere(function () { this.whereNull('team_id').whereNull('owner_user_id'); });
        }
      })
      .orderBy('name');
    return rows.map(rowToSshKey);
  },

  async getById(id: number): Promise<SshKey | null> {
    const row = await db('ssh_keys').where({ id }).first();
    return row ? rowToSshKey(row) : null;
  },

  /**
   * Plaintext private key for the given id. Never called from a route handler — only from the
   * workflow runner during action execution. Keeps the decrypt step next to the crypto for
   * an easier audit trail.
   */
  async getPrivateKey(id: number): Promise<string | null> {
    const row = await db('ssh_keys').where({ id }).select('private_key_enc').first();
    if (!row?.private_key_enc) return null;
    return decryptSecret(row.private_key_enc as string);
  },

  async create(data: {
    name: string;
    description?: string | null;
    teamId?: number | null;
    ownerUserId?: number | null;
    keyType?: SshKeyType;
    createdByUserId?: number | null;
  }): Promise<SshKey> {
    if (data.teamId && data.ownerUserId) {
      throw new Error('SSH key cannot be both team-scoped and personal — pick one');
    }
    const keyType: SshKeyType = data.keyType || 'ed25519';
    if (keyType !== 'ed25519') {
      throw new Error(`Key type ${keyType} not supported in v1 (ed25519 only)`);
    }
    const comment = `oblihub/${data.name.replace(/\s+/g, '_')}`;
    const { publicKey, privateKeyPem, fingerprint } = generateEd25519Keypair(comment);
    const [row] = await db('ssh_keys').insert({
      name: data.name,
      description: data.description || null,
      team_id: data.teamId || null,
      owner_user_id: data.ownerUserId || null,
      key_type: keyType,
      public_key: publicKey,
      private_key_enc: encryptSecret(privateKeyPem),
      fingerprint,
      created_by_user_id: data.createdByUserId || null,
    }).returning('*');
    return rowToSshKey(row);
  },

  async update(id: number, data: { name?: string; description?: string | null; teamId?: number | null; ownerUserId?: number | null }): Promise<SshKey | null> {
    if (data.teamId && data.ownerUserId) {
      throw new Error('SSH key cannot be both team-scoped and personal — pick one');
    }
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.teamId !== undefined) update.team_id = data.teamId;
    if (data.ownerUserId !== undefined) update.owner_user_id = data.ownerUserId;
    const [row] = await db('ssh_keys').where({ id }).update(update).returning('*');
    return row ? rowToSshKey(row) : null;
  },

  async delete(id: number): Promise<void> {
    // workflow_targets.ssh_key_id has ON DELETE RESTRICT so orphaning throws at the DB layer.
    // Surface a clean error instead of the raw pg constraint violation.
    const referencing = await db('workflow_targets').where({ ssh_key_id: id }).count<{ count: string }[]>('* as count').first();
    if (referencing && Number(referencing.count) > 0) {
      throw new Error(`This SSH key is in use by ${referencing.count} workflow target(s). Detach or delete them first.`);
    }
    await db('ssh_keys').where({ id }).delete();
  },
};
