import { extractChunkParam } from './chunk-utils';
import { isValidPin, PIN_CHARSET, PIN_LENGTH } from './crypto';
import {
  isValidBinaryPayload,
  parseClipboardPayload,
} from './manual-signaling';
import { extractPinFromUrl } from './pin-link';

/**
 * Whatever the sender handed over, classified.
 *
 * The receiver always holds exactly one of two things — a PIN Exchange PIN or a
 * Code Exchange offer — and the difference is decidable, so the receive screen
 * detects it instead of asking which mode to use.
 */
export type ReceiveInput =
  /** A PIN, typed, pasted, or scanned off a PIN link. */
  | { kind: 'pin'; pin: string }
  /** A complete PT01 offer container, as produced by Copy Data. */
  | { kind: 'offer'; payload: Uint8Array }
  /** One /r# chunk of an offer. Only the scanner can act on this. */
  | { kind: 'offer-chunk'; param: string };

/**
 * Whether the text has a PIN's shape, checksum aside.
 *
 * Lets the input box tell "you mistyped a PIN" apart from "this is not a PIN at
 * all", which classifyReceiveText alone cannot express.
 */
export function looksLikePin(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length === PIN_LENGTH &&
    [...trimmed].every((char) => PIN_CHARSET.includes(char))
  );
}

/**
 * Identify pasted or scanned receiver input, or null if it is neither a PIN nor
 * an offer.
 *
 * PIN links are checked before chunk URLs only for readability; the two formats
 * cannot collide (see PIN_FRAGMENT_PREFIX in pin-link.ts).
 */
export function classifyReceiveText(text: string): ReceiveInput | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const linkedPin = extractPinFromUrl(trimmed);
  if (linkedPin) return { kind: 'pin', pin: linkedPin };

  if (isValidPin(trimmed)) return { kind: 'pin', pin: trimmed };

  const param = extractChunkParam(trimmed);
  if (param) return { kind: 'offer-chunk', param };

  const payload = parseClipboardPayload(trimmed);
  if (payload && isValidBinaryPayload(payload)) {
    return { kind: 'offer', payload };
  }

  return null;
}
