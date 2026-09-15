import { formatFileSize } from '@/lib/file-utils';
import { CliRenderEvents, type Selection, type SubmitEvent } from '@opentui/core';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Presenter } from '../ui/presenter';
import { MaskedField } from './masked-field';
import { createTuiPresenter } from './presenter';
import { FIELD_MAX, Note, Problem, Screen } from './screen';
import { createTransferStore, type Handed } from './store';
import { theme } from './theme';

/**
 * A transfer, running.
 *
 * The engine is handed a `Presenter` that writes into a store rather than to
 * standard error, and this reads that store. Nothing shares a line the way the
 * line interface does: the step the engine is on, the bytes that have moved,
 * what the person has been handed and the lines they have read each keep their
 * own place, and a question the engine asks opens a field in the middle of it.
 *
 * The screen stays up after the transfer ends so its outcome can be read; the
 * status it leaves with is the one the command exits with.
 */

/** How many of the most recent lines are kept on screen. */
const LINES_SHOWN = 6;

/** How many rows a value too long for one line is given to scroll in. */
const LONG_VALUE = 5;

/** The width of the progress bar, in columns. */
const BAR = 40;

/**
 * What a copy that the terminal refused leaves behind. The mouse is the
 * app's, so selecting with the terminal instead takes the modifier every
 * terminal keeps for that.
 */
const NOT_TAKEN =
  'This terminal would not take a clipboard copy; hold shift (option on a Mac) and drag to select with the terminal instead.';

export interface RunProps {
  title: string;
  /** The transfer to run, given the presenter that shows it. */
  start(presenter: Presenter): Promise<number>;
  /**
   * An answer the previous screen already took in — a code, or a PIN — which
   * answers the engine's first request for one instead of asking again.
   */
  firstCode?: string;
  firstWord?: string;
  onFinished(status: number): void;
}

