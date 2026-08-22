import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { formatFileSize } from '@/lib/file-utils';
import type {
  NostrFileRelayStats,
  NostrFileTransferStats,
} from '@/lib/nostr-file';

/**
 * Detailed statistics for a Nostr file relay transfer (both roles): chunk and
 * byte totals, overhead versus the raw file, re-send counts, control-channel
 * traffic, and a per-relay breakdown. Values come from the live accumulator
 * in TransferState.stats, so the panel updates as the transfer runs and
 * freezes at its final values on completion.
 */
export function NostrRelayStatsPanel({
  stats,
}: {
  stats: NostrFileTransferStats;
}) {
  const [open, setOpen] = useState(false);

  const isSender = stats.role === 'sender';
  const ofFileSize = (bytes: number): string | null => {
    if (stats.fileBytes <= 0 || bytes <= 0) return null;
    const pct = (bytes / stats.fileBytes) * 100;
    return `${pct.toFixed(pct < 10 ? 1 : 0)}% of file size`;
  };
  // The one number people ask for: encoded chunks (whole-file deflate, then
  // AES-GCM + Z85 per chunk, one copy each) as a ratio of the original file,
  // with 100% = original — below 100% deflate shrank it more than Z85 grew
  // it, above 100% it grew.
  const encodedVsOriginal = (): string | null => {
    if (stats.fileBytes <= 0 || stats.encodedBytes <= 0) return null;
    const pct = (stats.encodedBytes / stats.fileBytes) * 100;
    return `${pct.toFixed(1)}% (100% = original size)`;
  };
  const ms = (value: number | undefined): string | null =>
    value === undefined ? null : `${(value / 1000).toFixed(1)}s`;

  const rows: [string, string | null][] = [
    ['Role', stats.role],
    ['File size', formatFileSize(stats.fileBytes)],
    [
      // Only shown when the whole-file deflate actually shrank the payload;
      // incompressible files travel as-is and the row would just repeat the
      // file size.
      'Compressed size',
      stats.payloadBytes > 0 && stats.payloadBytes < stats.fileBytes
        ? `${formatFileSize(stats.payloadBytes)} (${ofFileSize(stats.payloadBytes)})`
        : null,
    ],
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
        stats.encodedBytes > 0 ? formatFileSize(stats.encodedBytes) : null,
      ],
      ['Encoded vs original', encodedVsOriginal()],
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
      ['Chunks re-sent', String(stats.chunksResent)],
      ['Relays demoted', String(stats.relaysDemoted)],
    );
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
      ['Fetch cycles', String(stats.ackCycles)],
      ['Missing pieces reported', String(stats.missingReported)],
    );
  }

  rows.push([
    'Control messages',
    `${stats.controlSent} sent / ${stats.controlReceived} received`,
  ]);

  if (stats.relaysChecked > 0) {
    rows.push([
      'Relay discovery',
      `${stats.candidates} candidates, ${stats.relaysChecked} probed, ${stats.relaysHealthy} healthy`,
    ]);
  }

  const timings = [
    ['hash', ms(stats.phaseMs.hash)],
    ['compress', ms(stats.phaseMs.compress)],
    ['control probe', ms(stats.phaseMs.controlProbe)],
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
          <RelayList
            title="Signaling relays"
            relays={stats.relays.filter((r) => r.role === 'control')}
            isSender={isSender}
          />
          <RelayList
            title="Storage relays"
            relays={stats.relays.filter((r) => r.role === 'storage')}
            isSender={isSender}
          />
        </div>
      )}
    </div>
  );
}

function RelayList({
  title,
  relays,
  isSender,
}: {
  title: string;
  relays: NostrFileRelayStats[];
  isSender: boolean;
}) {
  if (relays.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="font-medium text-muted-foreground">
        {title} ({relays.length})
      </p>
      <ul className="space-y-1">
        {relays.map((relay) => (
          <li key={relay.url} className="text-muted-foreground">
            <p className="truncate" title={relay.url}>
              • {relay.url.replace('wss://', '')}
              {relay.demoted && (
                <span className="text-destructive"> (demoted)</span>
              )}
            </p>
            <p className="pl-3 tabular-nums">{relayDetail(relay, isSender)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function relayDetail(relay: NostrFileRelayStats, isSender: boolean): string {
  const parts: string[] = [];
  if (relay.rttMs !== undefined) parts.push(`probe ${relay.rttMs}ms`);
  if (relay.role === 'control') {
    // Both roles publish control messages; downstream control traffic is not
    // attributable per relay (the subscription pools all of them).
    parts.push(
      `${relay.eventsAccepted} messages / ${formatFileSize(relay.bytesUp)} up`,
    );
    const retries = relay.publishAttempts - relay.eventsAccepted;
    if (retries > 0) parts.push(`${retries} failed attempts`);
    if (relay.publishesFailed > 0)
      parts.push(`${relay.publishesFailed} given up`);
    return parts.join(' · ');
  }
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
