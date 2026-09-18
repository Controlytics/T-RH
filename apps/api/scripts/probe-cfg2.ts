import { prisma } from '../src/lib/prisma.js';
import { loadLimitConfig } from '../src/modules/alarms/load-limits.js';
const cfg = await loadLimitConfig();
console.log('enableKeys:', JSON.stringify(cfg.enableKeys));
console.log('enabled:', cfg.enabled);
await prisma.$disconnect();
