import type { NotificationPlugin } from '../types';
import { formatTitle, formatBody } from '../format';

export const ntfyPlugin: NotificationPlugin = {
  type: 'ntfy',
  name: 'Ntfy',
  configFields: [
    { key: 'serverUrl', label: 'Server URL', type: 'text', required: true, placeholder: 'https://ntfy.sh' },
    { key: 'topic', label: 'Topic', type: 'text', required: true },
    { key: 'token', label: 'Access Token', type: 'password' },
  ],
  async send(config, payload) {
    const { serverUrl, topic, token } = config as { serverUrl: string; topic: string; token?: string };
    const url = `${serverUrl.replace(/\/$/, '')}/${topic}`;
    const headers: Record<string, string> = { 'Title': formatTitle(payload) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(url, { method: 'POST', headers, body: formatBody(payload) });
    if (!res.ok) throw new Error(`Ntfy error: ${res.status}`);
  },
};
