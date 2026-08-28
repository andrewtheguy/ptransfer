import { useCallback, useEffect, useRef, useState } from 'react';
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
import { P2PConnectionError } from '@/lib/errors';
import { formatFileSize } from '@/lib/file-utils';
import type { TransferMetadata, TransferState } from '@/lib/nostr';
import {
  ANONYMOUS_RELAY_CONNECTION_TIMEOUT_MS,
  AnonymousSignalingTransport,
} from '@/lib/nostr/anonymous-transport';
import { ANONYMOUS_SIGNALING_RELAYS } from '@/lib/nostr/relays';
import { receiveFileLive } from '@/lib/nostr-file/download-live';
import { deriveRelaySession } from '@/lib/nostr-file/session';
import { createTransferPool } from '@/lib/nostr-file/transfer-pool';
import { NostrFileCancelledError } from '@/lib/nostr-file/upload';
import {
  ACK,
  createTransferReceiver,
  type TransferReceiver,
} from '@/lib/p2p-transfer';
import { createPendingStep, type PendingStep } from '@/lib/pending-step';
import { type AppendSink, createAdaptiveAppendSink } from '@/lib/scratch-sink';
import type { TorBridge } from '@/lib/tor/client';
import {
  deriveOnionPassword,
  receiveOverAnonymousRelay,
} from '@/lib/tor/code-relay';
import type { ReceivedContent } from '@/lib/types';
import { WebRTCConnection } from '@/lib/webrtc';
import { getWebRTCConfig } from '@/lib/webrtc-config';

// Extended transfer status for Code Exchange receive mode
export type CodeReceiveStatus =
  | 'idle'
  | 'waiting_for_offer'
  | 'generating_answer'
  | 'showing_answer'
  | 'connecting'
  | 'receiving'
  // Relay fallback after a failed direct connection.
  | 'fetching'
  | 'complete'
  | 'error';

// Typed Code Exchange receive state for UI consumers.
export interface CodeReceiveState {
  status: CodeReceiveStatus;
  message?: string;
  progress?: {
    current: number;
    total: number;
  };
  contentType?: 'file';
  fileMetadata?: {
    fileName: string;
    fileSize: number;
    mimeType: string;
  };
  useWebRTC?: boolean;
  currentRelays?: string[];
  totalRelays?: number;
  answerData?: Uint8Array; // Binary data for QR code
  /**
   * Whether the relay fallback could carry this file — the offer named
   * relays and the file is within the relay size cap. Without both there is
   * nothing for the simulation switch to fall back to.
   */
  relayFallbackAvailable?: boolean;
  /** Whether the response on screen is the simulated no-direct-route one. */
  simulateNoDirect?: boolean;
  /**
   * Whether the direct route died for real while the response was still on
   * screen. The response stays up — the sender needs it either way — but the
   * file will come through the fallback rather than directly.
   */
  directRouteDead?: boolean;
  /**
   * Whether the fallback this offer asked for runs inside Tor. The sender's
   * switch decides it and the offer carries it, so the response page is told
   * rather than asked — it only changes what the page calls the fallback.
   */
  anonymousFallback?: boolean;
  /**
   * Anonymous fallback only: what the Tor client is doing while the response
   * is on screen. It bootstraps behind the direct attempt, so its progress
   * belongs beside the response rather than in place of it.
   */
  torStatus?: string;
}

/**
 * An accepted offer, plus the digest of the container it arrived in. The
 * digest is what the answer's confirmation tag is bound to, so it has to be
 * taken from the bytes the receiver was handed rather than recomputed from
 * the parsed payload later.
 */
interface IncomingOffer {
  payload: SignalingPayload;
  transcriptHash: string;
}

/** What the receive flow is told before it is handed an offer. */
export interface CodeReceiveOptions {
  /**
   * Which Snowflake bridge this tab reaches Tor through, for an offer that
   * asked for the anonymous fallback. Asked for before the offer is handed
   * over, because taking it in is what starts the bootstrap; an ordinary
   * offer never loads a Tor client and never reads this.
   */
  bridge: TorBridge;
}

export interface UseCodeReceiveReturn {
  state: TransferState & CodeReceiveState;
  receivedContent: ReceivedContent | null;
  startReceive: (options: CodeReceiveOptions) => void;
  submitOffer: (offerData: Uint8Array) => void;
  /**
   * Testing aid on the response page: swap between a real direct attempt and
   * a simulated dead route, either way round. See `simulateNoDirectRef`.
   */
  setSimulateNoDirect: (value: boolean) => void;
  cancel: () => void;
  reset: () => void;
}

const ICE_GATHER_TIMEOUT_MS = 5000;
const CODE_CONNECTION_TIMEOUT_MS = 120000;
const RELAY_FALLBACK_MESSAGE =
  'No direct connection — receiving the file through Nostr instead';
const TOR_FALLBACK_MESSAGE =
  'No direct connection — receiving the file through Tor instead';
