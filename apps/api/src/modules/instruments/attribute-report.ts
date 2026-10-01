import { randomUUID } from 'node:crypto';
import { offsetKeyTest } from './load-offsets.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { parsePayload } from './payload-parser.js';
import { fanoutDevices } from './gateway-fanout.js';
import { childMapFor } from './gateway-children.js';
import { publishAttributeDownlink, type PublishLogger } from './attribute-downlink.js';
import { announceChildAttributeChange } from './child-attributes-bundle.js';
import type { IngestIdentity } from './ingest-auth.js';

/**
 * ATTRIBUTE REPORT — the device → platform attribute path (operator,
 * 2026-09-05: *"create two topics for attributes, one will i publish one will
 * i receive"*). The receive side is the bundle (`child-attributes-bundle.ts`);
 * this is the publish side:
 *
 *   instruments/<code>/attributes/report
 *
 * The payload is the TELEMETRY batch's shape, with attribute values where the
 * readings would be — a flat object for the instrument's own attributes, a
 * `devices` list (or a flat block naming a child under `devN`) from a gateway
 * for its children. Same parser, same fan-out, same child-map authorisation:
 * a gateway writes only for its own linked children.
 *
 * ── What makes a device write different from a person's ──
 * An attribute is a governed §11 record: in the app a change needs the role's
 * edit right, a reason and a signature, and lands in the audit trail against a
 * person. A device has none of those. So:
 *  - every accepted write is audited as `INSTRUMENT_ATTRIBUTE_REPORTED` (a
 *    system action — no user) with the reporting device's code in the row and
 *    a fixed reason, so the trail says a device did it and which one;
 *  - an UNCHANGED value is not written and not audited — firmware re-reporting
 *    its configuration every minute must not fill the hash chain with rows
 *    that record nothing;
 *  - the keys a device may write are ADMINISTERED (`instrument-attributes` →
 *    Device-writable attribute keys). Blank means any key, which is what the
 *    operator asked for; a refused key is dead-lettered, never silently
 *    dropped, so the firmware author can see it.
 *  - the role-based edit gate is NOT consulted — a device is not a role. The
 *    allow-list is the control that stands in for it.
 *
 * After the commit the same downlink slots a person's edit republishes are
 * republished here — the per-child slot and the gateway's bundle — so the
 * device reads back exactly what the platform now holds.
 */

export type AttributeReportOutcome =
  | { ok: true; written: number; unchanged: number; refused: number }
  | { ok: false; code: 'UNPARSEABLE' | 'NOT_A_GATEWAY'; message: string };

/** `null` = any key. */
export async function loadDeviceWritableKeys(): Promise<Set<string> | null> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'instrument-attributes' } });
  const raw = (row?.configValue as Record<string, unknown> | null)?.deviceWritableKeys;
  return parseWritableKeys(raw);
}

/** Pure: the textarea's lines, trimmed, blanks dropped; nothing usable = any key. */
export function parseWritableKeys(raw: unknown): Set<string> | null {
  if (typeof raw !== 'string') return null;
  const keys = raw.split(/\r?\n/).map((k) => k.trim()).filter(Boolean);
  return keys.length ? new Set(keys) : null;
}

/** A device value as the STRING an attribute holds. Objects are serialised;
 *  nothing here guesses a type, because the attribute column is text. */
export function attributeValueOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Pure: split a block's keys into the ones a device may write and the rest. */
export function splitWritable(
  entries: Iterable<[string, unknown]>,
  allow: Set<string> | null,
): { accepted: [string, string][]; refused: string[] } {
  const accepted: [string, string][] = [];
  const refused: string[] = [];
  for (const [rawKey, v] of entries) {
    const key = rawKey.trim();
    if (!key) continue;
    const value = attributeValueOf(v);
    if (value === null) continue;
    if (allow && !allow.has(key)) { refused.push(key); continue; }
    accepted.push([key, value]);
  }
  return { accepted, refused };
}

/** `signature_meaning` is VARCHAR(255); a long code or key must not roll the
 *  write back (the trap recorded on 2026-09-04). Clamped in the sentence only. */
const clamp = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

async function deadLetter(instrumentId: string, reason: string, raw: Buffer): Promise<void> {
  try {
    await prisma.deadLetter.create({
      data: { id: randomUUID(), instrumentId, transport: 'mqtt', reason, rawPayload: raw.toString('utf8').slice(0, 4000) },
    });
  } catch { /* a dead-letter failure must not take the report down */ }
}

