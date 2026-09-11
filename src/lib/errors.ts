/**
 * Custom error classes for specific error handling
 */

/**
 * Error thrown when input validation fails
 * Use this for user-facing validation errors that should be re-thrown as-is
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    // Fix prototype chain for instanceof to work reliably (esp. ES5 targets)
    Object.setPrototypeOf(this, ValidationError.prototype);
    this.name = 'ValidationError';
    // Capture stack trace if available (V8 environments)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ValidationError);
    }
  }
}

/**
 * Error thrown when a direct WebRTC P2P connection cannot be established
 * (or the peer never delivers data within the timeout).
 *
 * The send/receive hooks throw this at genuine connection-establishment failure
 * points so the UI can offer the offline-QR fallback without matching on error
 * message text.
 */
export class P2PConnectionError extends Error {
  constructor(message: string) {
    super(message);
    // Fix prototype chain for instanceof to work reliably (esp. ES5 targets)
    Object.setPrototypeOf(this, P2PConnectionError.prototype);
    this.name = 'P2PConnectionError';
    // Capture stack trace if available (V8 environments)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, P2PConnectionError);
    }
  }
}

/**
 * The payload being sent cannot be read as it was chosen: a file changed or
 * became unreadable on the sender's side. Unlike a failed connection, the
 * next receiver would meet it too, so the sender stops instead of waiting.
 *
 * `message` is for the sender and may name local paths; `peerReason` is what
 * the receiver is told, and names none.
 */
export class SourceError extends Error {
  readonly peerReason: string;

  constructor(message: string, peerReason: string) {
    super(message);
    Object.setPrototypeOf(this, SourceError.prototype);
    this.name = 'SourceError';
    this.peerReason = peerReason;
  }
}
