/**
 * Reading a secret from standard input.
 *
 * A password on the command line lands in shell history and in `ps`; on
 * standard input it lands nowhere. At a terminal it is typed at a prompt
 * with echo off; from a pipe or a file it is the first line.
 */

import { InterruptedError } from './interrupt';

export interface SecretInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

export interface SecretOutput {
  write: (text: string) => unknown;
}

export async function readSecret(
  prompt: string,
  input: SecretInput = process.stdin,
  output: SecretOutput = process.stderr,
): Promise<string> {
  if (input.isTTY && input.setRawMode) {
    return readAtTerminal(prompt, input, output);
  }
  return readFirstLine(input);
}

/** The first line, without its line ending. Empty input is an error. */
async function readFirstLine(input: SecretInput): Promise<string> {
  let text = '';
  for await (const chunk of input) {
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const newline = text.indexOf('\n');
    if (newline >= 0) {
      text = text.slice(0, newline);
      break;
    }
  }
  const line = text.replace(/\r$/, '');
  if (line === '') throw new Error('No password was given on standard input');
  return line;
}

/** Typed at the terminal, echo off; Ctrl-C and Ctrl-D give up. */
function readAtTerminal(
  prompt: string,
  input: SecretInput,
  output: SecretOutput,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Called on the stream: a real TTY's setRawMode needs its `this`.
    const setRawMode = (mode: boolean) => input.setRawMode?.(mode);
    let typed = '';
    const finish = (outcome: () => void) => {
      input.removeListener('data', onData);
      setRawMode(false);
      input.pause();
      output.write('\n');
      outcome();
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const char of text) {
        switch (char) {
          case '\r':
          case '\n':
            finish(() => resolve(typed));
            return;
          case '\u0003': // Ctrl-C, which raw mode delivers instead of SIGINT
            finish(() => reject(new InterruptedError()));
            return;
          case '\u0004': // Ctrl-D
            finish(() => reject(new Error('Cancelled')));
            return;
          case '\u007f': // Backspace
          case '\b':
            typed = typed.slice(0, -1);
            break;
          default:
            // Printable input only; an arrow key's escape sequence is not
            // part of a password.
            if (char >= ' ') typed += char;
        }
      }
    };
    output.write(prompt);
    setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}
