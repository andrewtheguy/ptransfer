import { isAnonymousOffer, parseMutualPayload } from '@/lib/code-signaling';
import {
  classifyReceiveText,
  looksLikeOffer,
  looksLikeOnionAddress,
  looksLikePin,
  type ReceiveInput,
} from '@/lib/receive-input';
import { TOR_BRIDGE_LABELS, type TorBridge } from '@/lib/tor/bridge';
import type { SubmitEvent } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useState } from 'react';
import { FIELD_MAX, Gap, Note, Problem, Screen } from './screen';
import { theme } from './theme';

/**
 * The receive screen: one field, and the mode read off what is in it.
 *
 * The receiver always holds exactly one of three things — a PIN, a Code
 * Exchange offer, or an onion address — and which it is, is decidable, so
 * there is nothing to ask. This is the tab's own `classifyReceiveText` on the
 * tab's own rules; only the QR chunk form has no answer here, because a
 * terminal has no camera to have scanned one with.
 *
 * Which bridge a Tor receive enters the network through is here as a key, as
 * the send screen's settings are — a non-printing one, since the field has
 * every printable key. It is only shown for what will go through Tor, since
 * to anything else the bridge is a setting with nothing to set. Where the
 * file is saved is not a setting here either: it is the screen after this
 * one, asked for once there is something to save.
 */

/**
 * A code that starts right and ends wrong. Worth its own words: a code is
 * carried by hand between two machines, and the way one fails is almost
 * always that something along the way cut it.
 */
const INCOMPLETE =
  'That is the start of a code, but not a whole one — or it is more than an hour old. Copy it again, whole.';

export type Accepted =
  | { kind: 'offer'; code: string }
  | { kind: 'onion'; address: string };

/**
 * Whether what is in the field will go through Tor. An onion address always
 * does. A code does only when the sender chose the anonymous fallback, which
 * the code says itself — a plain one falls back through Nostr, or not at all,
 * and never starts Tor.
 */
function needsTor(found: ReceiveInput | null): boolean {
  if (found?.kind === 'onion') return true;
  if (found?.kind !== 'offer') return false;
  const payload = parseMutualPayload(found.payload);
  return payload !== null && isAnonymousOffer(payload);
}

function describe(text: string, found: ReceiveInput | null): string | null {
  if (!text.trim()) return null;
  if (found?.kind === 'pin') return 'A PIN Exchange PIN';
  if (found?.kind === 'offer') {
    return needsTor(found)
      ? 'A Code Exchange code · anonymous, so its fallback is over Tor'
      : 'A Code Exchange code';
  }
  if (found?.kind === 'onion') return `A Tor onion service · ${found.address}`;
  if (found?.kind === 'offer-chunk') {
    return 'One QR chunk of a code — a terminal cannot scan the rest';
  }
  if (looksLikePin(text)) return 'That looks like a PIN, but it does not check out';
  if (looksLikeOnionAddress(text)) {
    return 'That looks like an onion address, but it does not check out';
  }
  if (looksLikeOffer(text)) return INCOMPLETE;
  return null;
}

export function ReceiveInputScreen({
  bridge,
  onBridge,
  onAccept,
  onUnsupported,
  onCancel,
}: {
  bridge: TorBridge;
  onBridge(): void;
  onAccept(accepted: Accepted): void;
  onUnsupported(what: string): void;
  onCancel(): void;
}) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const found = classifyReceiveText(text);
  const reading = describe(text, found);
  const tor = needsTor(found);

  // The submitted value rather than the state behind it: a paste and the Enter
  // after it can land in one frame, and the state would still be empty.
  const take = (raw: string) => {
    const found = classifyReceiveText(raw);
    if (!found) {
      setProblem(
        !raw.trim()
          ? 'Paste what the sender gave you.'
          : looksLikeOffer(raw)
            ? INCOMPLETE
            : 'That is not a PIN, a code, or an onion address. Check it was copied whole.',
      );
      return;
    }
    setProblem(null);
    switch (found.kind) {
      case 'pin':
        onUnsupported(
          'PIN Exchange is not supported in the terminal yet. Ask the sender for a code, or receive in the web app.',
        );
        return;
      case 'offer-chunk':
        setProblem(
          'That is one QR chunk of a code. Ask the sender to copy the whole code as text.',
        );
        return;
      case 'offer':
        onAccept({ kind: 'offer', code: raw.trim() });
        return;
      case 'onion':
        onAccept({ kind: 'onion', address: found.address });
        return;
    }
  };

  useKeyboard((key) => {
    if (key.name === 'escape') onCancel();
    if (key.name === 'tab' && tor) onBridge();
  });

  return (
    <Screen
      title="Receive"
      hints={
        tor
          ? ['enter continue', 'tab bridge', 'esc back']
          : ['enter continue', 'esc back']
      }
    >
      <text fg={theme.heading}>Paste what the sender gave you</text>
      <Note>A PIN, a Code Exchange code, or a .onion address.</Note>
      <Note>Where it is saved is the next screen.</Note>
      <Gap />
      <box
        style={{ border: true, borderColor: theme.border, height: 3 }}
        title=" code "
      >
        <input
          focused
          maxLength={FIELD_MAX}
          placeholder="paste here"
          onInput={(value) => {
            setText(value);
            setProblem(null);
          }}
          // An input's `onSubmit` is its Enter event, which carries the value;
          // the prop is typed for the textarea's empty event as well, so the
          // handler has to be written to take either.
          onSubmit={(value: string | SubmitEvent) => {
            if (typeof value === 'string') take(value);
          }}
        />
      </box>
      <Gap />
      {reading && <text fg={theme.good}>{reading}</text>}
      {problem && <Problem>{problem}</Problem>}
      <Gap />
      {tor && <Note>{`Tor bridge: ${TOR_BRIDGE_LABELS[bridge]}`}</Note>}
    </Screen>
  );
}
