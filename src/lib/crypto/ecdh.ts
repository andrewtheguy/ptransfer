import { AES_KEY_LENGTH } from './constants';

/**
 * ECDH key agreement for Code Exchange.
 *
 * SECURITY: Keys are generated as non-extractable to prevent exfiltration.
 * Public keys can still be exported even when non-extractable.
 *
 * ECDH by itself does not authenticate the peer. Manual mode relies on the
 * user-controlled QR/clipboard exchange path for authenticity.
 */

/**
 * Helper to get a proper ArrayBuffer from Uint8Array (handles subarray views)
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  // Create a copy for subarray views
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Generate fingerprint from public key bytes.
 * Returns 16 uppercase hex characters (64 bits from SHA-256 hash).
 * Used for event filtering and verification display.
 */
export async function publicKeyToFingerprint(
  publicKeyBytes: Uint8Array,
): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    publicKeyBytes as BufferSource,
  );
  const hashArray = new Uint8Array(hash);

  // Take first 8 bytes (64 bits) and convert to uppercase hex
  return Array.from(hashArray.slice(0, 8), (b) =>
    b.toString(16).padStart(2, '0'),
  )
    .join('')
    .toUpperCase();
}

/**
 * Format a fingerprint for human-readable display.
 * Input: 16 hex chars (e.g., "A1B2C3D4E5F67890")
 * Output: "A1B2-C3D4-E5F6-7890"
 * @throws TypeError if input is not exactly 16 hex characters
 */
export function formatFingerprint(fingerprint: string): string {
  if (typeof fingerprint !== 'string' || fingerprint.length !== 16) {
    throw new TypeError(
      `Invalid fingerprint: expected 16-character hex string, got ${typeof fingerprint === 'string' ? `${fingerprint.length} characters` : typeof fingerprint}`,
    );
  }
  if (!/^[0-9A-Fa-f]+$/.test(fingerprint)) {
    throw new TypeError(`Invalid fingerprint: contains non-hex characters`);
  }
  const fp = fingerprint.toUpperCase();
  return `${fp.slice(0, 4)}-${fp.slice(4, 8)}-${fp.slice(8, 12)}-${fp.slice(12, 16)}`;
}

/**
 * ECDH key pair with raw public key bytes for transmission.
 * WARNING: privateKey must never be exported or stored - use only for deriveBits.
 */
export interface ECDHKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey; // Ephemeral only - never export or store
  publicKeyBytes: Uint8Array; // 65 bytes uncompressed P-256 (0x04 || x || y)
}

/**
 * Generate an ephemeral ECDH key pair using P-256 curve.
 * Returns the key pair along with raw public key bytes for transmission.
 *
 * Keys are generated as non-extractable for security.
 */
export async function generateECDHKeyPair(): Promise<ECDHKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    false, // non-extractable
    ['deriveBits', 'deriveKey'],
  );

  // Export public key to raw format (65 bytes for P-256 uncompressed)
  const publicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', keyPair.publicKey),
  );

  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicKeyBytes,
  };
}

/**
 * Import a peer's public key from raw bytes.
 * Expects 65-byte uncompressed P-256 format: 0x04 || X (32 bytes) || Y (32 bytes)
 */
export async function importECDHPublicKey(
  publicKeyBytes: Uint8Array,
): Promise<CryptoKey> {
  // Validate uncompressed P-256 public key format
  if (!(publicKeyBytes instanceof Uint8Array) || publicKeyBytes.length !== 65) {
    throw new TypeError(
      'Invalid ECDH public key: expected 65-byte uncompressed P-256 key (0x04 || X || Y)',
    );
  }
  if (publicKeyBytes[0] !== 0x04) {
    throw new TypeError(
      'Invalid ECDH public key: missing uncompressed point prefix (0x04)',
    );
  }

  return await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(publicKeyBytes),
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    false, // non-extractable - only used for deriveBits
    [],
  );
}

/**
 * Derive shared secret as a non-extractable HKDF CryptoKey.
 * The raw shared secret bytes are never exposed to JavaScript - they remain
 * inside the crypto module.
 *
 * The returned key can be used with deriveAESKeyFromSecretKey(),
 * deriveNostrSessionKeys(), and deriveConfirmationCode() (kdf.ts) to derive
 * further values.
 *
 * SECURITY: The shared secret never leaves the Web Crypto module as raw bytes,
 * preventing exfiltration via XSS or memory inspection.
 */
