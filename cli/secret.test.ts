import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { InterruptedError } from './interrupt';
import { readSecret, type SecretInput } from './secret';

function piped(...chunks: string[]): SecretInput {
  return Readable.from(chunks) as unknown as SecretInput;
}

describe('readSecret from a pipe', () => {
  it('takes the first line, whatever follows', async () => {
    const output: string[] = [];
    const secret = await readSecret(
      'Password: ',
      piped('ABCDEFGHJKMN\nnot this\n'),
      { write: (t) => output.push(t) },
    );
    expect(secret).toBe('ABCDEFGHJKMN');
    // Nothing is prompted at a pipe.
    expect(output).toEqual([]);
  });

  it('joins chunks and drops a Windows line ending', async () => {
    expect(await readSecret('', piped('ABCDEF', 'GHJKMN\r\n'))).toBe(
      'ABCDEFGHJKMN',
    );
  });

  it('takes an unterminated last line', async () => {
    expect(await readSecret('', piped('ABCDEFGHJKMN'))).toBe('ABCDEFGHJKMN');
  });

  it('refuses empty input', async () => {
    await expect(readSecret('', piped())).rejects.toThrow('No password');
    await expect(readSecret('', piped('\n'))).rejects.toThrow('No password');
  });
});

describe('readSecret at a terminal', () => {
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

  it('prompts, takes keystrokes without echo, and honours backspace', async () => {
    const { input, modes } = terminal();
    const output: string[] = [];
    const pending = readSecret('Password: ', input, {
      write: (t) => output.push(t),
    });
    input.push('ABCX');
    input.push('\u007f');
    input.push('DEF\r');
    expect(await pending).toBe('ABCDEF');
    expect(modes).toEqual([true, false]);
    // The prompt and the newline that ends the hidden line, nothing typed.
    expect(output).toEqual(['Password: ', '\n']);
  });

  it('reports Ctrl-C as an interrupt, and Ctrl-D as giving up', async () => {
    const first = terminal();
    const interrupted = readSecret('', first.input, { write: () => {} });
    first.input.push('AB\u0003');
    await expect(interrupted).rejects.toBeInstanceOf(InterruptedError);
    expect(first.modes).toEqual([true, false]);

    const second = terminal();
    const ended = readSecret('', second.input, { write: () => {} });
    second.input.push('AB\u0004');
    await expect(ended).rejects.toThrow('Cancelled');
    expect(second.modes).toEqual([true, false]);
  });
});
