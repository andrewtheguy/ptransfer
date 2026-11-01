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
import { type Localized, t } from '@/lib/i18n';
import { offerLanes } from '@/lib/lanes';
import type { FileMetadata, TransferMetadata } from '@/lib/nostr';
import {
  ANONYMOUS_RELAY_CONNECTION_TIMEOUT_MS,
  type AnonymousSignalingTransport,
} from '@/lib/nostr/anonymous-transport';
import { ANONYMOUS_SIGNALING_RELAYS } from '@/lib/nostr/relays';
import { watchForReceiverHello } from '@/lib/nostr-file/hello-watch';
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
import { type TransferSource, wireEncodingFor } from '@/lib/transfer-source';
import { type PeerConnectionClass, WebRTCConnection } from '@/lib/webrtc';
import { getWebRTCConfig } from '@/lib/webrtc-config';
import { lingerAfterSend } from './hang-up';
import type { ExchangeHost } from './host';
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
  /**
   * The code is waiting on replacements for defunct default relays, and the
   * person may have it shown without them (`SenderFallback.deferBackfill`).
   */
  canDeferBackfill?: boolean;
}

/** Which data-path fallback an offer asks for. */
export type SendFallbackKind = 'relay' | 'anonymous' | 'none';

/** What the sender is doing while it resolves the offer's relays. */
export type RelayResolvePhase =
  | 'probing_defaults'
  | 'discovering'
  | 'probing_discovered';

/** Shown only when relay resolution outlasts WebRTC offer creation. */
const RELAY_PHASE_MESSAGES: Record<RelayResolvePhase, Localized> = {
  probing_defaults: {
    en: 'Checking relays for the fallback...',
    es: 'Comprobando los relays para el respaldo...',
  },
  discovering: {
    en: 'Looking for more storage relays to back them up...',
    es: 'Buscando más relays de almacenamiento como refuerzo...',
  },
  probing_discovered: {
    en: 'Testing the storage relays we found...',
    es: 'Probando los relays de almacenamiento encontrados...',
  },
};

/** The fallback an offer ended up naming. */
export type OfferFallback =
  | {
      kind: 'relay';
      /** The control relays the offer names. */
      controlRelays: string[];
      /** The storage ring, prepared in the background from here on. */
      storage: PreparedStorageRelays;
      /**
       * Null unless the offer went out before its defunct defaults were
       * replaced: then the replacements found behind the code, which the
       * fallback adds to the control set.
       */
      replacements: Promise<string[]> | null;
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
  /**
   * Whether the offer is waiting on a backfill it can go out without: the
   * defaults that passed reach the floor, and the rest are being looked for.
   */
  canDeferBackfill(): boolean;
  /**
   * Settle the offer's relays now, on the defaults that passed, and leave
   * the backfill to run on behind the code. Does nothing unless
   * `canDeferBackfill()`.
   */
  deferBackfill(): void;
  /** Follow storage-ring preparation until the returned function is called. */
  followStorage(listener: (progress: UploadProgress) => void): () => void;
  /** End the sweep and close the pool. The transport stays the caller's. */
  close(): void;
}

