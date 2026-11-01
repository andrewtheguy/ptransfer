import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SectionContainer } from '@/components/section-container';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n/locale-context';
import type { Localized } from '@/lib/i18n';
import {
  ANONYMOUS_SIGNALING_RELAYS,
  DEFAULT_RELAYS,
  parseRelayInput,
  probeSignalingRelays,
  type RejectedRelayInput,
  type RelayCheck,
  type RelayProbeResult,
  type RelayProbeStep,
} from '@/lib/nostr';

type RelaySource = 'pool' | 'custom';

/**
 * Relay diagnostics: run what each transfer method actually asks of a relay,
 * and report the two verdicts separately.
 *
 * The pool is hardcoded in the source, so a relay that quietly dies stays in
 * it until somebody notices — and the failure it produces (a transfer that
 * never finds its peer) points nowhere near the cause. Worse, "working" is
 * not one question: the methods use different event kinds, and a relay can
 * serve one and refuse the other. This page answers both without having to
 * start a transfer to find out, for the shipped pool or for any relay typed
 * in — which is how a candidate gets vetted before it becomes a default.
 */
export function DebugPage() {
  const t = useT();
  const [source, setSource] = useState<RelaySource>('pool');
  const [input, setInput] = useState('');
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

  // Parsed as it is typed, so a typo is named before the probe runs rather
  // than by its absence from the results afterwards.
  const parsed = useMemo(() => parseRelayInput(input), [input]);
  const relays = source === 'pool' ? [...DEFAULT_RELAYS] : parsed.relays;

  const chooseSource = (next: RelaySource) => {
    setSource(next);
    // Verdicts belong to the set they were run against; leaving them on
    // screen under the other tab would attribute them to relays that were
    // never checked.
    setResults([]);
    setRanAt(null);
  };

  const run = useCallback(async (urls: string[]) => {
    setRunning(true);
    setResults([]);
    try {
      const probed = await probeSignalingRelays(urls);
      if (!mounted.current) return;
      setResults(probed);
      setRanAt(new Date());
    } finally {
      if (mounted.current) setRunning(false);
    }
  }, []);

  const pinPassed = results.filter((r) => r.pinExchange.passed).length;
  const codePassed = results.filter((r) => r.codeExchange.passed).length;
  const reported = results.length > 0 && !running;

  return (
    <SectionContainer className="space-y-6 py-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">
          {t({ en: 'Relay diagnostics', es: 'Diagnóstico de relays' })}
        </h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          {t({
            en: 'Checks a relay by doing what a transfer does, under a throwaway key. The two methods ask different things of a relay, so each gets its own verdict: PIN Exchange puts the peers in touch over the signaling kinds, while Code Exchange hand-carries its code and needs a relay only for the encrypted control channel its fallback runs over the chunk kind. A relay that merely opens its socket proves neither — plenty accept the connection and then refuse a kind, or acknowledge a write and never serve it back.',
            es: 'Comprueba un relay haciendo lo mismo que una transferencia, con una clave desechable. Los dos métodos piden cosas distintas a un relay, así que cada uno recibe su propio veredicto: el Intercambio por PIN pone en contacto a los dos extremos mediante los kinds de señalización, mientras que el Intercambio por código lleva su código a mano y solo necesita un relay para el canal de control cifrado sobre el que su respaldo funciona con el kind de fragmentos. Un relay que solo abre su socket no demuestra ninguna de las dos cosas: muchos aceptan la conexión y luego rechazan un kind, o confirman una escritura y nunca la devuelven.',
          })}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {t({ en: 'Signaling relays', es: 'Relays de señalización' })}
          </CardTitle>
          <CardDescription>
            {source === 'pool'
              ? t({
                  en: `${DEFAULT_RELAYS.length} relays in the clearnet pool`,
                  es: `${DEFAULT_RELAYS.length} relays en el grupo de la red abierta`,
                })
              : t({
                  en: 'Relays you enter, checked exactly the same way',
                  es: 'Los relays que introduzcas, comprobados exactamente igual',
                })}
            {reported
              ? t({
                  en: ` · ${pinPassed} carry PIN Exchange · ${codePassed} carry Code Exchange`,
                  es: ` · ${pinPassed} admiten el Intercambio por PIN · ${codePassed} admiten el Intercambio por código`,
                })
              : ''}
            {ranAt && !running
              ? t({
                  en: ` · checked ${ranAt.toLocaleTimeString()}`,
                  es: ` · comprobado a las ${ranAt.toLocaleTimeString()}`,
                })
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs
            value={source}
            onValueChange={(value) => chooseSource(value as RelaySource)}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="pool" disabled={running}>
                {t({ en: 'Default pool', es: 'Grupo predeterminado' })}
              </TabsTrigger>
              <TabsTrigger value="custom" disabled={running}>
                {t({ en: 'Custom relays', es: 'Relays personalizados' })}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="pool" className="mt-3">
              <ul className="space-y-1 text-sm text-muted-foreground">
                {DEFAULT_RELAYS.map((url) => (
                  <li key={url}>• {url.replace('wss://', '')}</li>
                ))}
              </ul>
            </TabsContent>

            <TabsContent value="custom" className="mt-3 space-y-3">
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={'relay.example.com\nwss://another.example.com'}
                rows={3}
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
                aria-label={t({
                  en: 'Relay URLs to check',
                  es: 'URL de los relays que comprobar',
                })}
              />
              <p className="text-xs text-muted-foreground">
                {t({
                  en: (
                    <>
                      One per line, or separated by spaces or commas; the{' '}
                      <code>wss://</code> is optional. Every entry is normalized
                      the way the app normalizes any relay list, so what gets
                      checked is what a transfer would actually connect to.
                    </>
                  ),
                  es: (
                    <>
                      Uno por línea, o separados por espacios o comas; el{' '}
                      <code>wss://</code> es opcional. Cada entrada se normaliza
                      igual que la aplicación normaliza cualquier lista de
                      relays, así que lo que se comprueba es exactamente a lo
                      que se conectaría una transferencia.
                    </>
                  ),
                })}
              </p>
              {parsed.rejected.length > 0 && (
                <RejectedList rejected={parsed.rejected} />
              )}
            </TabsContent>
          </Tabs>

          <Button
            onClick={() => void run(relays)}
            disabled={running || relays.length === 0}
          >
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t({ en: 'Checking relays…', es: 'Comprobando relays…' })}
              </>
            ) : (
              t(checkLabel(source, relays.length))
            )}
          </Button>

          {results.length > 0 && (
            <ul className="space-y-5">
              {results.map((result) => (
                <RelayResult key={result.url} result={result} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {t({
              en: 'Anonymous signaling relays',
              es: 'Relays de señalización anónimos',
            })}
          </CardTitle>
          <CardDescription>
            {t({
              en: `${ANONYMOUS_SIGNALING_RELAYS.length} onion services · not checked here`,
              es: `${ANONYMOUS_SIGNALING_RELAYS.length} servicios onion · no se comprueban aquí`,
            })}
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

function checkLabel(source: RelaySource, count: number): Localized<string> {
  if (source === 'pool' || count === 0) {
    return { en: 'Check relays', es: 'Comprobar relays' };
  }
  return count === 1
    ? { en: 'Check 1 relay', es: 'Comprobar 1 relay' }
    : { en: `Check ${count} relays`, es: `Comprobar ${count} relays` };
}

/**
 * What the input box refused, and why. Dropping an entry in silence is the
 * exact confusion this page exists to cure: someone would type a relay, watch
 * it not appear, and have no way to tell a URL the app rejected from a relay
 * that failed its probe.
 */
function RejectedList({ rejected }: { rejected: RejectedRelayInput[] }) {
  return (
    <ul className="space-y-1 text-xs">
      {rejected.map((entry) => (
        <li key={entry.raw} className="flex gap-2 text-destructive">
          <XCircle className="h-3.5 w-3.5 shrink-0 translate-y-0.5" />
          <span className="break-all">
            <span className="font-mono">{entry.raw}</span> — {entry.reason}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RelayResult({ result }: { result: RelayProbeResult }) {
  const t = useT();
  const usable = result.pinExchange.passed || result.codeExchange.passed;
  return (
    <li className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="flex items-center gap-2 text-sm font-medium">
          {usable ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600 dark:text-green-500" />
          ) : (
            <XCircle className="h-4 w-4 shrink-0 text-destructive" />
          )}
          <span className="break-all">{result.url.replace('wss://', '')}</span>
        </span>
        {!usable && (
          <span className="shrink-0 text-sm text-destructive">
            {t({ en: 'unusable', es: 'inutilizable' })}
          </span>
        )}
      </div>
      <ul className="pl-6 space-y-0.5 text-xs text-muted-foreground">
        <StepRow step={result.connect} />
      </ul>
      <CheckBlock check={result.pinExchange} />
      <CheckBlock check={result.codeExchange} />
    </li>
  );
}

function CheckBlock({ check }: { check: RelayCheck }) {
  const t = useT();
  return (
    <div className="pl-6 space-y-0.5">
      <div className="flex items-baseline justify-between gap-4 text-xs font-medium">
        <span>{check.label}</span>
        <span
          className={`shrink-0 tabular-nums ${
            check.passed
              ? 'text-green-600 dark:text-green-500'
              : 'text-destructive'
          }`}
        >
          {check.passed
            ? t({
                en: `passes · ${check.rttMs}ms`,
                es: `funciona · ${check.rttMs}ms`,
              })
            : t({ en: 'fails', es: 'falla' })}
        </span>
      </div>
      <ul className="pl-4 space-y-0.5 text-xs text-muted-foreground">
        {check.steps.map((step) => (
          <StepRow key={step.label} step={step} />
        ))}
      </ul>
    </div>
  );
}

function StepRow({ step }: { step: RelayProbeStep }) {
  return (
    <li className="flex justify-between gap-4">
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
  );
}

function stepMark(step: RelayProbeStep): string {
  if (step.status === 'ok') return '✓';
  if (step.status === 'failed') return '✗';
  return '–';
}
