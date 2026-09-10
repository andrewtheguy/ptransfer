import { useCallback, useEffect, useRef, useState } from 'react';
import { hangUp } from '@/lib/code-exchange/hang-up';
import {
  type AcceptedOffer,
  acceptOffer,
  buildDirectAttempt,
  type DirectAttempt,
  deriveAnswerKeys,
  eligibleFallbackRelays,
  fallbackMessage,
  finishDirectReceive,
  type ReadOffer,
  readOffer,
  receiveOverFallback,
  unrelayableError,
} from '@/lib/code-exchange/receive';
import { createTorProgress } from '@/lib/code-exchange/tor-progress';
import { generateMutualAnswerBinary } from '@/lib/code-signaling';
import type { DuplexChannel } from '@/lib/duplex-channel';
import { P2PConnectionError } from '@/lib/errors';
import type { TransferState } from '@/lib/nostr';
import { AnonymousSignalingTransport } from '@/lib/nostr/anonymous-transport';
import type { createTransferPool } from '@/lib/nostr-file/transfer-pool';
import { createPendingStep, type PendingStep } from '@/lib/pending-step';
import type { AppendSink } from '@/lib/scratch-sink';
import type { TorBridge } from '@/lib/tor/client';
import type { ReceivedContent } from '@/lib/types';
import type { WebRTCConnection } from '@/lib/webrtc';

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

