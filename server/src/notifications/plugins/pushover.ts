import type { NotificationPlugin } from '../types';
import { formatTitle, formatBody } from '../format';

export const pushoverPlugin: NotificationPlugin = {
  type: 'pushover',
  name: 'Pushover',
  configFields: [
    { key: 'userKey', label: 'User Key', type: 'text', required: true },
    { key: 'apiToken', label: 'API Token', type: 'password', required: true },
  ],
  async send(config, payload) {
    const { userKey, apiToken } = config as { userKey: string; apiToken: string };
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: apiToken, user: userKey, title: formatTitle(payload), message: formatBody(payload) }),
    });
    if (!res.ok) throw new Error(`Pushover error: ${res.status}`);
  },
};
