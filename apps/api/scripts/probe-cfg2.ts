import { prisma } from '../src/lib/prisma.js';
import { loadLimitConfig } from '../src/modules/alarms/load-limits.js';
import { loadProfileMeasurements } from '../src/modules/instruments/profile-measurements.js';
import { slotConfigFromMeasurements } from '@digilog/shared';
// The enable keys are each PROFILE's since 2026-10-26; the master switch stays global.
const cfg = await loadLimitConfig();
for (const [profileId, ms] of await loadProfileMeasurements()) {
  const slot = slotConfigFromMeasurements(ms);
  console.log(profileId, 'enableKeys:', JSON.stringify(slot.enableKeys), 'boundSwitch:', JSON.stringify(slot.boundSwitch));
}
console.log('enabled:', cfg.enabled);
await prisma.$disconnect();
