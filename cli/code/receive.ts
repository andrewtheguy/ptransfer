import { join } from 'node:path';
import type { AppendSink } from '@/lib/append-sink';
import {
  type AcceptedOffer,
  acceptOffer,
  buildDirectAttempt,
  deriveAnswerKeys,
  eligibleFallbackRelays,
  fallbackMessage,
  finishDirectReceive,
  type Holder,
  type ReceiveReport,
  readOffer,
  receiveOverFallback,
  unrelayableError,
} from '@/lib/code-exchange/receive';
import { createTorProgress } from '@/lib/code-exchange/tor-progress';
import {
  generateMutualAnswerBinary,
  generateMutualClipboardData,
} from '@/lib/code-signaling';
import { P2PConnectionError } from '@/lib/errors';
import { formatFileSize } from '@/lib/file-utils';
import { AnonymousSignalingTransport } from '@/lib/nostr/anonymous-transport';
import type { createTransferPool } from '@/lib/nostr-file/transfer-pool';
import type { WebRTCConnection } from '@/lib/webrtc';
import { onInterrupt } from '../interrupt';
import { bootstrapTor, type TorOptions } from '../tor/bootstrap';
import { safeFileName } from '../transfer/files';
import type { Presenter } from '../ui/presenter';
import { createCliHost, savedFrom } from './host';

/**
 * `ptransfer receive --code`: Code Exchange from the terminal, the
 * counterpart of the tab's `useCodeReceive` on the same engine
 * (`src/lib/code-exchange/receive.ts`).
 *
 * The sender's code comes in on standard input; the response goes to
 * standard output as one line of text for the sender to paste, and the file
 * lands in the folder given under the sender's name, never overwriting
 * anything. What the code asks for decides the fallback, as in the tab: this
 * side has nothing to choose but, for an anonymous one, how to reach Tor.
 */

/**
 * How long the direct route may take to open. The response is still being
 * carried to the sender by a person, and nothing can connect until it is
 * there; a route that is really dead says so through its connection state
 * long before this.
 */
const CODE_CONNECTION_TIMEOUT_MS = 120000;

type TransferPool = ReturnType<typeof createTransferPool>;

export interface CodeReceiveOptions {
  /** The folder the file is saved in, already checked. */
  folder: string;
  /**
   * Testing aid: answer with no network routes at all, so the sender has
   * nothing to connect to and the file goes through the fallback the code
   * names — what a receiver behind a hostile NAT gets anyway.
   */
  simulateNoDirect: boolean;
  /** How to reach Tor, should the code ask for the anonymous fallback. */
  torOptions: TorOptions;
  cacheDir: string;
  verbose: boolean;
  /** Where the sender's code is asked for and the response is shown. */
  presenter: Presenter;
}