export function Run({
  title,
  start,
  firstCode,
  firstWord,
  onFinished,
}: RunProps) {
  const renderer = useRenderer();
  const [store] = useState(createTransferStore);
  const view = useSyncExternalStore(store.subscribe, store.snapshot);
  // The note under the values, and the value it is about: a PIN that rotates
  // takes its own note with it, since what is on the clipboard is then no
  // longer what is on the screen.
  const [copied, setCopied] = useState<{ value: string; note: string } | null>(
    null,
  );
  const started = useRef(false);

  useEffect(() => {
    // React runs an effect twice under StrictMode, and a transfer is not a
    // thing to start twice.
    if (started.current) return;
    started.current = true;
    const presenter = createTuiPresenter(store, { firstCode, firstWord });
    void (async () => {
      try {
        const status = await start(presenter);
        store.update((was) => ({
          ...was,
          prompt: null,
          outcome: { status, error: null },
        }));
      } catch (error) {
        store.update((was) => ({
          ...was,
          prompt: null,
          outcome: {
            status: 1,
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    })();
  }, [store, start, firstCode, firstWord]);

  const { prompt, outcome, handed, actions } = view;
  // The note stands only while the value it names is still on screen.
  const copiedNote =
    copied && handed.some((item) => item.value === copied.value)
      ? copied.note
      : null;
  // Which handed value the next tab copies, while a field is up.
  const turn = useRef(0);

  const copy = (index: number) => {
    const item = handed[index];
    if (!item) return;
    const ok = renderer.copyToClipboardOSC52(item.value);
    setCopied({
      value: item.value,
      note: ok
        ? `Copied ${item.label ?? 'the code'} to the clipboard.`
        : NOT_TAKEN,
    });
  };

  // A drag over a value copies what it took. The mouse is the app's, so the
  // terminal's own selection does not run, and a drag that only highlighted
  // would be a selection that copied nothing. A long value wraps in its box,
  // and the selection may carry those breaks, which the value never had.
  useEffect(() => {
    const onSelection = (selection: Selection) => {
      const text = selection.getSelectedText().replace(/\n/g, '');
      if (text === '') return;
      const item = handed.find((each) => each.value.includes(text));
      if (!item) return;
      const ok = renderer.copyToClipboardOSC52(text);
      const what =
        text === item.value ? (item.label ?? 'the code') : 'the selection';
      setCopied({
        value: item.value,
        note: ok ? `Copied ${what} to the clipboard.` : NOT_TAKEN,
      });
    };
    renderer.on(CliRenderEvents.SELECTION, onSelection);
    return () => {
      renderer.off(CliRenderEvents.SELECTION, onSelection);
    };
  }, [renderer, handed]);

  useKeyboard((key) => {
    if (outcome && (key.name === 'return' || key.name === 'escape')) {
      onFinished(outcome.status);
      return;
    }
    // Ctrl-C is the app's, not the `c` that copies.
    if (key.ctrl) return;
    // What the transfer itself offers — a fresh PIN is the one there is —
    // only while no field is up to take the key instead.
    if (!prompt && !outcome) {
      const offered = actions.find((action) => action.key === key.name);
      if (offered) {
        offered.run();
        return;
      }
    }
    if (handed.length === 0) return;
    // A field takes every printable key it is sent, so `c` and the digits
    // would be typed into it rather than copy anything — and the sender is
    // handed its code and asked for the answer to it at once, so that is
    // exactly when the code needs copying. Tab is the key that copies there,
    // stepping through the values when there is more than one.
    if (prompt) {
      if (key.name !== 'tab') return;
      const index = turn.current % handed.length;
      turn.current = index + 1;
      copy(index);
      return;
    }
    const digit = key.sequence ?? '';
    if (key.name === 'c') copy(handed.length - 1);
    else if (/^[1-9]$/.test(digit)) copy(Number(digit) - 1);
  });

  return (
    <Screen
      title={title}
      hints={
        outcome
          ? ['enter quit']
          : prompt
            ? handed.length > 0
              ? ['enter submit', 'tab copy']
              : ['enter submit']
            : [
                ...(handed.length > 1
                  ? ['1-9 copy']
                  : handed.length === 1
                    ? ['c copy']
                    : []),
                ...actions.map((action) => `${action.key} ${action.label}`),
                'ctrl-c stop',
              ]
      }
    >
      <box style={{ flexDirection: 'column', flexGrow: 1 }}>
        {view.lines.slice(-LINES_SHOWN).map((line, index) => (
          // Lines are append-only and never reordered, so their position is
          // as stable a key as they have — the same line can be said twice.
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only log
          <text key={index}>{line || ' '}</text>
        ))}
      </box>
      {handed.length > 0 && (
        <box style={{ flexDirection: 'column' }}>
          {handed.map((item, index) => (
            <HandedValue
              key={`${item.label ?? ''}:${item.value}`}
              item={item}
              index={index}
              numbered={handed.length > 1}
            />
          ))}
          <Note>{copiedNote ?? copyHint(Boolean(prompt), handed.length)}</Note>
        </box>
      )}
      {view.status && !outcome && <text fg={theme.accent}>{view.status}</text>}
      {view.progress && <Bar {...view.progress} />}
      {prompt && (
        <box style={{ flexDirection: 'column' }}>
          {prompt.error && <Problem>{prompt.error}</Problem>}
          <text fg={theme.heading}>{prompt.message}</text>
          <box
            style={{ border: true, borderColor: theme.border, height: 3 }}
          >
            {prompt.kind === 'secret' ? (
              <MaskedField onSubmit={prompt.submit} />
            ) : (
              <TypedField
                attempt={prompt.attempt}
                placeholder={prompt.kind === 'code' ? 'paste here' : 'type here'}
                onSubmit={prompt.submit}
              />
            )}
          </box>
        </box>
      )}
      {outcome && (
        <box style={{ flexDirection: 'column' }}>
          {outcome.error ? (
            <Problem>{outcome.error}</Problem>
          ) : (
            <text fg={outcome.status === 0 ? theme.good : theme.warn}>
              {outcome.status === 0 ? 'Done.' : 'Stopped.'}
            </text>
          )}
        </box>
      )}
    </Screen>
  );
}

/**
 * One thing the person must carry across, under the key that copies it.
 *
 * An onion address or a password is one line. A Code Exchange code is
 * thousands of characters and would fill the screen and push everything else
 * off it, so anything that does not fit on a line goes in a box of its own
 * that scrolls, with its length named — the clipboard is how it is meant to
 * leave, and the box is there to prove it is whole. Either kind is selectable,
 * and a drag over one copies what it selects.
 */
function HandedValue({
  item,
  index,
  numbered,
}: {
  item: Handed;
  index: number;
  numbered: boolean;
}) {
  const { width } = useTerminalDimensions();
  const label = `${numbered ? `${index + 1}. ` : ''}${item.label ?? 'code'}`;
  if (item.value.length <= width - label.length - 6) {
    // The label is its own text so that a drag over the value takes the
    // value alone.
    return (
      <box style={{ flexDirection: 'row' }}>
        <text fg={theme.muted}>{`${label}: `}</text>
        <text fg={theme.good} selectable>
          {item.value}
        </text>
      </box>
    );
  }
  return (
    <box
      style={{ border: true, borderColor: theme.border, height: LONG_VALUE + 2 }}
      title={` ${label} · ${item.value.length} characters `}
      titleColor={theme.muted}
    >
      <scrollbox style={{ flexGrow: 1 }}>
        <text fg={theme.good} selectable>
          {item.value}
        </text>
      </scrollbox>
    </box>
  );
}

/**
 * Which key copies a handed value, and what that key is depends on whether a
 * field is up: the field has every printable key, and tab is what is left.
 */
function copyHint(asking: boolean, count: number): string {
  if (asking) {
    return count > 1
      ? 'Press tab to copy each of them in turn.'
      : 'Press tab to copy it to the clipboard.';
  }
  return count > 1
    ? 'Press 1 or 2 to copy one to the clipboard.'
    : 'Press c to copy it to the clipboard.';
}

function Bar({ current, total }: { current: number; total: number }) {
  const fraction = total > 0 ? Math.min(current / total, 1) : 0;
  const filled = Math.round(fraction * BAR);
  return (
    <text>
      <span fg={theme.good}>{'█'.repeat(filled)}</span>
      <span fg={theme.border}>{'░'.repeat(BAR - filled)}</span>
      <span fg={theme.muted}>
        {` ${Math.floor(fraction * 100)}% (${formatFileSize(current)} of ${formatFileSize(total)})`}
      </span>
    </text>
  );
}

/**
 * The field an answer is typed or pasted into. A refused answer leaves a new
 * `attempt` behind it, which empties the field rather than leaving the bad one
 * to be edited — a code is pasted whole or not at all, and a PIN or a
 * confirmation code is short enough to type again.
 */
function TypedField({
  attempt,
  placeholder,
  onSubmit,
}: {
  attempt: number;
  placeholder: string;
  onSubmit(value: string): void;
}) {
  return (
    <input
      key={attempt}
      focused
      maxLength={FIELD_MAX}
      placeholder={placeholder}
      // An input's `onSubmit` is its Enter event, which carries the value;
      // the prop is typed for the textarea's empty event as well, so the
      // handler has to be written to take either.
      onSubmit={(value: string | SubmitEvent) => {
        if (typeof value === 'string') onSubmit(value);
      }}
    />
  );
}
