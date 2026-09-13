import { hangUp } from '@/lib/code-exchange/hang-up';
import {
  answersOffer,
  completeSend,
  createSenderOffer,
  readAnswer,
  type SenderFallback,
  type SendReport,
  startSenderFallback,
} from '@/lib/code-exchange/send';
import {
  describeSendSource,
  torFallbackRefusal,
} from '@/lib/code-exchange/source';
import { createTorProgress } from '@/lib/code-exchange/tor-progress';
import {
  generateMutualClipboardData,
  type SignalingPayload,
} from '@/lib/code-signaling';
import { TRANSFER_EXPIRATION_MS } from '@/lib/crypto';
import type { DuplexChannel } from '@/lib/duplex-channel';
import { AnonymousSignalingTransport } from '@/lib/nostr/anonymous-transport';
import type { TransferSource } from '@/lib/transfer-source';
import type { WebRTCConnection } from '@/lib/webrtc';
import { onInterrupt } from '../interrupt';
import { bootstrapTor, type TorOptions } from '../tor/bootstrap';
import type { Presenter } from '../ui/presenter';
import { createCliHost } from './host';

/**
 * `ptransfer send --code <path>...`: Code Exchange from the terminal, the
 * counterpart of the tab's `useCodeSend` on the same engine
 * (`src/lib/code-exchange/send.ts`).
 *
 * The offer goes to standard output as one line of text — the same text the
 * tab's Copy Data gives, so a tab can paste it — and the receiver's response
 * comes back on standard input. Taking that response in is this side's
 * confirmation step, exactly as scanning or pasting it is in the tab.
 */

/** How long a cancel's word to the receiver is given to leave. */
const HANG_UP_WAIT_MS = 600;

const ANSWER_MISMATCH =
  'That response does not answer this code. Paste the response the receiver made from the code above.';

export interface CodeSendOptions {
  content: TransferSource;
  /** Relay through Tor rather than public Nostr relays when no direct route opens. */
  anonymous: boolean;
  /** How to reach Tor, for the anonymous fallback. */
  torOptions: TorOptions;
  cacheDir: string;
  verbose: boolean;
  /** Where the offer is shown and the receiver's response comes back from. */
  presenter: Presenter;
}

export async function sendByCode(options: CodeSendOptions): Promise<number> {
  const { content, anonymous, presenter } = options;
  const say = (line: string) => presenter.say(line);
  const host = await createCliHost({
    cacheDir: options.cacheDir,
    destination: null,
  });
  const described = describeSendSource(content, host.maxTransferBytes);
  if ('error' in described) throw new Error(described.error);
  const { metadata } = described;
  // The fallback's ceiling is checked on the selection, before an offer asks
  // for a fallback that could not carry it.
  const torRefusal = anonymous ? torFallbackRefusal(content) : null;
  if (torRefusal) throw new Error(torRefusal);

  // The status of the signal that stopped the command, once one has.
  let interrupted: number | null = null;
  const isCancelled = () => interrupted !== null;
  let rtc: WebRTCConnection | null = null;
  let channel: DuplexChannel | null = null;
  let fallback: SenderFallback | null = null;
  let transport: AnonymousSignalingTransport | null = null;
  const teardown = async (cancelled: boolean) => {
    const closingRtc = rtc;
    const closingChannel = channel;
    rtc = null;
    channel = null;
    fallback?.close();
    fallback = null;
    transport?.close();
    transport = null;
    if (!cancelled) {
      // A transfer that finished or failed has already said what happened.
      closingRtc?.close();
      return;
    }
    // A receiver mid-transfer is told why the connection is going away.
    hangUp(closingRtc, closingChannel);
    if (closingChannel) {
      await new Promise((resolve) => setTimeout(resolve, HANG_UP_WAIT_MS));
    }
  };
  const uninstall = onInterrupt((status) => {
    interrupted = status;
    return teardown(true);
  });

  let moving = false;
  const report = (update: SendReport) => {
    if (isCancelled()) return;
    if (
      update.progress &&
      (update.status === 'transferring' || update.status === 'uploading')
    ) {
      moving = true;
      presenter.progress(update.progress.current, update.progress.total);
      return;
    }
    // The relay population is still being swept behind a relayed transfer;
    // once its bytes are moving, that is background the progress replaces.
    if (moving && update.status === 'discovering_relays') return;
    presenter.status(update.message);
  };

  try {
    // The Tor client behind the anonymous fallback bootstraps behind the
    // exchange, as it does in the tab: a bootstrap is the slow part, and by
    // the time the direct route is known to be dead the receiver is waiting.
    // Its progress is held until the fallback needs it, rather than written
    // over the prompt for the response.
    const torProgress = createTorProgress();
    if (anonymous) {
      transport = new AnonymousSignalingTransport({
        bootstrap: () =>
          bootstrapTor({
            ...options.torOptions,
            verbose: options.verbose,
            say: (line) => {
              torProgress.push(line);
              if (options.verbose) presenter.status(`[tor] ${line}`);
            },
          }),
      });
    }
    fallback = startSenderFallback({
      kind: anonymous ? 'anonymous' : 'relay',
      host,
      transport,
      isCancelled,
    });

    const offer = await createSenderOffer({
      metadata,
      host,
      fallback,
      isCancelled,
      report,
      onConnection: (connection) => {
        rtc = connection;
      },
    });
    if (!offer) return interrupted ?? 1;
    void (async () => {
      const opened = await offer.channelOpened;
      if (rtc === offer.rtc) channel = opened;
    })();
    if (offer.fallback.kind === 'none') {
      say(
        'No relays could be proven for a fallback, so this transfer needs a direct connection.',
      );
    }

    say('');
    say('Give the receiver this code:');
    say('');
    presenter.hand(generateMutualClipboardData(offer.offerBinary));
    say('');

    // The response is judged by the session it answers, which ends an hour
    // after the offer was made.
    const expiresIn = offer.createdAt + TRANSFER_EXPIRATION_MS - Date.now();
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      expiry = setTimeout(
        () => reject(new Error('Session expired. Send again for a new code.')),
        expiresIn,
      );
    });
    let answer: SignalingPayload;
    try {
      answer = await Promise.race([
        presenter.readCode(
          "Paste the receiver's response: ",
          async (container) => {
            const parsed = readAnswer(container);
            if (!(await answersOffer(offer, parsed))) {
              throw new Error(ANSWER_MISMATCH);
            }
            return parsed;
          },
        ),
        expired,
      ]);
    } finally {
      clearTimeout(expiry);
    }

    await completeSend({
      host,
      offer,
      answer,
      content,
      metadata,
      fallback,
      torProgress: transport ? torProgress : null,
      isCancelled,
      report,
      answerMismatchMessage: ANSWER_MISMATCH,
    });
    presenter.done();
    if (isCancelled()) return interrupted ?? 1;
    say(`Sent ${content.name}`);
    return 0;
  } catch (error) {
    presenter.done();
    if (interrupted !== null) return interrupted;
    throw error;
  } finally {
    uninstall();
    await teardown(false);
  }
}