export async function deriveSharedSecretKey(
  privateKey: CryptoKey,
  peerPublicKeyBytes: Uint8Array,
): Promise<CryptoKey> {
  const peerPublicKey = await importECDHPublicKey(peerPublicKeyBytes);

  // Use deriveKey to get HKDF key material directly from ECDH
  // The shared secret stays inside Web Crypto as non-extractable key
  return await crypto.subtle.deriveKey(
    {
      name: 'ECDH',
      public: peerPublicKey,
    },
    privateKey,
    {
      name: 'HKDF',
    },
    false, // non-extractable
    ['deriveKey', 'deriveBits'],
  );
}

/**
 * Derive AES-256-GCM key from HKDF CryptoKey (from deriveSharedSecretKey).
 * This is the secure version that never exposes raw shared secret bytes.
 *
 * @param sharedSecretKey - Non-extractable HKDF CryptoKey from deriveSharedSecretKey()
 * @param salt - Per-transfer salt for key derivation (at least 16 bytes)
 */
export async function deriveAESKeyFromSecretKey(
  sharedSecretKey: CryptoKey,
  salt: Uint8Array,
): Promise<CryptoKey> {
  if (salt.length < 16) {
    throw new Error(
      `Salt too short: expected at least 16 bytes, got ${salt.length}`,
    );
  }

  return await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: new TextEncoder().encode('ptransfer-mutual'),
    },
    sharedSecretKey,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Compute public key commitment (first 16 bytes of SHA-256 hash).
 * Used to prevent relay MITM attacks by committing to receiver's identity.
 * Returns 32 hex characters.
 */
export async function computePublicKeyCommitment(
  publicKeyBytes: Uint8Array,
): Promise<string> {
  if (!(publicKeyBytes instanceof Uint8Array) || publicKeyBytes.length < 16) {
    throw new TypeError(
      `Invalid public key bytes: expected at least 16 bytes, got ${publicKeyBytes instanceof Uint8Array ? publicKeyBytes.length : typeof publicKeyBytes}`,
    );
  }

  const hash = await crypto.subtle.digest(
    'SHA-256',
    publicKeyBytes as BufferSource,
  );
  const hashArray = new Uint8Array(hash);
  // Take first 16 bytes (32 hex chars)
  return Array.from(hashArray.slice(0, 16), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * Verify public key matches commitment.
 * Uses constant-time comparison to prevent timing attacks.
 */
export async function verifyPublicKeyCommitment(
  publicKeyBytes: Uint8Array,
  commitment: string,
): Promise<boolean> {
  const computed = await computePublicKeyCommitment(publicKeyBytes);
  return constantTimeEqual(computed, commitment.toLowerCase());
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns true only if strings are equal (same length and content), false otherwise.
 *
 * Note: This is a best-effort constant-time mitigation in JavaScript.
 * True constant-time guarantees are not possible in JS due to JIT optimization,
 * garbage collection, and string implementation details. However, this approach
 * avoids obvious timing leaks from early returns or variable iteration counts.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);

  // XOR lengths to detect mismatch (will be non-zero if different)
  let result = a.length ^ b.length;

  // Compare all characters up to maxLen, using 0 for out-of-bounds access
  for (let i = 0; i < maxLen; i++) {
    const charA = i < a.length ? a.charCodeAt(i) : 0;
    const charB = i < b.length ? b.charCodeAt(i) : 0;
    result |= charA ^ charB;
  }

  return result === 0;
}

/**
 * Constant-time comparison of two Uint8Arrays.
 * Prevents timing attacks by always comparing all bytes regardless of mismatch.
 *
 * Note: This is a best-effort constant-time mitigation in JavaScript.
 * True constant-time guarantees are not possible in JS due to JIT optimization,
 * garbage collection, and runtime engine behavior. However, this approach
 * avoids obvious timing leaks from early returns or variable iteration counts.
 */
export function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  // XOR lengths to detect mismatch
  let result = a.length ^ b.length;

  // Compare all bytes up to the longer length
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const byteA = i < a.length ? a[i] : 0;
    const byteB = i < b.length ? b[i] : 0;
    result |= byteA ^ byteB;
  }

  return result === 0;
}
