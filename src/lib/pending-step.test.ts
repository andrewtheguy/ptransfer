import { describe, expect, it, vi } from 'vitest';
import { createPendingStep } from './pending-step';

describe('createPendingStep', () => {
  it('resolves with the settled value', async () => {
    const step = createPendingStep<string>();
    step.resolve('relay');
    await expect(step.promise).resolves.toBe('relay');
    expect(step.settled).toBe(true);
  });

  it('rejects synchronously on cancel without any timers', async () => {
    vi.useFakeTimers();
    try {
      const step = createPendingStep<string>();
      step.reject(new Error('Cancelled'));
      // No poll interval is involved: the rejection is observable without
      // advancing time at all.
      expect(vi.getTimerCount()).toBe(0);
      await expect(step.promise).rejects.toThrow('Cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles once: a late resolve after cancel is ignored', async () => {
    const step = createPendingStep<string>();
    step.reject(new Error('Cancelled'));
    step.resolve('relay');
    await expect(step.promise).rejects.toThrow('Cancelled');
  });

  // Regression: cancel followed immediately by a restart. The step from the
  // old run must reject even though the restart flips the cancelled flag
  // back before any timer could observe it, and the new run's step must be
  // independent of the old one.
  it('cancel then immediate restart leaves the old step rejected and the new one live', async () => {
    let cancelled = false;
    let current = createPendingStep<string>();
    const cancel = () => {
      cancelled = true;
      current.reject(new Error('Cancelled'));
    };
    const restart = () => {
      cancelled = false;
      current = createPendingStep<string>();
    };

    const old = current;
    cancel();
    restart();

    expect(cancelled).toBe(false);
    expect(old.settled).toBe(true);
    await expect(old.promise).rejects.toThrow('Cancelled');

    // A stray settle aimed at the old run cannot leak into the new one.
    old.resolve('manual');
    expect(current.settled).toBe(false);
    current.resolve('relay');
    await expect(current.promise).resolves.toBe('relay');
  });
});
