import type { NotificationPlugin } from '../types';
import { formatTitle, formatBody } from '../format';

export const freemobilePlugin: NotificationPlugin = {
  type: 'freemobile',
  name: 'Free Mobile',
  configFields: [
    { key: 'userId', label: 'User ID', type: 'text', required: true },
    { key: 'apiKey', label: 'API Key', type: 'password', required: true },
  ],
  async send(config, payload) {
    const { userId, apiKey } = config as { userId: string; apiKey: string };
    const msg = `${formatTitle(payload)}\n${formatBody(payload)}`;
    const res = await fetch(`https://smsapi.free-mobile.fr/sendmsg?user=${userId}&pass=${apiKey}&msg=${encodeURIComponent(msg)}`);
    if (!res.ok) throw new Error(`Free Mobile error: ${res.status}`);
  },
};
