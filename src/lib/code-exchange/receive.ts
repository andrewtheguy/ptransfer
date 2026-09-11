import type { AppendSink } from '@/lib/append-sink';
import {
  type AnswerConfirmationSigner,
  computeOfferTranscriptHash,
  generateMutualAnswerBinary,
  isAnonymousOffer,
  parseMutualPayload,
  relaysFromOffer,
  type SignalingPayload,
} from '@/lib/code-signaling';
import {
  deriveAESKeyFromSecretKey,
  deriveAnswerConfirmation,
  deriveSharedSecretKey,
  generateECDHKeyPair,
  MAX_MESSAGE_SIZE,
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
import { receiveFileLive } from '@/lib/nostr-file/download-live';
import { deriveRelaySession } from '@/lib/nostr-file/session';
import type { NostrFileTransferStats } from '@/lib/nostr-file/stats';
import { createTransferPool } from '@/lib/nostr-file/transfer-pool';
import { NostrFileCancelledError } from '@/lib/nostr-file/upload';
import {
  createTransferReceiver,
  type TransferReceiver,
} from '@/lib/p2p-transfer';
import { createAdaptiveAppendSink } from '@/lib/scratch-sink';
import {
  deriveOnionPassword,
  receiveOverAnonymousRelay,
} from '@/lib/tor/code-relay';
import type { ReceivedContent } from '@/lib/types';
import { WebRTCConnection } from '@/lib/webrtc';
import { getWebRTCConfig } from '@/lib/webrtc-config';
import type { TorProgress } from './tor-progress';

/**
 * The receiving half of a Code Exchange session, whichever way its two codes
 * travel — handed over by a person, or carried by PIN Exchange's sealed
 * channel. See `send.ts` for the other half.
 */

type TransferPool = ReturnType<typeof createTransferPool>;

/** Somewhere a hook keeps a resource its cancel has to reach. */
export interface Holder<T> {
  current: T | null;
}

/** A status update, shaped to drop straight into either receive hook. */
export interface ReceiveReport {
  status:
    | 'generating_answer'
    | 'connecting'
    | 'receiving'
    | 'fetching'
    | 'complete';
  message: string;
  progress?: { current: number; total: number };
  contentType?: 'file';
  fileMetadata?: FileMetadata;
  currentRelays?: string[];
  useWebRTC?: boolean;
  stats?: NostrFileTransferStats;
}

/**
 * An offer as it arrived, plus the digest of the container it arrived in. The
 * digest is what the answer's confirmation tag is bound to, so it has to be
 * taken from the bytes the receiver was handed rather than recomputed from the
 * parsed payload later.
 */
export interface ReadOffer {
  payload: SignalingPayload;
  transcriptHash: string;
}

/** Parse an offer container. Throws on anything that is not an offer. */
export async function readOffer(offerBinary: Uint8Array): Promise<ReadOffer> {
  const parsed = parseMutualPayload(offerBinary);
  if (!parsed) throw new Error('Invalid offer format');
  if (parsed.type !== 'offer') throw new Error('Expected offer, got answer');
  // Hash the container as it arrived, before anything downstream can reshape
  // it; the answer's confirmation tag is bound to this exact value.
  return {
    payload: parsed,
    transcriptHash: await computeOfferTranscriptHash(offerBinary),
  };
}

/** An offer this side has agreed to act on. */
export interface AcceptedOffer {
  payload: SignalingPayload;
  transcriptHash: string;
  createdAt: number;
  metadata: TransferMetadata;
  salt: Uint8Array;
  senderPublicKey: Uint8Array;
  /**
   * Which fallback the offer asks for. The sender's choice alone, and the
   * only thing that decides it: the receiving side has nothing to turn on.
   */
  fallback: 'relay' | 'anonymous' | 'none';
  /**
   * The control relays of that fallback, or null when there is none. An
   * anonymous offer names none because its pool is a constant both sides
   * hold, so everything downstream reads this rather than the offer's list.
   */
  fallbackRelays: string[] | null;
}

/**
 * Check an offer's session and description, and settle which fallback it
 * asks for. Throws with the reason on anything this side will not act on.
 */
export function acceptOffer({
  payload,
  transcriptHash,
}: ReadOffer): AcceptedOffer {
  if (Date.now() - payload.createdAt > TRANSFER_EXPIRATION_MS) {
    throw new Error('Offer expired. Ask sender to create a new one.');
  }

  const { fileName, fileSize, contentEncoding, mimeType, salt } = payload;
  if (!salt) {
    throw new Error('Invalid offer: missing encryption salt');
  }
  if (
    !fileName ||
    !mimeType ||
    typeof fileSize !== 'number' ||
    !Number.isFinite(fileSize) ||
    fileSize < 0 ||
    (contentEncoding !== 'deflate-raw' && contentEncoding !== 'identity')
  ) {
    throw new Error('Invalid offer: missing or invalid file metadata');
  }
  if (fileSize > MAX_MESSAGE_SIZE) {
    throw new Error(
      `Transfer rejected: Size (${formatFileSize(fileSize)}) exceeds limit (${formatFileSize(MAX_MESSAGE_SIZE)})`,
    );
  }

  const anonymous = isAnonymousOffer(payload);
  const offerRelays = relaysFromOffer(payload);
  return {
    payload,
    transcriptHash,
    createdAt: payload.createdAt,
    metadata: {
      contentType: 'file',
      fileName,
      fileSize,
      contentEncoding,
      mimeType,
    },
    salt: new Uint8Array(salt),
    senderPublicKey: new Uint8Array(payload.publicKey),
    fallback: anonymous ? 'anonymous' : offerRelays ? 'relay' : 'none',
    fallbackRelays: anonymous ? [...ANONYMOUS_SIGNALING_RELAYS] : offerRelays,
  };
}

/** Whether two descriptions name the same file, field for field. */
export function sameTransferMetadata(
  a: TransferMetadata,
  b: TransferMetadata,
): boolean {
  return (
    a.contentType === b.contentType &&
    a.fileName === b.fileName &&
    a.fileSize === b.fileSize &&
    a.contentEncoding === b.contentEncoding &&
    a.mimeType === b.mimeType
  );
}

/**
 * The relays a fallback could hand this file to, or null when there is no
 * fallback that could carry it. Named relays are not enough on their own:
 * past the fallback's size cap it would refuse the file.
 */
export function eligibleFallbackRelays(offer: AcceptedOffer): string[] | null {
  return offer.fallbackRelays &&
    offer.metadata.fileSize <= SLOW_TRANSPORT_MAX_BYTES
    ? offer.fallbackRelays
    : null;
}

/**
 * The error a dead direct route ends in when the fallback cannot take over:
 * the route's own, or — past the size cap — one that says why the fallback
 * could not help either.
 */
export function unrelayableError(
  offer: AcceptedOffer,
  error: P2PConnectionError,
): P2PConnectionError {
  if (offer.metadata.fileSize <= SLOW_TRANSPORT_MAX_BYTES) return error;
  return new P2PConnectionError(
    `${error.message}. The file is over ${formatFileSize(SLOW_TRANSPORT_MAX_BYTES)}, so it cannot be relayed through ${offer.fallback === 'anonymous' ? 'Tor' : 'Nostr'} either.`,
  );
}

/**
 * Everything one answer's ECDH key pair yields. The relay session is derived
 * from the same shared secret, so a new key pair is also a new relay session
 * — which is how a response is given a control channel with no history.
 */
export interface AnswerKeys {
  publicKeyBytes: Uint8Array;
  /** Chunk key for the direct path. */
  key: CryptoKey;
  /** Root of the relay session and of the confirmation tag. */
  sharedSecretKey: CryptoKey;
  /**
   * Signs the answer once its fields are settled: proves to the sender that
   * this answer, unaltered, came from a peer that read its offer and reached
   * the same shared secret. Travels inside the answer with nothing for either
   * operator to read or type.
   */
  signAnswer: AnswerConfirmationSigner;
}

export async function deriveAnswerKeys(
  offer: AcceptedOffer,
): Promise<AnswerKeys> {
  const ecdhKeyPair = await generateECDHKeyPair();
  const sharedSecretKey = await deriveSharedSecretKey(
    ecdhKeyPair.privateKey,
    offer.senderPublicKey,
  );
  return {
    publicKeyBytes: ecdhKeyPair.publicKeyBytes,
    key: await deriveAESKeyFromSecretKey(sharedSecretKey, offer.salt),
    sharedSecretKey,
    signAnswer: (answerTranscriptHash: string) =>
      deriveAnswerConfirmation(sharedSecretKey, offer.salt, {
        offerTranscriptHash: offer.transcriptHash,
        answerTranscriptHash,
      }),
  };
}

const ICE_GATHER_TIMEOUT_MS = 5000;

/** One direct attempt: its peer connection, receiver, sink, and answer. */
export interface DirectAttempt {
  receiver: TransferReceiver;
  answerBinary: Uint8Array;
  /** The answer's SDP, which a simulated dead route reuses. */
  answerSDP: RTCSessionDescriptionInit;
  /** Resolves with the open data channel, rejects on a dead route. */
  opened: Promise<DuplexChannel>;
  /** Ends that wait now, with the reason the caller should act on. */
  stop: (error: Error) => void;
  /** Peer connection, receiver and sink, discarded together. */
  dispose: () => void;
}

/**
 * Answer the offer with a fresh peer connection, a streaming receiver and a
 * receive sink behind it. Resolves with null when cancelled on the way, having
 * discarded everything it built.
 */
export async function buildDirectAttempt(opts: {
  offer: AcceptedOffer;
  keys: AnswerKeys;
  /** Holds the attempt's sink while it is current, so a cancel can drop it. */
  sinkHolder: Holder<AppendSink>;
  /** Holds the attempt's peer connection while it is current. */
  rtcHolder: Holder<WebRTCConnection>;
  /** How long the channel may take to open before the route counts as dead. */
  connectionTimeoutMs: number;
  isCancelled: () => boolean;
  report: (update: ReceiveReport) => void;
  onProgress: (current: number, total: number) => void;
}): Promise<DirectAttempt | null> {
  const { offer, keys, sinkHolder, rtcHolder, isCancelled, report } = opts;
  report({ status: 'generating_answer', message: 'Creating P2P answer...' });

  const iceCandidates: RTCIceCandidate[] = [];
  let answerSDP: RTCSessionDescriptionInit | null = null;
  let answerSDPResolver: (() => void) | null = null;
  let dataChannelResolver: ((channel: DuplexChannel) => void) | null = null;
  // Set by the open callback, for a wait that begins after the fact.
  let openChannel: DuplexChannel | null = null;
  let connectionFailedRejecter: ((error: Error) => void) | null = null;
  let stopWait: ((error: Error) => void) | null = null;
  // A dead route can be known before the wait promise below exists (while
  // ICE is still gathering, or the answer is being built). With no rejecter
  // to hand it to yet, the failure is held here so the wait fails fast
  // instead of riding out the full timeout.
  let earlyConnectionFailure: Error | null = null;

  // Decrypted chunks land in the receive sink as they arrive. A cancel during
  // its creation cannot see it through the holder yet, so discard it here
  // instead of leaving its scratch storage orphaned.
  const sink = await createAdaptiveAppendSink(offer.metadata.fileSize);
  if (isCancelled()) {
    void sink.discard();
    return null;
  }
  sinkHolder.current = sink;

  // Streaming receiver: decrypts each chunk into the sink as it arrives
  // (inflating deflated payloads in between) and resolves once the sender's
  // `end` checks out against what it stored.
  const receiver = createTransferReceiver(
    keys.key,
    offer.metadata.contentEncoding,
    sink,
    {
      estimatedBytes: offer.metadata.fileSize,
      onProgress: opts.onProgress,
    },
  );

  const rtc = new WebRTCConnection(
    getWebRTCConfig(),
    (signal) => {
      // Collected rather than trickled; the answer carries them all.
      if (signal.type === 'answer') {
        answerSDP = { type: 'answer', sdp: signal.sdp };
        answerSDPResolver?.();
      } else if (signal.type === 'candidate' && signal.candidate) {
        iceCandidates.push(new RTCIceCandidate(signal.candidate));
      }
    },
    (channel) => {
      // Data channel opened: the receiver takes it over before any message
      // can arrive, and its idle watchdog covers the receiving stage from
      // here on.
      receiver.attach(channel);
      openChannel = channel;
      dataChannelResolver?.(channel);
    },
    (connectionState) => {
      // A dead route is known long before the connection timeout; the
      // fallback starts from it right away.
      if (connectionState === 'failed' || connectionState === 'disconnected') {
        const error = new P2PConnectionError('Connection failed');
        if (connectionFailedRejecter) connectionFailedRejecter(error);
        else earlyConnectionFailure ??= error;
      }
    },
  );

  // Everything this attempt owns goes at once, so the next one starts from
  // nothing. The sink is only reachable through the holder while this
  // attempt is the current one.
  const dispose = () => {
    receiver.dispose();
    rtc.close();
    if (rtcHolder.current === rtc) rtcHolder.current = null;
    if (sinkHolder.current === sink) sinkHolder.current = null;
    void sink.discard();
  };

  if (isCancelled()) {
    dispose();
    return null;
  }
  rtcHolder.current = rtc;

  try {
    await rtc.handleSignal({ type: 'offer', sdp: offer.payload.sdp });
    for (const candidate of offer.payload.candidates) {
      await rtc.handleSignal({
        type: 'candidate',
        candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0 },
      });
    }
    if (isCancelled()) {
      dispose();
      return null;
    }

    report({ status: 'generating_answer', message: 'Generating answer...' });
    await new Promise<void>((resolve) => {
      if (answerSDP) {
        resolve();
      } else {
        answerSDPResolver = resolve;
        setTimeout(resolve, 10000);
      }
    });
    if (isCancelled()) {
      dispose();
      return null;
    }

    report({
      status: 'generating_answer',
      message: 'Gathering network info...',
    });
    const iceGatheringComplete = await rtc.waitForIceGatheringComplete(
      ICE_GATHER_TIMEOUT_MS,
    );
    if (!iceGatheringComplete) {
      console.warn(
        'ICE gathering timed out while generating answer; continuing with available candidates',
      );
    }
    report({
      status: 'generating_answer',
      message: iceGatheringComplete
        ? 'Preparing response code...'
        : 'Network probe timed out. Preparing response code with available routes...',
    });
    if (isCancelled()) {
      dispose();
      return null;
    }

    if (!answerSDP) {
      throw new Error(
        'Failed to generate answer SDP: Answer was not created by WebRTC connection',
      );
    }
    const settledAnswerSDP: RTCSessionDescriptionInit = answerSDP;

    const answerBinary = await generateMutualAnswerBinary(
      settledAnswerSDP,
      iceCandidates,
      keys.publicKeyBytes,
      keys.signAnswer,
    );
    if (isCancelled()) {
      dispose();
      return null;
    }

    const opened = new Promise<DuplexChannel>((resolve, reject) => {
      // A failure that landed before this promise existed is not lost.
      if (earlyConnectionFailure) {
        reject(earlyConnectionFailure);
        return;
      }
      const timeout = setTimeout(() => {
        reject(new P2PConnectionError('Connection timeout'));
      }, opts.connectionTimeoutMs);
      dataChannelResolver = (channel) => {
        clearTimeout(timeout);
        resolve(channel);
      };
      connectionFailedRejecter = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      stopWait = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      if (openChannel) {
        clearTimeout(timeout);
        resolve(openChannel);
      }
    });
    // The caller awaits this a tick later; keep a rejection that already
    // landed from being reported as unhandled in between.
    void opened.catch(() => {});

    return {
      receiver,
      answerBinary,
      answerSDP: settledAnswerSDP,
      opened,
      stop: (error) => stopWait?.(error),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/**
 * Wait for a connected direct attempt's transfer to finish, then hang up.
 * Resolves with the sealed payload once the sender's `end` has checked out,
 * or null when cancelled. The sender hears nothing but the close: it is
 * complete once its bytes are out, and the two people confirm the rest
 * between themselves.
 */
export async function finishDirectReceive(opts: {
  attempt: DirectAttempt;
  rtcHolder: Holder<WebRTCConnection>;
  isCancelled: () => boolean;
}): Promise<Blob | null> {
  const { attempt, isCancelled } = opts;
  const { receiver } = attempt;

  // The receiver decrypts, authenticates and writes chunks to the sink as
  // they arrive, and resolves with the sealed payload once `end` checks out.
  // A stalled stream is aborted by its own idle watchdog; a cancel is told to
  // the sender by the close below.
  const payload = await new Promise<Blob>((resolve, reject) => {
    const checkInterval = setInterval(() => {
      if (isCancelled()) {
        clearInterval(checkInterval);
        receiver.dispose();
        reject(new Error('Cancelled'));
      }
    }, 500);
    receiver.done.then(
      (data) => {
        clearInterval(checkInterval);
        resolve(data);
      },
      (error: unknown) => {
        clearInterval(checkInterval);
        reject(error);
      },
    );
  });
  // The connection is this function's to close now: the file is whole, and
  // the close is how the sender learns it may let go.
  const rtc = opts.rtcHolder.current;
  opts.rtcHolder.current = null;
  rtc?.close();
  if (isCancelled()) return null;
  return payload;
}

const RELAY_FALLBACK_MESSAGE =
  'No direct connection — receiving the file through Nostr instead';
const TOR_FALLBACK_MESSAGE =
  'No direct connection — receiving the file through Tor instead';

/** What the fallback's control relays are called on screen. */
export function fallbackMessage(offer: AcceptedOffer): string {
  return offer.fallback === 'anonymous'
    ? TOR_FALLBACK_MESSAGE
    : RELAY_FALLBACK_MESSAGE;
}

/** A file the fallback delivered, and what to say about it. */
export interface FallbackReceipt {
  content: ReceivedContent;
  message: string;
  stats?: NostrFileTransferStats;
  /** The storage behind `content.data`, when it has any, for the caller to discard. */
  sink?: AppendSink;
}

export interface FallbackReceiveOptions {
  offer: AcceptedOffer;
  keys: AnswerKeys;
  /** The Tor client an anonymous offer's fallback runs on. */
  transport: AnonymousSignalingTransport | null;
  torProgress: TorProgress | null;
  /**
   * Set while the response has not reached the sender yet: nothing has begun
   * until the sender turns up on the control channel, so this is called in
   * place of progress until then, with the Tor client's latest line.
   */
  hold: ((torStatus: string) => void) | null;
  /** Holds the control channel's pool, so a cancel can close it. */
  poolHolder: Holder<TransferPool>;
  /** True once the caller wants the fallback abandoned for a direct attempt. */
  switchedBack: () => boolean;
  isCancelled: () => boolean;
  report: (update: ReceiveReport) => void;
}

/**
 * Receive the file through whichever fallback the offer asked for. Resolves
 * with the file, 'switched' when `switchedBack` ended it, or null when it was
 * cancelled.
 */
export function receiveOverFallback(
  opts: FallbackReceiveOptions,
): Promise<FallbackReceipt | 'switched' | null> {
  if (opts.offer.fallback === 'anonymous') {
    if (!opts.transport) {
      return Promise.reject(
        new Error('The Tor fallback needs a Tor client, and none is running'),
      );
    }
    return receiveOverTorFallback(opts, opts.transport);
  }
  return receiveOverRelayFallback(opts);
}

async function receiveOverRelayFallback(
  opts: FallbackReceiveOptions,
): Promise<FallbackReceipt | 'switched' | null> {
  const { offer, keys, hold, switchedBack, isCancelled, report } = opts;
  const relays = offer.fallbackRelays;
  if (!relays) throw new Error('This offer names no fallback relays');
  const { fileName, fileSize, mimeType } = offer.metadata;
  const stopped = () => isCancelled() || switchedBack();

  const pool = createTransferPool();
  opts.poolHolder.current = pool;
  let lastStats: NostrFileTransferStats | undefined;
  const relayState = {
    contentType: 'file' as const,
    fileMetadata: { fileName, fileSize, mimeType },
    currentRelays: relays,
  };
  if (hold) {
    hold('');
  } else {
    report({
      status: 'fetching',
      message: `${RELAY_FALLBACK_MESSAGE}. Connecting to relays...`,
      progress: { current: 0, total: fileSize },
      ...relayState,
    });
  }
  let data: Uint8Array;
  try {
    const session = await deriveRelaySession(keys.sharedSecretKey, offer.salt);
    data = await receiveFileLive(session, relays, {
      pool,
      isCancelled: stopped,
      since: Math.floor(offer.createdAt / 1000),
      expiresAt: Math.floor((offer.createdAt + TRANSFER_EXPIRATION_MS) / 1000),
      // While the response is still waiting to be handed over, the sender has
      // nothing to answer with yet, so its silence must not time the fetch
      // out from under it.
      awaitingHandover: hold !== null,
      onProgress: (p) => {
        if (stopped()) return;
        lastStats = p.stats;
        // Nothing from the sender yet: hold instead of showing a progress
        // bar for a transfer the sender has not started.
        if (hold && !p.manifest) {
          hold('');
          return;
        }
        const total = p.manifest?.fileSize ?? fileSize;
        const chunkBytes = Math.ceil(total / Math.max(p.chunksTotal, 1));
        report({
          status: 'fetching',
          message: !p.manifest
            ? `${RELAY_FALLBACK_MESSAGE}. Waiting for the sender...`
            : p.chunksDone === p.chunksTotal
              ? 'All pieces received — verifying...'
              : `Receiving pieces through relays... ${p.chunksDone}/${p.chunksTotal} (sender has uploaded ${p.available})`,
          progress: {
            current: Math.min(p.chunksDone * chunkBytes, total),
            total,
          },
          ...relayState,
          stats: p.stats,
        });
      },
    });
  } catch (error) {
    if (error instanceof NostrFileCancelledError) {
      return switchedBack() ? 'switched' : null;
    }
    throw error;
  } finally {
    if (opts.poolHolder.current === pool) opts.poolHolder.current = null;
    pool.destroy();
  }
  if (isCancelled()) return null;
  return {
    content: {
      contentType: 'file',
      data: new Blob([data as BlobPart], {
        type: mimeType || 'application/octet-stream',
      }),
      fileName,
      fileSize: data.length,
      mimeType,
    },
    message: 'File received through Nostr relays!',
    stats: lastStats,
  };
}

/**
 * The anonymous relay data path: the same session, an encrypted control
 * channel on the onion relay pool, and the file over the sender's onion
 * service rather than off storage relays.
 */
async function receiveOverTorFallback(
  opts: FallbackReceiveOptions,
  transport: AnonymousSignalingTransport,
): Promise<FallbackReceipt | 'switched' | null> {
  const { offer, keys, hold, switchedBack, isCancelled, report } = opts;
  const relays = offer.fallbackRelays ?? [...ANONYMOUS_SIGNALING_RELAYS];
  const stopped = () => isCancelled() || switchedBack();
  const torStatus = () => opts.torProgress?.latest() ?? '';

  const relayState = {
    contentType: 'file' as const,
    fileMetadata: {
      fileName: offer.metadata.fileName,
      fileSize: offer.metadata.fileSize,
      mimeType: offer.metadata.mimeType,
    },
    currentRelays: relays,
  };
  // Set once the sender has announced its service, which is the first moment
  // anything is happening that a held response could report.
  let senderPresent = hold === null;
  const status = (message: string) => {
    if (stopped()) return;
    if (!senderPresent && hold) {
      hold(torStatus());
      return;
    }
    report({ status: 'fetching', message, ...relayState });
  };

  status(
    `${TOR_FALLBACK_MESSAGE}. ${torStatus() || 'Starting the Tor client...'}`,
  );
  const session = await deriveRelaySession(keys.sharedSecretKey, offer.salt);
  // Created only once the session is in hand, so a failed derivation leaves
  // nothing open; from here the finally below destroys it.
  const pool = createTransferPool({
    websocketImplementation: transport.websocketImplementation,
    connectionTimeoutMs: ANONYMOUS_RELAY_CONNECTION_TIMEOUT_MS,
  });
  opts.poolHolder.current = pool;
  let payload: Blob;
  let sink: AppendSink;
  let received: FileMetadata;
  try {
    // From here until the client is up, its progress is the transfer's only
    // progress, and a cold start is minutes.
    const unfollow = opts.torProgress?.follow((message) =>
      status(`${TOR_FALLBACK_MESSAGE}. ${message}`),
    );
    let client: Awaited<ReturnType<typeof transport.torClient>>;
    try {
      client = await transport.torClient();
    } finally {
      unfollow?.();
    }
    if (switchedBack()) return 'switched';
    if (isCancelled()) return null;
    const receipt = await receiveOverAnonymousRelay({
      client,
      pool,
      relays,
      session,
      since: Math.floor(offer.createdAt / 1000),
      expiresAt: Math.floor((offer.createdAt + TRANSFER_EXPIRATION_MS) / 1000),
      password: await deriveOnionPassword(keys.sharedSecretKey, offer.salt),
      expected: offer.metadata,
      isCancelled: stopped,
      onAnnounced: () => {
        senderPresent = true;
      },
      onStatus: (message) => status(`${TOR_FALLBACK_MESSAGE}. ${message}`),
      onProgress: (current, total) => {
        if (stopped()) return;
        report({
          status: 'fetching',
          message: 'Receiving the file over Tor...',
          progress: { current, total },
          ...relayState,
        });
      },
    });
    payload = receipt.payload;
    sink = receipt.sink;
    received = {
      fileName: receipt.metadata.fileName,
      fileSize: payload.size,
      mimeType: receipt.metadata.mimeType,
    };
  } catch (error) {
    if (switchedBack()) return 'switched';
    if (isCancelled()) return null;
    throw error;
  } finally {
    // Nothing downstream took ownership: the control key was derived from
    // these, and the content key came out of the handshake.
    wipeBufferSource(session.keyBytes);
    if (opts.poolHolder.current === pool) opts.poolHolder.current = null;
    pool.destroy();
  }

  // A cancel that lands after the last frame leaves a payload nobody will
  // read, so its scratch file goes now rather than at the next sweep.
  if (isCancelled()) {
    await sink.discard();
    return null;
  }
  return {
    content: {
      contentType: 'file',
      data: payload,
      fileName: received.fileName,
      fileSize: received.fileSize,
      mimeType: received.mimeType,
    },
    message: 'File received through Tor!',
    sink,
  };
}