export function startSenderFallback(opts: {
  kind: SendFallbackKind;
  /** Where the clearnet fallback's relay cache lives. */
  host: ExchangeHost;
  /** Required for the anonymous fallback; ignored otherwise. */
  transport?: AnonymousSignalingTransport | null;
  isCancelled: () => boolean;
}): SenderFallback {
  let pool: TransferPool | null = null;
  let phase: RelayResolvePhase | null = null;
  let resolveListener: ((phase: RelayResolvePhase) => void) | null = null;
  let deferrable = false;
  let deferNow!: () => void;
  const backfillDeferred = new Promise<void>((resolve) => {
    deferNow = resolve;
  });
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
      throw new Error(
        t({
          en: 'The anonymous fallback needs a Tor client',
          es: 'La alternativa anónima necesita un cliente de Tor',
        }),
      );
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
    // discovery. The person may have the code shown before that backfill
    // finishes; the fallback then adds what it found behind the code. A
    // failure or a set below the floor is not an error: the offer simply
    // names no relays, and a failed direct connection then has no fallback.
    const relayPool = createTransferPool();
    pool = relayPool;
    const storage = opts.host.relayStorage();
    // A deferred backfill keeps reporting after the offer's relays settled;
    // by then its progress is no longer the offer's.
    let resolving = true;
    const setPhase = (next: RelayResolvePhase) => {
      if (!resolving) return;
      phase = next;
      resolveListener?.(next);
    };
    phase = 'probing_defaults';
    settled = (async (): Promise<OfferFallback> => {
      let selection: Awaited<ReturnType<typeof resolveTransferRelays>>;
      try {
        selection = await resolveTransferRelays(relayPool, storage, {
          // A deferred backfill can outlive the transfer's teardown, which
          // must not be recorded as relay failures.
          isCancelled: () => sweepAbort.signal.aborted || opts.isCancelled(),
          stats: createTransferStats('sender'),
          onControlProgress: () => setPhase('probing_defaults'),
          onUploadProgress: (p) =>
            setPhase(
              p.phase === 'discovering' ? 'discovering' : 'probing_discovered',
            ),
          onBackfill: (canDefer) => {
            deferrable = canDefer;
          },
          backfillDeferred,
        });
      } catch {
        resolving = false;
        deferrable = false;
        phase = null;
        close();
        return { kind: 'none' };
      }
      resolving = false;
      deferrable = false;
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
        replacements: selection.replacements,
        storage: prepareStorageRelays(relayPool, {
          controlRelays: selection.controlRelays,
          storage,
          stats: selection.stats,
          discovered: selection.discovered,
          controlReplacements: selection.replacements,
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
    canDeferBackfill: () => deferrable,
    deferBackfill() {
      if (deferrable) deferNow();
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
  /** What `rtc` is built on, and what its lanes are built on too. */
  peerConnection: PeerConnectionClass;
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
  /** What the peer connection is built on. */
  host: ExchangeHost;
  fallback: SenderFallback;
  isCancelled: () => boolean;
  report: (update: SendReport) => void;
  /** Hands the peer connection over the moment it exists, for a cancel. */
  onConnection?: (rtc: WebRTCConnection) => void;
}): Promise<SenderOffer | null> {
  const { metadata, fallback, isCancelled, report } = opts;

  report({
    status: 'generating_offer',
    message: t({ en: 'Generating keys...', es: 'Generando claves...' }),
  });
  const createdAt = Date.now();
  const ecdhKeyPair = await generateECDHKeyPair();
  const salt = generateSalt();
  if (isCancelled()) return null;

  report({
    status: 'generating_offer',
    message: t({
      en: 'Creating P2P offer...',
      es: 'Creando la oferta P2P...',
    }),
  });
  const iceCandidates: string[] = [];
  let offerSDP: RTCSessionDescriptionInit | null = null;
  let announceChannel!: (channel: DuplexChannel) => void;
  const channelOpened = new Promise<DuplexChannel>((resolve) => {
    announceChannel = resolve;
  });
  const rtc = new WebRTCConnection(
    opts.host.peerConnection,
    getWebRTCConfig(),
    (signal) => {
      // Collected rather than trickled: there is nothing to trickle them
      // over, so the offer carries every candidate gathered below.
      if (signal.type === 'offer') {
        offerSDP = { type: 'offer', sdp: signal.sdp };
      } else if (signal.type === 'candidate' && signal.candidate?.candidate) {
        iceCandidates.push(signal.candidate.candidate);
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
      message: t({
        en: 'Gathering network info...',
        es: 'Recopilando información de red...',
      }),
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
        ? t({
            en: 'Preparing exchange code...',
            es: 'Preparando el código de intercambio...',
          })
        : t({
            en: 'Network probe timed out. Preparing exchange code with available routes...',
            es: 'Se agotó el tiempo del sondeo de red. Preparando el código de intercambio con las rutas disponibles...',
          }),
    });
    if (isCancelled()) {
      rtc.close();
      return null;
    }

    // The relay probe usually finished under ICE gathering. A backfill from
    // discovery can outlast it, and since the offer has to name its relays,
    // that wait is reported rather than hidden — with the offer to go out
    // without the backfill when the defaults that passed are enough.
    const showPhase = (phase: RelayResolvePhase) =>
      report({
        status: 'generating_offer',
        message: t(RELAY_PHASE_MESSAGES[phase]),
        canDeferBackfill: fallback.canDeferBackfill(),
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
      throw new Error(
        t({
          en: 'Failed to create offer: no SDP was produced',
          es: 'No se pudo crear la oferta: no se generó ningún SDP',
        }),
      );
    }
    const offerBinary = generateMutualOfferBinary(offerSDP, iceCandidates, {
      createdAt,
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
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
      peerConnection: opts.host.peerConnection,
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
  if (!parsed) {
    throw new Error(
      t({
        en: 'Invalid response format',
        es: 'Formato de respuesta no válido',
      }),
    );
  }
  if (parsed.type !== 'answer') {
    throw new Error(
      t({
        en: 'Expected answer, got offer',
        es: 'Se esperaba una respuesta y llegó una oferta',
      }),
    );
  }
  return parsed;
}

/**
 * Whether `answer` carries a confirmation tag for this offer. The tag is
 * keyed by the shared secret and bound to both this offer and the answer's
 * own contents, so only a peer that read this offer and completed the same
 * agreement can produce one, and only for the answer it actually sent: an
 * answer meant for another transfer, a replayed answer, and one whose SDP or
 * candidates were altered on the way back all fail here instead of surfacing
 * later as a connection that never opens.
 */
async function confirmsAnswer(
  offer: SenderOffer,
  answer: SignalingPayload,
  sharedSecretKey: CryptoKey,
): Promise<boolean> {
  const expected = await deriveAnswerConfirmation(sharedSecretKey, offer.salt, {
    offerTranscriptHash: await computeOfferTranscriptHash(offer.offerBinary),
    answerTranscriptHash: await computeAnswerTranscriptHash(answer),
  });
  const presented = decodeAnswerConfirmation(answer.confirm);
  return presented !== null && constantTimeEqualBytes(presented, expected);
}

/**
 * Whether `answer`, parsed by `readAnswer`, is a response to this offer.
 * `completeSend` refuses one that is not; a host that would rather ask for
 * the response again than end the transfer checks here first.
 */
export async function answersOffer(
  offer: SenderOffer,
  answer: SignalingPayload,
): Promise<boolean> {
  let sharedSecretKey: CryptoKey;
  try {
    sharedSecretKey = await deriveSharedSecretKey(
      offer.privateKey,
      new Uint8Array(answer.publicKey),
    );
  } catch {
    // 65 bytes with the right prefix, but not a point on the curve: no
    // agreement with this offer's key, so not a response to it.
    return false;
  }
  return await confirmsAnswer(offer, answer, sharedSecretKey);
}

const CODE_CONNECTION_TIMEOUT_MS = 120000;
// When a fallback is available, the direct attempt is capped well below the
// full timeout: the offerer keeps real candidates to try against the
// receiver's unreachable ones, so its ICE agent is slow to declare failure,
// while the receiver (with no viable candidates) has already given up. A
// direct connection that is going to work opens in a few seconds; if none has
// after this window, relay it rather than ride out the full backstop.
const RELAY_FALLBACK_ATTEMPT_TIMEOUT_MS = 20000;
const RELAY_FALLBACK_MESSAGE: Localized = {
  en: 'No direct connection — relaying the file through Nostr instead',
  es: 'No hay conexión directa — el archivo se retransmite por Nostr',
};
const TOR_FALLBACK_MESSAGE: Localized = {
  en: 'No direct connection — relaying the file through Tor instead',
  es: 'No hay conexión directa — el archivo se retransmite por Tor',
};
const SESSION_EXPIRED: Localized = {
  en: 'Session expired. Please start a new transfer.',
  es: 'La sesión caducó. Inicia una nueva transferencia.',
};

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
  const { fileName, fileSize, mimeType } = metadata;
  const fileMetadata = { fileName, fileSize, mimeType };
  const { rtc, salt } = offer;

  // A response is judged by the session it answers.
  if (Date.now() - offer.createdAt > TRANSFER_EXPIRATION_MS) {
    throw new Error(t(SESSION_EXPIRED));
  }

  report({
    status: 'connecting',
    message: t({
      en: 'Establishing secure connection...',
      es: 'Estableciendo una conexión segura...',
    }),
  });

  // Non-extractable, and it outlives the content key: the fallback derives
  // its session from it.
  const sharedSecretKey = await deriveSharedSecretKey(
    offer.privateKey,
    new Uint8Array(answer.publicKey),
  );

  // Key confirmation before anything in the answer is acted on.
  if (!(await confirmsAnswer(offer, answer, sharedSecretKey))) {
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
      const limit = formatFileSize(SLOW_TRANSPORT_MAX_BYTES);
      const via = named.kind === 'anonymous' ? 'Tor' : 'Nostr';
      throw new P2PConnectionError(
        t({
          en: `${error.message}. The file is over ${limit}, so it cannot be relayed through ${via} either.`,
          es: `${error.message}. El archivo supera ${limit}, así que tampoco se puede retransmitir por ${via}.`,
        }),
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
    throw new Error(t(SESSION_EXPIRED));
  }

  const transferring = (current: number, total: number): SendReport => ({
    status: 'transferring',
    message: t({ en: 'Sending via P2P...', es: 'Enviando por P2P...' }),
    progress: { current, total },
    contentType: 'file',
    fileMetadata,
    useWebRTC: true,
  });
  report(transferring(0, fileSize));

  // More connections beside this one, offered over it, which the transfer
  // spreads across as they open; it starts on this one without waiting.
  const lanes = offerLanes(channel, offer.peerConnection, getWebRTCConfig());
  try {
    // Encrypted chunks as the connections take them, then `end`; complete
    // once all of it has left this side's buffers.
    await sendFileOverLink(lanes.link, key, content, {
      // Deflating costs more time than a direct connection saves.
      compressed: false,
      onProgress: (current, total) => {
        if (!isCancelled()) report(transferring(current, total));
      },
      isCancelled,
    });

    if (isCancelled()) return;
    report({
      status: 'complete',
      message: t({ en: 'File sent via P2P!', es: '¡Archivo enviado por P2P!' }),
      contentType: 'file',
      useWebRTC: true,
    });
    // The bytes left this side's buffers, not this machine: the connections
    // stay up until the receiver hangs up with the file, so the caller's close
    // cannot cut off what the transport is still delivering.
    await lingerAfterSend(channel, isCancelled);
  } finally {
    lanes.close();
  }

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
        message: `${t(TOR_FALLBACK_MESSAGE)}. ${message}`,
        ...relayState,
      });
    torStatus(
      opts.torProgress?.latest() ||
        t({
          en: 'Starting the Tor client...',
          es: 'Iniciando el cliente de Tor...',
        }),
    );
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
          mimeType,
        },
        fileMetadata,
        isCancelled,
        onStatus: (message) => {
          if (isCancelled()) return;
          report({
            status: 'waiting_for_receiver',
            message: `${t(TOR_FALLBACK_MESSAGE)}. ${message}`,
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
      message: t({
        en: 'File sent through Tor!',
        es: '¡Archivo enviado a través de Tor!',
      }),
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
        message: `${t(RELAY_FALLBACK_MESSAGE)}. ${
          p.phase === 'discovering'
            ? t({
                en: 'Finding storage relays...',
                es: 'Buscando relays de almacenamiento...',
              })
            : t({
                en: `Testing storage relays... ${p.relaysHealthy ?? 0} working of ${p.relaysChecked ?? 0} checked`,
                es: `Probando relays de almacenamiento... ${p.relaysHealthy ?? 0} funcionan de ${p.relaysChecked ?? 0} comprobados`,
              })
        }`,
        ...relayState,
        stats: p.stats,
      });
    });
    try {
      report({
        status: 'preparing',
        message: `${t(RELAY_FALLBACK_MESSAGE)}. ${t({
          en: 'Reading file...',
          es: 'Leyendo el archivo...',
        })}`,
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
        throw new Error(
          t({ en: 'File is empty', es: 'El archivo está vacío' }),
        );
      }
      const relayFileSize = data.length;
      let lastStats: NostrFileTransferStats | undefined;
      try {
        await sendFileLive(
          data,
          {
            fileName,
            mimeType,
            // The relay compresses the whole payload by the same rule.
            precompressed: wireEncodingFor(content, true) === 'identity',
          },
          {
            pool,
            session,
            controlRelays,
            ...(named.replacements
              ? { controlReplacements: named.replacements }
              : {}),
            storageRelays: named.storage,
            isCancelled,
            onProgress: (p) => {
              if (isCancelled()) return;
              lastStats = p.stats;
              switch (p.phase) {
                case 'hashing':
                  report({
                    status: 'preparing',
                    message: `${t(RELAY_FALLBACK_MESSAGE)}. ${t({
                      en: 'Encrypting file...',
                      es: 'Cifrando el archivo...',
                    })}`,
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
                        ? t({
                            en: 'All pieces uploaded to relays. Waiting for the receiver...',
                            es: 'Todas las partes se subieron a los relays. Esperando al receptor...',
                          })
                        : t({
                            en: `Uploading pieces to relays (${chunksDone}/${chunksTotal})... waiting for the receiver.`,
                            es: `Subiendo partes a los relays (${chunksDone}/${chunksTotal})... esperando al receptor.`,
                          });
                  } else if (have >= chunksTotal) {
                    message = t({
                      en: 'Receiver has every piece — verifying...',
                      es: 'El receptor tiene todas las partes — verificando...',
                    });
                  } else {
                    message = t({
                      en: `Relaying through Nostr — receiver has ${have}/${chunksTotal} pieces (uploaded ${chunksDone}/${chunksTotal}${
                        p.resent ? `, re-sent ${p.resent}` : ''
                      }).`,
                      es: `Retransmitiendo por Nostr — el receptor tiene ${have}/${chunksTotal} partes (subidas ${chunksDone}/${chunksTotal}${
                        p.resent ? `, reenviadas ${p.resent}` : ''
                      }).`,
                    });
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
        message: t({
          en: 'File sent through Nostr relays!',
          es: '¡Archivo enviado a través de los relays de Nostr!',
        }),
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
      reject(
        new P2PConnectionError(
          t({ en: 'Connection timeout', es: 'Tiempo de conexión agotado' }),
        ),
      );
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
            t({
              en: 'The receiver reports no direct connection is possible',
              es: 'El receptor indica que no es posible una conexión directa',
            }),
          ),
        );
      })();
    }
    onStateChange = () => {
      if (
        pc.connectionState === 'failed' ||
        pc.connectionState === 'disconnected'
      ) {
        reject(
          new P2PConnectionError(
            t({ en: 'Connection failed', es: 'La conexión falló' }),
          ),
        );
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
