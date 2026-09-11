import { describe, expect, it } from 'vitest';
import { createProgressLine } from './progress';

describe('createProgressLine', () => {
  it('rewrites one line at a terminal and ends it once', () => {
    const out: string[] = [];
    const line = createProgressLine('Sending', {
      write: (t) => out.push(t),
      isTTY: true,
    });
    line.update(0, 200);
    line.update(100, 200);
    line.update(200, 200);
    line.done();
    line.done();
    expect(out).toEqual([
      '\rSending 0% (0 B of 200 B)\x1b[K',
      '\rSending 50% (100 B of 200 B)\x1b[K',
      '\rSending 100% (200 B of 200 B)\x1b[K',
      '\n',
    ]);
  });

  it('prints one line per tenth from a pipe', () => {
    const out: string[] = [];
    const line = createProgressLine('Receiving', {
      write: (t) => out.push(t),
    });
    for (let i = 0; i <= 1000; i += 7) line.update(i, 1000);
    line.update(1000, 1000);
    line.done();
    expect(out.length).toBe(11);
    expect(out[0]).toBe('Receiving 0% (0 B of 1000 B)\n');
    expect(out[10]).toBe('Receiving 100% (1000 B of 1000 B)\n');
  });
});