export async function receiveByCode(
  options: CodeReceiveOptions,
): Promise<number> {
  const { presenter } = options;
  const say = (line: string) => presenter.say(line);

  const offer: AcceptedOffer = await presenter.readCode(
    "Paste the sender's code: ",
    async (container) => acceptOffer(await readOffer(container)),
  );
  const { fileName, fileSize } = offer.metadata;
  const destination = join(options.folder, safeFileName(fileName));
  const relays = eligibleFallbackRelays(offer);
  if (options.simulateNoDirect && !relays) {
    throw new Error(
      offer.fallbackRelays
        ? 'The file is too large for the fallback, so there is no route but the direct one to simulate the loss of'
        : 'The code names no fallback, so there is no route but the direct one to simulate the loss of',
    );
  }

  const host = await createCliHost({ cacheDir: options.cacheDir, destination });

  // The status of the signal that stopped the command, once one has.
  let interrupted: number | null = null;
  const isCancelled = () => interrupted !== null;
  const rtcHolder: Holder<WebRTCConnection> = { current: null };
  const sinkHolder: Holder<AppendSink> = { current: null };
  const poolHolder: Holder<TransferPool> = { current: null };
  let transport: AnonymousSignalingTransport | null = null;
  const teardown = async () => {
    // Closing the connection is what tells a sender mid-transfer.
    rtcHolder.current?.close();
    rtcHolder.current = null;
    poolHolder.current?.destroy();
    poolHolder.current = null;
    transport?.close();
    transport = null;
    await host.abandon();
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
    say(`The sender is offering ${fileName} (${formatFileSize(fileSize)})`);

    // Started the moment the code is taken in rather than once the direct
    // route is known to be dead: a bootstrap is the slow part, and by then
    // the sender is already waiting. Its progress is held until the fallback
    // needs it.
    const torProgress = createTorProgress();
    if (offer.fallback === 'anonymous') {
      say(
        'The sender chose the anonymous fallback: starting Tor behind the exchange',
      );
      transport = new AnonymousSignalingTransport({
        bootstrap: () =>
          bootstrapTor({
            ...options.torOptions,
            verbose: options.verbose,
            say: (line) => {
              torProgress.push(line);
              if (options.verbose) show(`[tor] ${line}`);
            },
          }),
      });
    }

    const keys = await deriveAnswerKeys(offer);
    if (isCancelled()) return interrupted ?? 1;

    const attempt = await buildDirectAttempt({
      offer,
      keys,
      host,
      sinkHolder,
      rtcHolder,
      connectionTimeoutMs: CODE_CONNECTION_TIMEOUT_MS,
      isCancelled,
      report,
      onProgress: (current, total) => presenter.progress(current, total),
    });
    if (!attempt) return interrupted ?? 1;

    let answerBinary = attempt.answerBinary;
    if (options.simulateNoDirect) {
      // No peer connection at all, and a response with the last answer's SDP
      // and none of its candidates: nothing on this side answers a
      // connectivity check, so the sender cannot find a way in.
      attempt.dispose();
      answerBinary = await generateMutualAnswerBinary(
        attempt.answerSDP,
        [],
        keys.publicKeyBytes,
        keys.signAnswer,
      );
    }

    say('');
    say('Give the sender this response:');
    say('');
    presenter.hand(generateMutualClipboardData(answerBinary));
    say('');

    // Held until the sender turns up on the fallback's control channel:
    // nothing has begun before then, and the response is still the only way
    // the transfer starts.
    const hold = (torStatus: string) => {
      show(
        options.simulateNoDirect
          ? 'Simulating no direct connection — waiting for the sender to take in the response'
          : `${fallbackMessage(offer)}. Waiting for the sender to take in the response`,
      );
      if (torStatus && options.verbose) show(`[tor] ${torStatus}`);
    };
    const viaFallback = () =>
      receiveOverFallback({
        offer,
        keys,
        host,
        transport,
        torProgress,
        hold,
        poolHolder,
        switchedBack: () => false,
        isCancelled,
        report,
      });

    let direct = !options.simulateNoDirect;
    if (direct) {
      show('Waiting for the sender to connect...');
      try {
        await attempt.opened;
      } catch (error) {
        if (!(error instanceof P2PConnectionError) || isCancelled()) {
          throw error;
        }
        // The route died on its own. The response is still the only way the
        // transfer starts, so the fallback waits behind it.
        attempt.dispose();
        if (!offer.fallbackRelays) throw error;
        if (!relays) throw unrelayableError(offer, error);
        direct = false;
      }
    }
    let saved: number;
    if (direct) {
      show('Connected directly; receiving...');
      const payload = await finishDirectReceive({
        attempt,
        rtcHolder,
        isCancelled,
      });
      if (!payload) throw new Error('Cancelled');
      saved = payload.size;
    } else {
      saved = await savedFrom(await viaFallback(), host);
    }
    presenter.done();
    if (isCancelled()) return interrupted ?? 1;
    say(`Saved ${formatFileSize(saved)} to ${destination}`);
    presenter.hand(destination);
    return 0;
  } catch (error) {
    presenter.done();
    if (interrupted !== null) return interrupted;
    throw error;
  } finally {
    uninstall();
    await teardown();
  }
}
