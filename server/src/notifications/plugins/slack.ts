import type { NotificationPlugin } from '../types';
import { formatTitle, formatBody } from '../format';

export const slackPlugin: NotificationPlugin = {
  type: 'slack',
  name: 'Slack',
  configFields: [
    { key: 'webhookUrl', label: 'Webhook URL', type: 'text', required: true, placeholder: 'https://hooks.slack.com/services/...' },
  ],
  async send(config, payload) {
    const { webhookUrl } = config as { webhookUrl: string };
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `*${formatTitle(payload)}*\n${formatBody(payload)}` }),
    });
    if (!res.ok) throw new Error(`Slack webhook error: ${res.status}`);
  },
};
