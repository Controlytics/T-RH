import { prisma } from './prisma.js';
import { userIdConfigSchema } from '@digilog/shared';

export async function validateUserId(userId: string): Promise<{ valid: boolean; errors: string[] }> {
  const config = await prisma.systemConfig.findUnique({ where: { configKey: 'user-id' } });
  const settings = userIdConfigSchema.safeParse(config?.configValue ?? {});
  const cfg = settings.success ? settings.data : userIdConfigSchema.parse({});

  const errors: string[] = [];
  const isPrefixFormat = cfg.format.startsWith('PREFIX_');
  const isCustomPattern = cfg.format === 'CUSTOM_PATTERN';

  // For CUSTOM_PATTERN, the regex is the sole validator — skip length/prefix/case checks
  if (isCustomPattern) {
    if (cfg.customPattern) {
      try {
        const regex = new RegExp(`^${cfg.customPattern}$`);
        if (!regex.test(userId)) {
          errors.push(cfg.customPatternDescription || 'User ID does not match required pattern');
        }
      } catch {
        errors.push('Invalid custom pattern configured');
      }
    } else {
      errors.push('No custom pattern has been configured');
    }
    return { valid: errors.length === 0, errors };
  }

  const prefix = isPrefixFormat && cfg.prefix ? `${cfg.prefix}${cfg.prefixSeparator}` : '';
  const expectedLength = cfg.length;

  // Check length
  if (userId.length !== expectedLength) {
    errors.push(`User ID must be exactly ${expectedLength} characters`);
  }

  // Check prefix (only for PREFIX_* formats)
  if (isPrefixFormat && prefix && !userId.startsWith(prefix)) {
    errors.push(`User ID must start with "${prefix}"`);
  }

  // Get the part after prefix
  const mainPart = prefix ? userId.slice(prefix.length) : userId;

  // Check format
  switch (cfg.format) {
    case 'NUMBERS_ONLY':
      if (!/^\d+$/.test(userId)) {
        errors.push('User ID must contain only numbers');
      }
      break;
    case 'LETTERS_ONLY':
      if (!/^[a-zA-Z]+$/.test(userId)) {
        errors.push('User ID must contain only letters');
      }
      break;
    case 'LETTERS_NUMBERS':
      if (!/^[a-zA-Z0-9]+$/.test(userId)) {
        errors.push('User ID must contain only letters and numbers');
      }
      break;
    case 'PREFIX_NUMBERS':
      if (!/^\d+$/.test(mainPart)) {
        errors.push('User ID must have numbers after prefix');
      }
      break;
    case 'PREFIX_LETTERS':
      if (!/^[a-zA-Z]+$/.test(mainPart)) {
        errors.push('User ID must have letters after prefix');
      }
      break;
    case 'PREFIX_LETTERS_NUMBERS':
      if (!/^[a-zA-Z0-9]+$/.test(mainPart)) {
        errors.push('User ID must have letters and numbers after prefix');
      }
      break;
  }

  // Check letter case
  if (cfg.letterCase === 'UPPERCASE' && userId !== userId.toUpperCase()) {
    errors.push('User ID must be uppercase');
  } else if (cfg.letterCase === 'LOWERCASE' && userId !== userId.toLowerCase()) {
    errors.push('User ID must be lowercase');
  }

  return { valid: errors.length === 0, errors };
}
