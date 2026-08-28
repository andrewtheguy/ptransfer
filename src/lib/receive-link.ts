import { isValidPin } from './crypto';
import { parseOnionAddress } from './tor/onion-address';

/**
 * The deep links a sender's QR code encodes, and the fragment namespace they
 * share.
 *
 * Every mode's QR points at the same screen: the receiver scans with whatever
 * camera app they have, land on /receive with the value already in the box, and
 * only have to press Receive. The value it carries — a PIN or an onion address
 * — travels in the fragment, which browsers never send to a server.
 */
const RECEIVE_LINK_PATH = '/receive';

/**
 * Fragment prefixes marking each kind of link. They live together because they
 * share a namespace with each other and with Code Exchange's offer chunks.
 *
 * The `=` is load-bearing: extractChunkParam only accepts fragments matching
 * /^[A-Za-z0-9_-]+$/, so neither link can be mistaken for a Code Exchange offer
 * chunk no matter which parser runs first. PIN_CHARSET is a subset of that
 * class, so without the separator a bare PIN of either length would decode as a
 * (garbage) chunk.
 */
const PIN_FRAGMENT_PREFIX = 'p=';
const ONION_FRAGMENT_PREFIX = 'o=';

/**
 * Build the link a PIN QR encodes: {origin}/receive#p={pin}
 */
export function buildPinUrl(baseUrl: string, pin: string): string {
  return buildReceiveUrl(baseUrl, PIN_FRAGMENT_PREFIX, pin);
}

/**
 * Build the link a Tor address QR encodes: {origin}/receive#o={address}
 *
 * The one-time password is deliberately not in it. The address alone is not a
 * secret, and keeping the two apart is what lets them travel by different
 * routes.
 */
export function buildOnionUrl(baseUrl: string, address: string): string {
  return buildReceiveUrl(baseUrl, ONION_FRAGMENT_PREFIX, address);
}

function buildReceiveUrl(
  baseUrl: string,
  prefix: string,
  value: string,
): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}${RECEIVE_LINK_PATH}#${prefix}${value}`;
}

/**
 * Extract the PIN from a PIN link, or null if this is not one.
 *
 * Returns only complete, checksum-valid PINs — a partial or corrupted fragment
 * yields null rather than a half PIN the caller might try to use.
 */
export function extractPinFromUrl(text: string): string | null {
  const pin = extractFragmentValue(text, PIN_FRAGMENT_PREFIX);
  if (pin === null) return null;
  return isValidPin(pin) ? pin : null;
}

/**
 * Extract the onion address from a Tor link, or null if this is not one.
 *
 * Like the PIN, the address is validated here — its checksum is what catches a
 * misread code before a Tor bootstrap turns a typo into a network failure — and
 * comes back in the canonical spelling both peers bind their handshake to.
 */
export function extractOnionFromUrl(text: string): string | null {
  const value = extractFragmentValue(text, ONION_FRAGMENT_PREFIX);
  if (value === null) return null;
  return parseOnionAddress(value)?.display ?? null;
}

function extractFragmentValue(text: string, prefix: string): string | null {
  let hash: string;
  try {
    hash = new URL(text).hash;
  } catch {
    return null;
  }

  if (!hash.startsWith(`#${prefix}`)) return null;
  return hash.slice(1 + prefix.length);
}
