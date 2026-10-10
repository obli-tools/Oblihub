export interface NotificationPayload {
  stackName: string;
  containerName?: string;
  image?: string;
  oldDigest?: string;
  newDigest?: string;
  eventType: 'update_available' | 'update_applied' | 'update_failed' | 'cert_renewal_failed' | 'cert_expiring_soon' | 'test';
  message?: string;
  timestamp: string;
  appName?: string;
}

export interface NotificationPlugin {
  type: string;
  name: string;
  configFields: Array<{ key: string; label: string; type: 'text' | 'password' | 'number' | 'boolean'; required?: boolean; placeholder?: string }>;
  send(config: Record<string, unknown>, payload: NotificationPayload): Promise<void>;
}
