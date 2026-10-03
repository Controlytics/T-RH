/**
 * Export the six 2D-traced floors to a STATIC data file for the client
 * presentation pages under `Layouts/presentation/` (2026-10-03, operator:
 * "prepare layouts not 2d, and other like normal and 3d and other models and
 * generate them as html pages separately, dont disturb current ones").
 *
 *   cd apps/api && npx tsx scripts/export-layout-models.ts
 *
 * READ-ONLY. It writes exactly one file, `Layouts/presentation/data/layouts.js`
 * (`window.LAYOUT_MODELS = {...}`), so the presentation pages can be opened by
 * double-click from the file system — no server, no API, no internet. Nothing
 * in the database or under `apps/` changes.
 *
 * What goes in:
 *   - every traced floor, in its DRAWING pixels (`ArchLayout`): rooms as
 *     polygons, doors as measured wall gaps, columns / windows / stubs /
 *     equipment; the plan's label / grade for a room is carried from the live
 *     `floorplan_rooms` row by code where the trace leaves it null, exactly as
 *     the draw scripts do;
 *   - a SNAPSHOT of the current readings and limits per instrument, through
 *     `buildTelemetryOverview()` — the one resolver the dashboard uses — taken
 *     once, timestamped, and frozen into the file;
 *   - a few DEMO overrides so each presentation page shows every status colour
 *     (out of limit, offline, sensor fault). They are listed in the file under
 *     `demoOverrides` and the pages label the snapshot as a sample.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prisma } from '../src/lib/prisma.js';
import { buildTelemetryOverview } from '../src/modules/instruments/telemetry-overview.js';
import type { ArchLayout } from '../src/modules/floorplans/architectural-layout.js';
import { QC2_BUILDING, QC2_ROOMS, QC2_ANNOTATIONS, QC2_PLAN_NAME, QC2_SOURCE } from '../src/modules/floorplans/qc-layout-2.js';
import { MICROBIOLOGY_LAYOUT } from '../src/modules/floorplans/microbiology-layout.js';
import { QC3_LAYOUT } from '../src/modules/floorplans/qc3-layout.js';
import { MODULE_E_LAYOUT } from '../src/modules/floorplans/module-e-layout.js';
import { MODULE_F_GROUND_LAYOUT, MODULE_F_FIRST_LAYOUT } from '../src/modules/floorplans/module-f-layout.js';

const OUT = resolve(import.meta.dirname, '../../../Layouts/presentation/data/layouts.js');

/** QC is drawn by its own script and is not an `ArchLayout`; shape it as one. */
const QC_LAYOUT: ArchLayout = {
  area: 'QC',
  planName: QC2_PLAN_NAME,
  source: QC2_SOURCE,
  building: QC2_BUILDING,
  rooms: QC2_ROOMS,
  annotations: QC2_ANNOTATIONS,
};

const FLOORS: { id: string; title: string; layout: ArchLayout }[] = [
  { id: 'qc', title: 'QC', layout: QC_LAYOUT },
  { id: 'microbiology', title: 'QC Microbiology', layout: MICROBIOLOGY_LAYOUT },
  { id: 'qc3', title: 'QC 3', layout: QC3_LAYOUT },
  { id: 'module-e', title: 'Module-E', layout: MODULE_E_LAYOUT },
  { id: 'module-f-ground', title: 'Module-F — Ground Floor', layout: MODULE_F_GROUND_LAYOUT },
  { id: 'module-f-first', title: 'Module-F — First Floor', layout: MODULE_F_FIRST_LAYOUT },
];

/**
 * Instruments forced into a demonstration state so every page shows every
 * colour. Chosen one per floor where possible. `null` for a reading = the slot
 * sends nothing; a string = the sensor sent that text (a fault).
 */
const DEMO_OVERRIDES: Record<string, { temperature?: number | string | null; humidity?: number | string | null; offline?: boolean; note: string }> = {
  'CWH/RDU/021-00': { temperature: 27.4, note: 'QC Dissolution Room-I: temperature above the high limit' },
  'CWH/RDU/016-00': { humidity: 66.2, note: 'QC Weighing Room: humidity above the high limit' },
  'CWH/RDU/014-00': { offline: true, note: 'QC GC Room: instrument not reporting' },
  'CWH/RDU/051-00': { temperature: 'NA', note: 'Microbiology Incubator Room-01: temperature probe fault' },
  'CWH/RDU/031-00': { offline: true, note: 'Module-E Blender Area: instrument not reporting' },
};

type Snapshot = {
  code: string;
  location: string | null;
  temperature: number | string | null;
  humidity: number | string | null;
  limits: { tempMin: number | null; tempMax: number | null; rhMin: number | null; rhMax: number | null };
  decimals: { temperature: number; humidity: number };
  reporting: boolean;
  status: string;
  demo?: string;
};

function statusOf(s: Snapshot): string {
  if (!s.reporting) return 'OFFLINE';
  const fault = typeof s.temperature === 'string' || typeof s.humidity === 'string';
  if (fault) return 'ERROR';
  const out = (v: number | string | null, lo: number | null, hi: number | null) =>
    typeof v === 'number' && ((lo !== null && v < lo) || (hi !== null && v > hi));
  if (out(s.temperature, s.limits.tempMin, s.limits.tempMax) || out(s.humidity, s.limits.rhMin, s.limits.rhMax)) return 'OUT_OF_SPEC';
  if (s.temperature === null && s.humidity === null) return 'NO_DATA';
  return 'OK';
}

