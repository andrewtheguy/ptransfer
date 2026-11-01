import { parseArgs } from 'node:util';
import { formatFileSize } from '@/lib/file-utils';
import { type Localized, t } from '@/lib/i18n';
import { TOR_WAIT_TIMEOUT_MS } from '@/lib/tor/serve';
import { defaultCacheDir } from '../cache-dir';
import { sendByCode } from '../code/send';
import { routeDiagnostics } from '../diagnostics';
import { sendByPin } from '../pin/send';
import {
  TOR_OPTIONS,
  TOR_OPTIONS_USAGE,
  torOptionsFrom,
} from '../tor/bootstrap';
import { openSelection } from '../transfer/selection';
import { sendOverTor } from '../transfer/tor-send';
import { createLinePresenter } from '../ui/line';
import { UsageError } from '../usage';

/**
 * `ptransfer send (--pin | --code | --tor) <path>...`: send files and folders
 * the way the tab's send tab does, in any of its three modes.
 *
 * - `--pin` is PIN Exchange (`../pin/send.ts`): a short PIN out, which rotates
 *   while it waits, and the confirmation code the receiver reads back in; the
 *   codes a Code Exchange would have been carried by hand ride the sealed
 *   channel the PIN sets up.
 * - `--code` is Code Exchange (`../code/send.ts`): a code out, the receiver's
 *   response back in, then a direct connection, or the fallback the code
 *   names when none opens.
 * - `--tor` publishes an ephemeral v3 onion service and prints the address
 *   and one-time password the receiver needs — the counterpart of the tab's
 *   `useTorSend`: the same accept loop, the same bounds.
 *
 * Either way one file goes as itself and anything more as one ZIP. What the
 * receiver needs goes to standard output, one line each, so a script can take
 * it; everything else goes to standard error.
 */

const USAGE: Localized = {
  en: `usage: ptransfer send --pin <path>... [options]
       ptransfer send --code <path>... [options]
       ptransfer send --tor <path>... [options]

Send files and folders. One file is sent as itself; several, or a folder, go
as one ZIP that keeps each folder's structure under its name.

--pin prints a short PIN to read out to the receiver, and prints a fresh one
every couple of minutes until someone takes it. Once they have, they are shown
the name and size of what is on offer, and a confirmation code: type that code
in, and no connection offer and no byte of the file leaves this process until
you have. With --anonymous the whole handshake goes through Tor.

--code prints a code for the receiver to paste into the web app or into
ptransfer receive --code, then reads the response they give back from standard
input. The file then goes over a direct connection; when none opens, through
public Nostr relays, or with --anonymous through Tor, for files up to
100 MiB. The code is good for an hour.

--tor publishes an onion service and prints the address and the one-time
password the receiver needs. The service answers until a receiver takes the
transfer, or for ${TOR_WAIT_TIMEOUT_MS / 60000} minutes.

options:
  --pin                    read the receiver a PIN and take back their
                           confirmation code
  --code                   hand the receiver a code and take back theirs
  --tor                    send over a Tor onion service
  --anonymous              with --pin: carry the handshake, and a file that
                           finds no direct route, through Tor rather than
                           public Nostr relays; with --code: the fallback
                           alone. The Tor options below say how to reach it
${TOR_OPTIONS_USAGE.en}
  -v, --verbose            show diagnostics and the Tor client's own log lines
  -h, --help

environment:
  PTRANSFER_RELAY_CACHE    where to keep what earlier transfers learned about
                           the public Nostr relays: a directory of your own,
                           or off to keep it in memory for this run alone
                           (default: relay-cache.json in the cache directory
                           above)
`,
  es: `uso: ptransfer send --pin <path>... [opciones]
     ptransfer send --code <path>... [opciones]
     ptransfer send --tor <path>... [opciones]

Envía archivos y carpetas. Un archivo se envía tal cual; varios, o una carpeta,
van en un solo ZIP que conserva la estructura de cada carpeta bajo su nombre.

--pin muestra un PIN corto para leérselo al receptor, y muestra uno nuevo cada
par de minutos hasta que alguien lo use. Cuando lo haga, verá el nombre y el
tamaño de lo que se ofrece y un código de confirmación: escribe ese código
aquí; ninguna oferta de conexión ni ningún byte del archivo sale de este
proceso hasta que lo hagas. Con --anonymous, toda la negociación pasa por Tor.

--code muestra un código para que el receptor lo pegue en la aplicación web o
en ptransfer receive --code, y luego lee de la entrada estándar la respuesta
que te devuelva. El archivo va entonces por una conexión directa; si no se abre
ninguna, a través de relays públicos de Nostr, o con --anonymous a través de
Tor, para archivos de hasta 100 MiB. El código vale una hora.

--tor publica un servicio onion y muestra la dirección y la contraseña de un
solo uso que necesita el receptor. El servicio responde hasta que un receptor
recibe la transferencia, o durante ${TOR_WAIT_TIMEOUT_MS / 60000} minutos.

opciones:
  --pin                    lee al receptor un PIN y recibe a cambio su código
                           de confirmación
  --code                   entrega al receptor un código y recibe el suyo
  --tor                    envía a través de un servicio onion de Tor
  --anonymous              con --pin: lleva la negociación, y un archivo que
                           no encuentre ruta directa, por Tor en lugar de por
                           relays públicos de Nostr; con --code: solo el
                           respaldo. Las opciones de Tor de abajo dicen cómo
                           llegar a él
${TOR_OPTIONS_USAGE.es}
  -v, --verbose            muestra diagnósticos y las líneas de registro del
                           propio cliente de Tor
  -h, --help

entorno:
  PTRANSFER_RELAY_CACHE    dónde guardar lo que las transferencias anteriores
                           aprendieron de los relays públicos de Nostr: un
                           directorio propio, u off para guardarlo en memoria
                           solo durante esta ejecución (por defecto:
                           relay-cache.json en el directorio de caché de
                           arriba)
`,
};

