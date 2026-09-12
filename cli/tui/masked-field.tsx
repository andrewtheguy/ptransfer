import { decodePasteBytes } from '@opentui/core';
import { useKeyboard, usePaste } from '@opentui/react';
import { useRef, useState } from 'react';
import { theme } from './theme';

/**
 * A field whose content is never shown: the one-time password a Tor receiver
 * was handed.
 *
 * OpenTUI's `<input>` has no mask, and a password on screen is a password on
 * whatever is recording the screen, so this reads the keys itself and draws a
 * dot per character. Pasting works, since a password is as likely to arrive
 * through a chat window as to be typed.
 *
 * What has been typed lives in a ref rather than in state: a paste and the
 * Enter after it, or the last character and the Enter after it, can arrive in
 * one terminal read, and state changed by the first has not been committed
 * when the second is handled — a password would go in short, or empty. The
 * state alongside it is only the length, which is all the screen draws.
 */
export function MaskedField({ onSubmit }: { onSubmit(value: string): void }) {
  const typed = useRef('');
  const [length, setLength] = useState(0);

  const change = (next: string) => {
    typed.current = next;
    setLength(next.length);
  };

  usePaste((event) => {
    const text = decodePasteBytes(event.bytes).replace(/\s+/g, '');
    if (text) change(typed.current + text);
  });

  useKeyboard((key) => {
    if (key.name === 'return') {
      if (typed.current) onSubmit(typed.current);
      return;
    }
    if (key.name === 'backspace') {
      change(typed.current.slice(0, -1));
      return;
    }
    // One printable character, in whatever alphabet: an arrow key's escape
    // sequence is not a password and neither is a modified key, but a letter
    // with an accent on it can be one, and pasting that already works.
    const char = key.sequence;
    if (key.ctrl || !char) return;
    if ([...char].length === 1 && !/\p{C}/u.test(char)) {
      change(typed.current + char);
    }
  });

  return (
    <text fg={theme.heading}>
      {length > 0 ? '•'.repeat(length) : ' '}
      <span fg={theme.accent}>{'▌'}</span>
    </text>
  );
}
