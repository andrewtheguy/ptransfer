import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { formatFileSize } from '@/lib/file-utils';
import type {
  NostrFileRelayStats,
  NostrFileTransferStats,
} from '@/lib/nostr-file';

/**
 * Detailed statistics for a Nostr file relay transfer (stored or live, both
 * roles): chunk and byte totals, overhead versus the raw file, retry/re-send
 * counts, control-channel traffic, and a per-relay breakdown. Values come
 * from the live accumulator in TransferState.stats, so the panel updates as
 * the transfer runs and freezes at its final values on completion.
 */
export function NostrRelayStatsPanel({
  stats,
}: {
  stats: NostrFileTransferStats;
}) {
  const [open, setOpen] = useState(false);

  const isSender = stats.role === 'sender';
  // Deflate can shrink well below the raw size, so a signed "overhead %"
  // turns negative and reads badly; "% of file size" is unambiguous in both
  // directions (6% for compressible data, ~250% for a stored upload).
  const ofFileSize = (bytes: number): string | null => {
    if (stats.fileBytes <= 0 || bytes <= 0) return null;
    const pct = (bytes / stats.fileBytes) * 100;
    return `${pct.toFixed(pct < 10 ? 1 : 0)}% of file size`;
  };
  const ms = (value: number | undefined): string | null =>
    value === undefined ? null : `${(value / 1000).toFixed(1)}s`;

  const rows: [string, string | null][] = [
    [
      'Method',
      `${stats.variant === 'live' ? 'Live, single copy' : 'Stored, two copies'} (${stats.role})`,
    ],
    ['File size', formatFileSize(stats.fileBytes)],
    [
      'Chunks',
      stats.chunksTotal > 0
        ? `${stats.chunksTotal} × ${formatFileSize(stats.chunkSize)}`
        : null,
    ],
  ];

  if (isSender) {
    rows.push(
      [
        'Encoded size',
        stats.encodedBytes > 0
          ? `${formatFileSize(stats.encodedBytes)} (${ofFileSize(stats.encodedBytes)})`
          : null,
      ],
      [
        'Published to relays',
        stats.bytesPublished > 0
          ? `${formatFileSize(stats.bytesPublished)} in ${stats.eventsPublished} events (${ofFileSize(stats.bytesPublished)})`
          : null,
      ],
      [
        'Publish attempts',
        stats.publishAttempts > 0
          ? `${stats.publishAttempts}${stats.publishesFailed > 0 ? ` (${stats.publishesFailed} gave up after retries)` : ''}`
          : null,
      ],
    );
    if (stats.variant === 'stored') {
      rows.push([
        'Fallback copies',
        stats.fallbackPublishes > 0 ? String(stats.fallbackPublishes) : '0',
      ]);
    } else {
      rows.push(
        ['Chunks re-sent', String(stats.chunksResent)],
        ['Relays demoted', String(stats.relaysDemoted)],
      );
    }
  } else {
    rows.push(
      [
        'Downloaded from relays',
        stats.bytesReceived > 0
          ? `${formatFileSize(stats.bytesReceived)} in ${stats.eventsReceived} events (${ofFileSize(stats.bytesReceived)})`
          : null,
      ],
      [
        'Relay queries',
        stats.queries > 0
          ? `${stats.queries}${stats.queryFailures > 0 ? ` (${stats.queryFailures} failed)` : ''}`
          : null,
      ],
      [
        'Duplicate / corrupt events',
        `${stats.duplicateEvents} / ${stats.corruptEvents}`,
      ],
    );
    if (stats.variant === 'stored') {
      rows.push(['Sweep passes', String(stats.sweepPasses)]);
    } else {
      rows.push(
        ['Fetch cycles', String(stats.ackCycles)],
        ['Missing pieces reported', String(stats.missingReported)],
      );
    }
  }

  if (stats.variant === 'live') {
    rows.push([
      'Control messages',
      `${stats.controlSent} sent / ${stats.controlReceived} received`,
    ]);
  }

  if (stats.relaysChecked > 0) {
    rows.push([
      'Relay discovery',
      `${stats.candidates} candidates, ${stats.relaysChecked} probed, ${stats.relaysHealthy} healthy`,
    ]);
  }

  const timings = [
    ['hash', ms(stats.phaseMs.hash)],
    ['discover', ms(stats.phaseMs.discover)],
    ['health check', ms(stats.phaseMs.healthCheck)],
    [isSender ? 'upload' : 'download', ms(stats.phaseMs.transfer)],
  ].filter((t): t is [string, string] => t[1] !== null);
  if (timings.length > 0) {
    rows.push(['Timings', timings.map(([k, v]) => `${k} ${v}`).join(', ')]);
  }

  return (
    <div className="text-xs space-y-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span>Transfer statistics</span>
      </button>
      {open && (
        <div className="pl-4 space-y-2">
          <dl className="space-y-0.5">
            {rows.map(([label, value]) =>
              value === null ? null : (
                <div key={label} className="flex justify-between gap-4">
                  <dt className="text-muted-foreground shrink-0">{label}</dt>
                  <dd className="text-right tabular-nums text-muted-foreground font-medium">
                    {value}
                  </dd>
                </div>
              ),
            )}
          </dl>
          {stats.relays.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium text-muted-foreground">
                Relays ({stats.relays.length}, placement order)
              </p>
              <ul className="space-y-1">
                {stats.relays.map((relay) => (
                  <li key={relay.url} className="text-muted-foreground">
                    <p className="truncate" title={relay.url}>
                      • {relay.url.replace('wss://', '')}
                      {relay.demoted && (
                        <span className="text-destructive"> (demoted)</span>
                      )}
                    </p>
                    <p className="pl-3 tabular-nums">
                      {relayDetail(relay, isSender)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function relayDetail(relay: NostrFileRelayStats, isSender: boolean): string {
  const parts: string[] = [];
  if (relay.rttMs !== undefined) parts.push(`probe ${relay.rttMs}ms`);
  if (isSender) {
    parts.push(
      `${relay.eventsAccepted} events / ${formatFileSize(relay.bytesUp)} up`,
    );
    const retries = relay.publishAttempts - relay.eventsAccepted;
    if (retries > 0) parts.push(`${retries} failed attempts`);
    if (relay.publishesFailed > 0)
      parts.push(`${relay.publishesFailed} given up`);
    if (relay.missesReported > 0) parts.push(`${relay.missesReported} misses`);
  } else {
    parts.push(
      `${relay.chunksSupplied} chunks / ${formatFileSize(relay.bytesDown)} down`,
    );
    if (relay.queryFailures > 0) {
      parts.push(`${relay.queryFailures}/${relay.queries} queries failed`);
    }
    if (relay.corruptEvents > 0) parts.push(`${relay.corruptEvents} corrupt`);
  }
  return parts.join(' · ');
}
