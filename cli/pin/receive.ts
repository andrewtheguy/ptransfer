import type { AppendSink } from '@/lib/append-sink';
import {
  buildDirectAttempt,
  deriveAnswerKeys,
  eligibleFallbackRelays,
  finishDirectReceive,
  type Holder,
  type ReceiveReport,
  receiveOverFallback,
  unrelayableError,
} from '@/lib/code-exchange/receive';
import { createTorProgress } from '@/lib/code-exchange/tor-progress';
import { generateMutualAnswerBinary } from '@/lib/code-signaling';
import {
  derivePakeSecret,
  formatConfirmationCode,
  getPinLocator,
  wipeBufferSource,
} from '@/lib/crypto';
import { P2PConnectionError } from '@/lib/errors';
import { formatFileSize } from '@/lib/file-utils';
import { type Localized, t } from '@/lib/i18n';
import { awaitCarriedOffer, type NostrClient } from '@/lib/nostr';
import { AnonymousSignalingTransport } from '@/lib/nostr/anonymous-transport';
import type { createTransferPool } from '@/lib/nostr-file/transfer-pool';
import {
  acceptPinOffer,
  claimPin,
  DIRECT_ATTEMPT_TIMEOUT_MS,
  NO_FALLBACK_ATTEMPT_TIMEOUT_MS,
  OFFER_WAIT_TIMEOUT_MS,
  pinReceiverConfirmation,
} from '@/lib/pin-exchange/receive';
import { openPinSignaling } from '@/lib/pin-exchange/signaling';
import { classifyReceiveText } from '@/lib/receive-input';
import type { WebRTCConnection } from '@/lib/webrtc';
import { createCliHost, savedFrom } from '../code/host';
import { onInterrupt } from '../interrupt';
import { bootstrapTor, type TorOptions } from '../tor/bootstrap';
import { savePath } from '../transfer/files';
import type { Presenter } from '../ui/presenter';

/**
 * `ptransfer receive --pin`: PIN Exchange from the terminal, the counterpart
 * of the tab's `usePinReceive` on the same handshake
 * (`src/lib/pin-exchange/receive.ts`) and the same Code Exchange session
 * behind it.
 *
 * The PIN the sender read out comes in on standard input; a PIN link works
 * too, since it is the same thing with a URL around it. What goes back is a
 * confirmation code, on standard output, for the person to read to the
 * sender: the sender sends nothing until it hears it, and hearing it is how
 * both of them learn that the peer they are talking to is the peer they meant.
 * Which relay pool this uses, and so whether it starts Tor, is read off the
 * PIN's length; the file lands in the folder given, under the name the sender
 * gave it, and nothing is ever overwritten.
 */

type TransferPool = ReturnType<typeof createTransferPool>;

const NOT_A_PIN: Localized = {
  en: 'That is not a PIN. A PIN is 12 characters, or 16 for an anonymous transfer, and the last one checks the rest — check it was read out whole.',
  es: 'Eso no es un PIN. Un PIN tiene 12 caracteres, o 16 en una transferencia anónima, y el último verifica el resto; comprueba que se leyó entero.',
};

export interface PinReceiveOptions {
  /** The folder the file is saved in, already checked. */
  folder: string;
  /**
   * Testing aid: answer with no network routes at all, so the sender has
   * nothing to connect to and the file goes through the fallback its offer
   * names — what a receiver behind a hostile NAT gets anyway.
   */
  simulateNoDirect: boolean;
  /** How to reach Tor, should the PIN be an anonymous one. */
  torOptions: TorOptions;
  cacheDir: string;
  verbose: boolean;
  /** Where the PIN is asked for and the confirmation code is shown. */
  presenter: Presenter;
}

