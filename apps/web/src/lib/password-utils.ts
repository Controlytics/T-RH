import type { PasswordPolicyConfig } from '@digilog/shared';

export const DEFAULT_PASSWORD_POLICY: PasswordPolicyConfig = {
  minLength: 8,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSpecialChars: true,
  minUppercase: 1,
  minLowercase: 1,
  minNumbers: 1,
  minSpecialChars: 1,
  preventReuseCount: 12,
  cannotBeUserId: true,
  cannotContainUserId: true,
  maxFailedAttempts: 5,
  passwordExpiryDays: 90,
  expiryNotificationDays: 0,
  autoLogoutEnabled: true,
  idleTimeoutMinutes: 15,
  warningMinutes: 2,
};

/**
 * Uniform random integer in [0, max) from the platform CSPRNG.
 *
 * `Math.floor(Math.random() * n)` was used here until 2026-07-15. Two problems,
 * both real: Math.random is NOT a CSPRNG (V8's xorshift128+ internal state is
 * recoverable from a handful of outputs, so an attacker who can observe or
 * provoke other random values in the same page can predict subsequent ones), and
 * these values become temporary passwords for user-create, unlock and
 * reset-approve. Forced change on first login bounds the window, but a
 * predictable temp password is a live account-takeover window inside it.
 *
 * Rejection sampling keeps the distribution uniform — the naive `% max` would
 * bias toward low values whenever max doesn't divide 2^32.
 */
function randomIndex(max: number): number {
  const limit = Math.floor(0xFFFFFFFF / max) * max;
  const buf = new Uint32Array(1);
  let v: number;
  do {
    crypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limit);
  return v % max;
}

function pick(chars: string): string {
  return chars[randomIndex(chars.length)];
}

export function generatePassword(policy: PasswordPolicyConfig): string {
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const special = '!@#$%^&*()_+-=[]{}|;:,.<>?';

  const out: string[] = [];
  const allChars: string[] = [];

  if (policy.requireUppercase) {
    for (let i = 0; i < policy.minUppercase; i++) out.push(pick(uppercase));
    allChars.push(...uppercase.split(''));
  }

  if (policy.requireLowercase) {
    for (let i = 0; i < policy.minLowercase; i++) out.push(pick(lowercase));
    allChars.push(...lowercase.split(''));
  }

  if (policy.requireNumbers) {
    for (let i = 0; i < policy.minNumbers; i++) out.push(pick(numbers));
    allChars.push(...numbers.split(''));
  }

  if (policy.requireSpecialChars) {
    for (let i = 0; i < policy.minSpecialChars; i++) out.push(pick(special));
    allChars.push(...special.split(''));
  }

  const targetLength = Math.max(policy.minLength, out.length + 4);
  while (out.length < targetLength) out.push(allChars[randomIndex(allChars.length)]);

  // Fisher-Yates. The previous `sort(() => Math.random() - 0.5)` is a classic
  // broken shuffle: the comparator is non-transitive, so the permutation it
  // produces is biased and engine-dependent — the required-class characters
  // stayed near the front far more often than chance.
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}
