import { hangUp } from '@/lib/code-exchange/hang-up';
import {
  completeSend,
  createSenderOffer,
  readAnswer,
  type SenderFallback,
  type SendFallbackKind,
  type SendReport,
  startSenderFallback,
} from '@/lib/code-exchange/send';
import {
  describeSendSource,
  torFallbackRefusal,
} from '@/lib/code-exchange/source';
import { createTorProgress } from '@/lib/code-exchange/tor-progress';
import type { PinKind } from '@/lib/crypto';
import type { DuplexChannel } from '@/lib/duplex-channel';
import { carryOfferForAnswer, type NostrClient } from '@/lib/nostr';
import { AnonymousSignalingTransport } from '@/lib/nostr/anonymous-transport';
import {
  ANSWER_WAIT_TIMEOUT_MS,
  CONFIRM_CODE_ENTRY_TIMEOUT_MS,
  confirmationCodeMatches,
  confirmPinClaim,
  OFFER_RETRY_MS,
  type PinRendezvous,
  startPinRendezvous,
} from '@/lib/pin-exchange/send';
import {
  openPinSignaling,
  pinSignalingRelays,
} from '@/lib/pin-exchange/signaling';
import type { TransferSource } from '@/lib/transfer-source';
import type { WebRTCConnection } from '@/lib/webrtc';
import { createCliHost } from '../code/host';
import { onInterrupt } from '../interrupt';
import { bootstrapTor, type TorOptions } from '../tor/bootstrap';
import type { Presenter } from '../ui/presenter';

/**
 * `ptransfer send --pin <path>...`: PIN Exchange from the terminal, the
 * counterpart of the tab's `usePinSend` on the same handshake
 * (`src/lib/pin-exchange/send.ts`) and the same Code Exchange session behind
 * it (`src/lib/code-exchange/send.ts`).
 *
 * The PIN goes to standard output as it is minted — and again every time it
 * rotates, since a printed line cannot be taken back — for the person to read
 * out. Once a receiver has proved it knew one, they are shown what is on
 * offer by name and size, and a confirmation code; typing that code here is
 * what opens the gate, and no connection offer and no byte of the file leaves
 * this process before it does.
 */

/** How long a cancel's word to the receiver is given to leave. */
const HANG_UP_WAIT_MS = 600;

const CODE_MISMATCH =
  'That is not the code the receiver is showing. Check you are reading it from the person you meant to send to, and type it again.';

export interface PinSendOptions {
  content: TransferSource;
  /** Carry the handshake, and the fallback, through Tor rather than clearnet relays. */
  anonymous: boolean;
  /** How to reach Tor, for an anonymous transfer. */
  torOptions: TorOptions;
  cacheDir: string;
  verbose: boolean;
  /** Where the PIN is shown and the confirmation code comes back from. */
  presenter: Presenter;
}

