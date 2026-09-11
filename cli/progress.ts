import { formatFileSize } from '@/lib/file-utils';

/**
 * A transfer's progress on standard error, without a terminal UI: one line
 * rewritten in place at a terminal, one line per tenth from a pipe.
 */

export interface ProgressLine {
  update(current: number, total: number): void;
  /** End the line, if one is being rewritten. */
  done(): void;
}

export function createProgressLine(
  label: string,
  output: {
    write: (text: string) => unknown;
    isTTY?: boolean;
  } = process.stderr,
): ProgressLine {
  const tty = output.isTTY === true;
  let lastTenth = -1;
  let pending = false;

  return {
    update(current, total) {
      const fraction = total > 0 ? Math.min(current / total, 1) : 0;
      const percent = Math.floor(fraction * 100);
      const text = `${label} ${percent}% (${formatFileSize(current)} of ${formatFileSize(total)})`;
      if (tty) {
        output.write(`\r${text}\x1b[K`);
        pending = true;
        return;
      }
      const tenth = Math.floor(fraction * 10);
      if (tenth === lastTenth) return;
      lastTenth = tenth;
      output.write(`${text}\n`);
    },
    done() {
      if (pending) output.write('\n');
      pending = false;
    },
  };
}

/**
 * What a transfer is doing, on standard error, one message at a time. A
 * message that only differs from the last in its numbers — "12 working of 22
 * checked", then "13 working of 23" — is the same step moving on: at a
 * terminal it replaces the last in place, and from a pipe it is left out, so
 * a step that ticks does not fill the screen or the log.
 */
export interface StatusLine {
  show(message: string): void;
  /** End the line, if one is being rewritten. */
  done(): void;
}

export function createStatusLine(
  output: {
    write: (text: string) => unknown;
    isTTY?: boolean;
  } = process.stderr,
): StatusLine {
  const tty = output.isTTY === true;
  const shapeOf = (message: string) => message.replace(/\d+/g, '#');
  let last: string | null = null;
  let pending = false;

  return {
    show(message) {
      if (message === last) return;
      const sameStep = last !== null && shapeOf(message) === shapeOf(last);
      last = message;
      if (!tty) {
        if (!sameStep) output.write(`${message}\n`);
        return;
      }
      if (sameStep && pending) {
        output.write(`\r${message}\x1b[K`);
        return;
      }
      if (pending) output.write('\n');
      output.write(message);
      pending = true;
    },
    done() {
      if (pending) output.write('\n');
      pending = false;
      last = null;
    },
  };
}
