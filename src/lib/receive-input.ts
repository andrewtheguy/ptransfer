import { extractChunkParam } from './chunk-utils';
import { isValidBinaryPayload, parseClipboardPayload } from './code-signaling';
import { classifyPin, PIN_CHARSET, PIN_LENGTHS, type PinKind } from './crypto';
import { extractPinFromUrl } from './pin-link';
import { parseOnionAddress } from './tor/onion-address';

/**
 * Whatever the sender handed over, classified.
 *
 * The receiver always holds exactly one of three things — a PIN Exchange PIN, a
 * Code Exchange offer, or a Tor onion address — and the difference is
 * decidable, so the receive screen detects it instead of asking which mode to
 * use. Only the Tor mode needs a second input afterwards: its password is a
 * separate secret and is asked for once the address is recognized.
 */
export type ReceiveInput =
  /**
   * A PIN, typed, pasted, or scanned off a PIN link. `pinKind` is read off its
   * length and decides which relay pool the sender is waiting on — there is
   * nothing to ask the receiver about it.
   */
  | { kind: 'pin'; pin: string; pinKind: PinKind }
  /** A complete PT01 offer container, as produced by Copy Data. */
  | { kind: 'offer'; payload: Uint8Array }
  /** One /r# chunk of an offer. Only the scanner can act on this. */
  | { kind: 'offer-chunk'; param: string }
  /**
   * A v3 onion address with a valid checksum, in the canonical spelling a
   * person is handed: `<host>.onion`, and the port only when it is not the
   * default. The handshake re-parses it into the `<host>:<port>` string it
   * binds, so nothing downstream depends on which of the two forms was typed.
   */
  | { kind: 'onion'; address: string };

/**
 * Whether the text has a PIN's shape, checksum aside.
 *
 * Lets the input box tell "you mistyped a PIN" apart from "this is not a PIN at
 * all", which classifyReceiveText alone cannot express.
 */
export function looksLikePin(text: string): boolean {
  const trimmed = text.trim();
  return (
    Object.values(PIN_LENGTHS).includes(trimmed.length) &&
    [...trimmed].every((char) => PIN_CHARSET.includes(char))
  );
}

/**
 * Whether the text has an onion address's shape, checksum aside.
 *
 * Lets the input box tell "you mistyped an onion address" apart from "this is
 * not an address at all", which classifyReceiveText alone cannot express.
 */
export function looksLikeOnionAddress(text: string): boolean {
  return /\.onion(:\d{1,5})?$/i.test(text.trim());
}

/**
 * Identify pasted or scanned receiver input, or null if it is none of a PIN, an
 * onion address, or an offer.
 *
 * PIN links are checked before chunk URLs only for readability; the two formats
 * cannot collide (see PIN_FRAGMENT_PREFIX in pin-link.ts).
 */
export function classifyReceiveText(text: string): ReceiveInput | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const linkedPin = extractPinFromUrl(trimmed);
  if (linkedPin) {
    // extractPinFromUrl already validated it, so the kind is decided.
    const linkedKind = classifyPin(linkedPin);
    if (linkedKind) return { kind: 'pin', pin: linkedPin, pinKind: linkedKind };
  }

  const pinKind = classifyPin(trimmed);
  if (pinKind) return { kind: 'pin', pin: trimmed, pinKind };

  const onion = parseOnionAddress(trimmed);
  if (onion) return { kind: 'onion', address: onion.display };

  const param = extractChunkParam(trimmed);
  if (param) return { kind: 'offer-chunk', param };

  const payload = parseClipboardPayload(trimmed);
  if (payload && isValidBinaryPayload(payload)) {
    return { kind: 'offer', payload };
  }

  return null;
}
