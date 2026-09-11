import { createProgressLine, createStatusLine } from '../progress';

/**
 * A Code Exchange command's standard error: lines the person has to read, the
 * engine's status messages, and the transfer's progress, which share one
 * terminal line between them and end it before handing it over.
 */
export interface TransferOutput {
  /** A line that is always shown whole: an instruction, a result. */
  say(line: string): void;
  /** What the engine says it is doing. */
  status(message: string): void;
  progress(current: number, total: number): void;
  /** End whatever line is being rewritten. */
  done(): void;
}

export function createTransferOutput(
  label: string,
  say: (line: string) => void,
): TransferOutput {
  const progress = createProgressLine(label);
  const status = createStatusLine();
  const done = () => {
    progress.done();
    status.done();
  };
  return {
    say(line) {
      done();
      say(line);
    },
    status(message) {
      if (!message) return;
      progress.done();
      status.show(message);
    },
    progress(current, total) {
      status.done();
      progress.update(current, total);
    },
    done,
  };
}
