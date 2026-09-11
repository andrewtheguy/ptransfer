import {
  computeAnswerTranscriptHash,
  computeOfferTranscriptHash,
  decodeAnswerConfirmation,
  generateMutualOfferBinary,
  parseMutualPayload,
  type SignalingPayload,
} from '@/lib/code-signaling';
import {
  constantTimeEqualBytes,
  deriveAESKeyFromSecretKey,
  deriveAnswerConfirmation,
  deriveSharedSecretKey,
  generateECDHKeyPair,
  generateSalt,
  SLOW_TRANSPORT_MAX_BYTES,
  TRANSFER_EXPIRATION_MS,
} from '@/lib/crypto';
import { wipeBufferSource } from '@/lib/crypto/memory';
import type { DuplexChannel } from '@/lib/duplex-channel';
import { P2PConnectionError } from '@/lib/errors';
import { formatFileSize } from '@/lib/file-utils';
import type { FileMetadata, TransferMetadata } from '@/lib/nostr';
import {
  ANONYMOUS_RELAY_CONNECTION_TIMEOUT_MS,
  type AnonymousSignalingTransport,
} from '@/lib/nostr/anonymous-transport';
import { ANONYMOUS_SIGNALING_RELAYS } from '@/lib/nostr/relays';
import { watchForReceiverHello } from '@/lib/nostr-file/hello-watch';
import { createIndexedDbRelayPool } from '@/lib/nostr-file/relay-pool';
import {
  deriveRelaySession,
  type RelaySession,
} from '@/lib/nostr-file/session';
import {
  createTransferStats,
  type NostrFileTransferStats,
} from '@/lib/nostr-file/stats';
import { createTransferPool } from '@/lib/nostr-file/transfer-pool';
import {
  NostrFileCancelledError,
  type PreparedStorageRelays,
  prepareStorageRelays,
  resolveTransferRelays,
  type UploadProgress,
} from '@/lib/nostr-file/upload';
import { sendFileLive } from '@/lib/nostr-file/upload-live';
import { sendFileOverLink } from '@/lib/p2p-transfer';
import {
  deriveOnionPassword,
  serveOverAnonymousRelay,
} from '@/lib/tor/code-relay';
import type { TransferSource } from '@/lib/transfer-source';
import { WebRTCConnection } from '@/lib/webrtc';
import { getWebRTCConfig } from '@/lib/webrtc-config';
import { lingerAfterSend } from './hang-up';
import { chunkBytesEstimate, readSourceFully } from './relay-source';
import type { TorProgress } from './tor-progress';

/**
 * The sending half of a Code Exchange session, whichever way its two codes
 * travel.
 *
 * Code Exchange hands them to a person: the offer as a QR grid or copied
 * text, the response back the same way. PIN Exchange carries the very same
 * codes over its SPAKE2-sealed Nostr channel instead (see
 * `lib/nostr/code-carriage.ts`). Everything the codes set up is the same
 * either way, and lives here: the key pair and the WebRTC offer, the fallback
 * prepared behind the exchange, the direct attempt once a response is in, and
 * the fallback that replaces a direct route that never opened.
 */

type TransferPool = ReturnType<typeof createTransferPool>;

/**
 * A status update, shaped to drop straight into either send hook's state.
 * Every field the screen shows is set on every update, so none can outlive
 * the step it belonged to.
 */
export interface SendReport {
  status:
    | 'generating_offer'
    | 'connecting'
    | 'transferring'
    | 'preparing'
    | 'discovering_relays'
    | 'uploading'
    | 'waiting_for_receiver'
    | 'complete';
  message: string;
  progress?: { current: number; total: number };
  contentType?: 'file';
  fileMetadata?: FileMetadata;
  currentRelays?: string[];
  useWebRTC?: boolean;
  /** Relay fallback: running totals for the relay transfer. */
  stats?: NostrFileTransferStats;
}

/** Which data-path fallback an offer asks for. */
export type SendFallbackKind = 'relay' | 'anonymous' | 'none';