// What the response page says while the simulation is on: the relay fetch is
// already running behind it, but nothing has begun until the sender takes the
// response in, and a progress bar would claim otherwise.
const SIMULATED_HOLDING_MESSAGE =
  'Simulating no direct connection — waiting for the sender to take in your response';
// The same, for a direct route that died on its own before the sender ever
// took the response in. The response is still the only way this transfer
// starts, so it stays on screen and the fallback waits behind it.
const HOLDING_SUFFIX = 'Hand your response to the sender to start it';

/**
 * The response left on screen while a fallback runs behind it, because the
 * sender has not taken it in yet. Without it there is nothing to hold and the
 * fallback shows its own progress.
 */
interface HeldResponse {
  answerData: Uint8Array;
  /** Whether the dead route was simulated rather than real. */
  simulated: boolean;
}

/** Ends the stint in progress when the simulation switch is flipped. */
class SimulationSwitched extends Error {
  constructor() {
    super('Simulation switched');
    this.name = 'SimulationSwitched';
  }
}

export function useCodeReceive(): UseCodeReceiveReturn {
  const [state, setState] = useState<TransferState & CodeReceiveState>({
    status: 'idle',
  });
  const [receivedContent, setReceivedContent] =
    useState<ReceivedContent | null>(null);

  const rtcRef = useRef<WebRTCConnection | null>(null);
  const cancelledRef = useRef(false);
  const receivingRef = useRef(false);
  // Storage backing the in-flight or completed transfer. Discarded whenever
  // the payload it backs is abandoned; kept after completion because
  // receivedContent.data reads from it until reset.
  const sinkRef = useRef<AppendSink | null>(null);
  // Pool carrying the relay transfer after a failed direct connection.
  // Cancel reaches it through this ref so an abandoned receive stops talking
  // to relays instead of finishing the round on a dead session.
  const relayPoolRef = useRef<ReturnType<typeof createTransferPool> | null>(
    null,
  );
  // The Tor client an anonymous offer starts bootstrapping the moment it is
  // taken in, and the socket adapter its control channel is built on. Null for
  // an ordinary offer, which never loads one. Closing it takes the bootstrap,
  // the relay sockets and every circuit with it.
  const transportRef = useRef<AnonymousSignalingTransport | null>(null);

  // The step a receive blocks on until the UI settles it. Cancel rejects it
  // while pending so the flow unwinds immediately.
  const offerStepRef = useRef<PendingStep<IncomingOffer> | null>(null);
  // Which side of the switch on the response page the flow is currently on.
  // The switch exists only to exercise the relay path without a hostile
  // network: it hands the sender a response with no ICE candidates in it and
  // tears down the peer connection behind it, which is the same situation a
  // receiver with no reachable candidate is in. Nothing about the response
  // format changes, and the sender is none the wiser.
  const simulateNoDirectRef = useRef(false);
  // Applies a flip of that switch to the receive in progress. Set only while
  // a response is on screen, which is also what gates the switch in the UI.
  const switchRef = useRef<((simulate: boolean) => void) | null>(null);
  // Identifies the receive currently in charge of the refs. A cancelled run
  // that is still unwinding compares against it before touching shared
  // state, so a restart right after cancel is never clobbered.
  const runRef = useRef(0);

  const discardSink = useCallback(() => {
    const sink = sinkRef.current;
    sinkRef.current = null;
    if (sink) void sink.discard();
  }, []);

  const cancel = useCallback(() => {
    // Only an in-flight transfer's storage is abandoned by cancel; a completed
    // payload stays readable until reset.
    if (receivingRef.current) discardSink();
    cancelledRef.current = true;
    const relayPool = relayPoolRef.current;
    relayPoolRef.current = null;
    if (relayPool) relayPool.destroy();
    const transport = transportRef.current;
    transportRef.current = null;
    transport?.close();
    receivingRef.current = false;
    simulateNoDirectRef.current = false;
    switchRef.current = null;
    const offerStep = offerStepRef.current;
    offerStepRef.current = null;
    offerStep?.reject(new Error('Cancelled'));
    if (rtcRef.current) {
      rtcRef.current.close();
      rtcRef.current = null;
    }
    setState({ status: 'idle' });
  }, [discardSink]);

  const reset = useCallback(() => {
    cancel();
    discardSink();
    setReceivedContent(null);
  }, [cancel, discardSink]);

  // Navigating away ends the transfer, as it does in the Tor modes: nothing
  // reaches this hook once it is gone, and an anonymous fallback left running
  // would hold a Tor client, its circuits, and an onion service until the
  // session expired.
  useEffect(() => () => cancel(), [cancel]);

  const setSimulateNoDirect = useCallback((value: boolean) => {
    switchRef.current?.(value);
  }, []);

  const submitOffer = useCallback(async (offerData: Uint8Array) => {
    const step = offerStepRef.current;
    if (!step) return;

    // Parse mutual payload (no decryption needed)
    const parsed = await parseMutualPayload(offerData);
    // The step may have been cancelled while parsing; settle-once makes the
    // calls below harmless then, but don't clear a newer run's step.
    if (offerStepRef.current === step) offerStepRef.current = null;
    if (!parsed) {
      step.reject(new Error('Invalid offer format'));
      return;
    }
    if (parsed.type !== 'offer') {
      step.reject(new Error('Expected offer, got answer'));
      return;
    }
    // Hash the container as it arrived, before anything downstream can
    // reshape it; the answer's confirmation tag is bound to this exact value.
    step.resolve({
      payload: parsed,
      transcriptHash: await computeOfferTranscriptHash(offerData),
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: doReceive is defined below and only invoked at call time; references stable refs/setState
  const startReceive = useCallback((options: CodeReceiveOptions) => {
    // Guard against concurrent invocations
    if (receivingRef.current) return;
    receivingRef.current = true;
    cancelledRef.current = false;
    setReceivedContent(null);
    // The previous transfer's payload (if any) is gone from the UI now.
    discardSink();

    // Start the receive flow
    void doReceive(options.bridge);
  }, []);

  const doReceive = async (bridge: TorBridge) => {
    const run = ++runRef.current;
    // Cancelled, or superseded by a receive started after the cancel — in
    // either case this closure must stop and leave the shared refs alone.
    const abandoned = () => cancelledRef.current || runRef.current !== run;
    try {
      // Show input for scanning/pasting offer
      setState({
        status: 'waiting_for_offer',
        message: "Scan or paste the sender's code",
      });

      // Wait for offer to be submitted
      const offerStep = createPendingStep<IncomingOffer>();
      offerStepRef.current = offerStep;
      const { payload: offerPayload, transcriptHash: offerTranscriptHash } =
        await offerStep.promise;

      if (abandoned()) return;

      // Enforce TTL
      if (
        typeof offerPayload.createdAt !== 'number' ||
        !Number.isFinite(offerPayload.createdAt)
      ) {
        setState({
          status: 'error',
          message: 'Offer missing timestamp. Ask sender to create a new one.',
        });
        return;
      }
      if (Date.now() - offerPayload.createdAt > TRANSFER_EXPIRATION_MS) {
        setState({
          status: 'error',
          message: 'Offer expired. Ask sender to create a new one.',
        });
        return;
      }

      // Extract metadata from offer
      const {
        fileName,
        fileSize,
        contentEncoding,
        mimeType,
        salt: saltArray,
        publicKey: senderPublicKeyArray,
      } = offerPayload;

      // Validate required fields
      if (!saltArray) {
        setState({
          status: 'error',
          message: 'Invalid offer: missing encryption salt',
        });
        return;
      }

      // Validate required metadata
      if (
        !fileName ||
        !mimeType ||
        typeof fileSize !== 'number' ||
        !Number.isFinite(fileSize) ||
        fileSize < 0 ||
        (contentEncoding !== 'deflate-raw' && contentEncoding !== 'identity')
      ) {
        setState({
          status: 'error',
          message: 'Invalid offer: missing or invalid file metadata',
        });
        return;
      }

      // Security check: Enforce MAX_MESSAGE_SIZE
      if (fileSize > MAX_MESSAGE_SIZE) {
        setState({
          status: 'error',
          message: `Transfer rejected: Size (${formatFileSize(fileSize)}) exceeds limit (${formatFileSize(MAX_MESSAGE_SIZE)})`,
        });
        return;
      }

      if (abandoned()) return;

      // Which fallback this offer asks for. The sender's switch, and the only
      // thing that decides it: there is nothing to turn on here, and nothing
      // to agree in advance. The UI has read the same flag off the same bytes
      // already — that is what the bridge above was asked for — but this is
      // the flag the flow acts on, taken from the offer it verified.
      const anonymous = isAnonymousOffer(offerPayload);
      // The slow part, started the moment the offer is taken in rather than
      // once the direct route is known to be dead — a bootstrap is minutes,
      // and by then the sender is already waiting. It runs behind the direct
      // attempt and is closed with the transfer, used or not.
      let torStatus = '';
      // Installed by the fallback while it waits on the bootstrap: from then
      // on the client's progress is the transfer's only progress, and a cold
      // start is minutes — one frozen line for all of them reads as a hang.
      let reportTorStatus: ((message: string) => void) | null = null;
      let transport: AnonymousSignalingTransport | null = null;
      if (anonymous) {
        transport = new AnonymousSignalingTransport({
          bridge,
          onStatus: (message) => {
            torStatus = message;
            console.info('[tor] Code Exchange fallback:', message);
            if (abandoned()) return;
            if (reportTorStatus) {
              reportTorStatus(message);
              return;
            }
            // Otherwise only ever an addition to the response page. Every
            // other state this flow sets is written whole, so a stale line
            // cannot outlive the step it belonged to.
            setState((current) =>
              current.status === 'showing_answer'
                ? { ...current, torStatus: message }
                : current,
            );
          },
        });
        transportRef.current = transport;
      }

      // Generate our ECDH keypair and derive shared secret
      setState({ status: 'generating_answer', message: 'Generating keys...' });

      const senderPublicKey = new Uint8Array(senderPublicKeyArray);
      const salt = new Uint8Array(saltArray);

      /**
       * Everything one answer's ECDH key pair yields. The relay session is
       * derived from the same shared secret, so a new key pair here is also a
       * new relay session — which is how a response is given a control
       * channel with no history behind it.
       */
      interface AnswerKeys {
        publicKeyBytes: Uint8Array;
        /** Chunk key for the direct path. */
        key: CryptoKey;
        /** Root of the relay session and of the confirmation tag. */
        sharedSecretKey: CryptoKey;
        /**
         * Signs the answer once its fields are settled: proves to the sender
         * that this answer, unaltered, came from a peer that read its offer
         * and reached the same shared secret. Travels inside the answer code
         * with nothing for either operator to read or type.
         */
        signAnswer: AnswerConfirmationSigner;
      }

      const deriveAnswerKeys = async (): Promise<AnswerKeys> => {
        const ecdhKeyPair = await generateECDHKeyPair();
        // Derive shared secret as non-extractable CryptoKey
        const sharedSecretKey = await deriveSharedSecretKey(
          ecdhKeyPair.privateKey,
          senderPublicKey,
        );
        return {
          publicKeyBytes: ecdhKeyPair.publicKeyBytes,
          key: await deriveAESKeyFromSecretKey(sharedSecretKey, salt),
          sharedSecretKey,
          signAnswer: (answerTranscriptHash: string) =>
            deriveAnswerConfirmation(sharedSecretKey, salt, {
              offerTranscriptHash,
              answerTranscriptHash,
            }),
        };
      };

      let keys = await deriveAnswerKeys();

      if (abandoned()) return;

      // ------------------------------------------------------------------
      // The response page. It alternates between a real direct attempt and a
      // simulated dead route for as long as the switch is flipped, and ends
      // when one of the two takes over the transfer.
      //
      // A direct attempt owns a peer connection, a streaming receiver and a
      // receive sink. Simulating a dead route throws all three away and hands
      // the sender the last answer SDP with an empty candidate list: the
      // sender then has nothing to connect to, and with the peer connection
      // gone there is no agent left here to answer a connectivity check
      // either — which is what makes the simulation hold rather than the two
      // sides still finding each other peer-reflexively. Switching back
      // builds a fresh attempt, so the response changes on every flip and the
      // sender has to be handed the current one.
      // ------------------------------------------------------------------

      const fileMetadata = {
        fileName: fileName!,
        fileSize: fileSize!,
        mimeType: mimeType!,
      };

      // The relays the offer named, if any: the control relays of the
      // file-relay fallback used only after the direct connection fails, and
      // the only reason the simulation switch is offered at all. The answer
      // itself is always hand-carried back to the sender.
      const offerRelays = relaysFromOffer(offerPayload);

      // Which relays carry the fallback's control channel, or null when this
      // offer has no fallback at all. An anonymous offer names none because
      // its pool is a constant both sides hold; everything below reads this
      // rather than the offer's list, so the two paths differ only in what
      // the control channel goes on to arrange.
      const fallbackRelays: string[] | null = anonymous
        ? [...ANONYMOUS_SIGNALING_RELAYS]
        : offerRelays;

      // The relays the simulation may hand the file to. Named relays are not
      // enough on their own: past the relay size cap the fallback would
      // refuse the file, so simulating a dead route would kill a working
      // direct connection and leave both sides with nowhere to go.
      const simulationRelays =
        fallbackRelays && fileSize <= SLOW_TRANSPORT_MAX_BYTES
          ? fallbackRelays
          : null;

      interface DirectAttempt {
        rtc: WebRTCConnection;
        receiver: TransferReceiver;
        answerBinary: Uint8Array;
        /** Resolves on an open data channel, rejects on a dead route. */
        opened: Promise<void>;
        /** Ends that wait now, with the reason the loop should act on. */
        stop: (error: Error) => void;
        /** Peer connection, receiver and sink, discarded together. */
        dispose: () => void;
      }

      // The SDP of the most recent attempt, which the simulated response
      // reuses. Its ICE credentials belong to a closed connection by then,
      // which does not matter: nothing will ever answer it.
      let latestAnswerSDP: RTCSessionDescriptionInit | null = null;

      const buildDirectAttempt = async (): Promise<DirectAttempt | null> => {
        setState({
          status: 'generating_answer',
          message: 'Creating P2P answer...',
        });

        const iceCandidates: RTCIceCandidate[] = [];
        let answerSDP: RTCSessionDescriptionInit | null = null;
        let answerSDPResolver: (() => void) | null = null;
        let dataChannelResolver: (() => void) | null = null;
        let connectionFailedRejecter: ((error: Error) => void) | null = null;
        let stopWait: ((error: Error) => void) | null = null;
        // A dead route can be known before the wait promise below exists
        // (while ICE is still gathering, or the answer code is being built).
        // With no rejecter to hand it to yet, the failure is held here so the
        // wait fails fast instead of riding out the full timeout.
        let earlyConnectionFailure: Error | null = null;

        // Decrypted chunks land in the receive sink as they arrive. A cancel
        // during its creation cannot see it through sinkRef yet, so discard it
        // here instead of leaving its scratch storage orphaned.
        const sink = await createAdaptiveAppendSink(fileSize);
        if (abandoned()) {
          void sink.discard();
          return null;
        }
        sinkRef.current = sink;

        // Streaming receiver: decrypts each chunk into the sink as it arrives
        // (inflating deflated payloads in between) and resolves once DONE
        // arrives and all chunks authenticate.
        const receiver = createTransferReceiver(
          keys.key,
          contentEncoding,
          sink,
          {
            estimatedBytes: fileSize,
            onProgress: (current, total) =>
              setState((s) => ({ ...s, progress: { current, total } })),
          },
        );

        const rtc = new WebRTCConnection(
          getWebRTCConfig(),
          (signal) => {
            // Collect signals (answer + candidates)
            if (signal.type === 'answer') {
              answerSDP = { type: 'answer', sdp: signal.sdp };
              if (answerSDPResolver) {
                answerSDPResolver();
              }
            } else if (signal.type === 'candidate' && signal.candidate) {
              iceCandidates.push(new RTCIceCandidate(signal.candidate));
            }
          },
          () => {
            // Data channel opened; the idle watchdog covers the receiving
            // stage from here on.
            receiver.start();
            if (dataChannelResolver) {
              dataChannelResolver();
            }
          },
          (data) => {
            receiver.onMessage(data);
          },
          (connectionState) => {
            // A dead route is known long before the connection timeout; the
            // relay fallback starts from it right away. If it fails before the
            // wait promise is set up, record it so that promise can reject at
            // once rather than waiting out the timeout.
            if (
              connectionState === 'failed' ||
              connectionState === 'disconnected'
            ) {
              const error = new P2PConnectionError('Connection failed');
              if (connectionFailedRejecter) connectionFailedRejecter(error);
              else earlyConnectionFailure ??= error;
            }
          },
        );

        // Everything this attempt owns goes at once, so the next one starts
        // from nothing. The sink is only reachable through sinkRef while this
        // attempt is the current one.
        const dispose = () => {
          receiver.dispose();
          rtc.close();
          if (rtcRef.current === rtc) rtcRef.current = null;
          if (sinkRef.current === sink) discardSink();
          else void sink.discard();
        };

        if (abandoned()) {
          dispose();
          return null;
        }
        rtcRef.current = rtc;

        // Handle offer signal
        await rtc.handleSignal({ type: 'offer', sdp: offerPayload.sdp });

        // Add ICE candidates from offer
        for (const candidateStr of offerPayload.candidates) {
          await rtc.handleSignal({
            type: 'candidate',
            candidate: {
              candidate: candidateStr,
              sdpMid: '0',
              sdpMLineIndex: 0,
            },
          });
        }

        if (abandoned()) {
          dispose();
          return null;
        }

        // Wait for answer SDP to be generated
        setState({
          status: 'generating_answer',
          message: 'Generating answer...',
        });

        await new Promise<void>((resolve) => {
          if (answerSDP) {
            resolve();
          } else {
            answerSDPResolver = resolve;
            // Timeout after 10 seconds
            setTimeout(resolve, 10000);
          }
        });

        if (abandoned()) {
          dispose();
          return null;
        }

        // Wait for ICE gathering to complete
        setState({
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
        setState({
          status: 'generating_answer',
          message: iceGatheringComplete
            ? 'Preparing response code...'
            : 'Network probe timed out. Preparing response code with available routes...',
        });

        if (abandoned()) {
          dispose();
          return null;
        }

        // Validate answerSDP is available
        if (!answerSDP) {
          dispose();
          throw new Error(
            'Failed to generate answer SDP: Answer was not created by WebRTC connection',
          );
        }
        latestAnswerSDP = answerSDP;

        // Generate answer with our public key
        const answerBinary = await generateMutualAnswerBinary(
          answerSDP,
          iceCandidates,
          keys.publicKeyBytes,
          keys.signAnswer,
        );

        if (abandoned()) {
          dispose();
          return null;
        }

        // Wait for the data channel to open. When no direct route exists and
        // the offer named relays, the file comes through them instead;
        // without relays, or past the relay size cap, the failure stands.
        const opened = new Promise<void>((resolve, reject) => {
          // A failure that landed before this promise existed is not lost.
          if (earlyConnectionFailure) {
            reject(earlyConnectionFailure);
            return;
          }
          // The sender caps its own direct attempt at 20s once a fallback is
          // available, and its clock starts when it takes the response in.
          // This side has no such clock: the response is still on screen
          // being handed over by a human, and nothing can connect until that
          // is done. Capping the wait here would give up on a route that was
          // never tried, and publishing this side's `hello` would then talk
          // the sender out of the direct route too. A route that really is
          // dead reports itself through `connectionState` long before the
          // backstop below.
          const timeout = setTimeout(() => {
            reject(new P2PConnectionError('Connection timeout'));
          }, CODE_CONNECTION_TIMEOUT_MS);

          dataChannelResolver = () => {
            clearTimeout(timeout);
            resolve();
          };
          connectionFailedRejecter = (error) => {
            clearTimeout(timeout);
            reject(error);
          };
          stopWait = (error) => {
            clearTimeout(timeout);
            reject(error);
          };

          // Check if already open
          const dc = rtc.getDataChannel();
          if (dc && dc.readyState === 'open') {
            clearTimeout(timeout);
            resolve();
          }
        });
        // The caller awaits this a tick later; keep a rejection that already
        // landed from being reported as unhandled in between.
        void opened.catch(() => {});

        return {
          rtc,
          receiver,
          answerBinary,
          opened,
          stop: (error) => stopWait?.(error),
          dispose,
        };
      };

      /**
       * The response page as it stays while a fallback runs behind it: the
       * sender has not taken the code in yet, so the code is still the only
       * thing this transfer is waiting on and taking it off screen would
       * strand both sides. Nothing has begun either, so a progress bar would
       * claim otherwise.
       */
      const holdResponse = (
        held: HeldResponse | null,
      ): (TransferState & CodeReceiveState) | null =>
        held
          ? {
              status: 'showing_answer',
              message: held.simulated
                ? SIMULATED_HOLDING_MESSAGE
                : `${anonymous ? TOR_FALLBACK_MESSAGE : RELAY_FALLBACK_MESSAGE}. ${HOLDING_SUFFIX}`,
              answerData: held.answerData,
              contentType: 'file',
              fileMetadata,
              // The switch is only offered while there is still a direct
              // route to drop; one that died on its own leaves nothing to
              // simulate.
              relayFallbackAvailable: held.simulated,
              simulateNoDirect: held.simulated,
              directRouteDead: !held.simulated,
              anonymousFallback: anonymous,
            }
          : null;

      /**
       * The relay data path. `held` is set while the response is still on
       * screen — a simulated stint, or a route that died before the sender
       * took the code in. The fetch then waits behind the response until the
       * sender turns up on the control channel, rather than announcing a
       * transfer that has not begun.
       *
       * Returns 'switched' when the simulation switch went back off while the
       * fetch was still waiting; the caller rebuilds the direct route.
       */
      const runRelayTransfer = async (
        relays: string[],
        held: HeldResponse | null,
        switchedBack: () => boolean,
      ): Promise<'completed' | 'switched'> => {
        const pool = createTransferPool();
        relayPoolRef.current = pool;
        let lastStats: TransferState['stats'];
        const relayState = {
          contentType: 'file' as const,
          fileMetadata,
          currentRelays: relays,
        };
        const holding = holdResponse(held);
        setState(
          holding ?? {
            status: 'fetching',
            message: `${RELAY_FALLBACK_MESSAGE}. Connecting to relays...`,
            progress: { current: 0, total: fileSize },
            ...relayState,
          },
        );
        let data: Uint8Array;
        try {
          const session = await deriveRelaySession(keys.sharedSecretKey, salt);
          data = await receiveFileLive(session, relays, {
            pool,
            isCancelled: () => abandoned() || switchedBack(),
            since: Math.floor(offerPayload.createdAt / 1000),
            expiresAt: Math.floor(
              (offerPayload.createdAt + TRANSFER_EXPIRATION_MS) / 1000,
            ),
            onProgress: (p) => {
              if (abandoned() || switchedBack()) return;
              lastStats = p.stats;
              // Nothing from the sender yet on a simulated stint: hold the
              // response page instead of showing a progress bar for a
              // transfer the sender has not started.
              if (holding && !p.manifest) {
                setState(holding);
                return;
              }
              const total = p.manifest?.fileSize ?? fileSize;
              const chunkBytes = Math.ceil(total / Math.max(p.chunksTotal, 1));
              setState({
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
        } catch (relayError) {
          if (relayError instanceof NostrFileCancelledError) {
            return switchedBack() ? 'switched' : 'completed';
          }
          throw relayError;
        } finally {
          if (relayPoolRef.current === pool) relayPoolRef.current = null;
          pool.destroy();
        }
        if (abandoned()) return 'completed';
        setReceivedContent({
          contentType: 'file',
          data: new Blob([data as BlobPart], {
            type: mimeType || 'application/octet-stream',
          }),
          fileName,
          fileSize: data.length,
          mimeType,
        });
        setState({
          status: 'complete',
          message: 'File received through Nostr relays!',
          contentType: 'file',
          fileMetadata: { fileName, fileSize: data.length, mimeType },
          stats: lastStats,
        });
        return 'completed';
      };

      /**
       * The anonymous relay data path: the same session, an encrypted control
       * channel on the onion relay pool, and the file over the sender's onion
       * service rather than off storage relays.
       *
       * `held` holds the response page for the same reason it does on the
       * clearnet path — the sender has not taken the code in yet, so until it
       * announces an address there is nothing to report but a page that is
       * waiting.
       */
      const runAnonymousTransfer = async (
        transport: AnonymousSignalingTransport,
        relays: string[],
        held: HeldResponse | null,
        switchedBack: () => boolean,
      ): Promise<'completed' | 'switched'> => {
        const pool = createTransferPool({
          websocketImplementation: transport.websocketImplementation,
          connectionTimeoutMs: ANONYMOUS_RELAY_CONNECTION_TIMEOUT_MS,
        });
        relayPoolRef.current = pool;
        const relayState = {
          contentType: 'file' as const,
          fileMetadata,
          currentRelays: relays,
        };
        const holding = holdResponse(held);
        // Set once the sender has announced its service, which is the first
        // moment anything is happening that the response page could report.
        let senderPresent = holding === null;
        const report = (message: string) => {
          if (abandoned() || switchedBack()) return;
          if (!senderPresent && holding) {
            setState({ ...holding, torStatus });
            return;
          }
          setState({ status: 'fetching', message, ...relayState });
        };

        report(
          `${TOR_FALLBACK_MESSAGE}. ${torStatus || 'Starting the Tor client...'}`,
        );
        const session = await deriveRelaySession(keys.sharedSecretKey, salt);
        let payload: Blob;
        let received: { fileName: string; fileSize: number; mimeType: string };
        try {
          reportTorStatus = (message) =>
            report(`${TOR_FALLBACK_MESSAGE}. ${message}`);
          let client: Awaited<ReturnType<typeof transport.torClient>>;
          try {
            client = await transport.torClient();
          } finally {
            reportTorStatus = null;
          }
          if (switchedBack()) return 'switched';
          if (abandoned()) return 'completed';
          const receipt = await receiveOverAnonymousRelay({
            client,
            pool,
            relays,
            session,
            since: Math.floor(offerPayload.createdAt / 1000),
            expiresAt: Math.floor(
              (offerPayload.createdAt + TRANSFER_EXPIRATION_MS) / 1000,
            ),
            password: await deriveOnionPassword(keys.sharedSecretKey, salt),
            expected: {
              contentType: 'file',
              fileName,
              fileSize,
              contentEncoding,
              mimeType,
            } satisfies TransferMetadata,
            isCancelled: () => abandoned() || switchedBack(),
            onAnnounced: () => {
              senderPresent = true;
            },
            onStatus: (message) =>
              report(`${TOR_FALLBACK_MESSAGE}. ${message}`),
            onProgress: (current, total) => {
              if (abandoned() || switchedBack()) return;
              setState({
                status: 'fetching',
                message: 'Receiving the file over Tor...',
                progress: { current, total },
                ...relayState,
              });
            },
          });
          payload = receipt.payload;
          received = {
            fileName: receipt.metadata.fileName,
            fileSize: payload.size,
            mimeType: receipt.metadata.mimeType,
          };
        } catch (error) {
          if (switchedBack()) return 'switched';
          if (abandoned()) return 'completed';
          throw error;
        } finally {
          // Nothing downstream took ownership: the control key was derived
          // from these, and the content key came out of the handshake.
          wipeBufferSource(session.keyBytes);
          if (relayPoolRef.current === pool) relayPoolRef.current = null;
          pool.destroy();
        }

        if (abandoned()) return 'completed';
        setReceivedContent({
          contentType: 'file',
          data: payload,
          fileName: received.fileName,
          fileSize: received.fileSize,
          mimeType: received.mimeType,
        });
        setState({
          status: 'complete',
          message: 'File received through Tor!',
          contentType: 'file',
          fileMetadata: received,
        });
        return 'completed';
      };

      /** Whichever fallback this offer asked for. */
      const runFallbackTransfer = (
        relays: string[],
        held: HeldResponse | null,
        switchedBack: () => boolean,
      ): Promise<'completed' | 'switched'> =>
        transport
          ? runAnonymousTransfer(transport, relays, held, switchedBack)
          : runRelayTransfer(relays, held, switchedBack);

      let simulate = false;
      let connected: DirectAttempt | null = null;

      for (;;) {
        if (abandoned()) return;

        // The switch, armed for this stint only. Flipping it ends the stint
        // in progress; the loop then builds the other kind. It is offered at
        // all only where the relay fallback could carry the file, since
        // otherwise a dead route just fails the transfer.
        let switchedTo: boolean | null = null;
        let endStint: ((error: Error) => void) | null = null;
        simulateNoDirectRef.current = simulate;
        switchRef.current = simulationRelays
          ? (next) => {
              if (next === simulate || switchedTo !== null) return;
              switchedTo = next;
              endStint?.(new SimulationSwitched());
            }
          : null;

        if (!simulate) {
          const attempt = await buildDirectAttempt();
          if (!attempt) return;
          if (switchedTo !== null) {
            attempt.dispose();
            simulate = switchedTo;
            continue;
          }
          endStint = attempt.stop;
          setState({
            status: 'showing_answer',
            message: 'Show this to sender and wait for connection',
            answerData: attempt.answerBinary,
            contentType: 'file',
            fileMetadata,
            relayFallbackAvailable: simulationRelays !== null,
            simulateNoDirect: false,
            anonymousFallback: anonymous,
            torStatus,
          });
          try {
            await attempt.opened;
          } catch (error) {
            attempt.dispose();
            if (error instanceof SimulationSwitched) {
              simulate = true;
              continue;
            }
            if (
              !(error instanceof P2PConnectionError) ||
              !fallbackRelays ||
              abandoned()
            ) {
              throw error;
            }
            if (fileSize > SLOW_TRANSPORT_MAX_BYTES) {
              throw new P2PConnectionError(
                `${error.message}. The file is over ${formatFileSize(SLOW_TRANSPORT_MAX_BYTES)}, so it cannot be relayed through ${anonymous ? 'Tor' : 'Nostr'} either.`,
              );
            }
            // The direct route died on its own; there is nothing left for the
            // switch to simulate. The response is still on screen and still
            // the only way this transfer starts — the sender cannot reach the
            // fallback without it — so it is held there until the sender
            // turns up on the control channel rather than being replaced by
            // the fallback's own progress.
            switchRef.current = null;
            await runFallbackTransfer(
              fallbackRelays,
              { answerData: attempt.answerBinary, simulated: false },
              () => false,
            );
            return;
          }
          switchRef.current = null;
          connected = attempt;
          break;
        }

        // Simulated: no peer connection at all. The response reuses the SDP
        // of the attempt just torn down, with its candidates left out.
        if (!latestAnswerSDP || !simulationRelays) {
          throw new Error('Cannot simulate a dead route before an answer');
        }
        const answerBinary = await generateMutualAnswerBinary(
          latestAnswerSDP,
          [],
          keys.publicKeyBytes,
          keys.signAnswer,
        );
        if (abandoned()) return;
        if (switchedTo !== null) {
          simulate = switchedTo;
          continue;
        }
        const outcome = await runFallbackTransfer(
          simulationRelays,
          { answerData: answerBinary, simulated: true },
          () => switchedTo !== null,
        );
        if (outcome === 'switched') {
          // That stint left this side's `hello` on the control relays, and a
          // relay keeps it for the rest of the exchange. A sender handed a
          // response built on the same shared secret would read that stale
          // hello out of the backlog and give up on the direct route before
          // it had a chance — so the next attempt starts from new key
          // material, which puts it in a relay session of its own.
          keys = await deriveAnswerKeys();
          simulate = false;
          continue;
        }
        return;
      }

      switchRef.current = null;
      if (!connected || abandoned()) return;
      const { rtc, receiver } = connected;

      setState({
        status: 'receiving',
        message: 'Receiving file...',
        contentType: 'file',
        fileMetadata,
        useWebRTC: true,
        progress: { current: 0, total: fileSize },
      });

      // Wait for the streaming receiver to finish, racing cancellation. The
      // receiver decrypts, authenticates and writes chunks to the sink as they
      // arrive and resolves with the sealed payload. A stalled stream is
      // aborted by the receiver's own idle watchdog (see
      // createTransferReceiver).
      const receivedData = await new Promise<Blob>((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (abandoned()) {
            clearInterval(checkInterval);
            receiver.dispose();
            reject(new Error('Cancelled'));
          }
        }, 500);

        receiver.done
          .then((data) => {
            clearInterval(checkInterval);
            resolve(data);
          })
          .catch((err) => {
            clearInterval(checkInterval);
            reject(err);
          });
      });

      if (abandoned()) return;

      // Acknowledge only after all chunks authenticate and reassemble.
      rtc.send(ACK);

      // Set received content
      setReceivedContent({
        contentType: 'file',
        data: receivedData,
        fileName: fileName!,
        fileSize: receivedData.size,
        mimeType: mimeType!,
      });
      setState({
        status: 'complete',
        message: 'File received (P2P)!',
        contentType: 'file',
        fileMetadata: {
          fileName: fileName!,
          fileSize: receivedData.size,
          mimeType: mimeType!,
        },
      });
    } catch (error) {
      // Nothing downloadable survives a failed transfer; drop its storage
      // — unless a newer run owns the sink by now.
      if (!abandoned()) {
        discardSink();
        setState((prevState) => ({
          ...prevState,
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to receive',
          connectionFailed: error instanceof P2PConnectionError,
        }));
      }
    } finally {
      // A superseded run's refs already belong to the newer receive.
      if (runRef.current === run) {
        receivingRef.current = false;
        offerStepRef.current = null;
        switchRef.current = null;
        // A transfer that connected directly bootstrapped a Tor client it
        // never used; it goes with the transfer either way.
        const transport = transportRef.current;
        transportRef.current = null;
        transport?.close();
        if (rtcRef.current) {
          rtcRef.current.close();
          rtcRef.current = null;
        }
      }
    }
  };

  return {
    state,
    receivedContent,
    startReceive,
    submitOffer,
    setSimulateNoDirect,
    cancel,
    reset,
  };
}
