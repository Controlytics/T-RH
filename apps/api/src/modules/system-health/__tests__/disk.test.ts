import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { logger } from '../../../lib/logger.js';
import { getDiskUsage, driveOf, type DiskReaders } from '../disk.js';

/**
 * Audit 2026-10-03, API-17. The old reader shelled out to `wmic` (absent on
 * current Windows) and returned zeros from an empty catch. These pin the
 * reader order, the arithmetic, and — the finding itself — that a total
 * failure is LOGGED and REPORTED rather than zeroed silently.
 */
const GB = 1024 ** 3;

const readers = (over: Partial<DiskReaders> = {}): DiskReaders => ({
  statfs: vi.fn(async () => ({ bsize: 4096, blocks: 100 * GB / 4096, bfree: 40 * GB / 4096, bavail: 35 * GB / 4096 })),
  exec: vi.fn(async () => ({ stdout: '' })),
  platform: 'win32',
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('getDiskUsage', () => {
  it('measures through statfs first: total from blocks, free from bavail, used from bfree', async () => {
    const r = readers();
    const out = await getDiskUsage('C:\\data\\uploads', r);
    expect(out).toMatchObject({ available: true, error: null, path: 'C:\\data\\uploads', total: 100 * GB, used: 60 * GB, free: 35 * GB, usagePercent: 60 });
    expect(r.exec).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('accepts the bigint fields Node returns on some platforms', async () => {
    const r = readers({ statfs: async () => ({ bsize: 4096n, blocks: BigInt(10 * GB / 4096), bfree: BigInt(5 * GB / 4096), bavail: BigInt(5 * GB / 4096) }) });
    const out = await getDiskUsage('/srv/uploads', { ...r, platform: 'linux' });
    expect(out).toMatchObject({ available: true, total: 10 * GB, free: 5 * GB, usagePercent: 50 });
  });

  it('falls back to Get-CimInstance on Windows when statfs fails, asking for the path\'s drive', async () => {
    const r = readers({
      statfs: async () => { throw new Error('ENOSYS'); },
      exec: vi.fn(async () => ({ stdout: `${200 * GB} ${50 * GB}\r\n` })),
    });
    const out = await getDiskUsage('D:\\digilog\\uploads', r);
    expect(out).toMatchObject({ available: true, total: 200 * GB, free: 50 * GB, used: 150 * GB, usagePercent: 75 });
    const cmd = (r.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(cmd).toContain('Get-CimInstance Win32_LogicalDisk');
    expect(cmd).toContain("DeviceID='D:'");
    expect(cmd).not.toContain('wmic');
  });

  it('falls back to df elsewhere', async () => {
    const r = readers({
      platform: 'linux',
      statfs: async () => { throw new Error('ENOSYS'); },
      exec: vi.fn(async () => ({ stdout: `${80 * GB} ${20 * GB} ${60 * GB}\n` })),
    });
    const out = await getDiskUsage('/opt/digilog/uploads', r);
    expect(out).toMatchObject({ available: true, total: 80 * GB, used: 20 * GB, free: 60 * GB, usagePercent: 25 });
    expect((r.exec as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('df -B1');
  });

  // The finding: zeros with nothing to say they are not a measurement.
  it('reports and logs a total failure instead of zeroing silently', async () => {
    const r = readers({
      statfs: async () => { throw new Error('ENOSYS'); },
      exec: async () => { throw new Error('powershell: not found'); },
    });
    const out = await getDiskUsage('C:\\x', r);
    expect(out.available).toBe(false);
    expect(out.error).toContain('statfs: ENOSYS');
    expect(out.error).toContain('Get-CimInstance: powershell: not found');
    expect(out).toMatchObject({ total: 0, used: 0, free: 0, usagePercent: 0 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('Disk usage unavailable');
  });

  it('treats a zero-capacity or unparseable answer as a failure of that reader', async () => {
    const r = readers({
      statfs: async () => ({ bsize: 4096, blocks: 0, bfree: 0, bavail: 0 }),
      exec: async () => ({ stdout: 'Get-CimInstance : not recognized' }),
    });
    const out = await getDiskUsage('C:\\x', r);
    expect(out.available).toBe(false);
    expect(out.error).toContain('no capacity');
  });
});

describe('driveOf', () => {
  it('reads the drive letter of a Windows path, upper-cased', () => {
    expect(driveOf('d:\\digilog\\uploads')).toBe('D:');
  });
});
