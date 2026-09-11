import { createDataChannelDuplex } from '@/lib/data-channel';
import type { DuplexChannel } from '@/lib/duplex-channel';

export type WebRTCSignal =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'candidate'; candidate?: RTCIceCandidateInit | null };

/**
 * The `RTCPeerConnection` implementation a connection is built on. Taken from
 * the host rather than the global scope, which only a browser has: the tab
 * passes its own, the CLI passes node-datachannel's W3C polyfill.
 */
export type PeerConnectionClass = new (
  configuration: RTCConfiguration,
) => RTCPeerConnection;

/**
 * One peer connection and its single data channel.
 *
 * This class owns connection setup — the offer/answer, ICE, and the channel's
 * creation — and nothing past it. Once the channel opens it is handed to
 * `onDataChannelOpen` as a `DuplexChannel`, which both peers send and listen
 * on alike; which side made the offer says nothing about which way messages
 * may flow afterwards.
 */
export class WebRTCConnection {
  private pc: RTCPeerConnection;
  private channel: DuplexChannel | null = null;
  private onSignal: (signal: WebRTCSignal) => void;
  private onDataChannelOpen: (channel: DuplexChannel) => void;
  private onConnectionStateChange?: (state: RTCPeerConnectionState) => void;

  private remoteDescriptionSet = false;
  private candidateQueue: RTCIceCandidateInit[] = [];

  /**
   * `onDataChannelOpen` runs from the channel's open event, before any message
   * can be dispatched on it. A client that must see every message subscribes
   * there; see `DuplexChannel`.
   */
  constructor(
    PeerConnection: PeerConnectionClass,
    config: RTCConfiguration,
    onSignal: (signal: WebRTCSignal) => void,
    onDataChannelOpen: (channel: DuplexChannel) => void,
    onConnectionStateChange?: (state: RTCPeerConnectionState) => void,
  ) {
    this.pc = new PeerConnection(config);
    this.onSignal = onSignal;
    this.onDataChannelOpen = onDataChannelOpen;
    this.onConnectionStateChange = onConnectionStateChange;

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        // The candidate attribute without its `a=` line prefix, which is how
        // a browser spells it and what a code carries. libdatachannel, under
        // the CLI, keeps the prefix; a browser handed one may refuse it.
        const candidate = event.candidate.candidate.replace(/^a=/, '');
        console.log('Generated ICE candidate:', candidate);
        this.onSignal({
          type: 'candidate',
          candidate: {
            candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          },
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      console.log('WebRTC connection state:', this.pc.connectionState);
      if (this.pc.connectionState === 'failed') {
        console.error('WebRTC Connection failed');
      }
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(this.pc.connectionState);
      }
    };

    this.pc.ondatachannel = (event) => {
      console.log('Received DataChannel from remote');
      this.setupDataChannel(event.channel);
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log('ICE Connection State:', this.pc.iceConnectionState);
    };
  }

  /**
   * Create the data channel. Only the offering side calls this; the answering
   * side receives the same channel through `ondatachannel`. The WebRTC
   * defaults make it ordered and reliable, which INTEROP_PROTOCOL.md §7
   * requires.
   */
  public createDataChannel(label: string) {
    console.log('Creating DataChannel:', label);
    const channel = this.pc.createDataChannel(label);
    this.setupDataChannel(channel);
  }

  private setupDataChannel(dc: RTCDataChannel) {
    // Wrapped at once, so its message listener is in place before the open
    // event hands the channel to anyone.
    const channel = createDataChannelDuplex(dc);
    this.channel = channel;
    dc.onopen = () => {
      console.log('Data channel open state:', dc.readyState);
      this.onDataChannelOpen(channel);
    };
  }

  public async createOffer() {
    console.log('Creating Offer...');
    const offer = await this.pc.createOffer();
    console.log('Offer created, setting local description...');
    await this.pc.setLocalDescription(offer);
    console.log('Local description set. Sending offer signal.');
    if (!offer.sdp) {
      throw new Error('Failed to create offer: SDP is missing');
    }
    this.onSignal({ type: 'offer', sdp: offer.sdp });
  }