/** What the sender is doing while it resolves the offer's relays. */
export type RelayResolvePhase =
  | 'probing_defaults'
  | 'discovering'
  | 'probing_discovered';

/** Shown only when relay resolution outlasts WebRTC offer creation. */
const RELAY_PHASE_MESSAGES: Record<RelayResolvePhase, string> = {
  probing_defaults: 'Checking relays for the fallback...',
  discovering: 'Looking for more storage relays to back them up...',
  probing_discovered: 'Testing the storage relays we found...',
};

/** The fallback an offer ended up naming. */
export type OfferFallback =
  | {
      kind: 'relay';
      /** The control relays the offer names. */
      controlRelays: string[];
      /** The storage ring, prepared in the background from here on. */
      storage: PreparedStorageRelays;
    }
  | { kind: 'anonymous'; relays: string[] }
  | { kind: 'none' };

/**
 * The fallback, prepared behind the exchange from the moment a transfer
 * starts rather than once the direct route is known to be dead.
 *
 * For the clearnet fallback that is proving the control relays the offer
 * will name, then preparing the storage ring and sweeping the rest of the
 * relay population behind it for as long as the transfer lasts. For the Tor
 * fallback it is a pool on the transfer's Tor client, whose bootstrap is the
 * slow part and is already running. Nothing about the file is touched here.
 */
export interface SenderFallback {
  /** Carries the fallback's control channel; null when there is none. */
  readonly pool: TransferPool | null;
  /** The Tor client behind the anonymous fallback. Borrowed, never closed. */
  readonly transport: AnonymousSignalingTransport | null;
  /** What the offer can name once its relays are settled. Never rejects. */
  readonly settled: Promise<OfferFallback>;
  /** Where relay resolution is, or null once it has finished. */
  resolvePhase(): RelayResolvePhase | null;
  /** Follow relay resolution until the returned function is called. */
  followResolve(listener: (phase: RelayResolvePhase) => void): () => void;
  /** Follow storage-ring preparation until the returned function is called. */
  followStorage(listener: (progress: UploadProgress) => void): () => void;
  /** End the sweep and close the pool. The transport stays the caller's. */
  close(): void;
}

