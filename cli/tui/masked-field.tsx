import { decodePasteBytes } from '@opentui/core';
import { useKeyboard, usePaste } from '@opentui/react';
import { useState } from 'react';
import { theme } from './theme';

/**
 * A field whose content is never shown: the one-time password a Tor receiver
 * was handed.
 *
 * OpenTUI's `<input>` has no mask, and a password on screen is a password on
 * whatever is recording the screen, so this reads the keys itself and draws a
 * dot per character. Pasting works, since a password is as likely to arrive
 * through a chat window as to be typed.
 */
export function MaskedField({ onSubmit }: { onSubmit(value: string): void }) {
  const [typed, setTyped] = useState('');

  usePaste((event) => {
    const text = decodePasteBytes(event.bytes).replace(/\s+/g, '');
    if (text) setTyped((was) => was + text);
  });

  useKeyboard((key) => {
    if (key.name === 'return') {
      if (typed) onSubmit(typed);
      return;
    }
    if (key.name === 'backspace') {
      setTyped((was) => was.slice(0, -1));
      return;
    }
    // Printable input only: an arrow key's escape sequence is not a password.
    const char = key.sequence;
    if (char && char.length === 1 && char >= ' ' && char <= '~') {
      setTyped((was) => was + char);
    }
  });

  return (
    <text fg={theme.heading}>
      {typed ? '•'.repeat(typed.length) : ' '}
      <span fg={theme.accent}>{'▌'}</span>
    </text>
  );
}
