import type { ParseArgsOptionsConfig } from 'node:util';
import { type Localized, t } from '@/lib/i18n';
import {
  type BridgeSetup,
  bridgeOptions,
  type CustomBridge,
  DEFAULT_TOR_BRIDGE,
  TOR_BRIDGE_LABELS,
  TOR_BRIDGES,
  type TorBridge,
} from '@/lib/tor/bridge';
import type { DirectoryDescription, WebtorClient } from '@/lib/tor/webtor-api';
import { UsageError } from '../usage';
import { loadRtcPeerConnection } from '../webrtc';
import { fetchDirectorySeed } from './directory-fetch';
import { openDirectoryStore } from './directory-store';
import { loadWebtor } from './webtor';

/**
 * Bootstrapping the Tor client for one command, the way every Tor command
 * does it:
 *
 * 1. Load the Tor client — the same wasm the browser tab runs.
 * 2. Get a directory: the seed cached from the last run if it still
 *    describes the network, otherwise a fresh one over plain HTTP from the
 *    authorities, which is the fast path a browser does not have.
 * 3. Bootstrap over the Snowflake bridge the command chose, the same two the
 *    tab offers.
 *
 * The browser's counterpart is `bootstrapTorClient` in `src/lib/tor/client.ts`;
 * the two differ in where the directory comes from and goes to, and in where
 * the `webrtc` bridge's `RTCPeerConnection` comes from.
 */

/** The flags every Tor command takes, for `parseArgs`. */
export const TOR_OPTIONS = {
  'refresh-directory': { type: 'boolean', default: false },
  'cache-dir': { type: 'string' },
  bridge: { type: 'string', default: DEFAULT_TOR_BRIDGE },
  'bridge-url': { type: 'string' },
  'bridge-fingerprint': { type: 'string' },
} as const satisfies ParseArgsOptionsConfig;

/** Their help text, for a command's usage. */
export const TOR_OPTIONS_USAGE: Localized = {
  en: `  --refresh-directory      ignore the cached directory and download a fresh one
  --cache-dir <path>       where to keep the Tor directory and the relay cache
                           (default: ~/Library/Caches/ptransfer on macOS,
                           %LOCALAPPDATA%\\ptransfer\\cache on Windows,
                           otherwise $XDG_CACHE_HOME/ptransfer or
                           ~/.cache/ptransfer)
  --bridge <websocket|webrtc>
                           how to reach the Tor network (default ${DEFAULT_TOR_BRIDGE}):
                           websocket connects straight to one fixed Snowflake
                           bridge and is the faster; webrtc goes through a
                           volunteer proxy the Snowflake broker assigns, which
                           is harder to block
  --bridge-url <ws://...>  a Snowflake bridge to use instead of the public one,
                           with --bridge websocket; requires --bridge-fingerprint
  --bridge-fingerprint <hex>`,
  es: `  --refresh-directory      ignora el directorio en caché y descarga uno nuevo
  --cache-dir <path>       dónde guardar el directorio de Tor y la caché de
                           relays (por defecto: ~/Library/Caches/ptransfer en
                           macOS, %LOCALAPPDATA%\\ptransfer\\cache en Windows,
                           y si no, $XDG_CACHE_HOME/ptransfer o
                           ~/.cache/ptransfer)
  --bridge <websocket|webrtc>
                           cómo llegar a la red Tor (por defecto ${DEFAULT_TOR_BRIDGE}):
                           websocket se conecta directamente a un puente
                           Snowflake fijo y es el más rápido; webrtc pasa por
                           un proxy voluntario que asigna el broker de
                           Snowflake, más difícil de bloquear
  --bridge-url <ws://...>  un puente Snowflake en lugar del público, con
                           --bridge websocket; requiere --bridge-fingerprint
  --bridge-fingerprint <hex>`,
};

export interface TorOptions {
  refreshDirectory: boolean;
  cacheDir?: string;
  bridge: TorBridge;
  /** A `websocket` bridge other than the public one. */
  customBridge?: CustomBridge;
}

function isTorBridge(value: string): value is TorBridge {
  return (TOR_BRIDGES as readonly string[]).includes(value);
}

/** The parsed flags as options, checked for consistency. */
export function torOptionsFrom(values: {
  'refresh-directory'?: boolean;
  'cache-dir'?: string;
  bridge?: string;
  'bridge-url'?: string;
  'bridge-fingerprint'?: string;
}): TorOptions {
  const bridge = values.bridge ?? DEFAULT_TOR_BRIDGE;
  if (!isTorBridge(bridge)) {
    throw new UsageError(
      t({
        en: `--bridge must be ${TOR_BRIDGES.join(' or ')}, not ${JSON.stringify(bridge)}`,
        es: `--bridge debe ser ${TOR_BRIDGES.join(' o ')}, no ${JSON.stringify(bridge)}`,
      }),
    );
  }
  const url = values['bridge-url'];
  const fingerprint = values['bridge-fingerprint'];
  if (Boolean(url) !== Boolean(fingerprint)) {
    throw new UsageError(
      t({
        en: 'Give --bridge-url and --bridge-fingerprint together, or neither',
        es: 'Indica --bridge-url y --bridge-fingerprint juntos, o ninguno',
      }),
    );
  }
  if (bridge === 'webrtc' && url) {
    throw new UsageError(
      t({
        en:
          '--bridge-url and --bridge-fingerprint apply to --bridge websocket only: ' +
          'the webrtc bridge reaches the public bridge through a volunteer proxy',
        es:
          '--bridge-url y --bridge-fingerprint solo valen con --bridge websocket: ' +
          'el puente webrtc llega al puente público a través de un proxy voluntario',
      }),
    );
  }
  return {
    refreshDirectory: values['refresh-directory'] ?? false,
    cacheDir: values['cache-dir'],
    bridge,
    ...(url && fingerprint ? { customBridge: { url, fingerprint } } : {}),
  };
}