export function startSenderFallback(opts: {
  kind: SendFallbackKind;
  /** Required for the anonymous fallback; ignored otherwise. */
  transport?: AnonymousSignalingTransport | null;
  isCancelled: () => boolean;
}): SenderFallback {
  let pool: TransferPool | null = null;
  let phase: RelayResolvePhase | null = null;
  let resolveListener: ((phase: RelayResolvePhase) => void) | null = null;
  let storageListener: ((progress: UploadProgress) => void) | null = null;
  // Ends the storage preparation and the sweep behind it with the pool, so a
  // teardown never waits out a probe and never records itself as failures.
  const sweepAbort = new AbortController();
  const transport = opts.kind === 'anonymous' ? (opts.transport ?? null) : null;

  const close = () => {
    sweepAbort.abort();
    pool?.destroy();
    pool = null;
  };

  let settled: Promise<OfferFallback>;
  if (opts.kind === 'anonymous') {
    if (!transport) {
      throw new Error('The anonymous fallback needs a Tor client');
    }
    // Its control relays are a constant both sides hold, so there is nothing
    // to prove or discover; what it needs instead is the Tor client, whose
    // bootstrap is already running.
    pool = createTransferPool({
      websocketImplementation: transport.websocketImplementation,
      connectionTimeoutMs: ANONYMOUS_RELAY_CONNECTION_TIMEOUT_MS,
    });
    settled = Promise.resolve({
      kind: 'anonymous',
      relays: [...ANONYMOUS_SIGNALING_RELAYS],
    });
  } else if (opts.kind === 'relay') {
    // Robustness matches the storage transfer: the defaults are
    // control-probed, and a defunct default is replaced by a
    // full-size-proven discovered relay, not a weaker control-sized
    // discovery. A failure or a set below the floor is not an error: the
    // offer simply names no relays, and a failed direct connection then has
    // no fallback.
    const relayPool = createTransferPool();
    pool = relayPool;
    const storage = createIndexedDbRelayPool();
    const setPhase = (next: RelayResolvePhase) => {
      phase = next;
      resolveListener?.(next);
    };
    phase = 'probing_defaults';
    settled = (async (): Promise<OfferFallback> => {
      let selection: Awaited<ReturnType<typeof resolveTransferRelays>>;
      try {
        selection = await resolveTransferRelays(relayPool, storage, {
          isCancelled: opts.isCancelled,
          stats: createTransferStats('sender'),
          onControlProgress: () => setPhase('probing_defaults'),
          onUploadProgress: (p) =>
            setPhase(
              p.phase === 'discovering' ? 'discovering' : 'probing_discovered',
            ),
        });
      } catch {
        phase = null;
        close();
        return { kind: 'none' };
      }
      phase = null;
      // The control relays are settled; the storage ring is prepared in the
      // background on the same pool and relay cache, since the offer does not
      // depend on it. When control resolution already had to discover
      // candidates to backfill a defunct default, the ring is probed from what
      // it left unprobed instead of discovering again. Either way the sweep
      // then keeps probing the rest of the population for as long as the
      // transfer lasts, warming the shared cache and handing a failed direct
      // attempt its ring ready-made.
      return {
        kind: 'relay',
        controlRelays: selection.controlRelays,
        storage: prepareStorageRelays(relayPool, {
          controlRelays: selection.controlRelays,
          storage,
          stats: selection.stats,
          discovered: selection.discovered,
          signal: sweepAbort.signal,
          isCancelled: opts.isCancelled,
          onProgress: (p) => storageListener?.(p),
        }),
      };
    })();
  } else {
    settled = Promise.resolve({ kind: 'none' });
  }

  return {
    get pool() {
      return pool;
    },
    transport,
    settled,
    resolvePhase: () => phase,
    followResolve(listener) {
      resolveListener = listener;
      return () => {
        if (resolveListener === listener) resolveListener = null;
      };
    },
    followStorage(listener) {
      storageListener = listener;
      return () => {
        if (storageListener === listener) storageListener = null;
      };
    },
    close,
  };
}

const ICE_GATHER_TIMEOUT_MS = 5000;

/** A made offer, and everything the sender holds to act on its response. */
export interface SenderOffer {
  /** The PT01 container; the answer's confirmation tag is bound to it. */
  offerBinary: Uint8Array;
  /** The offer's `createdAt`: the session's TTL runs from here. */
  createdAt: number;
  rtc: WebRTCConnection;
  /** Settles whenever the channel opens, even before anything waits on it. */
  channelOpened: Promise<DuplexChannel>;
  privateKey: CryptoKey;
  salt: Uint8Array;
  /** The fallback the offer names. */
  fallback: OfferFallback;
}

/**
 * Mint the key pair, create the WebRTC offer, gather its candidates, and wait
 * for the fallback's relays — then encode all of it into the offer. Resolves
 * with null when cancelled on the way.
 */
