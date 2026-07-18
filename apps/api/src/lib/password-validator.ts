import { prisma } from './prisma.js';
import { ValidationError } from './errors.js';

const POLICY_CHECKS: Array<{ flag: string; regex: RegExp; countKey: string; name: string; defaultMin: number }> = [
  { flag: 'requireUppercase', regex: /[A-Z]/g, countKey: 'minUppercase', name: 'uppercase letter', defaultMin: 1 },
  { flag: 'requireLowercase', regex: /[a-z]/g, countKey: 'minLowercase', name: 'lowercase letter', defaultMin: 1 },
  { flag: 'requireNumbers', regex: /[0-9]/g, countKey: 'minNumbers', name: 'number', defaultMin: 1 },
  { flag: 'requireSpecialChars', regex: /[^A-Za-z0-9]/g, countKey: 'minSpecialChars', name: 'special character', defaultMin: 1 },
];

/**
 * Validate a password against the active password policy.
 * Throws ValidationError on policy violation.
 */
export async function validatePasswordPolicy(password: string, username?: string): Promise<void> {
  const config = await prisma.systemConfig.findUnique({ where: { configKey: 'password-policy' } });
  const policy = (config?.configValue as any) ?? {
    minLength: 8, maxLength: 128, requireUppercase: true, requireLowercase: true,
    requireNumbers: true, requireSpecialChars: true,
  };

  const minLength = (policy.minLength as number) ?? 8;
  const maxLength = (policy.maxLength as number) ?? 128;
  if (password.length < minLength) throw new ValidationError(`Password must be at least ${minLength} characters`);
  if (password.length > maxLength) throw new ValidationError(`Password must be at most ${maxLength} characters`);

  for (const check of POLICY_CHECKS) {
    if (policy[check.flag]) {
      const min = (policy[check.countKey] as number) ?? check.defaultMin;
      if ((password.match(check.regex) || []).length < min) {
        throw new ValidationError(`Password must contain at least ${min} ${check.name}(s)`);
      }
    }
  }

  if (username) {
    if (policy.cannotBeUserId !== false && password === username) {
      throw new ValidationError('Password cannot be same as User ID');
    }
    if (policy.cannotContainUserId !== false && password.toLowerCase().includes(username.toLowerCase())) {
      throw new ValidationError('Password cannot contain User ID');
    }
  }
}
