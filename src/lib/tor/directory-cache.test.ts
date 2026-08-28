import { describe, expect, it } from 'vitest';
import { judgeDescription } from './directory-cache';
import type { DirectoryDescription } from './webtor';

/**
 * A description shaped the way webtor produces one: periods a day long that
 * begin at 12:00 UTC, which is the boundary two peers can end up either side
 * of. Reading a consensus to get here is webtor's job and is tested there;
 * what this file covers is the rule this app puts on top of the reading.
 */
const PERIOD_MS = 24 * 3_600_000;
const PERIOD_OFFSET_MS = 12 * 3_600_000;

function timePeriodAt(at: number): number {
  return Math.floor((at - PERIOD_OFFSET_MS) / PERIOD_MS);
}

function described(validAfter: string): DirectoryDescription {
  const validAfterMs = Date.parse(validAfter);
  return {
    validAfter: new Date(validAfterMs),
    // Three hours, the life of a real consensus.
    validUntil: new Date(validAfterMs + 3 * 3_600_000),
    timePeriod: timePeriodAt(validAfterMs),
    timePeriodAt,
  };
}

describe('judgeDescription', () => {
  const noon = Date.parse('2026-08-27T12:00:00Z');
  const hour = 3_600_000;

  it('accepts a live consensus from the current time period', () => {
    expect(described('2026-08-27T12:00:00Z')).toBeDefined();
    expect(
      judgeDescription(described('2026-08-27T12:00:00Z'), noon + hour),
    ).toEqual({ usable: true });
  });

  // The failure this rule exists for: still valid, still signed, and placing
  // the ring where the network stopped looking at 12:00 UTC.
  it('rejects a live consensus from the previous time period', () => {
    const verdict = judgeDescription(
      described('2026-08-27T11:00:00Z'),
      noon + hour,
    );
    expect(verdict.usable).toBe(false);
    expect(verdict.reason).toContain('time period');
  });

  it('rejects a consensus with too little life left to bootstrap with', () => {
    const verdict = judgeDescription(
      described('2026-08-27T12:00:00Z'),
      noon + 3 * hour - 60_000,
    );
    expect(verdict.usable).toBe(false);
    expect(verdict.reason).toContain('expires at');
  });

  it('rejects a consensus that is not valid yet', () => {
    expect(
      judgeDescription(described('2026-08-27T12:00:00Z'), noon - hour),
    ).toEqual({ usable: false, reason: 'its consensus is not valid yet' });
  });

  it('rejects a directory that could not be read at all', () => {
    expect(judgeDescription(undefined, noon)).toEqual({
      usable: false,
      reason: 'it carries no readable consensus',
    });
  });
});
