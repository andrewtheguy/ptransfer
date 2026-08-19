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
 * Rendezvous payload (plaintext JSON inside the kind-24243 event). Republished
 * with a fresh PIN, hint, nonce, and SPAKE2 element on every rotation;
 * transferId and senderPubkey stay stable for the transfer's lifetime.
 *
 * Plaintext is deliberate: a SPAKE2 element is password-blinded, so nothing
 * here can confirm a PIN guess offline — encrypting it under a PIN-derived
 * key (as the pre-PAKE protocol did) would reintroduce exactly the offline
 * target the PAKE exists to remove. File metadata is *not* here for the same
 * reason; it travels sealed inside the confirm, after the handshake, under a
 * key only the two PAKE peers hold.
 */
export interface RendezvousPayload {
  type: 'rendezvous';
  transferId: string;
  /** Nostr pubkey of the sender; must equal the rendezvous event author. */
  senderPubkey: string;
  /** Sender's SPAKE2 element pA (base64, 33-byte compressed P-256 point). */
  pakeMessage: string;
  /** Sender handshake nonce (base64), fresh per rotation; echoed in the claim. */
  nonce: string;
  // Sender's preferred relays for signaling
  relays?: string[];
}

/**
 * The file metadata delivered inside the sender's sealed confirm payload —
 * after the handshake, never on the public rendezvous. Both sides hash it
 * into the confirmation code (see computeTransferMetadataHash), so the code
 * the humans compare attests to what is being transferred.
 */
export interface TransferMetadata {
  contentType: ContentType;
  fileName: string;
  fileSize: number;
  /** False when fileSize is an input-size estimate for a streamed ZIP. */
  fileSizeExact: boolean;
  mimeType: string;
}

/**
 * Claim payload (receiver -> sender), sealed with the claim key derived from
 * the receiver's SPAKE2 run against the rendezvous element. Opening it is the
 * sender's proof that the claimant knows the PIN: the seal key exists only on
 * the two ends of a matching PAKE session. The claim event also carries the
 * receiver's SPAKE2 element pB in plaintext (the sender needs it to finish
 * its side before it can try the seal).
 */
export interface ClaimPayload {
  type: 'claim';
  transferId: string;
  /** Echo of the rendezvous nonce for the PIN generation the receiver used. */
  senderNonce: string;
  /** Fresh receiver handshake nonce (base64); echoed back in the confirm. */
  receiverNonce: string;
  /**
   * Nostr pubkey of the sender the receiver is answering — the author of the
   * rendezvous event it acted on. Also keyed into the SPAKE2 transcript, so a
   * relay cannot interpose its own identity between the two.
   */
  senderPubkey: string;
  /**
   * Receiver's own Nostr pubkey. Verified against this claim event's author
   * and keyed into the SPAKE2 transcript, which is what stops a sealed claim
   * from being rewrapped and forwarded under a third party's identity.
   */
  receiverPubkey: string;
  /**
   * Digest of the rendezvous the receiver acted on (see transcript.ts). The
   * sender compares it with the one it published, so a republished rendezvous
   * with any altered field is rejected outright rather than left for the
   * humans to notice.
   */
  transcriptHash: string;
}

/**
 * Confirm payload (sender -> receiver), sealed with the confirm key from the
 * same SPAKE2 session that verified the claim. Tells the receiver its claim
 * won the transfer, proves the sender knows the PIN in the reverse direction,
 * and delivers the file metadata the rendezvous deliberately omits.
 *
 * Published as soon as the claim verifies — the confirmation-code gate guards
 * the WebRTC offer and file bytes, not this event. A front-runner holding a
 * stolen PIN learns the metadata here, which is nothing the old protocol kept
 * from them either (they could decrypt the rendezvous), and still gets no
 * bytes without reciting the code.
 */
export interface ConfirmPayload {
  type: 'confirm';
  transferId: string;
  senderNonce: string;
  receiverNonce: string;
  /** Sender's own Nostr pubkey; verified against this confirm event's author. */
  senderPubkey: string;
  /** Echo of the receiver pubkey the sender locked onto. */
  receiverPubkey: string;
  /** Echo of the rendezvous transcript digest both sides agreed on. */
  transcriptHash: string;
  /** File metadata, delivered post-handshake and bound into the code. */
  metadata: TransferMetadata;
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
