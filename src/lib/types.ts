export interface ReceivedFile {
  contentType: 'file';
  /**
   * Received plaintext — in memory for payloads of 100 MiB or less, backed by
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
 * @property pakeSecret - The SPAKE2 password scalar w as 32 big-endian bytes
 *   (see derivePakeSecret). This is the secret the whole handshake rests on;
 *   the receiver feeds it to startPake/finishPake and wipes it once its
 *   claims are built. Kept as bytes rather than a CryptoKey because Web
 *   Crypto has no group operations — the PAKE math runs in @noble/curves.
 * @property locator - The PIN's public locator segment (see getPinLocator),
 *   the sole input to the per-bucket rendezvous hints the receiver filters on.
 *   Deliberately not secret: it is recoverable by enumeration from any hint the
 *   sender published, which is exactly why it is kept out of the PAKE's job.
 */
export interface PinKeyMaterial {
  pakeSecret: Uint8Array;
  locator: string;
}
