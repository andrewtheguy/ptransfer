import { formatFileSize } from '@/lib/file-utils';
import { useKeyboard } from '@opentui/react';
import { homedir } from 'node:os';
import { useEffect, useRef, useState } from 'react';
import { type Entry, listDirectory, parentOf, shortenPath } from './browse';
import { Gap, Note, Problem, Screen } from './screen';
import { theme } from './theme';

/**
 * The path picker: a directory browser that marks what is to be sent, or
 * picks the one folder a received file is saved into.
 *
 * It is the terminal's answer to the file input the tab has, and it marks the
 * same thing the command line takes — several files and folders at once, which
 * `openSelection` then walks into one ZIP. In `folder` mode nothing is marked
 * and the directory being browsed is itself the answer, which is what `--out`
 * names.
 *
 * The keys are the same in both modes: the arrows and Enter move around the
 * tree, and tab is what finishes — with the marked paths, or with the folder
 * the browser is standing in.
 */

/** How many rows of the listing are shown at once. */
const WINDOW = 12;

export interface PickerProps {
  mode: 'paths' | 'folder';
  /** Where the browser opens. */
  start: string;
  title: string;
  /**
   * In folder mode, what the folder under Enter has to pass before it is the
   * answer: it returns the path to use, or throws with why this side will not
   * save into it. A refusal is shown and the browser stays where it is, so a
   * folder that cannot be written to is found out about here rather than
   * after a Tor bootstrap and a handshake.
   */
  accept?(directory: string): Promise<string>;
  onDone(chosen: string[]): void;
  onCancel(): void;
}

export function Picker({
  mode,
  start,
  title,
  accept,
  onDone,
  onCancel,
}: PickerProps) {
  const [directory, setDirectory] = useState(start);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  // Where the cursor is, read back by the key handler. Keys can arrive faster
  // than the screen is redrawn — several at once from a held arrow or a
  // terminal's own buffer — and the handler of the frame they land in would
  // otherwise act on the position the cursor had before them.
  const at = useRef(0);
  const [hidden, setHidden] = useState(false);
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  // One folder is being decided on at a time: Enter can land again while the
  // check on the last one is still out.
  const deciding = useRef(false);

  useEffect(() => {
    let current = true;
    setEntries(null);
    void (async () => {
      try {
        const found = await listDirectory(directory, hidden);
        if (!current) return;
        setEntries(found);
        setFailure(null);
        at.current = 0;
        setCursor(0);
        setOffset(0);
      } catch (error) {
        if (!current) return;
        setEntries([]);
        setFailure(
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
    return () => {
      current = false;
    };
  }, [directory, hidden]);

  // One row above the listing climbs out of the directory, so the cursor
  // moves over `rows` and index 0 is always that row.
  const above = parentOf(directory);
  const rows = entries ?? [];
  const total = rows.length + (above ? 1 : 0);

  const move = (delta: number) => {
    const next = Math.min(
      Math.max(at.current + delta, 0),
      Math.max(total - 1, 0),
    );
    at.current = next;
    setCursor(next);
    setOffset((from) => {
      if (next < from) return next;
      if (next >= from + WINDOW) return next - WINDOW + 1;
      return from;
    });
  };

  const toggle = (entry: Entry) => {
    setMarked((was) => {
      const next = new Set(was);
      if (!next.delete(entry.path)) next.add(entry.path);
      return next;
    });
  };

  /** Take the folder being browsed, if whoever asked for it will have it. */
  const decide = async (chosen: string) => {
    if (deciding.current) return;
    deciding.current = true;
    try {
      onDone([accept ? await accept(chosen) : chosen]);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      deciding.current = false;
    }
  };

  const entryAt = (index: number): Entry | null => {
    const shift = above ? 1 : 0;
    if (above && index === 0) return null;
    return rows[index - shift] ?? null;
  };

  useKeyboard((key) => {
    switch (key.name) {
      case 'up':
        move(-1);
        return;
      case 'down':
        move(1);
        return;
      case 'pageup':
        move(-WINDOW);
        return;
      case 'pagedown':
        move(WINDOW);
        return;
      case 'left':
        if (above) setDirectory(above);
        return;
      case 'escape':
        onCancel();
        return;
      default:
        break;
    }
    if (key.name === 'space' && mode === 'paths') {
      const entry = entryAt(at.current);
      if (entry) {
        toggle(entry);
        move(1);
      }
      return;
    }
    if (key.name === 'h') {
      setHidden((was) => !was);
      return;
    }
    if (key.name === 'right') {
      const entry = entryAt(at.current);
      if (entry?.directory) setDirectory(entry.path);
      return;
    }
    if (key.name === 'return') {
      // Enter acts on the row the cursor is on, in both modes: `../` climbs
      // out, a folder opens. Anything else would make the cursor a liar —
      // it is on `../` and the folder it is in gets taken instead.
      const entry = entryAt(at.current);
      if (!entry) {
        if (above) setDirectory(above);
        return;
      }
      if (entry.directory) {
        setDirectory(entry.path);
        return;
      }
      // A file has nothing to open: marking it is the only thing Enter could
      // have meant, and in folder mode there is nothing to mark.
      if (mode === 'paths') toggle(entry);
      return;
    }
    // Tab is what finishes, in both modes: the marked paths, or the folder
    // being browsed.
    if (key.name === 'tab') {
      if (mode === 'folder') void decide(directory);
      else if (marked.size > 0) onDone([...marked]);
    }
  });

  const home = homedir();
  const window = Array.from({ length: WINDOW }, (_, row) => offset + row).filter(
    (index) => index < total,
  );

  return (
    <Screen
      title={title}
      hints={
        mode === 'paths'
          ? [
              '↑↓ move',
              '→ open',
              '← up',
              'space mark',
              'h hidden',
              'tab send marked',
              'esc back',
            ]
          : [
              '↑↓ move',
              '→ open / enter',
              '← up',
              'h hidden',
              'tab save here',
              'esc back',
            ]
      }
    >
      <text fg={theme.heading}>{shortenPath(directory, home)}</text>
      <Gap />
      {entries === null ? (
        <Note>Reading...</Note>
      ) : (
        <box style={{ flexDirection: 'column' }}>
          {window.map((index) => {
            const entry = entryAt(index);
            const here = index === cursor;
            const name = entry
              ? `${entry.name}${entry.directory ? '/' : ''}`
              : '../';
            const box =
              mode === 'folder' || !entry
                ? '  '
                : marked.has(entry.path)
                  ? '[x]'
                  : '[ ]';
            const size =
              entry && entry.size !== null ? formatFileSize(entry.size) : '';
            return (
              <text
                key={entry?.path ?? '..'}
                fg={here ? theme.accent : entry?.directory ? theme.heading : undefined}
              >
                {`${here ? '▸' : ' '} ${box} ${name.padEnd(34).slice(0, 34)} ${size.padStart(9)}`}
              </text>
            );
          })}
          {total === 0 && <Note>This folder is empty.</Note>}
        </box>
      )}
      <Gap />
      {failure && <Problem>{failure}</Problem>}
      {mode === 'folder' ? (
        <text fg={theme.good}>
          {`Saving into ${shortenPath(directory, home)} · tab to save here`}
        </text>
      ) : (
        <text fg={marked.size > 0 ? theme.good : theme.muted}>
          {marked.size === 0
            ? 'Nothing marked yet — space marks the file or folder under the cursor.'
            : `${marked.size} marked · tab to send`}
        </text>
      )}
    </Screen>
  );
}