async function main() {
  const rows = await buildTelemetryOverview();
  const byCode = new Map(rows.map((r) => [r.code, r]));

  const readings: Record<string, Snapshot> = {};
  for (const f of FLOORS) {
    for (const room of f.layout.rooms) {
      if (!room.instrument) continue;
      const r = byCode.get(room.instrument);
      if (!r) {
        console.warn(`no live instrument for ${room.instrument} (${f.title} / ${room.code}) — exporting as NO_DATA`);
        readings[room.instrument] = {
          code: room.instrument, location: room.label, temperature: null, humidity: null,
          limits: { tempMin: null, tempMax: null, rhMin: null, rhMax: null },
          decimals: { temperature: 1, humidity: 1 }, reporting: false, status: 'NO_DATA',
        };
        continue;
      }
      const snap: Snapshot = {
        code: r.code,
        location: r.locationAttribute,
        temperature: r.sensorError.temperature ? String(r.rawSlots.temperature?.value ?? 'NA') : (r.temperature?.value ?? null),
        humidity: r.sensorError.humidity ? String(r.rawSlots.humidity?.value ?? 'NA') : (r.humidity?.value ?? null),
        limits: r.limits ?? { tempMin: null, tempMax: null, rhMin: null, rhMax: null },
        decimals: r.decimals,
        reporting: r.reporting,
        status: r.status,
      };
      // A PRESENTATION snapshot: the last stored reading is shown as current
      // (the local sender is not running, so every instrument is "offline" by
      // the 3-minute window), and a slot with no reading at all is filled with
      // the midpoint of its limits so no card shows a blank — both marked.
      snap.reporting = true;
      const mid = (lo: number | null, hi: number | null, fallback: number) => (lo !== null && hi !== null ? Math.round(((lo + hi) / 2) * 10) / 10 : fallback);
      const filled: string[] = [];
      if (snap.temperature === null) { snap.temperature = mid(snap.limits.tempMin, snap.limits.tempMax, 22.5); filled.push('temperature'); }
      if (snap.humidity === null) { snap.humidity = mid(snap.limits.rhMin, snap.limits.rhMax, 45); filled.push('humidity'); }
      if (filled.length) snap.demo = `${filled.join(' and ')} filled for the demonstration (no stored reading)`;
      const demo = DEMO_OVERRIDES[r.code];
      if (demo) {
        if ('temperature' in demo) snap.temperature = demo.temperature ?? null;
        if ('humidity' in demo) snap.humidity = demo.humidity ?? null;
        if (demo.offline) snap.reporting = false;
        snap.demo = demo.note;
      }
      snap.status = statusOf(snap);
      readings[r.code] = snap;
    }
  }

  // Labels / grades the plan carries that the trace leaves null (Module-F's
  // lift lobby and the like), by plan name and room code — the draw scripts'
  // own rule.
  const plans = await prisma.floorplan.findMany({
    where: { name: { in: FLOORS.map((f) => f.layout.planName) } },
    select: { name: true, rooms: { select: { code: true, label: true, grade: true } } },
  });
  const planRooms = new Map(plans.map((p) => [p.name, new Map(p.rooms.map((r) => [r.code, r]))]));

  const floors = FLOORS.map((f) => {
    const stored = planRooms.get(f.layout.planName);
    return {
      id: f.id,
      title: f.title,
      area: f.layout.area,
      planName: f.layout.planName,
      source: f.layout.source,
      north: f.layout.north ?? null,
      floor: f.layout.floor ?? null,
      building: f.layout.building,
      rooms: f.layout.rooms.map((r) => {
        const s = stored?.get(r.code);
        return {
          code: r.code,
          label: r.label ?? s?.label ?? null,
          grade: r.grade ?? s?.grade ?? null,
          outline: r.outline,
          doors: r.doors,
          instrument: r.instrument ?? null,
          meta: r.meta ?? null,
        };
      }),
      annotations: {
        columns: f.layout.annotations.columns,
        windows: f.layout.annotations.windows,
        walls: f.layout.annotations.walls,
        equipment: f.layout.annotations.equipment ?? [],
        labels: f.layout.annotations.labels ?? [],
      },
    };
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    note: 'Sample snapshot of live readings taken at generatedAt; a few instruments are forced into demonstration states (see demoOverrides).',
    demoOverrides: Object.entries(DEMO_OVERRIDES).map(([code, d]) => ({ code, note: d.note })),
    floors,
    readings,
  };

  mkdirSync(resolve(OUT, '..'), { recursive: true });
  writeFileSync(OUT, `// Generated by apps/api/scripts/export-layout-models.ts — do not edit by hand.\nwindow.LAYOUT_MODELS = ${JSON.stringify(payload, null, 1)};\n`);
  const counts = floors.map((f) => `${f.title}: ${f.rooms.length} rooms, ${f.rooms.filter((r) => r.instrument).length} instruments`);
  console.log(`wrote ${OUT}\n  ${counts.join('\n  ')}\n  readings: ${Object.keys(readings).length}`);
  const states = Object.values(readings).reduce<Record<string, number>>((n, r) => ((n[r.status] = (n[r.status] ?? 0) + 1), n), {});
  console.log(`  statuses: ${JSON.stringify(states)}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
