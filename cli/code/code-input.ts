import {
  isValidBinaryPayload,
  parseClipboardPayload,
  parseMutualPayload,
} from '@/lib/code-signaling';
import { InterruptedError } from '../interrupt';
import type { SecretInput, SecretOutput } from '../secret';

/**
 * Reading a Code Exchange code — the sender's, or the response to it — from
 * standard input.
 *
 * A code is the base64 of a PT01 container, the text the tab's Copy Data
 * produces; whitespace and line wrapping in it are ignored, so a code copied
 * out of a chat window that wrapped it still reads. There is no terminator to
 * wait for: input is taken until what has arrived decodes as a whole code,
 * which is what lets a script pipe a code in without closing the pipe.
 *
 * At a terminal the code is read in raw mode, because a terminal's own line
 * editing holds only so much — 1024 bytes on macOS — and a code can be
 * longer. What is pasted is echoed. An Enter on an empty line gives up on
 * what was pasted, which then did not form a code, and asks again.
 */

/** Why a code was refused, for the person or script that gave it. */
const INCOMPLETE =
  'That is not a complete pTransfer code, or it is more than an hour old. Check it was copied whole.';

/** The container `text` holds, once it holds a whole one. */
export function decodeCode(text: string): Uint8Array | null {
  const compact = text.replace(/\s+/g, '');
  if (compact === '') return null;
  const bytes = parseClipboardPayload(compact);
  if (!bytes || !isValidBinaryPayload(bytes)) return null;
  return parseMutualPayload(bytes) ? bytes : null;
}

/**
 * Read one code and hand its container to `accept`, which says what it is or
 * throws with why this side will not take it. At a terminal a refusal is
 * shown and the code asked for again; from a pipe it is the command's error.
 */
export async function readCode<T>(
  prompt: string,
  accept: (container: Uint8Array) => Promise<T>,
  input: SecretInput = process.stdin,
  output: SecretOutput = process.stderr,
): Promise<T> {
  if (input.isTTY && input.setRawMode) {
    return await readAtTerminal(prompt, accept, input, output);
  }
  return await readFromPipe(accept, input);
}

async function readFromPipe<T>(
  accept: (container: Uint8Array) => Promise<T>,
  input: SecretInput,
): Promise<T> {
  let text = '';
  for await (const chunk of input) {
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const container = decodeCode(text);
    if (container) return await accept(container);
  }
  throw new Error(
    text.trim() === '' ? 'No code was given on standard input' : INCOMPLETE,
  );
}

function readAtTerminal<T>(
  prompt: string,
  accept: (container: Uint8Array) => Promise<T>,
  input: SecretInput,
  output: SecretOutput,
): Promise<T> {
  return new Promise((resolve, reject) => {
    // Called on the stream: a real TTY's setRawMode needs its `this`.
    const setRawMode = (mode: boolean) => input.setRawMode?.(mode);
    let pasted = '';
    let line = '';

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
      pasted = '';
      line = '';
      output.write(prompt);
      listen();
    };
    const fail = (error: Error) => {
      stopListening();
      output.write('\n');
      reject(error);
    };
    const refuse = (reason: string) => {
      output.write(`\n${reason}\n`);
      ask();
    };
    const take = async (container: Uint8Array) => {
      stopListening();
      output.write('\n');
      let accepted: T;
      try {
        accepted = await accept(container);
      } catch (error) {
        output.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        ask();
        return;
      }
      resolve(accepted);
    };

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const char of text) {
        switch (char) {
          case '\u0003': // Ctrl-C, which raw mode delivers instead of SIGINT
            fail(new InterruptedError());
            return;
          case '\u0004': // Ctrl-D
            fail(new Error('Cancelled'));
            return;
          case '\r':
          case '\n':
            if (line === '' && pasted.trim() !== '') {
              // A second Enter: what was pasted is all there is.
              const container = decodeCode(pasted);
              if (container) {
                void take(container);
              } else {
                stopListening();
                refuse(INCOMPLETE);
              }
              return;
            }
            if (line !== '') output.write('\r\n');
            line = '';
            pasted += '\n';
            break;
          case '\u007f': // Backspace
          case '\b':
            if (line !== '') {
              line = line.slice(0, -1);
              pasted = pasted.slice(0, -1);
              output.write('\b \b');
            }
            break;
          default:
            // Printable input only; an arrow key's escape sequence is not
            // part of a code.
            if (char >= ' ') {
              line += char;
              pasted += char;
              output.write(char);
            }
        }
      }
      const container = decodeCode(pasted);
      if (container) void take(container);
    };

    ask();
  });
}
