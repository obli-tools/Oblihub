import type { NotificationPayload } from './types';

const ICONS: Record<string, string> = {
  update_available: '\uD83D\uDD04',
  update_applied: '\u2705',
  update_failed: '\u274C',
  cert_renewal_failed: '\uD83D\uDD12',
  cert_expiring_soon: '\u23F3',
  test: '\uD83D\uDD14',
};

export function formatTitle(payload: NotificationPayload): string {
  const icon = ICONS[payload.eventType] || '\uD83D\uDCE6';
  const app = payload.appName || 'Oblihub';
  if (payload.eventType === 'test') return `${icon} ${app} — Test notification`;
  const target = payload.containerName || payload.stackName;
  const labels: Record<string, string> = {
    update_available: 'Update available',
    update_applied: 'Update applied',
    update_failed: 'Update failed',
    cert_renewal_failed: 'Certificate renewal failed',
    cert_expiring_soon: 'Certificate expiring soon',
  };
  return `${icon} ${app} — ${labels[payload.eventType] || payload.eventType}: ${target}`;
}

export function formatBody(payload: NotificationPayload): string {
  const lines: string[] = [];
  if (payload.containerName) lines.push(`Container: ${payload.containerName}`);
  if (payload.stackName) lines.push(`Stack: ${payload.stackName}`);
  if (payload.image) lines.push(`Image: ${payload.image}`);
  if (payload.oldDigest) lines.push(`Current: ${payload.oldDigest.substring(0, 19)}`);
  if (payload.newDigest) lines.push(`New: ${payload.newDigest.substring(0, 19)}`);
  if (payload.message) lines.push(payload.message);
  lines.push(`Time: ${new Date(payload.timestamp).toLocaleString()}`);
  return lines.join('\n');
}
