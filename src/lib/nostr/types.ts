// Event kinds (matching wormhole-rs)
export const EVENT_KIND_DATA_TRANSFER = 24242;
export const EVENT_KIND_RENDEZVOUS = 24243;

// Content types
export type ContentType = 'file';

// Transfer states
export type TransferStatus =
  | 'idle'
  | 'connecting'
  | 'waiting_for_receiver'
  // Confirmation-code handshake (Auto Exchange). The receiver shows a code
  // derived from the ECDH exchange; the sender parks until its operator types
  // the matching one, so a claim that front-ran the intended receiver stalls
  // here instead of receiving a file.
  | 'showing_confirmation_code'
  | 'awaiting_confirmation_code'
  | 'transferring'
  | 'receiving'
  | 'complete'
  | 'error'
  // Manual exchange states
  | 'generating_offer'
  | 'showing_offer'
  | 'waiting_for_answer'
  | 'waiting_for_offer'
  | 'generating_answer'
  | 'showing_answer';

// File metadata
export interface FileMetadata {
  fileName: string;
  fileSize: number;
  mimeType: string;
}

// Base properties shared across all transfer states
interface TransferStateBase {
  progress?: {
    current: number; // bytes transferred
    total: number; // total bytes
  };
  contentType?: ContentType;
  fileMetadata?: FileMetadata;
  useWebRTC?: boolean;
  currentRelays?: string[]; // Connected relay URLs being used (for signaling)
  totalRelays?: number; // Total relays attempted to connect
  // Set on an error state when a direct P2P connection could not be established;
  // drives the offline-QR fallback suggestion in the UI.
  connectionFailed?: boolean;
}

// Error state has required message
export interface TransferStateError extends TransferStateBase {
  status: 'error';
  message: string;
}

// All other states have optional message
export interface TransferStateOther extends TransferStateBase {
  status: Exclude<TransferStatus, 'error'>;
  message?: string;
}

// Discriminated union: TypeScript narrows to TransferStateError when status === 'error'
export type TransferState = TransferStateError | TransferStateOther;

/**
 * Rendezvous payload (encrypted with the PIN-derived rendezvous key inside the
 * kind-24243 event). Republished with a fresh PIN, hint, and nonce on every
 * rotation; transferId, senderPubkey, and the sender's ECDH public key stay
 * stable for the transfer's lifetime.
 */
export interface RendezvousPayload {
  type: 'rendezvous';
  contentType: ContentType;
  transferId: string;
  /** Nostr pubkey of the sender; must equal the rendezvous event author. */
  senderPubkey: string;
  /** Sender's ephemeral ECDH public key (base64, 65-byte uncompressed P-256). */
  ecdhPublicKey: string;
  /** Sender handshake nonce (base64), fresh per rotation; echoed in the claim. */
  nonce: string;
  // Sender's preferred relays for signaling
  relays?: string[];
  fileName: string;
  fileSize: number;
  /** False when fileSize is an input-size estimate for a streamed ZIP. */
  fileSizeExact: boolean;
  mimeType: string;
}

/**
 * Claim payload (receiver -> sender), sealed with the PIN-derived auth key.
 * Decrypting proves the receiver knows the PIN; the echoed sender nonce and
 * ECDH key bind the proof to this rotation generation and rule out a
 * man-in-the-middle substituting either side's ECDH key.
 */
export interface ClaimPayload {
  type: 'claim';
  transferId: string;
  /** Echo of the rendezvous nonce for the PIN generation the receiver used. */
  senderNonce: string;
  /** Fresh receiver handshake nonce (base64); echoed back in the confirm. */
  receiverNonce: string;
  /** Receiver's ephemeral ECDH public key (base64, 65-byte uncompressed P-256). */
  receiverEcdhPublicKey: string;
  /** Echo of the sender's ECDH public key the receiver will run ECDH against. */
  senderEcdhPublicKey: string;
  /**
   * Nostr pubkey of the sender the receiver is answering — the author of the
   * rendezvous event it opened. The sender rejects a claim naming anyone else,
   * so a relay cannot interpose its own identity between the two.
   */
  senderPubkey: string;
  /**
   * Receiver's own Nostr pubkey. Verified against this claim event's author,
   * which is what stops a sealed claim from being rewrapped and forwarded
   * under a third party's identity.
   */
  receiverPubkey: string;
  /**
   * Digest of the rendezvous the receiver acted on (see transcript.ts). The
   * sender compares it with the one it published, so substituted file metadata
   * is rejected outright rather than left for the humans to notice.
   */
  transcriptHash: string;
}

/**
 * Confirm payload (sender -> receiver), sealed with the same PIN-derived auth
 * key that verified the claim. Tells the receiver its claim won the transfer
 * and confirms the sender accepted exactly the receiver's ECDH key.
 */
export interface ConfirmPayload {
  type: 'confirm';
  transferId: string;
  senderNonce: string;
  receiverNonce: string;
  /** Echo of the receiver ECDH public key the sender locked the transfer to. */
  receiverEcdhPublicKey: string;
  /** Sender's own Nostr pubkey; verified against this confirm event's author. */
  senderPubkey: string;
  /** Echo of the receiver pubkey the sender locked onto. */
  receiverPubkey: string;
  /** Echo of the rendezvous transcript digest both sides agreed on. */
  transcriptHash: string;
}

// Re-export shared received-content types
export type { ReceivedContent, ReceivedFile } from '../types';

// WebRTC Signaling
export type SignalingType = 'offer' | 'answer' | 'candidate';

export interface SignalingPayload {
  type: SignalingType;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}
