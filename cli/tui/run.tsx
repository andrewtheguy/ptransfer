import { formatFileSize } from '@/lib/file-utils';
import type { SubmitEvent } from '@opentui/core';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Presenter } from '../ui/presenter';
import { MaskedField } from './masked-field';
import { createTuiPresenter } from './presenter';
import { Note, Problem, Screen } from './screen';
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

export interface RunProps {
  title: string;
  /** The transfer to run, given the presenter that shows it. */
  start(presenter: Presenter): Promise<number>;
  /**
   * A code the previous screen already took in, which answers the engine's
   * first request for one instead of asking again.
   */
  firstCode?: string;
  onFinished(status: number): void;
}

export function Run({ title, start, firstCode, onFinished }: RunProps) {
  const renderer = useRenderer();
  const [store] = useState(createTransferStore);
  const view = useSyncExternalStore(store.subscribe, store.snapshot);
  const [copied, setCopied] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // React runs an effect twice under StrictMode, and a transfer is not a
    // thing to start twice.
    if (started.current) return;
    started.current = true;
    const presenter = createTuiPresenter(store, { firstCode });
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
  }, [store, start, firstCode]);

  const { prompt, outcome, handed } = view;

  useKeyboard((key) => {
    if (outcome && (key.name === 'return' || key.name === 'escape')) {
      onFinished(outcome.status);
      return;
    }
    // A field has the keyboard while one is up; copying waits its turn. And
    // Ctrl-C is the app's, not the `c` that copies.
    if (prompt || key.ctrl || handed.length === 0) return;
    const digit = key.sequence ?? '';
    const index =
      key.name === 'c'
        ? handed.length - 1
        : /^[1-9]$/.test(digit)
          ? Number(digit) - 1
          : -1;
    const item = handed[index];
    if (!item) return;
    const ok = renderer.copyToClipboardOSC52(item.value);
    setCopied(
      ok
        ? `Copied ${item.label ?? 'the code'} to the clipboard.`
        : 'This terminal would not take a clipboard copy; select the text instead.',
    );
  });

  return (
    <Screen
      title={title}
      hints={
        outcome
          ? ['enter quit']
          : prompt
            ? ['enter submit']
            : handed.length > 1
              ? ['1-9 copy', 'ctrl-c stop']
              : handed.length === 1
                ? ['c copy', 'ctrl-c stop']
                : ['ctrl-c stop']
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
          <Note>
            {copied ??
              (handed.length > 1
                ? 'Press 1 or 2 to copy one to the clipboard.'
                : 'Press c to copy it to the clipboard.')}
          </Note>
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
              <CodeField attempt={prompt.attempt} onSubmit={prompt.submit} />
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
 * leave, and the box is there to prove it is whole and to be selected from
 * when the terminal will not take a clipboard copy.
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
    return (
      <text>
        <span fg={theme.muted}>{`${label}: `}</span>
        <span fg={theme.good}>{item.value}</span>
      </text>
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
 * The field a code is pasted into. A refused code leaves a new `attempt`
 * behind it, which empties the field rather than leaving the bad code to be
 * edited — a code is pasted whole or not at all.
 */
function CodeField({
  attempt,
  onSubmit,
}: {
  attempt: number;
  onSubmit(value: string): void;
}) {
  return (
    <input
      key={attempt}
      focused
      placeholder="paste here"
      // An input's `onSubmit` is its Enter event, which carries the value;
      // the prop is typed for the textarea's empty event as well, so the
      // handler has to be written to take either.
      onSubmit={(value: string | SubmitEvent) => {
        if (typeof value === 'string') onSubmit(value);
      }}
    />
  );
}
