import type { NotificationPlugin } from '../types';
import { formatTitle, formatBody } from '../format';

export const discordPlugin: NotificationPlugin = {
  type: 'discord',
  name: 'Discord',
  configFields: [
    { key: 'webhookUrl', label: 'Webhook URL', type: 'text', required: true, placeholder: 'https://discord.com/api/webhooks/...' },
  ],
  async send(config, payload) {
    const { webhookUrl } = config as { webhookUrl: string };
    const color = payload.eventType === 'update_applied' ? 0x2ea043 : payload.eventType === 'update_failed' ? 0xf85149 : 0xd29922;
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{ title: formatTitle(payload), description: formatBody(payload), color, timestamp: payload.timestamp }],
      }),
    });
    if (!res.ok) throw new Error(`Discord webhook error: ${res.status}`);
  },
};
