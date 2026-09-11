/**
 * The WebRTC types the shared code in `src/lib` is written against, for a
 * build that leaves `lib.dom` out.
 *
 * Interfaces only, and deliberately so: there is no `declare var` here, so no
 * `RTCPeerConnection` global exists for the type checker either, just as none
 * exists in Bun. Shared code takes the implementation from its host — the
 * `PeerConnectionClass` in `src/lib/webrtc.ts` — and the CLI hands it
 * node-datachannel's W3C polyfill (`cli/webrtc.ts`). The members are the ones
 * that code uses, with the shapes `lib.dom` gives them.
 */

type RTCSdpType = 'answer' | 'offer' | 'pranswer' | 'rollback';
type RTCPeerConnectionState =
  | 'closed'
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'failed'
  | 'new';
type RTCIceConnectionState =
  | 'checking'
  | 'closed'
  | 'completed'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'new';
type RTCIceGatheringState = 'complete' | 'gathering' | 'new';
type RTCDataChannelState = 'closed' | 'closing' | 'connecting' | 'open';

interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface RTCConfiguration {
  iceServers?: RTCIceServer[];
  iceCandidatePoolSize?: number;
}

interface RTCIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

interface RTCIceCandidate {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
}

interface RTCSessionDescriptionInit {
  sdp?: string;
  type: RTCSdpType;
}

interface RTCSessionDescription {
  readonly sdp: string;
  readonly type: RTCSdpType;
}

interface RTCDataChannelInit {
  ordered?: boolean;
  maxPacketLifeTime?: number;
  maxRetransmits?: number;
  protocol?: string;
  negotiated?: boolean;
  id?: number;
}

interface RTCPeerConnectionIceEvent extends Event {
  readonly candidate: RTCIceCandidate | null;
}

interface RTCDataChannelEvent extends Event {
  readonly channel: RTCDataChannel;
}

interface RTCDataChannelEventMap {
  bufferedamountlow: Event;
  close: Event;
  closing: Event;
  error: Event;
  message: MessageEvent;
  open: Event;
}

interface RTCDataChannel extends EventTarget {
  binaryType: BinaryType;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  readonly label: string;
  readonly readyState: RTCDataChannelState;
  onopen: ((this: RTCDataChannel, ev: Event) => unknown) | null;
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void;
  close(): void;
  addEventListener<K extends keyof RTCDataChannelEventMap>(
    type: K,
    listener: (this: RTCDataChannel, ev: RTCDataChannelEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof RTCDataChannelEventMap>(
    type: K,
    listener: (this: RTCDataChannel, ev: RTCDataChannelEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface RTCPeerConnectionEventMap {
  connectionstatechange: Event;
  datachannel: RTCDataChannelEvent;
  icecandidate: RTCPeerConnectionIceEvent;
  iceconnectionstatechange: Event;
  icegatheringstatechange: Event;
}

interface RTCPeerConnection extends EventTarget {
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  readonly iceGatheringState: RTCIceGatheringState;
  readonly remoteDescription: RTCSessionDescription | null;
  onconnectionstatechange:
    | ((this: RTCPeerConnection, ev: Event) => unknown)
    | null;
  ondatachannel:
    | ((this: RTCPeerConnection, ev: RTCDataChannelEvent) => unknown)
    | null;
  onicecandidate:
    | ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => unknown)
    | null;
  oniceconnectionstatechange:
    | ((this: RTCPeerConnection, ev: Event) => unknown)
    | null;
  addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void>;
  close(): void;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  createDataChannel(
    label: string,
    dataChannelDict?: RTCDataChannelInit,
  ): RTCDataChannel;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addEventListener<K extends keyof RTCPeerConnectionEventMap>(
    type: K,
    listener: (
      this: RTCPeerConnection,
      ev: RTCPeerConnectionEventMap[K],
    ) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof RTCPeerConnectionEventMap>(
    type: K,
    listener: (
      this: RTCPeerConnection,
      ev: RTCPeerConnectionEventMap[K],
    ) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
}
