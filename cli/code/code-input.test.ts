import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  generateMutualClipboardData,
  generateMutualOfferBinary,
} from '@/lib/code-signaling';
import { InterruptedError } from '../interrupt';
import type { SecretInput } from '../secret';
import { decodeCode, readCode } from './code-input';

function offerCode(): string {
  const publicKey = new Uint8Array(65).fill(1);
  publicKey[0] = 4;
  return generateMutualClipboardData(
    generateMutualOfferBinary(
      { type: 'offer', sdp: 'v=0\r\na=offer\r\n' },
      ['candidate:1 1 udp 2130706431 192.0.2.1 5000 typ host'],
      {
        createdAt: Date.now(),
        fileName: 'notes.txt',
        fileSize: 5,
        contentEncoding: 'deflate-raw',
        mimeType: 'text/plain',
        publicKey,
        salt: new Uint8Array(16).fill(7),
      },
    ),
  );
}

const CODE = offerCode();
const accept = async (container: Uint8Array) => container.length;

function piped(...chunks: string[]): SecretInput {
  return Readable.from(chunks) as unknown as SecretInput;
}

function terminal() {
  const input = new Readable({ read() {} }) as unknown as SecretInput & {
    push: (chunk: string | null) => void;
  };
  const modes: boolean[] = [];
  input.isTTY = true;
  input.setRawMode = function (this: unknown, mode: boolean) {
    if (this !== input) throw new Error('setRawMode called without its stream');
    modes.push(mode);
  };
  const output: string[] = [];
  return { input, modes, output, write: (t: string) => output.push(t) };
}

describe('decodeCode', () => {
  it('takes a code however it was wrapped', () => {
    const wrapped = CODE.match(/.{1,60}/g)?.join('\n  ') ?? '';
    expect(decodeCode(`  ${wrapped}\n`)).not.toBeNull();
  });

  it('refuses a code that is cut short, or anything else', () => {
    expect(decodeCode(CODE.slice(0, -8))).toBeNull();
    expect(decodeCode('')).toBeNull();
    expect(decodeCode('not a code at all')).toBeNull();
  });
});

describe('readCode from a pipe', () => {
  it('finishes as soon as a whole code has arrived', async () => {
    const half = Math.floor(CODE.length / 2);
    // No newline and no end of stream after the code: the code is enough.
    const input = new Readable({ read() {} });
    input.push(CODE.slice(0, half));
    const pending = readCode('', accept, input as unknown as SecretInput);
    input.push(`${CODE.slice(half)}`);
    expect(await pending).toBeGreaterThan(0);
  });

  it('refuses input that ends without a code', async () => {
    await expect(readCode('', accept, piped())).rejects.toThrow('No code');
    await expect(
      readCode('', accept, piped(CODE.slice(0, 40))),
    ).rejects.toThrow('not a complete pTransfer code');
  });

  it('fails with the reason a code was not accepted', async () => {
    const refuse = () =>
      Promise.reject(new Error('Expected answer, got offer'));
    await expect(readCode('', refuse, piped(CODE))).rejects.toThrow(
      'Expected answer, got offer',
    );
  });
});

describe('readCode at a terminal', () => {
  it('takes a pasted code in raw mode and echoes it', async () => {
    const { input, modes, output, write } = terminal();
    const pending = readCode('Code: ', accept, input, { write });
    input.push(CODE.slice(0, 30));
    input.push(`${CODE.slice(30)}\r`);
    expect(await pending).toBeGreaterThan(0);
    expect(modes).toEqual([true, false]);
    expect(output[0]).toBe('Code: ');
    expect(output.join('')).toContain(CODE.slice(0, 30));
  });

  it('takes a code whose lines end in CRLF', async () => {
    const { input, output, write } = terminal();
    const pending = readCode('Code: ', accept, input, { write });
    // What a terminal that ends its lines the DOS way sends for a wrapped
    // paste: the \n of each \r\n must not read as an Enter on an empty line.
    input.push(`${CODE.match(/.{1,60}/g)?.join('\r\n')}\r`);
    expect(await pending).toBeGreaterThan(0);
    expect(output.join('')).not.toContain('not a complete pTransfer code');
  });

  it('asks again after a refusal, and after text that is not a code', async () => {
    const { input, output, write } = terminal();
    let calls = 0;
    const pending = readCode(
      'Code: ',
      (container) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('Offer expired'));
        return Promise.resolve(container.length);
      },
      input,
      { write },
    );
    input.push(`${CODE}\r`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    input.push('garbage\r\r');
    input.push(`${CODE}\r`);
    expect(await pending).toBeGreaterThan(0);
    const shown = output.join('');
    expect(shown).toContain('Offer expired');
    expect(shown).toContain('not a complete pTransfer code');
    expect(output.filter((t) => t === 'Code: ')).toHaveLength(3);
  });

  it('reports Ctrl-C as an interrupt, and Ctrl-D as giving up', async () => {
    const first = terminal();
    const interrupted = readCode('', accept, first.input, first);
    first.input.push('AB\u0003');
    await expect(interrupted).rejects.toBeInstanceOf(InterruptedError);
    expect(first.modes).toEqual([true, false]);

    const second = terminal();
    const ended = readCode('', accept, second.input, second);
    second.input.push('AB\u0004');
    await expect(ended).rejects.toThrow('Cancelled');
  });
});
