import type { NotificationPlugin } from '../types';
import { formatTitle, formatBody } from '../format';

export const telegramPlugin: NotificationPlugin = {
  type: 'telegram',
  name: 'Telegram',
  configFields: [
    { key: 'botToken', label: 'Bot Token', type: 'password', required: true, placeholder: '123456:ABC-DEF...' },
    { key: 'chatId', label: 'Chat ID', type: 'text', required: true, placeholder: '-1001234567890' },
  ],
  async send(config, payload) {
    const { botToken, chatId } = config as { botToken: string; chatId: string };
    const text = `<b>${formatTitle(payload)}</b>\n\n${formatBody(payload)}`;
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`Telegram API error: ${res.status}`);
  },
};
