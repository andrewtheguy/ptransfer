export interface ReceivedFile {
  contentType: 'file';
  /**
   * Received plaintext — in memory for payloads of 100MB or less, backed by
   * an OPFS scratch file above that so reading/downloading streams from disk.
   */
  data: Blob;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export type ReceivedContent = ReceivedFile;

/**
 * Key material derived from an entered PIN.
 * @property key - Non-extractable HKDF PIN root (see importPinRoot): the full
 *   PBKDF2 stretch of the PIN, from which the receiver derives the rendezvous
 *   payload key and the claim/confirm auth key. It derives no
 *   content-encryption keys — those come from the ephemeral ECDH exchange the
 *   PIN authenticates.
 * @property locator - The PIN's public locator segment (see getPinLocator),
 *   the sole input to the per-bucket rendezvous hints the receiver filters on.
 *   Deliberately not secret: it is recoverable by enumeration from any hint the
 *   sender published, which is exactly why it is kept out of the root's job.
 */
export interface PinKeyMaterial {
  key: CryptoKey;
  locator: string;
}
