import bcrypt from 'bcrypt';
import crypto from 'crypto';

const SALT_ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ── Symmetric secret encryption (for engine credentials) ──────────────────────
// AES-256-GCM, key derived from OBLIHUB_ENCRYPTION_KEY (preferred) or SESSION_SECRET.
// Output format: base64(iv || authTag || ciphertext) — single string column-friendly.
// IMPORTANT: rotating the source secret invalidates all stored ciphertexts.

function getEncryptionKey(): Buffer {
  const src = process.env.OBLIHUB_ENCRYPTION_KEY || process.env.SESSION_SECRET || '';
  if (!src) throw new Error('OBLIHUB_ENCRYPTION_KEY or SESSION_SECRET must be set to use encrypted secrets');
  // Derive a stable 32-byte key from the source secret.
  return crypto.createHash('sha256').update(src).digest();
}

export function encryptSecret(plain: string): string {
  if (!plain) return '';
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(blob: string): string {
  if (!blob) return '';
  const data = Buffer.from(blob, 'base64');
  if (data.length < 12 + 16) throw new Error('decryptSecret: ciphertext too short');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ct = data.subarray(28);
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