export async function ingestAttributeReport(input: {
  identity: IngestIdentity;
  raw: Buffer;
  log?: PublishLogger;
}): Promise<AttributeReportOutcome> {
  const { identity, raw } = input;
  const parsed = parsePayload(raw);
  if (!parsed.ok) {
    await deadLetter(identity.id, `Attribute report: ${parsed.reason ?? 'unparseable'}`, raw);
    return { ok: false, code: 'UNPARSEABLE', message: parsed.reason ?? 'Unknown parse failure' };
  }
  const ts = parsed.ts ?? new Date();

  // Which instrument(s) each block is for — the telemetry rules exactly.
  const devN = parsed.values.devN;
  const devices = parsed.devices
    ?? (identity.isGateway && typeof devN === 'string' && devN.length > 0 ? { dev1: parsed.values } : null);

  const perInstrument = new Map<string, Map<string, unknown>>();
  if (devices) {
    if (!identity.isGateway) {
      await deadLetter(identity.id, 'Attribute report with a devices block from an instrument that is not a gateway', raw);
      return { ok: false, code: 'NOT_A_GATEWAY', message: `Instrument "${identity.code}" is not a gateway.` };
    }
    const { readings, rejected } = fanoutDevices(devices, await childMapFor(identity.id), ts, identity.code);
    for (const r of rejected.slice(0, 20)) await deadLetter(identity.id, `Attribute report: ${r.reason}`, raw);
    for (const r of readings) {
      const m = perInstrument.get(r.instrumentId) ?? new Map<string, unknown>();
      m.set(r.key, r.value);
      perInstrument.set(r.instrumentId, m);
    }
  } else {
    perInstrument.set(identity.id, new Map(Object.entries(parsed.values)));
  }

  const allow = await loadDeviceWritableKeys();
  const targets = await prisma.instrument.findMany({
    where: { id: { in: [...perInstrument.keys()] } },
    select: { id: true, code: true, gatewayId: true, gateway: { select: { code: true } } },
  });

  let written = 0;
  let unchanged = 0;
  let refused = 0;

  for (const target of targets) {
    // A device may never set its own sensor offset (2026-10-01) — refused like
    // a key outside the writable list, and dead-lettered by name the same way.
    const isOffset = await offsetKeyTest();
    const split = splitWritable(perInstrument.get(target.id)!.entries(), allow);
    const accepted = split.accepted.filter(([k]) => !isOffset(k));
    const refusedKeys = [...split.refused, ...split.accepted.filter(([k]) => isOffset(k)).map(([k]) => k)];
    for (const key of refusedKeys) {
      refused++;
      await deadLetter(identity.id, `Attribute report: "${key}" is not a device-writable attribute key (Configuration → Instrument Attributes)`, raw);
    }
    const changed: [string, string][] = [];
    await prisma.$transaction(async (tx) => {
      for (const [key, value] of accepted) {
        const before = await tx.instrumentAttribute.findUnique({
          where: { instrumentId_key: { instrumentId: target.id, key } },
        });
        if (before && before.value === value) { unchanged++; continue; }
        await tx.instrumentAttribute.upsert({
          where: { instrumentId_key: { instrumentId: target.id, key } },
          create: { instrumentId: target.id, key, value },
          update: { value },
        });
        await auditLog({
          action: 'INSTRUMENT_ATTRIBUTE_REPORTED', targetType: 'Instrument', targetId: target.id,
          beforeValue: { code: target.code, attribute: key, value: before?.value ?? null },
          afterValue: { code: target.code, attribute: key, value, reportedBy: identity.code, transport: 'mqtt' },
          reason: `Reported by device "${identity.code}" over MQTT`,
          signatureMeaning: `Attribute "${clamp(key)}" on instrument "${clamp(target.code)}" reported by device "${clamp(identity.code)}"`,
        }, tx);
        changed.push([key, value]);
        written++;
      }
    });
    if (changed.length === 0) continue;

    // The device reads back what the platform now holds: the per-instrument
    // slot (retained, one message per changed key, each carrying the COMPLETE
    // set), and — for a child — the gateway's CHANGE event, once per key.
    const rows = await prisma.instrumentAttribute.findMany({ where: { instrumentId: target.id }, select: { key: true, value: true } });
    const attributes = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    for (const [key, value] of changed) {
      await publishAttributeDownlink({
        code: target.code, gatewayCode: target.gateway?.code ?? null, attributes,
        changedKey: key, changedValue: value, ts: new Date(),
      }, input.log);
      if (target.gatewayId) {
        await announceChildAttributeChange(target.gatewayId, { code: target.code, key, value }, input.log);
      }
    }
  }
  return { ok: true, written, unchanged, refused };
}
