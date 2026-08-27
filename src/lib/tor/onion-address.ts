import { sha3_256 } from '@noble/hashes/sha3.js';

/**
 * Parsing and validating v3 onion addresses, matching what ptransfer-cli's
 * `tor::split_address` accepts and how it spells what it accepted back.
 *
 * The address is not merely a hostname here: both peers bind their SPAKE2
 * transcript to the exact `<host>.onion:<port>` string (see torPakeIdentities),
 * so two peers who typed the same address in different letter cases have to
 * agree on one spelling or they derive different roots. Everything returned by
 * `parseOnionAddress` is that canonical, lowercase spelling.
 *
 * The checksum is verified locally, before anything touches the network. A
 * Tor bootstrap costs tens of seconds to minutes in a browser tab, and a typo
 * that is only caught after it would read as a network failure rather than as
 * the input error it is.
 */

/**
 * Virtual port both ends of a pTransfer onion transfer use. Onion services
 * have their own port space, so this collides with nothing, and it must match
 * ptransfer-cli's `tor::DEFAULT_PORT` — the port is part of the string the
 * handshake is bound to, so a peer that assumed a different one derives a
 * different SPAKE2 root and fails to authenticate.
 */
export const TOR_DEFAULT_PORT = 9735;

/** Length of the base32 label in a v3 address, excluding the `.onion` suffix. */
const ONION_LABEL_LENGTH = 56;
/** Version byte trailing the public key in a v3 address. */
const ONION_VERSION = 3;
/** Domain separator Tor hashes into a v3 address checksum. */
const CHECKSUM_PREFIX = '.onion checksum';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Decode an RFC 4648 base32 label, or null if it is not one. */
function decodeBase32(label: string): Uint8Array | null {
  const bits = label.length * 5;
  const out = new Uint8Array(Math.floor(bits / 8));
  let accumulator = 0;
  let accumulatedBits = 0;
  let offset = 0;

  for (const char of label) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) return null;
    accumulator = (accumulator << 5) | value;
    accumulatedBits += 5;
    if (accumulatedBits >= 8) {
      accumulatedBits -= 8;
      out[offset++] = (accumulator >> accumulatedBits) & 0xff;
    }
  }

  // The trailing bits that did not fill a byte are padding and must be zero;
  // otherwise two distinct labels would decode to the same key.
  if (
    accumulatedBits > 0 &&
    (accumulator & ((1 << accumulatedBits) - 1)) !== 0
  ) {
    return null;
  }
  return out;
}

/**
 * Whether `host` is a syntactically valid v3 onion host whose checksum and
 * version byte both check out. Case-insensitive; no port may be attached.
 */
export function isOnionHost(host: string): boolean {
  return decodeOnionHost(host) !== null;
}

/** The canonical lowercase spelling of a valid v3 onion host, or null. */
function decodeOnionHost(host: string): string | null {
  const lower = host.trim().toLowerCase();
  if (!lower.endsWith('.onion')) return null;

  const label = lower.slice(0, -'.onion'.length);
  if (label.length !== ONION_LABEL_LENGTH) return null;

  const decoded = decodeBase32(label);
  // 56 base32 characters decode to exactly 35 bytes: 32 key, 2 checksum, 1
  // version.
  if (decoded === null || decoded.length !== 35) return null;

  const publicKey = decoded.subarray(0, 32);
  const checksum = decoded.subarray(32, 34);
  const version = decoded[34];
  if (version !== ONION_VERSION) return null;

  const preimage = new Uint8Array(CHECKSUM_PREFIX.length + 33);
  preimage.set(new TextEncoder().encode(CHECKSUM_PREFIX), 0);
  preimage.set(publicKey, CHECKSUM_PREFIX.length);
  preimage[preimage.length - 1] = version;
  const expected = sha3_256(preimage);

  if (expected[0] !== checksum[0] || expected[1] !== checksum[1]) return null;
  return lower;
}

export interface OnionAddress {
  /** Canonical lowercase `<label>.onion` host. */
  host: string;
  port: number;
  /**
   * `<host>:<port>` — the exact string both peers bind the handshake to. It
   * always carries the port, because two peers that disagreed about it would
   * derive different SPAKE2 roots.
   */
  onion: string;
  /**
   * The same address as a human copies it: the port is dropped when it is the
   * default, since that is the only one this app ever publishes on and
   * ptransfer-cli assumes the same one. A non-default port is kept, so a
   * `--port` address still round-trips through the box that echoes it back.
   */
  display: string;
}

/**
 * Parse `<host>.onion` or `<host>.onion:<port>`, or null if it is neither.
 *
 * A port in the address wins over `defaultPort`, so the line ptransfer-cli
 * prints pastes in verbatim.
 */
export function parseOnionAddress(
  address: string,
  defaultPort = TOR_DEFAULT_PORT,
): OnionAddress | null {
  const trimmed = address.trim();
  if (!trimmed) return null;

  const separator = trimmed.lastIndexOf(':');
  let hostPart = trimmed;
  let port = defaultPort;

  if (separator >= 0) {
    const portText = trimmed.slice(separator + 1);
    if (!/^\d{1,5}$/.test(portText)) return null;
    port = Number(portText);
    if (port < 1 || port > 65535) return null;
    hostPart = trimmed.slice(0, separator);
  }

  const host = decodeOnionHost(hostPart);
  if (host === null) return null;

  return {
    host,
    port,
    onion: `${host}:${port}`,
    display: formatOnionAddress(host, port),
  };
}

/**
 * Spell an address the way it is handed to a person: `<host>.onion`, with the
 * port left implicit unless it is not the default one.
 *
 * The port is not a choice either side offers — it is a constant on both — so
 * showing it only gives the receiver five more characters to mistype and a `:`
 * that a chat client may swallow into a link. What the handshake binds is
 * still `<host>:<port>`; this is presentation only.
 */
export function formatOnionAddress(host: string, port: number): string {
  return port === TOR_DEFAULT_PORT ? host : `${host}:${port}`;
}
