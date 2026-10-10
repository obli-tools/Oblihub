import type { NotificationPlugin } from '../types';
import { formatTitle, formatBody } from '../format';

export const gotifyPlugin: NotificationPlugin = {
  type: 'gotify',
  name: 'Gotify',
  configFields: [
    { key: 'serverUrl', label: 'Server URL', type: 'text', required: true, placeholder: 'https://gotify.example.com' },
    { key: 'appToken', label: 'App Token', type: 'password', required: true },
    { key: 'priority', label: 'Priority', type: 'number', placeholder: '5' },
  ],
  async send(config, payload) {
    const { serverUrl, appToken, priority } = config as { serverUrl: string; appToken: string; priority?: number };
    const url = `${serverUrl.replace(/\/$/, '')}/message?token=${appToken}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: formatTitle(payload), message: formatBody(payload), priority: priority || 5 }),
    });
    if (!res.ok) throw new Error(`Gotify error: ${res.status}`);
  },
};
