/**
 * Config Loader — Loads email/SMS settings from SystemConfig table.
 * Caches configs in memory with TTL for performance.
 */

import { prisma } from '../../lib/prisma.js';
import type { EmailConfig, SmsConfig } from './types.js';

const CONFIG_CACHE_TTL = 30_000; // 30 seconds

interface CacheEntry<T> {
  data: T | null;
  expiresAt: number;
}

const cache: Record<string, CacheEntry<unknown>> = {};

async function loadConfig<T>(key: string): Promise<T | null> {
  const now = Date.now();
  const cached = cache[key];
  if (cached && cached.expiresAt > now) return cached.data as T | null;

  const config = await prisma.systemConfig.findUnique({
    where: { configKey: key },
  });

  const value = config?.configValue as T | null;
  cache[key] = { data: value, expiresAt: now + CONFIG_CACHE_TTL };
  return value;
}

export async function getEmailConfig(): Promise<EmailConfig | null> {
  return loadConfig<EmailConfig>('notification-email');
}

export async function getSmsConfig(): Promise<SmsConfig | null> {
  return loadConfig<SmsConfig>('notification-sms');
}

/** Invalidate cached configs (call after settings update). */
export function invalidateNotificationConfigCache(): void {
  delete cache['notification-email'];
  delete cache['notification-sms'];
}
