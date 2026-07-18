import { useEffect, useState } from 'react';
import { onSyncEvent, type SyncEvent, type SyncStage } from '@/lib/sync-engine';

interface ConnectivityRibbonProps {
  /** From useOffline().online — capacitor-aware connectivity state */
  online: boolean;
  /** From useOffline().pendingCount — queued operations awaiting sync */
  pendingCount: number;
  /** From useOffline().syncing — currently mid-drain */
  syncing: boolean;
}

/**
 * W6 (offline-safety series): always-visible status ribbon at the top of the
 * mobile shell. Three color states:
 *
 *   green   — online + nothing pending + not syncing
 *   red     — offline (with pending count if any)
 *   orange  — syncing (with stage label from W5 sync-engine events)
 *
 * Subscribes to the sync-engine W5 stage events for the orange-state label.
 * Falls back to a generic "Syncing…" string when no stage info has arrived
 * yet (very first event of a drain).
 *
 * Mounted only on the mobile shell (`/m/*` via mobile-wrapper.tsx). Desktop
 * users have other connectivity affordances (pending-count banner in
 * filter-operations.tsx, header status, etc.) and don't need the ribbon
 * taking up vertical space.
 */
export function ConnectivityRibbon({ online, pendingCount, syncing }: ConnectivityRibbonProps) {
  const [stage, setStage] = useState<SyncStage>('idle');
  const [stageDetail, setStageDetail] = useState<{ current?: number; total?: number; message?: string }>({});
  // `needs-reauth` is sticky: once the sync engine reports a missing/expired
  // grant, the ribbon should keep warning until the next successful drain
  // clears it (`complete` or `start` resets). Without this, the warning was
  // overwritten on the next 'idle' stage emit and operators saw nothing —
  // exactly the silent-stuck-queue bug reported 2026-05-25.
  const [reauthNeeded, setReauthNeeded] = useState<{ pendingCount: number } | null>(null);

  useEffect(() => {
    const unsub = onSyncEvent((evt: SyncEvent) => {
      if (evt.type === 'stage') {
        setStage(evt.stage);
        setStageDetail({ current: evt.current, total: evt.total, message: evt.message });
      } else if (evt.type === 'complete' || evt.type === 'start') {
        setStage('idle');
        setStageDetail({});
        if (evt.type === 'complete') setReauthNeeded(null);
      } else if (evt.type === 'error' || evt.type === 'interrupted') {
        setStage('idle');
        setStageDetail({});
      } else if (evt.type === 'needs-reauth') {
        setReauthNeeded({ pendingCount: evt.pendingCount });
        setStage('idle');
      }
    });
    return unsub;
  }, []);

  // Decide which color state we're in. Reauth wins over everything else
  // (it's the only state requiring a user action to recover) — order matters:
  // reauth → syncing → offline → online.
  let color: 'green' | 'red' | 'orange' | 'purple';
  let label: string;
  let sublabel: string | null = null;

  if (reauthNeeded && (pendingCount > 0 || reauthNeeded.pendingCount > 0)) {
    color = 'purple';
    label = 'Re-login to sync';
    const n = Math.max(pendingCount, reauthNeeded.pendingCount);
    sublabel = `${n} operation${n === 1 ? '' : 's'} stuck — log out and log back in to mint a fresh sync grant`;
  } else if (syncing || (stage !== 'idle' && online)) {
    color = 'orange';
    label = stageToLabel(stage, stageDetail);
    sublabel = stageDetail.message ?? null;
  } else if (!online) {
    color = 'red';
    label = 'Offline';
    sublabel = pendingCount > 0 ? `${pendingCount} operation${pendingCount === 1 ? '' : 's'} queued` : null;
  } else {
    color = 'green';
    label = pendingCount > 0 ? `Online — ${pendingCount} pending` : 'Online';
    sublabel = null;
  }

  const palette = {
    green: 'bg-emerald-500 text-white',
    red: 'bg-red-500 text-white',
    orange: 'bg-amber-500 text-white',
    purple: 'bg-purple-600 text-white',
  }[color];

  const dotPalette = {
    green: 'bg-emerald-200',
    red: 'bg-red-200',
    orange: 'bg-amber-200',
    purple: 'bg-purple-200',
  }[color];

  return (
    <div
      className={`sticky top-0 z-40 ${palette} text-xs font-medium flex items-center gap-2 px-3 py-1.5 shadow-sm`}
      role="status"
      aria-live="polite"
    >
      <span
        className={`inline-block w-2 h-2 rounded-full ${dotPalette} ${color === 'orange' || color === 'purple' ? 'animate-pulse' : ''}`}
      />
      <span className="font-semibold">{label}</span>
      {sublabel && <span className="opacity-90 truncate">— {sublabel}</span>}
    </div>
  );
}

function stageToLabel(stage: SyncStage, detail: { current?: number; total?: number }): string {
  switch (stage) {
    case 'token-refresh':
      return 'Connecting…';
    case 'tombstone-drain':
      return 'Sending deletions…';
    case 'sending-ops': {
      const c = detail.current ?? 0;
      const t = detail.total ?? 0;
      if (t > 0) return `Syncing operation ${c}/${t}…`;
      return 'Syncing operations…';
    }
    case 'fetching-snapshot':
      return 'Refreshing data…';
    case 'idle':
    default:
      return 'Syncing…';
  }
}