/** How many left-out paths are named before the rest are only counted. */
const SKIPPED_SHOWN = 5;

export async function send(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...TOR_OPTIONS,
      pin: { type: 'boolean', default: false },
      code: { type: 'boolean', default: false },
      tor: { type: 'boolean', default: false },
      anonymous: { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(t(USAGE));
    return 0;
  }
  const modes = [values.pin, values.code, values.tor].filter(Boolean).length;
  if (modes !== 1) {
    throw new UsageError(
      t({
        en: 'Choose one mode: --pin, --code or --tor',
        es: 'Elige un modo: --pin, --code o --tor',
      }),
    );
  }
  if (values.anonymous && values.tor) {
    throw new UsageError(
      t({
        en: '--anonymous goes with --pin or --code',
        es: '--anonymous va con --pin o --code',
      }),
    );
  }
  if (positionals.length === 0) {
    throw new UsageError(
      t({
        en: 'Give at least one file or folder to send',
        es: 'Indica al menos un archivo o carpeta para enviar',
      }),
    );
  }
  const torOptions = torOptionsFrom(values);
  routeDiagnostics(values.verbose);
  const presenter = createLinePresenter(t({ en: 'Sending', es: 'Enviando' }));
  const say = (line: string) => presenter.say(line);

  const {
    source: content,
    fileCount,
    skipped,
  } = await openSelection(positionals);
  if (skipped.length > 0) {
    const shown = skipped.slice(0, SKIPPED_SHOWN);
    const more = skipped.length - shown.length;
    const n = skipped.length;
    say(
      t({
        en: `Leaving out ${n} ${n === 1 ? 'symbolic link or special file' : 'symbolic links or special files'}, which the ZIP does not carry:`,
        es: `Se omite${n === 1 ? '' : 'n'} ${n} ${n === 1 ? 'enlace simbólico o archivo especial' : 'enlaces simbólicos o archivos especiales'}, que el ZIP no lleva:`,
      }),
    );
    for (const path of shown) say(`  ${path}`);
    if (more > 0) {
      say(t({ en: `  and ${more} more`, es: `  y ${more} más` }));
    }
  }
  // Only the multiple file/folder flow is an archive: a ZIP.
  if (content.archive) {
    const size = formatFileSize(content.estimatedSize);
    say(
      t({
        en: `Sending ${fileCount} ${fileCount === 1 ? 'file' : 'files'} (${size}) as ${content.name}`,
        es: `Enviando ${fileCount} ${fileCount === 1 ? 'archivo' : 'archivos'} (${size}) como ${content.name}`,
      }),
    );
  }
  if (values.pin) {
    return await sendByPin({
      content,
      anonymous: values.anonymous,
      torOptions,
      cacheDir: torOptions.cacheDir ?? defaultCacheDir(),
      verbose: values.verbose,
      presenter,
    });
  }
  if (values.code) {
    return await sendByCode({
      content,
      anonymous: values.anonymous,
      torOptions,
      cacheDir: torOptions.cacheDir ?? defaultCacheDir(),
      verbose: values.verbose,
      presenter,
    });
  }
  return await sendOverTor({
    content,
    torOptions,
    verbose: values.verbose,
    presenter,
  });
}
