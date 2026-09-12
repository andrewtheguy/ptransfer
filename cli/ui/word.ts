import { InterruptedError } from '../interrupt';
import {
  escapeSequenceFilter,
  type SecretInput,
  type SecretOutput,
} from '../secret';

/**
 * Reading one short answer from standard input: a PIN Exchange PIN, or the
 * confirmation code the other side is showing.
 *
 * Both are carried by a person — typed from something read out loud — so
 * unlike a Tor password they are echoed: the thing that goes wrong is a
 * mistyped character, and a character you cannot see is one you cannot fix.
 * What is typed is checked as soon as Enter ends the line, and a refusal —
 * a PIN whose checksum does not add up, a confirmation code that is not the
 * one expected — is shown and the answer asked for again.
 *
 * From a pipe the first line is the answer and a refusal is the command's
 * error: there is no one there to type a second one.
 */

/** Read one answer and hand it to `accept`, which says what it is or throws. */
export async function readWord<T>(
  prompt: string,
  accept: (text: string) => T | Promise<T>,
  input: SecretInput = process.stdin,
  output: SecretOutput = process.stderr,
): Promise<T> {
  if (input.isTTY && input.setRawMode) {
    return await readAtTerminal(prompt, accept, input, output);
  }
  return await readFromPipe(accept, input);
}

/** The first line, without its line ending. Empty input is an error. */
async function readFromPipe<T>(
  accept: (text: string) => T | Promise<T>,
  input: SecretInput,
): Promise<T> {
  let text = '';
  for await (const chunk of input) {
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const newline = text.indexOf('\n');
    if (newline >= 0) {
      text = text.slice(0, newline);
      break;
    }
  }
  const line = text.trim();
  if (line === '') throw new Error('Nothing was given on standard input');
  return await accept(line);
}

/** Typed at the terminal and echoed; Ctrl-C and Ctrl-D give up. */
function readAtTerminal<T>(
  prompt: string,
  accept: (text: string) => T | Promise<T>,
  input: SecretInput,
  output: SecretOutput,
): Promise<T> {
  return new Promise((resolve, reject) => {
    // Called on the stream: a real TTY's setRawMode needs its `this`.
    const setRawMode = (mode: boolean) => input.setRawMode?.(mode);
    let typed = '';
    // An arrow key's bracket and letter are no more part of a PIN than the
    // ESC that introduced them.
    let inSequence = escapeSequenceFilter();

    const listen = () => {
      setRawMode(true);
      input.resume();
      input.on('data', onData);
    };
    const stopListening = () => {
      input.removeListener('data', onData);
      setRawMode(false);
      input.pause();
    };
    const ask = () => {
      typed = '';
      inSequence = escapeSequenceFilter();
      output.write(prompt);
      listen();
    };
    const fail = (error: Error) => {
      stopListening();
      output.write('\n');
      reject(error);
    };
    const take = async (text: string) => {
      stopListening();
      output.write('\n');
      if (text.trim() === '') {
        ask();
        return;
      }
      try {
        resolve(await accept(text.trim()));
      } catch (error) {
        if (error instanceof InterruptedError) {
          reject(error);
          return;
        }
        output.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        ask();
      }
    };

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const char of text) {
        if (inSequence(char)) continue;
        switch (char) {
          case '\r':
          case '\n':
            void take(typed);
            return;
          case '\u0003': // Ctrl-C, which raw mode delivers instead of SIGINT
            fail(new InterruptedError());
            return;
          case '\u0004': // Ctrl-D
            fail(new Error('Cancelled'));
            return;
          case '\u007f': // Backspace
          case '\b':
            if (typed !== '') {
              typed = typed.slice(0, -1);
              output.write('\b \b');
            }
            break;
          default:
            // Printable input only; what an escape sequence is made of has
            // already been swallowed above.
            if (char >= ' ') {
              typed += char;
              output.write(char);
            }
        }
      }
    };

    ask();
  });
}
