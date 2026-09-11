import { readCode } from '../code/code-input';
import { createProgressLine, createStatusLine } from '../progress';
import { readSecret } from '../secret';
import type { Presenter } from './presenter';

/**
 * A transfer on standard error and standard input: the line-oriented
 * interface, which is what a pipe and a script get and what every live test
 * drives.
 *
 * The lines a person reads, the engine's status messages and the transfer's
 * progress share one terminal line between them, and end it before handing it
 * over. Only `hand` goes to standard output, which carries nothing else, so a
 * script can read a command's result without filtering.
 */
export function createLinePresenter(label: string): Presenter {
  const progress = createProgressLine(label);
  const status = createStatusLine();
  const done = () => {
    progress.done();
    status.done();
  };
  const settle = <T>(run: () => T): T => {
    done();
    return run();
  };
  return {
    say(line) {
      settle(() => process.stderr.write(`${line}\n`));
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
    hand(value, label) {
      settle(() =>
        process.stdout.write(`${label ? `${label}: ` : ''}${value}\n`),
      );
    },
    readCode(prompt, accept) {
      return settle(() => readCode(prompt, accept));
    },
    readSecret(prompt) {
      return settle(() => readSecret(prompt));
    },
    done,
  };
}
