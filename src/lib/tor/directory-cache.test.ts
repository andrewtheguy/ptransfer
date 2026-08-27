import { describe, expect, it } from 'vitest';
import { describeDirectory, judgeDirectorySeed } from './directory-cache';

/**
 * A directory carrying just the consensus header the description reads. What
 * places the HSDir ring is the validity window and the time period the
 * consensus falls in, so that is all this needs.
 */
function directory(
  validAfter: string,
  options: { hsdirInterval?: number } = {},
): string {
  const validAfterMs = Date.parse(validAfter);
  const at = (offsetHours: number) =>
    new Date(validAfterMs + offsetHours * 3_600_000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\..*$/, '');
  const params =
    options.hsdirInterval === undefined
      ? 'params bwweightscale=10000 cbtdisabled=0'
      : `params bwweightscale=10000 hsdir_interval=${options.hsdirInterval} cbtdisabled=0`;
  return JSON.stringify({
    version: 1,
    consensus: [
      'network-status-version 3 microdesc',
      'vote-status consensus',
      `valid-after ${at(0)}`,
      `fresh-until ${at(1)}`,
      `valid-until ${at(3)}`,
      params,
      '',
    ].join('\n'),
    certificates: '',
    microdescriptors: '',
  });
}

describe('describeDirectory', () => {
  it('reads the validity window as UTC', () => {
    const described = describeDirectory(directory('2026-08-27T13:00:00Z'));
    expect(described?.validAfter.toISOString()).toBe(
      '2026-08-27T13:00:00.000Z',
    );
    expect(described?.validUntil.toISOString()).toBe(
      '2026-08-27T16:00:00.000Z',
    );
  });

  // The default period runs 12:00 UTC to 12:00 UTC, which is the boundary two
  // peers can end up on opposite sides of.
  it('puts consensuses either side of 12:00 UTC in different periods', () => {
    const before = describeDirectory(directory('2026-08-27T11:00:00Z'));
    const after = describeDirectory(directory('2026-08-27T12:00:00Z'));
    const later = describeDirectory(directory('2026-08-27T13:00:00Z'));
    expect(after?.timePeriod).toBe((before?.timePeriod ?? 0) + 1);
    expect(later?.timePeriod).toBe(after?.timePeriod);
  });

  it('follows the consensus hsdir_interval when it names one', () => {
    const noon = describeDirectory(
      directory('2026-08-27T12:00:00Z', { hsdirInterval: 60 }),
    );
    const later = describeDirectory(
      directory('2026-08-27T13:00:00Z', { hsdirInterval: 60 }),
    );
    expect(later?.timePeriod).toBe((noon?.timePeriod ?? 0) + 1);
  });

  it('describes nothing it cannot read', () => {
    expect(describeDirectory('not json')).toBeUndefined();
    expect(describeDirectory(JSON.stringify({ version: 1 }))).toBeUndefined();
    expect(
      describeDirectory(
        JSON.stringify({ version: 1, consensus: 'network-status-version 3\n' }),
      ),
    ).toBeUndefined();
  });
});

describe('judgeDirectorySeed', () => {
  const noon = Date.parse('2026-08-27T12:00:00Z');
  const hour = 3_600_000;

  it('accepts a live consensus from the current time period', () => {
    expect(
      judgeDirectorySeed(directory('2026-08-27T12:00:00Z'), noon + hour),
    ).toEqual({ usable: true });
  });

  // The failure this rule exists for: still valid, still signed, and placing
  // the ring where the network stopped looking at 12:00 UTC.
  it('rejects a live consensus from the previous time period', () => {
    const verdict = judgeDirectorySeed(
      directory('2026-08-27T11:00:00Z'),
      noon + hour,
    );
    expect(verdict.usable).toBe(false);
    expect(verdict.reason).toContain('time period');
  });

  it('rejects a consensus with too little life left to bootstrap with', () => {
    const verdict = judgeDirectorySeed(
      directory('2026-08-27T12:00:00Z'),
      noon + 3 * hour - 60_000,
    );
    expect(verdict.usable).toBe(false);
    expect(verdict.reason).toContain('expires at');
  });

  it('rejects a consensus that is not valid yet', () => {
    expect(
      judgeDirectorySeed(directory('2026-08-27T12:00:00Z'), noon - hour),
    ).toEqual({ usable: false, reason: 'its consensus is not valid yet' });
  });

  it('rejects a seed it cannot read', () => {
    expect(judgeDirectorySeed('not json').usable).toBe(false);
    expect(judgeDirectorySeed(JSON.stringify({ version: 1 }))).toEqual({
      usable: false,
      reason: 'it carries no readable consensus',
    });
  });
});
