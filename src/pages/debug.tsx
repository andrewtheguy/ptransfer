import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SectionContainer } from '@/components/section-container';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  ANONYMOUS_SIGNALING_RELAYS,
  DEFAULT_RELAYS,
  EVENT_KIND_DATA_TRANSFER,
  EVENT_KIND_RENDEZVOUS,
  probeSignalingRelays,
  type RelayProbeResult,
  type RelayProbeStep,
} from '@/lib/nostr';

/**
 * Relay diagnostics: run the real signaling round trip against every relay in
 * the clearnet pool and say which ones work.
 *
 * The pool is hardcoded in the source, so a relay that quietly dies stays in
 * it until somebody notices — and the failure it produces (a transfer that
 * never finds its peer) points nowhere near the cause. This page turns that
 * into a direct answer, without having to start a transfer to get one.
 */
export function DebugPage() {
  const [results, setResults] = useState<RelayProbeResult[]>([]);
  const [running, setRunning] = useState(false);
  const [ranAt, setRanAt] = useState<Date | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setResults([]);
    try {
      const probed = await probeSignalingRelays(DEFAULT_RELAYS);
      if (!mounted.current) return;
      setResults(probed);
      setRanAt(new Date());
    } finally {
      if (mounted.current) setRunning(false);
    }
  }, []);

  const healthy = results.filter((result) => result.healthy).length;

  return (
    <SectionContainer className="space-y-6 py-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Relay diagnostics</h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Checks every relay in the signaling pool by doing what a transfer
          does: publish a kind-{EVENT_KIND_RENDEZVOUS} rendezvous and a kind-
          {EVENT_KIND_DATA_TRANSFER} handshake under a throwaway key, then read
          the rendezvous back. A relay that only opens its socket is not enough
          — plenty accept the connection and then refuse the event kinds
          signaling needs, or acknowledge a write and never serve it.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Signaling relays</CardTitle>
          <CardDescription>
            {DEFAULT_RELAYS.length} relays in the clearnet pool
            {results.length > 0 && !running
              ? ` · ${healthy} of ${results.length} healthy`
              : ''}
            {ranAt && !running
              ? ` · checked ${ranAt.toLocaleTimeString()}`
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={() => void run()} disabled={running}>
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Checking relays…
              </>
            ) : (
              'Check relays'
            )}
          </Button>

          {results.length === 0 && !running ? (
            <ul className="space-y-1 text-sm text-muted-foreground">
              {DEFAULT_RELAYS.map((url) => (
                <li key={url}>• {url.replace('wss://', '')}</li>
              ))}
            </ul>
          ) : null}

          {results.length > 0 && (
            <ul className="space-y-3">
              {results.map((result) => (
                <RelayResult key={result.url} result={result} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Anonymous signaling relays</CardTitle>
          <CardDescription>
            {ANONYMOUS_SIGNALING_RELAYS.length} onion services · not checked
            here
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {ANONYMOUS_SIGNALING_RELAYS.map((url) => (
              <li key={url} className="break-all">
                • {url.replace('ws://', '')}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </SectionContainer>
  );
}

function RelayResult({ result }: { result: RelayProbeResult }) {
  return (
    <li className="space-y-1">
      <div className="flex items-baseline justify-between gap-4">
        <span className="flex items-center gap-2 text-sm font-medium">
          {result.healthy ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600 dark:text-green-500" />
          ) : (
            <XCircle className="h-4 w-4 shrink-0 text-destructive" />
          )}
          <span className="break-all">{result.url.replace('wss://', '')}</span>
        </span>
        <span
          className={`shrink-0 text-sm tabular-nums ${
            result.healthy ? 'text-muted-foreground' : 'text-destructive'
          }`}
        >
          {result.healthy ? `healthy · ${result.rttMs}ms` : 'unusable'}
        </span>
      </div>
      <ul className="pl-6 space-y-0.5 text-xs text-muted-foreground">
        {result.steps.map((step) => (
          <li key={step.label} className="flex justify-between gap-4">
            <span>
              {stepMark(step)} {step.label}
            </span>
            {step.detail && (
              <span
                className={`shrink-0 text-right tabular-nums ${
                  step.status === 'failed' ? 'text-destructive' : ''
                }`}
              >
                {step.detail}
              </span>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

function stepMark(step: RelayProbeStep): string {
  if (step.status === 'ok') return '✓';
  if (step.status === 'failed') return '✗';
  return '–';
}
