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
