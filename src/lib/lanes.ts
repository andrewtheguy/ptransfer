/**
 * Extra peer connections beside a direct transfer's first one — its lanes —
 * and the transfer link that spreads chunks over all of them.
 *
 * One WebRTC connection rarely fills a real network path. Its congestion
 * control backs off on every loss on its own, and across the internet that
 * holds a single connection to a fraction of the link whichever WebRTC stack
 * runs it; separate connections back off separately, so together they carry
 * several times as much. A data channel added to the same connection shares
 * that connection's congestion window and gains nothing, which is why a lane
 * is a peer connection of its own.
 *
 * Lanes are negotiated over the first channel once it is open, so nothing
 * about how the two peers first reach each other changes: the sender offers
 * each lane in a `lane-offer` text message, the receiver answers in a
 * `lane-answer`, and every candidate travels in the SDP, gathered before it
 * is sent. That channel is already authenticated end to end, so a lane's DTLS
 * fingerprints are as trustworthy as the first connection's, and every chunk
 * on a lane is still sealed under the content key with its index as
 * additional data (INTEROP_PROTOCOL.md §7).
 *
 * The transfer starts on the first channel at once, and each lane joins the
 * link as it opens. A lane that never opens is let go after
 * `LANE_OPEN_TIMEOUT_MS`; one that ends before it has carried anything is
 * dropped; one that ends after carrying chunks fails the transfer, since what
 * it still held is lost.
 */

import type {
  ChannelEndReason,
  ChannelListener,
  DuplexChannel,
} from '@/lib/duplex-channel';
import type { TransferLink } from '@/lib/p2p-transfer';
import { type PeerConnectionClass, WebRTCConnection } from '@/lib/webrtc';

/** Lanes a sender offers beside the first connection. */
export const EXTRA_LANES = 3;

/** Most lanes a receiver accepts; offers beyond it are ignored. */
export const MAX_EXTRA_LANES = 7;

/** How long a lane may take to gather its candidates. */
const LANE_GATHER_TIMEOUT_MS = 5000;

/**
 * How long the sender gives a lane to open before letting it go. The
 * receiver waits longer, so a lane is always given up on by the sender first
 * and never closed under chunks the sender has started putting on it.
 */
export const LANE_OPEN_TIMEOUT_MS = 15_000;
const LANE_ACCEPT_TIMEOUT_MS = LANE_OPEN_TIMEOUT_MS + 5000;

/** Longest SDP accepted in a lane message. */
const MAX_LANE_SDP_LENGTH = 64 * 1024;

/** One lane message, as it travels in a text message on the first channel. */
export type LaneMessage =
  | { t: 'lane-offer'; lane: number; sdp: string }
  | { t: 'lane-answer'; lane: number; sdp: string };

export function encodeLaneMessage(message: LaneMessage): string {
  return JSON.stringify(message);
}

/**
 * Read a text message as a lane message. Returns null for anything else,
 * malformed lane messages included: they are left alone, and a lane that is
 * never answered is simply never opened.
 */
export function parseLaneMessage(text: string): LaneMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  if (m.t !== 'lane-offer' && m.t !== 'lane-answer') return null;
  if (
    typeof m.lane !== 'number' ||
    !Number.isInteger(m.lane) ||
    m.lane < 1 ||
    m.lane > MAX_EXTRA_LANES ||
    typeof m.sdp !== 'string' ||
    m.sdp.length === 0 ||
    m.sdp.length > MAX_LANE_SDP_LENGTH
  ) {
    return null;
  }
  return { t: m.t, lane: m.lane, sdp: m.sdp };
}

/** A transfer over a first channel and whatever lanes join it. */
export interface Lanes {
  /** The first channel and every open lane, as one transfer link. */
  link: TransferLink;
  /** Close every lane. The first channel is the caller's. */
  close: () => void;
}

/**
 * The first channel and its lanes as one `TransferLink`.
 *
 * Binary messages go to whichever channel has room, so each lane carries what
 * its own connection can move; text goes on the first channel, in order with
 * the rest of what is said there. Every channel's incoming messages reach
 * every subscriber. The link ends when the first channel ends, or a lane that
 * has carried something does.
 */
