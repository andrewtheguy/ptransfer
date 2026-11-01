import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useT } from '@/i18n/locale-context';
import { formatFileSize } from '@/lib/file-utils';
import type {
  NostrFileRelayStats,
  NostrFileSeedProbe,
  NostrFileTransferStats,
} from '@/lib/nostr-file';

type Translate = ReturnType<typeof useT>;

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
  const t = useT();
  const [open, setOpen] = useState(false);

  const isSender = stats.role === 'sender';
  const ofFileSize = (bytes: number): string | null => {
    if (stats.fileBytes <= 0 || bytes <= 0) return null;
    const pct = (bytes / stats.fileBytes) * 100;
    const value = pct.toFixed(pct < 10 ? 1 : 0);
    return t({
      en: `${value}% of file size`,
      es: `${value}% del tamaño del archivo`,
    });
  };
  // The one number people ask for: encoded chunks (whole-file deflate, then
  // AES-GCM + Z85 per chunk, one copy each) as a ratio of the original file,
  // with 100% = original — below 100% deflate shrank it more than Z85 grew
  // it, above 100% it grew.
  const encodedVsOriginal = (): string | null => {
    if (stats.fileBytes <= 0 || stats.encodedBytes <= 0) return null;
    const pct = (stats.encodedBytes / stats.fileBytes) * 100;
    return t({
      en: `${pct.toFixed(1)}% (100% = original size)`,
      es: `${pct.toFixed(1)}% (100% = tamaño original)`,
    });
  };
  const ms = (value: number | undefined): string | null =>
    value === undefined ? null : `${(value / 1000).toFixed(1)}s`;

  const rows: [string, string | null][] = [
    [
      t({ en: 'Role', es: 'Rol' }),
      isSender
        ? t({ en: 'sender', es: 'emisor' })
        : t({ en: 'receiver', es: 'receptor' }),
    ],
    [
      t({ en: 'File size', es: 'Tamaño del archivo' }),
      formatFileSize(stats.fileBytes),
    ],
    [
      // Only shown when the whole-file deflate actually shrank the payload;
      // otherwise (generated ZIPs sent as-is, or deflate output that is not
      // smaller than the input) the row would not add useful information.
      t({ en: 'Compressed size', es: 'Tamaño comprimido' }),
      stats.payloadBytes > 0 && stats.payloadBytes < stats.fileBytes
        ? `${formatFileSize(stats.payloadBytes)} (${ofFileSize(stats.payloadBytes)})`
        : null,
    ],
    [
      t({ en: 'Chunks', es: 'Fragmentos' }),
      stats.chunksTotal > 0
        ? `${stats.chunksTotal} × ${formatFileSize(stats.chunkSize)}`
        : null,
    ],
  ];

  if (isSender) {
    rows.push(
      [
        t({ en: 'Encoded size', es: 'Tamaño codificado' }),
        stats.encodedBytes > 0 ? formatFileSize(stats.encodedBytes) : null,
      ],
      [
        t({ en: 'Encoded vs original', es: 'Codificado frente a original' }),
        encodedVsOriginal(),
      ],
      [
        t({ en: 'Published to relays', es: 'Publicado en los relays' }),
        stats.bytesPublished > 0
          ? t({
              en: `${formatFileSize(stats.bytesPublished)} in ${stats.eventsPublished} events (${ofFileSize(stats.bytesPublished)})`,
              es: `${formatFileSize(stats.bytesPublished)} en ${stats.eventsPublished} eventos (${ofFileSize(stats.bytesPublished)})`,
            })
          : null,
      ],
      [
        t({ en: 'Publish attempts', es: 'Intentos de publicación' }),
        stats.publishAttempts > 0
          ? `${stats.publishAttempts}${
              stats.publishesFailed > 0
                ? t({
                    en: ` (${stats.publishesFailed} gave up after retries)`,
                    es: ` (${stats.publishesFailed} abandonados tras reintentos)`,
                  })
                : ''
            }`
          : null,
      ],
      [
        t({ en: 'Chunks re-sent', es: 'Fragmentos reenviados' }),
        String(stats.chunksResent),
      ],
      [
        t({
          en: 'Storage relays demoted',
          es: 'Relays de almacenamiento degradados',
        }),
        String(stats.storageRelaysDemoted),
      ],
    );
  } else {
    rows.push(
      [
        t({ en: 'Downloaded from relays', es: 'Descargado de los relays' }),
        stats.bytesReceived > 0
          ? t({
              en: `${formatFileSize(stats.bytesReceived)} in ${stats.eventsReceived} events (${ofFileSize(stats.bytesReceived)})`,
              es: `${formatFileSize(stats.bytesReceived)} en ${stats.eventsReceived} eventos (${ofFileSize(stats.bytesReceived)})`,
            })
          : null,
      ],
      [
        t({ en: 'Relay queries', es: 'Consultas a relays' }),
        stats.queries > 0
          ? `${stats.queries}${
              stats.queryFailures > 0
                ? t({
                    en: ` (${stats.queryFailures} failed)`,
                    es: ` (${stats.queryFailures} fallidas)`,
                  })
                : ''
            }`
          : null,
      ],
      [
        t({
          en: 'Duplicate / corrupt events',
          es: 'Eventos duplicados / corruptos',
        }),
        `${stats.duplicateEvents} / ${stats.corruptEvents}`,
      ],
      [
        t({ en: 'Fetch cycles', es: 'Ciclos de descarga' }),
        String(stats.ackCycles),
      ],
      [
        t({
          en: 'Missing pieces reported',
          es: 'Fragmentos faltantes notificados',
        }),
        String(stats.missingReported),
      ],
    );
  }

  rows.push([
    t({ en: 'Control messages', es: 'Mensajes de control' }),
    t({
      en: `${stats.controlSent} sent / ${stats.controlReceived} received`,
      es: `${stats.controlSent} enviados / ${stats.controlReceived} recibidos`,
    }),
  ]);
  rows.push([
    t({
      en: 'Signaling relays swapped',
      es: 'Relays de señalización sustituidos',
    }),
    String(stats.controlRelaysDemoted),
  ]);

  if (stats.relaysChecked > 0) {
    rows.push([
      t({ en: 'Relay discovery', es: 'Descubrimiento de relays' }),
      t({
        en: `${stats.candidates} candidates, ${stats.relaysChecked} probed, ${stats.relaysHealthy} healthy`,
        es: `${stats.candidates} candidatos, ${stats.relaysChecked} sondeados, ${stats.relaysHealthy} en buen estado`,
      }),
    ]);
  }

  const timings = [
    [t({ en: 'hash', es: 'hash' }), ms(stats.phaseMs.hash)],
    [t({ en: 'compress', es: 'compresión' }), ms(stats.phaseMs.compress)],
    [
      t({ en: 'control probe', es: 'sondeo de control' }),
      ms(stats.phaseMs.controlProbe),
    ],
    [t({ en: 'discover', es: 'descubrimiento' }), ms(stats.phaseMs.discover)],
    [
      t({ en: 'health check', es: 'comprobación de estado' }),
      ms(stats.phaseMs.healthCheck),
    ],
    [
      isSender
        ? t({ en: 'upload', es: 'subida' })
        : t({ en: 'download', es: 'descarga' }),
      ms(stats.phaseMs.transfer),
    ],
  ].filter((entry): entry is [string, string] => entry[1] !== null);
  if (timings.length > 0) {
    rows.push([
      t({ en: 'Timings', es: 'Tiempos' }),
      timings.map(([k, v]) => `${k} ${v}`).join(', '),
    ]);
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
        <span>
          {t({
            en: 'Transfer statistics',
            es: 'Estadísticas de la transferencia',
          })}
        </span>
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
          <SeedProbeList probes={stats.seedProbes} />
          <RelayList
            title={t({ en: 'Signaling relays', es: 'Relays de señalización' })}
            relays={stats.relays.filter((r) => r.role === 'control')}
            isSender={isSender}
          />
          <RelayList
            title={t({
              en: 'Storage relays',
              es: 'Relays de almacenamiento',
            })}
            relays={stats.relays.filter((r) => r.role === 'storage')}
            isSender={isSender}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Every signaling seed the control probe was given, with its verdict. Unlike
 * the lists below it this is not a record of relays the transfer used: a seed
 * that failed carries no traffic and appears nowhere else, so naming the
 * failures here is the whole point — it answers "which of the pool still
 * works" without having to infer it from an absence.
 */
function SeedProbeList({ probes }: { probes: NostrFileSeedProbe[] }) {
  const t = useT();
  if (probes.length === 0) return null;
  const healthy = probes.filter((p) => typeof p.rttMs === 'number').length;
  return (
    <div className="space-y-1">
      <p className="font-medium text-muted-foreground">
        {t({
          en: `Signaling relay health (${healthy}/${probes.length} healthy)`,
          es: `Estado de los relays de señalización (${healthy}/${probes.length} en buen estado)`,
        })}
      </p>
      <ul className="space-y-0.5">
        {probes.map((probe) => (
          <li
            key={probe.url}
            className="flex justify-between gap-4 text-muted-foreground"
          >
            <span className="truncate" title={probe.url}>
              • {probe.url.replace('wss://', '')}
            </span>
            <span
              className={`shrink-0 tabular-nums ${
                probe.rttMs === null ? 'text-destructive' : ''
              }`}
            >
              {probe.rttMs === undefined
                ? t({ en: 'not probed', es: 'sin sondear' })
                : probe.rttMs === null
                  ? t({ en: 'failed', es: 'fallido' })
                  : t({
                      en: `healthy ${probe.rttMs}ms`,
                      es: `en buen estado ${probe.rttMs}ms`,
                    })}
            </span>
          </li>
        ))}
      </ul>
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
  const t = useT();
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
                <span className="text-destructive">
                  {t({ en: ' (demoted)', es: ' (degradado)' })}
                </span>
              )}
            </p>
            <p className="pl-3 tabular-nums">
              {relayDetail(relay, isSender, t)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function relayDetail(
  relay: NostrFileRelayStats,
  isSender: boolean,
  t: Translate,
): string {
  const parts: string[] = [];
  if (relay.rttMs !== undefined)
    parts.push(
      t({ en: `probe ${relay.rttMs}ms`, es: `sondeo ${relay.rttMs}ms` }),
    );
  const failedAttempts = (retries: number) =>
    t({
      en: `${retries} failed attempts`,
      es: `${retries} intentos fallidos`,
    });
  const givenUp = (count: number) =>
    t({ en: `${count} given up`, es: `${count} abandonados` });
  if (relay.role === 'control') {
    // Both roles publish control messages; downstream control traffic is not
    // attributable per relay (the subscription pools all of them).
    parts.push(
      t({
        en: `${relay.eventsAccepted} messages / ${formatFileSize(relay.bytesUp)} up`,
        es: `${relay.eventsAccepted} mensajes / ${formatFileSize(relay.bytesUp)} subidos`,
      }),
    );
    const retries = relay.publishAttempts - relay.eventsAccepted;
    if (retries > 0) parts.push(failedAttempts(retries));
    if (relay.publishesFailed > 0) parts.push(givenUp(relay.publishesFailed));
    return parts.join(' · ');
  }
  if (isSender) {
    parts.push(
      t({
        en: `${relay.eventsAccepted} events / ${formatFileSize(relay.bytesUp)} up`,
        es: `${relay.eventsAccepted} eventos / ${formatFileSize(relay.bytesUp)} subidos`,
      }),
    );
    const retries = relay.publishAttempts - relay.eventsAccepted;
    if (retries > 0) parts.push(failedAttempts(retries));
    if (relay.publishesFailed > 0) parts.push(givenUp(relay.publishesFailed));
    if (relay.missesReported > 0)
      parts.push(
        t({
          en: `${relay.missesReported} misses`,
          es: `${relay.missesReported} fallos de lectura`,
        }),
      );
  } else {
    parts.push(
      t({
        en: `${relay.chunksSupplied} chunks / ${formatFileSize(relay.bytesDown)} down`,
        es: `${relay.chunksSupplied} fragmentos / ${formatFileSize(relay.bytesDown)} descargados`,
      }),
    );
    if (relay.queryFailures > 0) {
      parts.push(
        t({
          en: `${relay.queryFailures}/${relay.queries} queries failed`,
          es: `${relay.queryFailures}/${relay.queries} consultas fallidas`,
        }),
      );
    }
    if (relay.corruptEvents > 0)
      parts.push(
        t({
          en: `${relay.corruptEvents} corrupt`,
          es: `${relay.corruptEvents} corruptos`,
        }),
      );
  }
  return parts.join(' · ');
}
