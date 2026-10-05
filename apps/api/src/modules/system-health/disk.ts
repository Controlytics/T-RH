/**
 * Disk usage for the System Health page.
 *
 * Audit 2026-10-03, API-17: the previous reader shelled out to `wmic`, which
 * is ABSENT on current Windows (removed from 11 24H2; `where wmic` on this
 * machine → not found), and its catch returned zeros with no log. A customer
 * `Setup.exe` install therefore showed "Disk 0 B / 0 %" with nothing anywhere
 * to say the figure was not a measurement — on the one page meant to warn of
 * a full disk.
 *
 * Order now: `fs.promises.statfs` (Node ≥ 18.15, works on Windows — verified
 * here against `C:\` and the uploads directory), then PowerShell
 * `Get-CimInstance Win32_LogicalDisk` on Windows (`wmic`'s supported
 * successor), then `df` elsewhere. A failure is LOGGED and REPORTED
 * (`available: false`, `error`), never zeroed: the response schema declares
 * both so the page can say "unavailable" instead of printing 0.
 *
 * The path measured is the UPLOADS root rather than `/` or `C:`: it is the
 * disk this process writes to, which is the one that matters when it fills.
 */
import { promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { UPLOADS_ROOT } from '../../lib/uploads-dir.js';
import { logger } from '../../lib/logger.js';

const execAsync = promisify(exec);

export interface DiskUsage {
  /** The path the figures describe. */
  path: string;
  total: number;
  used: number;
  free: number;
  usagePercent: number;
  /** False when every reader failed; the numbers are then 0 and `error` says why. */
  available: boolean;
  error: string | null;
}

/** The readers, injectable so the fallback order is unit-testable without a disk. */
export interface DiskReaders {
  statfs: (p: string) => Promise<{ bsize: number | bigint; blocks: number | bigint; bfree: number | bigint; bavail: number | bigint }>;
  exec: (cmd: string) => Promise<{ stdout: string }>;
  platform: NodeJS.Platform;
}

const defaultReaders: DiskReaders = {
  statfs: (p) => fs.statfs(p),
  exec: (cmd) => execAsync(cmd),
  platform: process.platform,
};

function percent(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 100) : 0;
}

/** The drive letter of a Windows path (`C:`), or null for a UNC / relative path. */
export function driveOf(p: string): string | null {
  const m = /^([A-Za-z]):/.exec(path.resolve(p));
  return m ? `${m[1].toUpperCase()}:` : null;
}

async function viaStatfs(p: string, r: DiskReaders): Promise<Omit<DiskUsage, 'path' | 'available' | 'error'>> {
  const s = await r.statfs(p);
  const bsize = Number(s.bsize);
  const total = Number(s.blocks) * bsize;
  // `bavail` is what an unprivileged writer can actually use; `bfree` counts
  // root-reserved blocks on Linux, which this process cannot fill.
  const free = Number(s.bavail) * bsize;
  const used = total - Number(s.bfree) * bsize;
  if (!Number.isFinite(total) || total <= 0) throw new Error(`statfs reported no capacity for ${p}`);
  return { total, used, free, usagePercent: percent(used, total) };
}

async function viaPowerShell(drive: string, r: DiskReaders): Promise<Omit<DiskUsage, 'path' | 'available' | 'error'>> {
  // `-NoProfile` so a user profile script cannot change the output shape;
  // sizes printed as plain integers so no locale formatting creeps in.
  const { stdout } = await r.exec(
    `powershell -NoProfile -NonInteractive -Command "$d = Get-CimInstance Win32_LogicalDisk -Filter \\"DeviceID='${drive}'\\"; Write-Output ([string]$d.Size + ' ' + [string]$d.FreeSpace)"`,
  );
  const [totalStr, freeStr] = stdout.trim().split(/\s+/);
  const total = Number(totalStr);
  const free = Number(freeStr);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free)) {
    throw new Error(`Get-CimInstance returned "${stdout.trim()}" for ${drive}`);
  }
  const used = total - free;
  return { total, used, free, usagePercent: percent(used, total) };
}

async function viaDf(p: string, r: DiskReaders): Promise<Omit<DiskUsage, 'path' | 'available' | 'error'>> {
  const { stdout } = await r.exec(`df -B1 "${p}" | tail -1 | awk '{print $2,$3,$4}'`);
  const [totalStr, usedStr, freeStr] = stdout.trim().split(/\s+/);
  const total = Number(totalStr);
  const used = Number(usedStr);
  const free = Number(freeStr);
  if (!Number.isFinite(total) || total <= 0) throw new Error(`df returned "${stdout.trim()}" for ${p}`);
  return { total, used, free, usagePercent: percent(used, total) };
}

export async function getDiskUsage(
  p: string = UPLOADS_ROOT,
  readers: DiskReaders = defaultReaders,
): Promise<DiskUsage> {
  const failures: string[] = [];
  const attempts: Array<[string, () => Promise<Omit<DiskUsage, 'path' | 'available' | 'error'>>]> = [
    ['statfs', () => viaStatfs(p, readers)],
  ];
  if (readers.platform === 'win32') {
    const drive = driveOf(p);
    if (drive) attempts.push(['Get-CimInstance', () => viaPowerShell(drive, readers)]);
  } else {
    attempts.push(['df', () => viaDf(p, readers)]);
  }

  for (const [name, attempt] of attempts) {
    try {
      const figures = await attempt();
      return { path: p, ...figures, available: true, error: null };
    } catch (e) {
      failures.push(`${name}: ${(e as Error).message}`);
    }
  }

  const error = `Disk usage unavailable for ${p} — ${failures.join('; ')}`;
  // Logged every time it is asked for, not once: the page polls, and a figure
  // that silently stays at zero is the defect this file exists to remove.
  logger.warn(`[system-health] ${error}`);
  return { path: p, total: 0, used: 0, free: 0, usagePercent: 0, available: false, error };
}