export async function createSenderOffer(opts: {
  metadata: TransferMetadata;
  fallback: SenderFallback;
  isCancelled: () => boolean;
  report: (update: SendReport) => void;
  /** Hands the peer connection over the moment it exists, for a cancel. */
  onConnection?: (rtc: WebRTCConnection) => void;
}): Promise<SenderOffer | null> {
  const { metadata, fallback, isCancelled, report } = opts;

  report({ status: 'generating_offer', message: 'Generating keys...' });
  const createdAt = Date.now();
  const ecdhKeyPair = await generateECDHKeyPair();
  const salt = generateSalt();
  if (isCancelled()) return null;

  report({ status: 'generating_offer', message: 'Creating P2P offer...' });
  const iceCandidates: RTCIceCandidate[] = [];
  let offerSDP: RTCSessionDescriptionInit | null = null;
  let announceChannel!: (channel: DuplexChannel) => void;
  const channelOpened = new Promise<DuplexChannel>((resolve) => {
    announceChannel = resolve;
  });
  const rtc = new WebRTCConnection(
    getWebRTCConfig(),
    (signal) => {
      // Collected rather than trickled: there is nothing to trickle them
      // over, so the offer carries every candidate gathered below.
      if (signal.type === 'offer') {
        offerSDP = { type: 'offer', sdp: signal.sdp };
      } else if (signal.type === 'candidate' && signal.candidate) {
        iceCandidates.push(new RTCIceCandidate(signal.candidate));
      }
    },
    (channel) => announceChannel(channel),
  );
  opts.onConnection?.(rtc);

  try {
    rtc.createDataChannel('file-transfer');
    await rtc.createOffer();
    if (isCancelled()) {
      rtc.close();
      return null;
    }

    report({
      status: 'generating_offer',
      message: 'Gathering network info...',
    });
    const iceGatheringComplete = await rtc.waitForIceGatheringComplete(
      ICE_GATHER_TIMEOUT_MS,
    );
    if (!iceGatheringComplete) {
      console.warn(
        'ICE gathering timed out while generating offer; continuing with available candidates',
      );
    }
    report({
      status: 'generating_offer',
      message: iceGatheringComplete
        ? 'Preparing exchange code...'
        : 'Network probe timed out. Preparing exchange code with available routes...',
    });
    if (isCancelled()) {
      rtc.close();
      return null;
    }

    // The relay probe usually finished under ICE gathering. A backfill from
    // discovery can outlast it, and since the offer has to name its relays,
    // that wait is reported rather than hidden.
    const showPhase = (phase: RelayResolvePhase) =>
      report({
        status: 'generating_offer',
        message: RELAY_PHASE_MESSAGES[phase],
      });
    const unfollow = fallback.followResolve(showPhase);
    const pending = fallback.resolvePhase();
    if (pending) showPhase(pending);
    let offerFallback: OfferFallback;
    try {
      offerFallback = await fallback.settled;
    } finally {
      unfollow();
    }
    if (isCancelled()) {
      rtc.close();
      return null;
    }

    if (!offerSDP) {
      throw new Error('Failed to create offer: no SDP was produced');
    }
    const offerBinary = generateMutualOfferBinary(offerSDP, iceCandidates, {
      createdAt,
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      contentEncoding: metadata.contentEncoding,
      mimeType: metadata.mimeType,
      publicKey: ecdhKeyPair.publicKeyBytes,
      salt,
      ...(offerFallback.kind === 'anonymous'
        ? { anonymous: true }
        : offerFallback.kind === 'relay'
          ? { relays: offerFallback.controlRelays }
          : {}),
    });

    return {
      offerBinary,
      createdAt,
      rtc,
      channelOpened,
      privateKey: ecdhKeyPair.privateKey,
      salt,
      fallback: offerFallback,
    };
  } catch (error) {
    rtc.close();
    throw error;
  }
}

/**
 * Parse a response the sender took in. Throws on anything that is not a
 * well-formed answer; its authenticity is checked by `completeSend`.
 */
export function readAnswer(answerBinary: Uint8Array): SignalingPayload {
  const parsed = parseMutualPayload(answerBinary);
  if (!parsed) throw new Error('Invalid response format');
  if (parsed.type !== 'answer') throw new Error('Expected answer, got offer');
  return parsed;
}

const CODE_CONNECTION_TIMEOUT_MS = 120000;
// When a fallback is available, the direct attempt is capped well below the
// full timeout: the offerer keeps real candidates to try against the
// receiver's unreachable ones, so its ICE agent is slow to declare failure,
// while the receiver (with no viable candidates) has already given up. A
// direct connection that is going to work opens in a few seconds; if none has
// after this window, relay it rather than ride out the full backstop.
const RELAY_FALLBACK_ATTEMPT_TIMEOUT_MS = 20000;
const RELAY_FALLBACK_MESSAGE =
  'No direct connection — relaying the file through Nostr instead';
