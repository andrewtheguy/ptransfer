/**
 * A promise the UI settles later — an offer being scanned, a choice being
 * made — with settle-once semantics and no polling. Whoever cancels the
 * flow rejects it directly, so the waiting closure unwinds on the spot
 * instead of on the next timer tick (a restart in between would otherwise
 * strand it forever).
 */
export interface PendingStep<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  /** True once resolve or reject has been called. */
  readonly settled: boolean;
}

export function createPendingStep<T>(): PendingStep<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: Error) => void;
  let settled = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolveFn(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectFn(error);
    },
    get settled() {
      return settled;
    },
  };
}