export interface BootstrapOptions extends TorOptions {
  /** Progress, one line at a time. */
  say: (line: string) => void;
  /**
   * Whether the Tor client's own log lines are worth showing. Warnings and
   * errors always are.
   */
  verbose: boolean;
  /** Called as each stage completes, for a command that times them. */
  onLap?: (label: string) => void;
}

/**
 * Bootstrap a Tor client. Resolves once it has a Tor channel and a directory;
 * it has reached nothing at that point. The caller owns the client and must
 * `close()` it.
 */
export async function bootstrapTor(
  options: BootstrapOptions,
): Promise<WebtorClient> {
  const { say, onLap = () => {} } = options;

  say(
    t({ en: 'Loading the Tor client...', es: 'Cargando el cliente de Tor...' }),
  );
  const { WebtorClient, describeDirectory } = await loadWebtor();
  // Before the directory, so a WebRTC stack that will not load fails the
  // command without first spending a download on it.
  const bridge: BridgeSetup =
    options.bridge === 'webrtc'
      ? { bridge: 'webrtc', rtcPeerConnection: await loadRtcPeerConnection() }
      : { bridge: 'websocket', custom: options.customBridge };
  onLap(t({ en: 'load the Tor client', es: 'cargar el cliente de Tor' }));

  const store = openDirectoryStore(options.cacheDir);
  let seed = options.refreshDirectory
    ? undefined
    : await store.load(describeDirectory, (reason) =>
        say(
          t({
            en: `Ignoring the cached directory: ${reason}`,
            es: `Se ignora el directorio en caché: ${reason}`,
          }),
        ),
      );
  let directory: DirectoryDescription | undefined;
  if (seed) {
    directory = describeDirectory(seed);
    say(
      t({
        en: `Using the cached directory in ${store.path}`,
        es: `Usando el directorio en caché de ${store.path}`,
      }),
    );
    onLap(
      t({
        en: 'read the cached directory',
        es: 'leer el directorio en caché',
      }),
    );
  } else {
    try {
      const fresh = await fetchDirectorySeed({ onProgress: say });
      // Read it before keeping it: a seed the client cannot read is worth
      // neither a file nor a bootstrap.
      directory = describeDirectory(fresh);
      seed = fresh;
    } catch (error) {
      // The fast path is a convenience: without a seed the client downloads
      // the directory through the bridge itself, which is what a tab does.
      seed = undefined;
      const reason = error instanceof Error ? error.message : String(error);
      say(
        t({
          en: `Could not download the directory from the authorities: ${reason}`,
          es: `No se pudo descargar el directorio de las autoridades: ${reason}`,
        }),
      );
      say(
        t({
          en: 'The client will download it through the bridge instead; expect minutes',
          es: 'El cliente lo descargará a través del puente; tardará unos minutos',
        }),
      );
    }
    onLap(t({ en: 'download the directory', es: 'descargar el directorio' }));
    if (seed) {
      const kept = await store.save(seed, (reason) =>
        say(
          t({
            en: `Could not keep the directory: ${reason}`,
            es: `No se pudo guardar el directorio: ${reason}`,
          }),
        ),
      );
      if (kept) {
        say(
          t({
            en: `Kept the directory in ${store.path}`,
            es: `Directorio guardado en ${store.path}`,
          }),
        );
      }
    }
  }

  // The time period places the HSDir ring: peers more than one period apart
  // cannot reach each other, and nothing else in either log says so.
  if (directory) {
    const after = directory.validAfter.toISOString();
    const until = directory.validUntil.toISOString();
    say(
      t({
        en:
          `Directory: consensus valid ${after} to ` +
          `${until}, onion time period ` +
          `${directory.timePeriod}`,
        es:
          `Directorio: consenso válido de ${after} a ` +
          `${until}, periodo de tiempo onion ` +
          `${directory.timePeriod}`,
      }),
    );
  }

  const bridgeLabel = TOR_BRIDGE_LABELS[bridge.bridge];
  say(
    t({
      en: `Bootstrapping Tor over the ${bridgeLabel} bridge...`,
      es: `Iniciando Tor a través del puente ${bridgeLabel}...`,
    }),
  );
  const client = await WebtorClient.create({
    ...bridgeOptions(bridge),
    ...(seed ? { directorySeed: seed } : {}),
    onLog: (message, level) => {
      if (options.verbose || level === 'warn' || level === 'error') {
        say(`[webtor ${level}] ${message}`);
      }
    },
    // A long-lived client refreshes its directory; keep what it downloads so
    // the next run starts from it. A seed this side supplied is never handed
    // back, so nothing here rewrites what it just read.
    onDirectoryChange: (fresh) => void store.save(fresh),
  });
  onLap(t({ en: 'bootstrap', es: 'iniciar Tor' }));
  return client;
}

/** Close a client, swallowing the failure — teardown has nothing to report. */
export async function closeTor(client: WebtorClient | null): Promise<void> {
  if (!client) return;
  try {
    await client.close();
  } catch (error) {
    process.stderr.write(
      t({
        en: `Failed to close the Tor client: ${error instanceof Error ? error.message : String(error)}\n`,
        es: `No se pudo cerrar el cliente de Tor: ${error instanceof Error ? error.message : String(error)}\n`,
      }),
    );
  }
}