const TOR_FALLBACK_MESSAGE =
  'No direct connection — relaying the file through Tor instead';

export interface CompleteSendOptions {
  offer: SenderOffer;
  /** The response, parsed by `readAnswer`; verified here before use. */
  answer: SignalingPayload;
  content: TransferSource;
  metadata: TransferMetadata;
  fallback: SenderFallback;
  /** The Tor client's progress, for the anonymous fallback. */
  torProgress: TorProgress | null;
  isCancelled: () => boolean;
  report: (update: SendReport) => void;
  /** What to say when the response is not one to this offer. */
  answerMismatchMessage: string;
}

/**
 * Act on an accepted response: verify it, connect directly, and send the file
 * — or, when no direct route opens, send it through the fallback the offer
 * named. Resolves once the file is delivered, or early when cancelled.
 */
export async function completeSend(opts: CompleteSendOptions): Promise<void> {
  const { offer, answer, content, metadata, fallback, isCancelled, report } =
    opts;
  const { fileName, fileSize, mimeType, contentEncoding } = metadata;
  const fileMetadata = { fileName, fileSize, mimeType };
  const { rtc, salt } = offer;

  // A response is judged by the session it answers.
  if (Date.now() - offer.createdAt > TRANSFER_EXPIRATION_MS) {
    throw new Error('Session expired. Please start a new transfer.');
  }

  report({
    status: 'connecting',
    message: 'Establishing secure connection...',
  });

  // Non-extractable, and it outlives the content key: the fallback derives
  // its session from it.
  const sharedSecretKey = await deriveSharedSecretKey(
    offer.privateKey,
    new Uint8Array(answer.publicKey),
  );

  // Key confirmation before anything in the answer is acted on. The tag is
  // keyed by the shared secret just derived and bound to both this offer and
  // the answer's own contents, so only a peer that read this offer and
  // completed the same agreement can produce one, and only for the answer it
  // actually sent: an answer meant for another transfer, a replayed answer,
  // and one whose SDP or candidates were altered on the way back all fail
  // here instead of surfacing later as a connection that never opens.
  const expectedConfirmation = await deriveAnswerConfirmation(
    sharedSecretKey,
    salt,
    {
      offerTranscriptHash: await computeOfferTranscriptHash(offer.offerBinary),
      answerTranscriptHash: await computeAnswerTranscriptHash(answer),
    },
  );
  const presentedConfirmation = decodeAnswerConfirmation(answer.confirm);
  if (
    !presentedConfirmation ||
    !constantTimeEqualBytes(presentedConfirmation, expectedConfirmation)
  ) {
    throw new Error(opts.answerMismatchMessage);
  }

  const key = await deriveAESKeyFromSecretKey(sharedSecretKey, salt);

  await rtc.handleSignal({ type: 'answer', sdp: answer.sdp });
  for (const candidate of answer.candidates) {
    await rtc.handleSignal({
      type: 'candidate',
      candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0 },
    });
  }

  // Which relays carry the fallback's control channel, or null when there is
  // no fallback at all.
  const named = offer.fallback;
  const fallbackRelays =
    named.kind === 'relay'
      ? named.controlRelays
      : named.kind === 'anonymous'
        ? named.relays
        : null;
  const pool = fallback.pool;

  // With a fallback available, the relay session is derived now and the
  // control relays are watched for the receiver's `hello` while the direct
  // attempt runs: the receiver gives up on the direct route long before this
  // side's ICE agent does, and its hello — sealed under the session key only
  // it and this side hold — is the earliest word that the file has to go
  // through the fallback.
  let relaySession: RelaySession | null = null;
  let helloWatch: ReturnType<typeof watchForReceiverHello> | null = null;
  if (fallbackRelays !== null && pool) {
    relaySession = await deriveRelaySession(sharedSecretKey, salt);
    if (isCancelled()) {
      wipeBufferSource(relaySession.keyBytes);
      return;
    }
    helloWatch = watchForReceiverHello(pool, fallbackRelays, relaySession, {
      since: Math.floor(offer.createdAt / 1000),
      expiresAt: Math.floor((offer.createdAt + TRANSFER_EXPIRATION_MS) / 1000),
      ...(named.kind === 'relay' ? { stats: named.storage.stats } : {}),
    });
  }

  let channel: DuplexChannel;
  try {
    channel = await waitForDataChannel(
      rtc,
      offer.channelOpened,
      relaySession !== null
        ? RELAY_FALLBACK_ATTEMPT_TIMEOUT_MS
        : CODE_CONNECTION_TIMEOUT_MS,
      helloWatch?.hello ?? null,
    );
  } catch (error) {
    if (
      !(error instanceof P2PConnectionError) ||
      relaySession === null ||
      fallbackRelays === null ||
      !pool ||
      isCancelled()
    ) {
      if (relaySession) wipeBufferSource(relaySession.keyBytes);
      throw error;
    }
    if (content.estimatedSize > SLOW_TRANSPORT_MAX_BYTES) {
      wipeBufferSource(relaySession.keyBytes);
      throw new P2PConnectionError(
        `${error.message}. The file is over ${formatFileSize(SLOW_TRANSPORT_MAX_BYTES)}, so it cannot be relayed through ${named.kind === 'anonymous' ? 'Tor' : 'Nostr'} either.`,
      );
    }
    rtc.close();
    // The fallback runs its own control channel; the hello has done its job.
    helloWatch?.close();
    if (named.kind === 'anonymous' && fallback.transport) {
      await anonymousFallback(
        pool,
        named.relays,
        relaySession,
        fallback.transport,
      );
    } else if (named.kind === 'relay') {
      await relayFallback(pool, named, relaySession);
    } else {
      wipeBufferSource(relaySession.keyBytes);
      throw error;
    }
    return;
  } finally {
    helloWatch?.close();
  }
  // The direct route opened; the relay session is not needed.
  if (relaySession) wipeBufferSource(relaySession.keyBytes);

  if (isCancelled()) return;

  // Enforce TTL again right before data transfer begins
  if (Date.now() - offer.createdAt > TRANSFER_EXPIRATION_MS) {
    throw new Error('Session expired. Please start a new transfer.');
  }

  const transferring = (current: number, total: number): SendReport => ({
    status: 'transferring',
    message: 'Sending via P2P...',
    progress: { current, total },
    contentType: 'file',
    fileMetadata,
    useWebRTC: true,
  });
  report(transferring(0, fileSize));

  // Encrypted chunks as the channel takes them, then `end`; complete once
  // all of it has left this side's buffer.
  await sendFileOverLink(channel, key, content, {
    onProgress: (current, total) => {
      if (!isCancelled()) report(transferring(current, total));
    },
    isCancelled,
  });

  if (isCancelled()) return;
  report({
    status: 'complete',
    message: 'File sent via P2P!',
    contentType: 'file',
    useWebRTC: true,
  });
  // The bytes left this side's buffer, not this machine: the connection stays
  // up until the receiver hangs up with the file, so the caller's close
  // cannot cut off what the transport is still delivering.
  await lingerAfterSend(channel, isCancelled);

  /**
   * The anonymous relay data path: the same session keys an encrypted control
   * channel on the onion relay pool, and the file goes over a v3 onion
   * service this tab publishes rather than to storage relays.
   *
   * Neither of the two values the Tor transport normally asks a person for
   * is handed over: the password comes out of the ECDH secret on both sides,
   * and the address — which cannot be derived — is announced on that control
   * channel. Both happen here, after the response was accepted and verified,
   * which is what keeps the service unreachable until then. See
   * lib/tor/code-relay.ts.
   */
  async function anonymousFallback(
    pool: TransferPool,
    relays: string[],
    session: RelaySession,
    transport: AnonymousSignalingTransport,
  ): Promise<void> {
    const relayState = {
      contentType: 'file' as const,
      fileMetadata,
      currentRelays: relays,
    };
    const torStatus = (message: string) =>
      report({
        status: 'connecting',
        message: `${TOR_FALLBACK_MESSAGE}. ${message}`,
        ...relayState,
      });
    torStatus(opts.torProgress?.latest() || 'Starting the Tor client...');
    // The bootstrap has been running behind the exchange; this is only the
    // wait for whatever is left of it, and its own progress is the
    // transfer's now that there is nothing else on screen — a cold start is
    // minutes, and one frozen line for all of them reads as a hang.
    const unfollow = opts.torProgress?.follow((message) => {
      if (!isCancelled()) torStatus(message);
    });
    let client: Awaited<ReturnType<typeof transport.torClient>>;
    try {
      client = await transport.torClient();
    } catch (error) {
      // A bootstrap that never finished handed the session on to nothing, so
      // these bytes die here rather than riding the throw out to a catch that
      // only reports it.
      wipeBufferSource(session.keyBytes);
      throw error;
    } finally {
      unfollow?.();
    }
    if (isCancelled()) {
      wipeBufferSource(session.keyBytes);
      return;
    }

    try {
      await serveOverAnonymousRelay({
        client,
        pool,
        relays,
        session,
        since: Math.floor(offer.createdAt / 1000),
        expiresAt: Math.floor(
          (offer.createdAt + TRANSFER_EXPIRATION_MS) / 1000,
        ),
        password: await deriveOnionPassword(sharedSecretKey, salt),
        content,
        metadata: {
          contentType: 'file',
          fileName,
          fileSize,
          contentEncoding,
          mimeType,
        },
        fileMetadata,
        isCancelled,
        onStatus: (message) => {
          if (isCancelled()) return;
          report({
            status: 'waiting_for_receiver',
            message: `${TOR_FALLBACK_MESSAGE}. ${message}`,
            ...relayState,
          });
        },
        onProgress: (current, total, message) => {
          if (isCancelled()) return;
          report({
            status: 'uploading',
            message,
            progress: { current, total },
            ...relayState,
          });
        },
      });
    } finally {
      // Nothing downstream took ownership of these: the control key was
      // derived from them and the file key came from the handshake.
      wipeBufferSource(session.keyBytes);
    }

    if (isCancelled()) return;
    report({
      status: 'complete',
      message: 'File sent through Tor!',
      contentType: 'file',
      fileMetadata,
    });
  }

  /**
   * The relay data path: the session both sides derive from the ECDH secret
   * keys the transfer, the relays the offer named carry its control channel,
   * and the storage ring prepared behind the exchange holds the pieces. Only
   * now is the file read, hashed, and uploaded — nothing was staged while a
   * direct connection was still possible.
   */
  async function relayFallback(
    pool: TransferPool,
    named: Extract<OfferFallback, { kind: 'relay' }>,
    session: RelaySession,
  ): Promise<void> {
    const { controlRelays } = named;
    const relayState = {
      contentType: 'file' as const,
      fileMetadata,
      currentRelays: controlRelays,
    };
    // From here on the storage preparation's progress is the transfer's.
    const unfollow = fallback.followStorage((p) => {
      if (isCancelled()) return;
      report({
        status: 'discovering_relays',
        message:
          p.phase === 'discovering'
            ? `${RELAY_FALLBACK_MESSAGE}. Finding storage relays...`
            : `${RELAY_FALLBACK_MESSAGE}. Testing storage relays... ${p.relaysHealthy ?? 0} working of ${p.relaysChecked ?? 0} checked`,
        ...relayState,
        stats: p.stats,
      });
    });
    try {
      report({
        status: 'preparing',
        message: `${RELAY_FALLBACK_MESSAGE}. Reading file...`,
        ...relayState,
      });
      // `session.keyBytes` belong to sendFileLive once it runs; until then
      // every exit wipes them here.
      let data: Uint8Array;
      try {
        data = await readSourceFully(content, isCancelled);
      } catch (error) {
        wipeBufferSource(session.keyBytes);
        if (error instanceof NostrFileCancelledError) return;
        throw error;
      }
      if (data.length === 0 || isCancelled()) {
        wipeBufferSource(session.keyBytes);
        if (isCancelled()) return;
        throw new Error('File is empty');
      }
      const relayFileSize = data.length;
      let lastStats: NostrFileTransferStats | undefined;
      try {
        await sendFileLive(
          data,
          { fileName, mimeType, precompressed: content.precompressed },
          {
            pool,
            session,
            controlRelays,
            storageRelays: named.storage,
            isCancelled,
            onProgress: (p) => {
              if (isCancelled()) return;
              lastStats = p.stats;
              switch (p.phase) {
                case 'hashing':
                  report({
                    status: 'preparing',
                    message: `${RELAY_FALLBACK_MESSAGE}. Encrypting file...`,
                    ...relayState,
                    stats: p.stats,
                  });
                  break;
                case 'transfer': {
                  const chunksDone = p.chunksDone ?? 0;
                  const chunksTotal = p.chunksTotal ?? 1;
                  const have = p.receiverHave ?? 0;
                  let message: string;
                  if (!p.receiverConnected) {
                    message =
                      chunksDone === chunksTotal
                        ? 'All pieces uploaded to relays. Waiting for the receiver...'
                        : `Uploading pieces to relays (${chunksDone}/${chunksTotal})... waiting for the receiver.`;
                  } else if (have >= chunksTotal) {
                    message = 'Receiver has every piece — verifying...';
                  } else {
                    message = `Relaying through Nostr — receiver has ${have}/${chunksTotal} pieces (uploaded ${chunksDone}/${chunksTotal}${
                      p.resent ? `, re-sent ${p.resent}` : ''
                    }).`;
                  }
                  report({
                    status: 'uploading',
                    message,
                    progress: {
                      current: Math.min(
                        have * chunkBytesEstimate(relayFileSize, chunksTotal),
                        relayFileSize,
                      ),
                      total: relayFileSize,
                    },
                    ...relayState,
                    stats: p.stats,
                  });
                  break;
                }
              }
            },
          },
        );
      } catch (error) {
        if (error instanceof NostrFileCancelledError) return;
        throw error;
      }
      if (isCancelled()) return;
      report({
        status: 'complete',
        message: 'File sent through Nostr relays!',
        contentType: 'file',
        fileMetadata,
        stats: lastStats,
      });
    } finally {
      unfollow();
    }
  }
}

