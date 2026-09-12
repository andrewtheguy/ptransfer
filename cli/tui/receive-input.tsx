import { homedir } from 'node:os';
import {
  classifyReceiveText,
  looksLikeOnionAddress,
  looksLikePin,
  type ReceiveInput,
} from '@/lib/receive-input';
import { TOR_BRIDGE_LABELS, type TorBridge } from '@/lib/tor/bridge';
import type { SubmitEvent } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useState } from 'react';
import { shortenPath } from './browse';
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
 * The two things a receive takes besides what is pasted are here as keys, as
 * the send screen's are: where the file is saved, and which bridge a Tor
 * receive enters the network through. Both are non-printing keys, since the
 * field has every printable one.
 */

export type Accepted =
  | { kind: 'offer'; code: string }
  | { kind: 'onion'; address: string };

function describe(text: string, found: ReceiveInput | null): string | null {
  if (!text.trim()) return null;
  if (found?.kind === 'pin') return 'A PIN Exchange PIN';
  if (found?.kind === 'offer') return 'A Code Exchange code';
  if (found?.kind === 'onion') return `A Tor onion service · ${found.address}`;
  if (found?.kind === 'offer-chunk') {
    return 'One QR chunk of a code — a terminal cannot scan the rest';
  }
  if (looksLikePin(text)) return 'That looks like a PIN, but it does not check out';
  if (looksLikeOnionAddress(text)) {
    return 'That looks like an onion address, but it does not check out';
  }
  return null;
}

export function ReceiveInputScreen({
  folder,
  folderProblem,
  bridge,
  onFolder,
  onBridge,
  onAccept,
  onUnsupported,
  onCancel,
}: {
  folder: string;
  /** Why nothing can be saved into `folder`, which stops a transfer starting. */
  folderProblem: string | null;
  bridge: TorBridge;
  onFolder(): void;
  onBridge(): void;
  onAccept(accepted: Accepted): void;
  onUnsupported(what: string): void;
  onCancel(): void;
}) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const reading = describe(text, classifyReceiveText(text));

  // The submitted value rather than the state behind it: a paste and the Enter
  // after it can land in one frame, and the state would still be empty.
  const take = (raw: string) => {
    // A folder that cannot be written to costs a Tor bootstrap and a
    // handshake to find out about afterwards, so it stops the transfer here.
    if (folderProblem) {
      setProblem(folderProblem);
      return;
    }
    const found = classifyReceiveText(raw);
    if (!found) {
      setProblem(
        raw.trim()
          ? 'That is not a PIN, a code, or an onion address. Check it was copied whole.'
          : 'Paste what the sender gave you.',
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
    if (key.name === 'tab') {
      if (key.shift) onBridge();
      else onFolder();
    }
  });

  return (
    <Screen
      title="Receive"
      hints={[
        'enter continue',
        'tab change folder',
        'shift-tab bridge',
        'esc back',
      ]}
    >
      <text fg={theme.heading}>Paste what the sender gave you</text>
      <Note>A PIN, a Code Exchange code, or a .onion address.</Note>
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
      {folderProblem ? (
        <Problem>{folderProblem}</Problem>
      ) : (
        <Note>{`Saving into ${shortenPath(folder, homedir())}`}</Note>
      )}
      <Note>{`Tor bridge: ${TOR_BRIDGE_LABELS[bridge]}`}</Note>
    </Screen>
  );
}
