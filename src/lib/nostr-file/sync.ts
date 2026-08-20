/** Small async coordination helpers for the live relay flows. */

export class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (value: T) => void;
  private rejectFn!: (reason: unknown) => void;
  private done = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  get settled(): boolean {
    return this.done;
  }

  resolve(value: T): void {
    if (this.done) return;
    this.done = true;
    this.resolveFn(value);
  }

  reject(reason: unknown): void {
    if (this.done) return;
    this.done = true;
    this.rejectFn(reason);
  }
}

/**
 * Wake-up signal: `wait` resolves on the next `notify` or after `timeoutMs`,
 * whichever comes first. A notify with no waiter is remembered for the next
 * wait so wake-ups are never lost.
 */
export class Signal {
  private waiters: (() => void)[] = [];
  private pending = false;

  notify(): void {
    if (this.waiters.length === 0) {
      this.pending = true;
      return;
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  wait(timeoutMs: number): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve();
      }, timeoutMs);
      this.waiters.push(wake);
    });
  }
}