const CODE_CONNECTION_TIMEOUT_MS = 120000;
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
  // The data channel of the attempt that connected, so a cancel can tell
  // the sender.
  const channelRef = useRef<DuplexChannel | null>(null);
  const cancelledRef = useRef(false);
  const receivingRef = useRef(false);
  // Storage backing the in-flight or completed transfer. Discarded whenever
  // the payload it backs is abandoned; kept after completion because
  // receivedContent.data reads from it until reset.
  const sinkRef = useRef<AppendSink | null>(null);
  // Pool carrying the fallback after a failed direct connection. Cancel
  // reaches it through this ref so an abandoned receive stops talking to
  // relays instead of finishing the round on a dead session.
  const relayPoolRef = useRef<ReturnType<typeof createTransferPool> | null>(
    null,
  );
  // The Tor client an anonymous offer starts bootstrapping the moment it is
  // taken in. Null for an ordinary offer, which never loads one. Closing it
  // takes the bootstrap, the relay sockets and every circuit with it.
  const transportRef = useRef<AnonymousSignalingTransport | null>(null);

  // The step a receive blocks on until the UI settles it. Cancel rejects it
  // while pending so the flow unwinds immediately.
  const offerStepRef = useRef<PendingStep<ReadOffer> | null>(null);
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
    // A sender mid-transfer is told why the connection is going away.
    hangUp(rtcRef.current, channelRef.current);
    rtcRef.current = null;
    channelRef.current = null;
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
    let read: ReadOffer;
    try {
      read = await readOffer(offerData);
    } catch (error) {
      if (offerStepRef.current === step) offerStepRef.current = null;
      step.reject(error instanceof Error ? error : new Error('Invalid offer'));
      return;
    }
    // The step may have been cancelled while parsing; settle-once makes the
    // call below harmless then, but don't clear a newer run's step.
    if (offerStepRef.current === step) offerStepRef.current = null;
    step.resolve(read);
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
      setState({
        status: 'waiting_for_offer',
        message: "Scan or paste the sender's code",
      });

      const offerStep = createPendingStep<ReadOffer>();
      offerStepRef.current = offerStep;
      const offer: AcceptedOffer = acceptOffer(await offerStep.promise);
      if (abandoned()) return;

      const anonymous = offer.fallback === 'anonymous';
      const { fileName, fileSize, mimeType } = offer.metadata;
      const fileMetadata = { fileName, fileSize, mimeType };

      // The slow part, started the moment the offer is taken in rather than
      // once the direct route is known to be dead — a bootstrap is minutes,
      // and by then the sender is already waiting. It runs behind the direct
      // attempt and is closed with the transfer, used or not.
      const torProgress = createTorProgress();
      let transport: AnonymousSignalingTransport | null = null;
      if (anonymous) {
        transport = new AnonymousSignalingTransport({
          bridge,
          onStatus: (message) => {
            console.info('[tor] Code Exchange fallback:', message);
            torProgress.push(message);
            if (abandoned()) return;
            // Only ever an addition to the response page. Every other state
            // this flow sets is written whole, so a stale line cannot outlive
            // the step it belonged to.
            setState((current) =>
              current.status === 'showing_answer'
                ? { ...current, torStatus: message }
                : current,
            );
          },
        });
        transportRef.current = transport;
      }

      setState({ status: 'generating_answer', message: 'Generating keys...' });
      let keys = await deriveAnswerKeys(offer);
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

      // The relays the simulation may hand the file to: the switch is offered
      // only where the fallback could carry the file, since otherwise
      // simulating a dead route would kill a working direct connection and
      // leave both sides with nowhere to go.
      const simulationRelays = eligibleFallbackRelays(offer);

      // The SDP of the most recent attempt, which the simulated response
      // reuses. Its ICE credentials belong to a closed connection by then,
      // which does not matter: nothing will ever answer it.
      let latestAnswerSDP: RTCSessionDescriptionInit | null = null;

      const report = (update: Parameters<typeof setState>[0]) => {
        if (!abandoned()) setState(update);
      };

      /**
       * The response page as it stays while a fallback runs behind it: the
       * sender has not taken the code in yet, so the code is still the only
       * thing this transfer is waiting on and taking it off screen would
       * strand both sides. Nothing has begun either, so a progress bar would
       * claim otherwise.
       */
      const holdResponse = (held: HeldResponse) => (torStatus: string) =>
        report({
          status: 'showing_answer',
          message: held.simulated
            ? SIMULATED_HOLDING_MESSAGE
            : `${fallbackMessage(offer)}. ${HOLDING_SUFFIX}`,
          answerData: held.answerData,
          contentType: 'file',
          fileMetadata,
          // The switch is only offered while there is still a direct route to
          // drop; one that died on its own leaves nothing to simulate.
          relayFallbackAvailable: held.simulated,
          simulateNoDirect: held.simulated,
          directRouteDead: !held.simulated,
          anonymousFallback: anonymous,
          ...(torStatus ? { torStatus } : {}),
        });

      /**
       * The fallback, held behind the response page until the sender turns
       * up on the control channel. Returns 'switched' when the simulation
       * switch went back off while it was still waiting.
       */
      const runFallback = async (
        held: HeldResponse,
        switchedBack: () => boolean,
      ): Promise<'completed' | 'switched'> => {
        const outcome = await receiveOverFallback({
          offer,
          keys,
          transport,
          torProgress,
          hold: holdResponse(held),
          poolHolder: relayPoolRef,
          switchedBack,
          isCancelled: abandoned,
          report,
        });
        if (outcome === 'switched') return 'switched';
        if (!outcome || abandoned()) return 'completed';
        setReceivedContent(outcome.content);
        setState({
          status: 'complete',
          message: outcome.message,
          contentType: 'file',
          fileMetadata: {
            fileName: outcome.content.fileName,
            fileSize: outcome.content.fileSize,
            mimeType: outcome.content.mimeType,
          },
          stats: outcome.stats,
        });
        return 'completed';
      };

      let simulate = false;
      let connected: { attempt: DirectAttempt; channel: DuplexChannel } | null =
        null;

      for (;;) {
        if (abandoned()) return;

        // The switch, armed for this stint only. Flipping it ends the stint
        // in progress; the loop then builds the other kind.
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
          // This side has no short clock: the response is still on screen
          // being handed over by a human, and nothing can connect until that
          // is done. Capping the wait would give up on a route that was never
          // tried, and this side's `hello` would then talk the sender out of
          // the direct route too. A route that really is dead reports itself
          // through its connection state long before the backstop.
          const attempt = await buildDirectAttempt({
            offer,
            keys,
            sinkHolder: sinkRef,
            rtcHolder: rtcRef,
            connectionTimeoutMs: CODE_CONNECTION_TIMEOUT_MS,
            isCancelled: abandoned,
            report,
            onProgress: (current, total) =>
              setState((s) => ({ ...s, progress: { current, total } })),
          });
          if (!attempt) return;
          latestAnswerSDP = attempt.answerSDP;
          if (switchedTo !== null) {
            attempt.dispose();
            simulate = switchedTo;
            continue;
          }
          endStint = attempt.stop;
          let channel: DuplexChannel;
          setState({
            status: 'showing_answer',
            message: 'Show this to sender and wait for connection',
            answerData: attempt.answerBinary,
            contentType: 'file',
            fileMetadata,
            relayFallbackAvailable: simulationRelays !== null,
            simulateNoDirect: false,
            anonymousFallback: anonymous,
            torStatus: torProgress.latest(),
          });
          try {
            channel = await attempt.opened;
          } catch (error) {
            attempt.dispose();
            if (error instanceof SimulationSwitched) {
              simulate = true;
              continue;
            }
            if (
              !(error instanceof P2PConnectionError) ||
              !offer.fallbackRelays ||
              abandoned()
            ) {
              throw error;
            }
            if (!simulationRelays) throw unrelayableError(offer, error);
            // The direct route died on its own; there is nothing left for the
            // switch to simulate. The response is still on screen and still
            // the only way this transfer starts — the sender cannot reach the
            // fallback without it — so it is held there until the sender
            // turns up on the control channel.
            switchRef.current = null;
            await runFallback(
              { answerData: attempt.answerBinary, simulated: false },
              () => false,
            );
            return;
          }
          switchRef.current = null;
          channelRef.current = channel;
          connected = { attempt, channel };
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
        const outcome = await runFallback(
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
          keys = await deriveAnswerKeys(offer);
          simulate = false;
          continue;
        }
        return;
      }

      switchRef.current = null;
      if (!connected || abandoned()) return;

      setState({
        status: 'receiving',
        message: 'Receiving file...',
        contentType: 'file',
        fileMetadata,
        useWebRTC: true,
        progress: { current: 0, total: fileSize },
      });

      const payload = await finishDirectReceive({
        attempt: connected.attempt,
        rtcHolder: rtcRef,
        isCancelled: abandoned,
      });
      if (!payload || abandoned()) return;

      setReceivedContent({
        contentType: 'file',
        data: payload,
        fileName,
        fileSize: payload.size,
        mimeType,
      });
      setState({
        status: 'complete',
        message: 'File received (P2P)!',
        contentType: 'file',
        fileMetadata: { fileName, fileSize: payload.size, mimeType },
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
        channelRef.current = null;
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
