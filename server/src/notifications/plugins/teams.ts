import type { NotificationPlugin } from '../types';
import { formatTitle, formatBody } from '../format';

export const teamsPlugin: NotificationPlugin = {
  type: 'teams',
  name: 'Microsoft Teams',
  configFields: [
    { key: 'webhookUrl', label: 'Webhook URL', type: 'text', required: true, placeholder: 'https://outlook.office.com/webhook/...' },
  ],
  async send(config, payload) {
    const { webhookUrl } = config as { webhookUrl: string };
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ '@type': 'MessageCard', summary: formatTitle(payload), title: formatTitle(payload), text: formatBody(payload).replace(/\n/g, '<br>') }),
    });
    if (!res.ok) throw new Error(`Teams webhook error: ${res.status}`);
  },
};