  public async handleSignal(signal: WebRTCSignal) {
    console.log('Handling signal:', signal.type);
    try {
      if (signal.type === 'offer') {
        if (!signal.sdp) {
          throw new Error('Invalid offer signal: SDP is missing');
        }
        console.log('Setting remote offer...');
        await this.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        this.remoteDescriptionSet = true;
        await this.processQueue();

        console.log('Creating answer...');
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        if (!answer.sdp) {
          throw new Error('Failed to create answer: SDP is missing');
        }
        this.onSignal({ type: 'answer', sdp: answer.sdp });
      } else if (signal.type === 'answer') {
        if (!signal.sdp) {
          throw new Error('Invalid answer signal: SDP is missing');
        }
        console.log('Setting remote answer...');
        await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        this.remoteDescriptionSet = true;
        await this.processQueue();
      } else if (signal.type === 'candidate') {
        // A malformed candidate is refused by addIceCandidate, which ignores
        // that one and keeps the rest.
        if (signal.candidate?.candidate) {
          const candidate = signal.candidate;
          if (this.remoteDescriptionSet && this.pc.remoteDescription) {
            console.log('Adding ICE candidate immediately');
            await this.addIceCandidateSafely(candidate, 'immediate');
          } else {
            console.log('Buffering ICE candidate (remote description not set)');
            this.candidateQueue.push(candidate);
          }
        }
      }
    } catch (err) {
      console.error('Error handling signal:', err);
      throw err;
    }
  }

  public getPeerConnection(): RTCPeerConnection {
    return this.pc;
  }

  /**
   * Wait for ICE gathering to complete with a bounded timeout.
   * Uses event listeners + post-subscribe checks to avoid missing the completion event.
   * If the peer connection fails while waiting, rejects immediately.
   * Returns true when ICE gathering reaches "complete", false on timeout.
   */
  public async waitForIceGatheringComplete(
    timeoutMs: number = 5000,
  ): Promise<boolean> {
    if (this.pc.iceGatheringState === 'complete') {
      return true;
    }

    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        this.pc.removeEventListener(
          'icegatheringstatechange',
          onIceGatheringStateChange,
        );
        this.pc.removeEventListener(
          'connectionstatechange',
          onConnectionStateChange,
        );
        clearTimeout(timeoutId);
        clearInterval(pollId);
      };

      const settleResolve = (completed: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(completed);
      };

      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const checkState = () => {
        if (this.pc.iceGatheringState === 'complete') {
          settleResolve(true);
          return;
        }
        if (
          this.pc.connectionState === 'failed' ||
          this.pc.connectionState === 'closed'
        ) {
          settleReject(
            new Error('Connection failed while gathering network info'),
          );
          return;
        }
      };

      const onIceGatheringStateChange = () => {
        checkState();
      };

      const onConnectionStateChange = () => {
        checkState();
      };

      const timeoutId = setTimeout(() => {
        settleResolve(false);
      }, timeoutMs);
      const pollId = setInterval(checkState, 250);

      this.pc.addEventListener(
        'icegatheringstatechange',
        onIceGatheringStateChange,
      );
      this.pc.addEventListener(
        'connectionstatechange',
        onConnectionStateChange,
      );

      // Check after subscribing to avoid missing a race where state flips before handler attach.
      checkState();
    });
  }

  private async processQueue() {
    console.log(`Processing ${this.candidateQueue.length} buffered candidates`);
    while (this.candidateQueue.length > 0) {
      const c = this.candidateQueue.shift();
      if (c) {
        await this.addIceCandidateSafely(c, 'buffered');
      }
    }
  }

  private async addIceCandidateSafely(
    candidate: RTCIceCandidateInit,
    source: 'immediate' | 'buffered',
  ) {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (e) {
      // Ignore individual ICE candidate failures so remaining candidates can still establish connectivity.
      console.warn(`Ignoring ${source} ICE candidate error:`, e);
    }
  }

  public close() {
    this.channel?.close();
    this.pc.close();
  }
}