/**
 * Resolve with the channel once it opens; reject on ICE failure, on the
 * timeout, or as soon as `receiverGaveUp` settles (the receiver has reported
 * over the fallback's control relays that no direct route exists).
 */
async function waitForDataChannel(
  rtc: WebRTCConnection,
  channelOpened: Promise<DuplexChannel>,
  timeoutMs: number,
  receiverGaveUp: Promise<void> | null,
): Promise<DuplexChannel> {
  const pc = rtc.getPeerConnection();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onStateChange: (() => void) | undefined;
  const dead = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new P2PConnectionError('Connection timeout'));
    }, timeoutMs);
    if (receiverGaveUp) {
      void (async () => {
        try {
          await receiverGaveUp;
        } catch {
          // A failed hello watch only disables this early-exit signal; ICE
          // failure and the connection timeout remain authoritative.
          return;
        }
        reject(
          new P2PConnectionError(
            'The receiver reports no direct connection is possible',
          ),
        );
      })();
    }
    onStateChange = () => {
      if (
        pc.connectionState === 'failed' ||
        pc.connectionState === 'disconnected'
      ) {
        reject(new P2PConnectionError('Connection failed'));
      }
    };
    pc.addEventListener('connectionstatechange', onStateChange);
    onStateChange();
  });
  try {
    return await Promise.race([channelOpened, dead]);
  } finally {
    clearTimeout(timeout);
    if (onStateChange) {
      pc.removeEventListener('connectionstatechange', onStateChange);
    }
  }
}