export async function sendByPin(options: PinSendOptions): Promise<number> {
  const { content, anonymous, presenter } = options;
  const say = (line: string) => presenter.say(line);
  const described = describeSendSource(content);
  if ('error' in described) throw new Error(described.error);
  const { metadata } = described;

  const host = await createCliHost({
    cacheDir: options.cacheDir,
    destination: null,
  });

  // The PIN's length is what tells the receiver which relay pool to look on,
  // so the kind and the pool are decided together and never separately.
  const pinKind: PinKind = anonymous ? 'anonymous' : 'standard';
  const relays = pinSignalingRelays(anonymous);

  // The status of the signal that stopped the command, once one has.
  let interrupted: number | null = null;
  const isCancelled = () => interrupted !== null;
  let client: NostrClient | null = null;
  let transport: AnonymousSignalingTransport | null = null;
  let fallback: SenderFallback | null = null;
  let rendezvous: PinRendezvous | null = null;
  let rtc: WebRTCConnection | null = null;
  let channel: DuplexChannel | null = null;
  const teardown = async (cancelled: boolean) => {
    const closingRtc = rtc;
    const closingChannel = channel;
    rtc = null;
    channel = null;
    fallback?.close();
    fallback = null;
    // Closing the rendezvous is what wipes every PAKE secret it retained.
    rendezvous?.close();
    rendezvous = null;
    client?.close();
    client = null;
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
  // Held until the gate opens: until then the offer is being built behind a
  // person, and its steps are not what this screen is waiting on.
  let offerOnScreen = false;
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
    // One Tor client for the whole anonymous transfer: its relay sockets carry
    // the handshake, and if no direct route opens, the Tor fallback publishes
    // its onion service on it too. Two would mean two bootstraps, minutes each.
    const torProgress = createTorProgress();
    let bootstrapOnScreen = true;
    if (anonymous) {
      transport = new AnonymousSignalingTransport({
        bootstrap: () =>
          bootstrapTor({
            ...options.torOptions,
            verbose: options.verbose,
            say: (line) => {
              torProgress.push(line);
              if (bootstrapOnScreen && !isCancelled()) {
                presenter.status(options.verbose ? `[tor] ${line}` : line);
              }
            },
          }),
      });
    }

    // The fallback, prepared from the start rather than once a receiver has
    // turned up: the PIN on screen is a wait of its own it can run behind, so
    // by the time a receiver has claimed and confirmed, the offer's relays are
    // proven and the ring is ready. An anonymous transfer's fallback is the
    // Tor one, unless the selection is more than it can carry; then it has
    // none, and a dead direct route ends the transfer.
    const fallbackKind: SendFallbackKind = anonymous
      ? torFallbackRefusal(content)
        ? 'none'
        : 'anonymous'
      : 'relay';
    fallback = startSenderFallback({
      kind: fallbackKind,
      host,
      transport,
      isCancelled,
    });
    const preparedFallback = fallback;

    client = await openPinSignaling({
      anonymous,
      transport,
      isCancelled,
      report: (message) => presenter.status(message),
      onTorUp: () => {
        bootstrapOnScreen = false;
      },
    });
    if (!client) return interrupted ?? 1;
    const nostr = client;

    let shown = 0;
    rendezvous = startPinRendezvous({
      client: nostr,
      pinKind,
      relays,
      isCancelled,
      onPin: (pin) => {
        shown += 1;
        if (shown === 1) {
          say('');
          say('Read the receiver this PIN:');
        } else {
          say('The PIN has rotated. Read out this one instead:');
        }
        presenter.hand(pin, 'PIN');
        if (shown === 1) {
          say('');
          say(
            'A fresh one appears every couple of minutes: read out the newest.',
          );
        }
        presenter.status('Waiting for the receiver to enter the PIN...');
      },
    });
    const session = rendezvous;
    // A fresh PIN on demand, for a PIN that was read to the wrong person or
    // seen by someone over a shoulder. The line interface has no key to bind
    // it to and rotation covers it there.
    const withdrawRefresh = presenter.action('r', 'a fresh PIN', () => {
      void session.refresh();
    });

    let claim: Awaited<typeof session.claimed>;
    try {
      claim = await session.claimed;
    } finally {
      withdrawRefresh();
    }
    if (isCancelled()) return interrupted ?? 1;

    // Mutual proof plus metadata delivery: the confirm is sealed under the
    // session's confirm key, which only the matching PAKE peer holds, so
    // publishing it is this side's PIN proof in the reverse direction.
    const { expectedCode, signalsKey } = await confirmPinClaim({
      client: nostr,
      rendezvous: session,
      claim,
      metadata,
    });
    if (isCancelled()) return interrupted ?? 1;

    // Built while the operator types the code, and published only past the
    // gate: gathering candidates and waiting on the fallback's relays need no
    // human, so they need not wait for one either.
    const offerBuild = createSenderOffer({
      metadata,
      host,
      fallback: preparedFallback,
      isCancelled,
      report: (update) => {
        if (offerOnScreen) report(update);
      },
      onConnection: (connection) => {
        rtc = connection;
      },
    });
    // Awaited only past the gate; a failure before then must not surface as an
    // unhandled rejection in the meantime.
    offerBuild.catch(() => undefined);

    say('');
    say('A receiver has the PIN, and is showing a confirmation code.');
    say(
      'Ask them for it over a channel someone who read the PIN off your screen',
    );
    say(
      'does not control: the code, not the PIN, is what decides that this is the',
    );
    say('person you meant to send to.');

    let expiry: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      expiry = setTimeout(
        () =>
          reject(
            new Error(
              'Confirmation code was not entered in time. Start a new transfer.',
            ),
          ),
        CONFIRM_CODE_ENTRY_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([
        presenter.readWord("The receiver's confirmation code: ", (text) => {
          if (!confirmationCodeMatches(text, expectedCode)) {
            throw new Error(CODE_MISMATCH);
          }
        }),
        expired,
      ]);
    } finally {
      clearTimeout(expiry);
    }
    if (isCancelled()) return interrupted ?? 1;

    // The typed code matched: the human vouched for the peer this transfer
    // locked onto, so the gate opens. From here it is a Code Exchange session
    // whose codes ride the sealed channel instead of a person's hand.
    offerOnScreen = true;
    presenter.status('Preparing the connection...');
    const offer = await offerBuild;
    if (!offer) return interrupted ?? 1;
    void (async () => {
      const opened = await offer.channelOpened;
      if (rtc === offer.rtc) channel = opened;
    })();

    presenter.status('Sending the connection offer...');
    const answerCode = await carryOfferForAnswer({
      client: nostr,
      secretKey: session.secretKey,
      transferId: session.transferId,
      senderPubkey: session.publicKey,
      receiverPubkey: claim.receiverPubkey,
      signalsKey,
      isCancelled,
      offer: offer.offerBinary,
      retryMs: OFFER_RETRY_MS,
      timeoutMs: ANSWER_WAIT_TIMEOUT_MS,
    });
    if (isCancelled()) return interrupted ?? 1;

    // Only the locked receiver can have sealed this, and the confirmation tag
    // inside it still has to bind it to this offer before anything in it is
    // acted on.
    await completeSend({
      offer,
      answer: readAnswer(answerCode),
      content,
      metadata,
      fallback: preparedFallback,
      torProgress: transport ? torProgress : null,
      isCancelled,
      report,
      answerMismatchMessage:
        "The receiver's response does not match this transfer. Start a new transfer.",
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
