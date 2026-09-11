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
