import type { NotificationPlugin } from '../types';

export const webhookPlugin: NotificationPlugin = {
  type: 'webhook',
  name: 'Webhook',
  configFields: [
    { key: 'url', label: 'URL', type: 'text', required: true },
    { key: 'method', label: 'Method (GET/POST)', type: 'text', placeholder: 'POST' },
    { key: 'headers', label: 'Headers (JSON)', type: 'text', placeholder: '{"Authorization": "Bearer ..."}' },
  ],
  async send(config, payload) {
    const { url, method, headers } = config as { url: string; method?: string; headers?: string };
    const parsedHeaders = headers ? JSON.parse(headers) : {};
    const res = await fetch(url, {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json', ...parsedHeaders },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Webhook error: ${res.status}`);
  },
};
