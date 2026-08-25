import { isValidPin } from './crypto';

/**
 * Route the PIN deep link lands on. The consolidated receive screen reads the
 * fragment on mount, so a PIN QR opens straight into the input it belongs in.
 */
const PIN_LINK_PATH = '/receive';

/**
 * Fragment prefix marking a PIN link.
 *
 * The `=` is load-bearing: extractChunkParam only accepts fragments matching
 * /^[A-Za-z0-9_-]+$/, so a PIN link can never be mistaken for a Code Exchange
 * offer chunk no matter which parser runs first. PIN_CHARSET is a subset of
 * that class, so without the separator a bare 12-character PIN would decode as
 * a (garbage) chunk.
 */
const PIN_FRAGMENT_PREFIX = 'p=';

/**
 * Build the link a PIN QR encodes: {origin}/receive#p={pin}
 *
 * The PIN rides in the fragment, which browsers never send to a server.
 */
export function buildPinUrl(baseUrl: string, pin: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}${PIN_LINK_PATH}#${PIN_FRAGMENT_PREFIX}${pin}`;
}

/**
 * Extract the PIN from a PIN link, or null if this is not one.
 *
 * Returns only complete, checksum-valid PINs — a partial or corrupted fragment
 * yields null rather than a half PIN the caller might try to use.
 */
export function extractPinFromUrl(text: string): string | null {
  let hash: string;
  try {
    hash = new URL(text).hash;
  } catch {
    return null;
  }

  if (!hash.startsWith(`#${PIN_FRAGMENT_PREFIX}`)) return null;

  const pin = hash.slice(1 + PIN_FRAGMENT_PREFIX.length);
  return isValidPin(pin) ? pin : null;
}
