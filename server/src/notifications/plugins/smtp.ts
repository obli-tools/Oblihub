import nodemailer from 'nodemailer';
import type { NotificationPlugin } from '../types';
import { formatTitle, formatBody } from '../format';

export const smtpPlugin: NotificationPlugin = {
  type: 'smtp',
  name: 'Email (SMTP)',
  configFields: [
    { key: 'host', label: 'SMTP Host', type: 'text', required: true },
    { key: 'port', label: 'Port', type: 'number', required: true, placeholder: '587' },
    { key: 'secure', label: 'Use TLS', type: 'boolean' },
    { key: 'username', label: 'Username', type: 'text' },
    { key: 'password', label: 'Password', type: 'password' },
    { key: 'from', label: 'From Address', type: 'text', required: true },
    { key: 'to', label: 'To Address', type: 'text', required: true },
  ],
  async send(config, payload) {
    const { host, port, secure, username, password, from, to } = config as Record<string, unknown>;
    const transport = nodemailer.createTransport({
      host: host as string, port: Number(port), secure: !!secure,
      auth: username ? { user: username as string, pass: password as string } : undefined,
    });
    await transport.sendMail({ from: from as string, to: to as string, subject: formatTitle(payload), text: formatBody(payload) });
  },
};