export async function receiveByPin(
  options: PinReceiveOptions,
): Promise<number> {
  const { presenter } = options;
  const say = (line: string) => presenter.say(line);

  const pin = await presenter.readWord(
    t({ en: "The sender's PIN: ", es: 'PIN del emisor: ' }),
    // The tab's own rules, so a PIN link a sender pasted into a chat window
    // reads here exactly as it does there.
    (text) => {
      const found = classifyReceiveText(text);
      if (found?.kind !== 'pin') throw new Error(t(NOT_A_PIN));
      return found;
    },
  );
  // The PIN's length is the only thing that says which pool the sender is
  // waiting on, and so whether this needs Tor at all.
  const anonymous = pin.pinKind === 'anonymous';
  const pakeSecret = await derivePakeSecret(pin.pin);
  const locator = getPinLocator(pin.pin);

  // The status of the signal that stopped the command, once one has.
  let interrupted: number | null = null;
  const isCancelled = () => interrupted !== null;
  let client: NostrClient | null = null;
  let transport: AnonymousSignalingTransport | null = null;
  let closeCarriage: (() => void) | null = null;
  let discardSinks: (() => Promise<void>) | null = null;
  const rtcHolder: Holder<WebRTCConnection> = { current: null };
  const sinkHolder: Holder<AppendSink> = { current: null };
  const poolHolder: Holder<TransferPool> = { current: null };
  const teardown = async () => {
    // Closing the connection is what tells a sender mid-transfer.
    rtcHolder.current?.close();
    rtcHolder.current = null;
    poolHolder.current?.destroy();
    poolHolder.current = null;
    closeCarriage?.();
    closeCarriage = null;
    client?.close();
    client = null;
    transport?.close();
    transport = null;
    await discardSinks?.();
  };
  const uninstall = onInterrupt((status) => {
    interrupted = status;
    return teardown();
  });

  const show = (message: string) => {
    if (!isCancelled()) presenter.status(message);
  };
  const report = (update: ReceiveReport) => {
    if (isCancelled()) return;
    if (update.progress && update.status === 'fetching') {
      presenter.progress(update.progress.current, update.progress.total);
      return;
    }
    show(update.message);
  };

  try {
    // One Tor client for the whole anonymous transfer: its relay sockets carry
    // the handshake, and the Tor fallback reaches the sender's onion service
    // through it if no direct route opens.
    const torProgress = createTorProgress();
    let bootstrapOnScreen = true;
    if (anonymous) {
      say(
        t({
          en: 'That is an anonymous PIN: the handshake goes through Tor, which takes a few minutes to start.',
          es: 'Es un PIN anónimo: la negociación pasa por Tor, que tarda unos minutos en iniciarse.',
        }),
      );
      transport = new AnonymousSignalingTransport({
        bootstrap: () =>
          bootstrapTor({
            ...options.torOptions,
            verbose: options.verbose,
            say: (line) => {
              torProgress.push(line);
              if (bootstrapOnScreen) {
                show(options.verbose ? `[tor] ${line}` : line);
              }
            },
          }),
      });
    }

    client = await openPinSignaling({
      anonymous,
      transport,
      isCancelled,
      report: show,
      onTorUp: () => {
        bootstrapOnScreen = false;
      },
    });
    if (!client) return interrupted ?? 1;
    const nostr = client;

    const session = await claimPin({
      client: nostr,
      pakeSecret,
      locator,
      isCancelled,
      report: (update) => show(update.message),
    });
    if (!session) return interrupted ?? 1;

    const { metadata } = session;
    const fileName = metadata.fileName || 'unknown';
    const destination = savePath(options.folder, fileName);
    const host = await createCliHost({
      cacheDir: options.cacheDir,
      destination,
    });
    discardSinks = () => host.abandon();

    const { confirmationCode, signalsKey } =
      await pinReceiverConfirmation(session);
    if (isCancelled()) return interrupted ?? 1;

    say(
      t({
        en: `The sender is offering ${fileName} (${formatFileSize(metadata.fileSize)})`,
        es: `El emisor ofrece ${fileName} (${formatFileSize(metadata.fileSize)})`,
      }),
    );
    say('');
    for (const line of t({
      en: [
        'Read the sender this confirmation code. They send nothing until they',
        'have typed it, and whoever read the PIN off their screen without',
        'being meant to holds a different one:',
      ],
      es: [
        'Léele al emisor este código de confirmación. No enviará nada hasta',
        'haberlo escrito, y quien haya leído el PIN en su pantalla sin deber',
        'hacerlo tiene uno distinto:',
      ],
    })) {
      say(line);
    }
    say('');
    // Grouped as the tab shows it; the sender's side accepts it either way.
    presenter.hand(
      formatConfirmationCode(confirmationCode),
      'confirmation code',
    );
    say('');

    // The sender publishes nothing past its confirm until its operator types
    // that code, so the offer arriving is how this side learns it matched.
    const carriage = awaitCarriedOffer({
      client: nostr,
      secretKey: session.secretKey,
      transferId: session.transferId,
      senderPubkey: session.senderPubkey,
      signalsKey,
      isCancelled,
      timeoutMs: OFFER_WAIT_TIMEOUT_MS,
      timeoutMessage: t({
        en: 'The sender did not enter the confirmation code in time. Start a new transfer.',
        es: 'El emisor no introdujo el código de confirmación a tiempo. Empieza una nueva transferencia.',
      }),
    });
    closeCarriage = carriage.close;
    show(
      t({
        en: 'Waiting for the sender to type the confirmation code...',
        es: 'Esperando a que el emisor escriba el código de confirmación...',
      }),
    );
    const offerCode = await carriage.offer;
    if (isCancelled()) return interrupted ?? 1;

    show(
      t({
        en: 'The sender confirmed — connecting...',
        es: 'El emisor confirmó; conectando...',
      }),
    );
    const offer = await acceptPinOffer(offerCode, { metadata, anonymous });
    const relayFallback = eligibleFallbackRelays(offer);
    if (options.simulateNoDirect && !relayFallback) {
      throw new Error(
        offer.fallbackRelays
          ? t({
              en: 'The file is too large for the fallback, so there is no route but the direct one to simulate the loss of',
              es: 'El archivo es demasiado grande para el respaldo, así que no hay más ruta que la directa cuya pérdida simular',
            })
          : t({
              en: 'The offer names no fallback, so there is no route but the direct one to simulate the loss of',
              es: 'La oferta no indica ningún respaldo, así que no hay más ruta que la directa cuya pérdida simular',
            }),
      );
    }

    const keys = await deriveAnswerKeys(offer);
    if (isCancelled()) return interrupted ?? 1;

    const attempt = await buildDirectAttempt({
      offer,
      keys,
      host,
      sinkHolder,
      rtcHolder,
      connectionTimeoutMs: relayFallback
        ? DIRECT_ATTEMPT_TIMEOUT_MS
        : NO_FALLBACK_ATTEMPT_TIMEOUT_MS,
      isCancelled,
      report,
      onProgress: (current, total) => presenter.progress(current, total),
    });
    if (!attempt) return interrupted ?? 1;

    if (options.simulateNoDirect) {
      // No peer connection at all, and a response with the last answer's SDP
      // and none of its candidates: nothing on this side answers a
      // connectivity check, so the sender cannot find a way in.
      attempt.dispose();
      await carriage.answer(
        await generateMutualAnswerBinary(
          attempt.answerSDP,
          [],
          keys.publicKeyBytes,
          keys.signAnswer,
        ),
      );
    } else {
      await carriage.answer(attempt.answerBinary);
    }
    if (isCancelled()) return interrupted ?? 1;

    let direct = !options.simulateNoDirect;
    if (direct) {
      show(
        t({
          en: 'Waiting for the sender to connect...',
          es: 'Esperando a que el emisor se conecte...',
        }),
      );
      try {
        await attempt.opened;
      } catch (error) {
        attempt.dispose();
        if (
          !(error instanceof P2PConnectionError) ||
          !offer.fallbackRelays ||
          isCancelled()
        ) {
          throw error;
        }
        if (!relayFallback) throw unrelayableError(offer, error);
        direct = false;
      }
    }

    let saved: number;
    if (direct) {
      show(
        t({
          en: 'Connected directly; receiving...',
          es: 'Conexión directa establecida; recibiendo...',
        }),
      );
      const payload = await finishDirectReceive({
        attempt,
        rtcHolder,
        isCancelled,
      });
      if (!payload) throw new Error(t({ en: 'Cancelled', es: 'Cancelado' }));
      saved = payload.size;
    } else {
      // The offer and the answer have done their job; the fallback meets the
      // sender on its own control channel from here.
      carriage.close();
      closeCarriage = null;
      saved = await savedFrom(
        await receiveOverFallback({
          offer,
          keys,
          host,
          transport,
          torProgress,
          hold: null,
          poolHolder,
          switchedBack: () => false,
          isCancelled,
          report,
        }),
        host,
      );
    }
    presenter.done();
    if (isCancelled()) return interrupted ?? 1;
    say(
      t({
        en: `Saved ${formatFileSize(saved)} to ${destination}`,
        es: `Se guardaron ${formatFileSize(saved)} en ${destination}`,
      }),
    );
    presenter.hand(destination);
    return 0;
  } catch (error) {
    presenter.done();
    if (interrupted !== null) return interrupted;
    throw error;
  } finally {
    // Idempotent backstop for every exit before the claims settled — the
    // handshake wipes it itself the moment they do.
    wipeBufferSource(pakeSecret);
    uninstall();
    await teardown();
  }
}
