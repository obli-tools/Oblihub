import type { NotificationPlugin } from './types';
import { telegramPlugin } from './plugins/telegram';
import { discordPlugin } from './plugins/discord';
import { slackPlugin } from './plugins/slack';
import { teamsPlugin } from './plugins/teams';
import { smtpPlugin } from './plugins/smtp';
import { webhookPlugin } from './plugins/webhook';
import { gotifyPlugin } from './plugins/gotify';
import { ntfyPlugin } from './plugins/ntfy';
import { pushoverPlugin } from './plugins/pushover';
import { freemobilePlugin } from './plugins/freemobile';

const plugins: NotificationPlugin[] = [
  telegramPlugin, discordPlugin, slackPlugin, teamsPlugin, smtpPlugin,
  webhookPlugin, gotifyPlugin, ntfyPlugin, pushoverPlugin, freemobilePlugin,
];

export function getPlugin(type: string): NotificationPlugin | undefined {
  return plugins.find(p => p.type === type);
}

export function getAllPlugins(): NotificationPlugin[] {
  return plugins;
}
