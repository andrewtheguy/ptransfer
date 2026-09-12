import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { InterruptedError } from '../interrupt';
import type { SecretInput } from '../secret';
import { readWord } from './word';

function piped(...chunks: string[]): SecretInput {
  return Readable.from(chunks) as unknown as SecretInput;
}

/** What a PIN or a confirmation code is judged by: taken, or refused with why. */
const upperOnly = (text: string) => {
  if (text !== text.toUpperCase()) throw new Error('That is not the code');
  return text;
};

describe('readWord from a pipe', () => {
  it('takes the first line, whatever follows', async () => {
    const output: string[] = [];
    const word = await readWord(
      'PIN: ',
      (text) => text,
      piped('W7KQ\nnext\n'),
      {
        write: (t) => output.push(t),
      },
    );
    expect(word).toBe('W7KQ');
    // Nothing is prompted at a pipe.
    expect(output).toEqual([]);
  });

  it('joins chunks and ignores the spacing around the answer', async () => {
    expect(await readWord('', (text) => text, piped('  W7K', 'Q \r\n'))).toBe(
      'W7KQ',
    );
  });

  it('takes an unterminated last line', async () => {
    expect(await readWord('', (text) => text, piped('W7KQ'))).toBe('W7KQ');
  });

  it('refuses empty input', async () => {
    await expect(readWord('', (t) => t, piped())).rejects.toThrow('Nothing');
    await expect(readWord('', (t) => t, piped('\n'))).rejects.toThrow(
      'Nothing',
    );
  });

  it('makes a refusal the error, since no one is there to type another', async () => {
    await expect(readWord('', upperOnly, piped('w7kq\n'))).rejects.toThrow(
      'That is not the code',
    );
  });
});

describe('readWord at a terminal', () => {
  function terminal() {
    const input = new Readable({ read() {} }) as unknown as SecretInput & {
      push: (chunk: string | null) => void;
    };
    const modes: boolean[] = [];
    input.isTTY = true;
    // A method, as on a real TTY stream, that fails when called unbound.
    input.setRawMode = function (this: unknown, mode: boolean) {
      if (this !== input)
        throw new Error('setRawMode called without its stream');
      modes.push(mode);
    };
    return { input, modes };
  }

  it('prompts, echoes what is typed, and honours backspace', async () => {
    const { input, modes } = terminal();
    const output: string[] = [];
    const pending = readWord('PIN: ', (text) => text, input, {
      write: (t) => output.push(t),
    });
    input.push('W7X');
    input.push('\u007f');
    input.push('KQ\r');
    expect(await pending).toBe('W7KQ');
    expect(modes).toEqual([true, false]);
    expect(output.join('')).toBe('PIN: W7X\b \bKQ\n');
  });

  it('says why an answer was refused and asks for another', async () => {
    const { input } = terminal();
    const output: string[] = [];
    const pending = readWord('Code: ', upperOnly, input, {
      write: (t) => output.push(t),
    });
    input.push('w7kq\r');
    // The refusal is written before the question is asked a second time.
    await new Promise((resolve) => setTimeout(resolve, 0));
    input.push('W7KQ\r');
    expect(await pending).toBe('W7KQ');
    expect(output.join('')).toContain('That is not the code\nCode: ');
  });

  it('asks again on an empty line rather than taking it', async () => {
    const { input } = terminal();
    const output: string[] = [];
    const pending = readWord('PIN: ', (text) => text, input, {
      write: (t) => output.push(t),
    });
    input.push('\r');
    await new Promise((resolve) => setTimeout(resolve, 0));
    input.push('W7KQ\r');
    expect(await pending).toBe('W7KQ');
    expect(output.join('')).toBe('PIN: \nPIN: W7KQ\n');
  });

  it('swallows an arrow key whole, bracket and letter with it', async () => {
    const { input } = terminal();
    const output: string[] = [];
    const pending = readWord('PIN: ', (text) => text, input, {
      write: (t) => output.push(t),
    });
    input.push('W7');
    // Arrow up, arrow left, and a modified arrow whose parameters run on —
    // none of them is a character of the PIN, and none is echoed.
    input.push('\u001b[A');
    input.push('\u001b[D');
    input.push('\u001b[1;5C');
    // The introducer and its sequence can arrive in separate reads.
    input.push('\u001b');
    input.push('[B');
    // Alt-b, which is ESC and one character rather than a sequence.
    input.push('\u001bb');
    input.push('KQ\r');
    expect(await pending).toBe('W7KQ');
    expect(output.join('')).toBe('PIN: W7KQ\n');
  });

  it('reports Ctrl-C as an interrupt, and Ctrl-D as giving up', async () => {
    const first = terminal();
    const interrupted = readWord('', (t) => t, first.input, {
      write: () => {},
    });
    first.input.push('W7\u0003');
    await expect(interrupted).rejects.toBeInstanceOf(InterruptedError);
    expect(first.modes).toEqual([true, false]);

    const second = terminal();
    const ended = readWord('', (t) => t, second.input, { write: () => {} });
    second.input.push('W7\u0004');
    await expect(ended).rejects.toThrow('Cancelled');
    expect(second.modes).toEqual([true, false]);
  });
});