export function createLaneLink(primary: DuplexChannel): {
  link: TransferLink;
  /** Add an open lane, before any message can arrive on it. */
  add: (lane: DuplexChannel) => void;
  /** How many channels the link spreads over, the first included. */
  size: () => number;
} {
  const channels: DuplexChannel[] = [];
  /** Channels that have carried a message, either way. */
  const used = new Set<DuplexChannel>();
  /** Channels with a send not yet taken, so not to be handed another. */
  const busy = new Set<DuplexChannel>();
  const listeners = new Set<ChannelListener>();
  const enders = new Set<(reason: ChannelEndReason) => void>();
  let endedWith: ChannelEndReason | null = null;
  let sendError: Error | null = null;
  /** Sends waiting for a channel with room, woken when one frees up. */
  const waiting: (() => void)[] = [];
  const wake = () => {
    for (const resume of waiting.splice(0)) resume();
  };

  const end = (reason: ChannelEndReason) => {
    if (endedWith !== null) return;
    endedWith = reason;
    for (const ender of Array.from(enders)) ender(reason);
    enders.clear();
    wake();
  };

  const add = (channel: DuplexChannel) => {
    if (endedWith !== null) return;
    channels.push(channel);
    channel.subscribe((message) => {
      used.add(channel);
      for (const listener of Array.from(listeners)) listener(message);
    });
    channel.onEnd((reason) => {
      if (channel === primary || used.has(channel)) {
        end(reason);
        return;
      }
      // A lane that never carried anything takes nothing with it.
      const index = channels.indexOf(channel);
      if (index >= 0) channels.splice(index, 1);
      busy.delete(channel);
      wake();
    });
    wake();
  };
  add(primary);

  const sendBinary = async (data: Uint8Array): Promise<void> => {
    for (;;) {
      if (sendError) throw sendError;
      if (endedWith !== null) throw new Error('The connection has closed');
      const channel = channels.find((c) => !busy.has(c));
      if (channel) {
        busy.add(channel);
        used.add(channel);
        void channel.sendBinary(data).then(
          () => {
            busy.delete(channel);
            wake();
          },
          (error: unknown) => {
            busy.delete(channel);
            sendError ??=
              error instanceof Error ? error : new Error('A send failed');
            wake();
          },
        );
        // Resolved at once while another channel still has room; the one just
        // used paces this side only once every channel is waiting.
        return;
      }
      await new Promise<void>((resume) => waiting.push(resume));
    }
  };

  const link: TransferLink = {
    sendBinary,
    sendText: (text) => primary.sendText(text),
    sendNow: (text) => primary.sendNow(text),
    flush: async () => {
      await Promise.all(channels.map((channel) => channel.flush()));
      // A chunk whose send failed never counted on its channel, so that
      // channel's flush can resolve without it; it is still lost.
      if (sendError) throw sendError;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onEnd: (listener) => {
      if (endedWith !== null) {
        listener(endedWith);
        return () => {};
      }
      enders.add(listener);
      return () => {
        enders.delete(listener);
      };
    },
  };

  return { link, add, size: () => channels.length };
}

/** The bookkeeping both ends of a lane negotiation share. */
function laneSet(primary: DuplexChannel) {
  const laneLink = createLaneLink(primary);
  const connections: WebRTCConnection[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const stops: (() => void)[] = [];
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    for (const stop of stops.splice(0)) stop();
    for (const rtc of connections) rtc.close();
  };
  // Lanes do not outlive the connection they were negotiated over.
  stops.push(primary.onEnd(close));

  /**
   * A new lane's connection: added to the link once its channel opens, and
   * closed if that takes longer than `openTimeoutMs`.
   */
  const connect = (
    PeerConnection: PeerConnectionClass,
    config: RTCConfiguration,
    openTimeoutMs: number,
  ) => {
    let opened = false;
    const rtc = new WebRTCConnection(
      PeerConnection,
      config,
      // Nothing is trickled: the SDP carries every candidate once gathered.
      () => {},
      (channel) => {
        if (closed) return;
        opened = true;
        laneLink.add(channel);
      },
    );
    connections.push(rtc);
    timers.push(
      setTimeout(() => {
        if (!opened) rtc.close();
      }, openTimeoutMs),
    );
    return rtc;
  };

  /** The local description with every candidate gathered, once it has them. */
  const gatheredSdp = async (rtc: WebRTCConnection) => {
    await rtc.waitForIceGatheringComplete(LANE_GATHER_TIMEOUT_MS);
    return rtc.getPeerConnection().localDescription?.sdp ?? null;
  };

  return {
    laneLink,
    connect,
    gatheredSdp,
    isClosed: () => closed,
    watch: (stop: () => void) => stops.push(stop),
    lanes: { link: laneLink.link, close } satisfies Lanes,
  };
}

/**
 * The sender's side: offer `count` lanes over the open first channel, and add
 * each to the transfer link as it opens. Send on the returned link from now
 * on; the transfer need not wait for any lane.
 */
export function offerLanes(
  primary: DuplexChannel,
  PeerConnection: PeerConnectionClass,
  config: RTCConfiguration,
  count: number = EXTRA_LANES,
): Lanes {
  const set = laneSet(primary);
  const offered = new Map<number, WebRTCConnection>();

  set.watch(
    primary.subscribe((message) => {
      if (typeof message !== 'string') return;
      const answer = parseLaneMessage(message);
      if (answer?.t !== 'lane-answer') return;
      const rtc = offered.get(answer.lane);
      if (!rtc) return;
      offered.delete(answer.lane);
      void (async () => {
        try {
          await rtc.handleSignal({ type: 'answer', sdp: answer.sdp });
        } catch (error) {
          console.log(`Lane ${answer.lane} answer refused:`, error);
          rtc.close();
        }
      })();
    }),
  );

  const offer = async (lane: number) => {
    const rtc = set.connect(PeerConnection, config, LANE_OPEN_TIMEOUT_MS);
    try {
      rtc.createDataChannel('lane');
      await rtc.createOffer();
      const sdp = await set.gatheredSdp(rtc);
      if (set.isClosed() || !sdp) return;
      offered.set(lane, rtc);
      await primary.sendText(encodeLaneMessage({ t: 'lane-offer', lane, sdp }));
    } catch (error) {
      console.log(`Lane ${lane} could not be offered:`, error);
      rtc.close();
    }
  };
  for (let lane = 1; lane <= Math.min(count, MAX_EXTRA_LANES); lane++) {
    void offer(lane);
  }

  return set.lanes;
}

/**
 * The receiver's side: answer each lane the sender offers over the first
 * channel, up to `MAX_EXTRA_LANES`, and add it to the transfer link as it
 * opens. Call from the first channel's open callback, and attach the receiver
 * to the returned link in the same callback, so no message is missed.
 */
export function acceptLanes(
  primary: DuplexChannel,
  PeerConnection: PeerConnectionClass,
  config: RTCConfiguration,
): Lanes {
  const set = laneSet(primary);
  const seen = new Set<number>();

  const answer = async (lane: number, sdp: string) => {
    const rtc = set.connect(PeerConnection, config, LANE_ACCEPT_TIMEOUT_MS);
    try {
      await rtc.handleSignal({ type: 'offer', sdp });
      const answerSdp = await set.gatheredSdp(rtc);
      if (set.isClosed() || !answerSdp) return;
      await primary.sendText(
        encodeLaneMessage({ t: 'lane-answer', lane, sdp: answerSdp }),
      );
    } catch (error) {
      console.log(`Lane ${lane} could not be answered:`, error);
      rtc.close();
    }
  };

  set.watch(
    primary.subscribe((message) => {
      if (typeof message !== 'string' || set.isClosed()) return;
      const offer = parseLaneMessage(message);
      if (offer?.t !== 'lane-offer') return;
      if (seen.has(offer.lane) || seen.size >= MAX_EXTRA_LANES) return;
      seen.add(offer.lane);
      void answer(offer.lane, offer.sdp);
    }),
  );

  return set.lanes;
}
