/**
 * Ctrl-C during a transfer: say so, take the circuits and the service down,
 * and leave with the conventional status. A teardown that hangs — a client
 * still bootstrapping has nothing to close — is not waited on for long.
 */

const TEARDOWN_GRACE_MS = 3000;

export const INTERRUPTED_STATUS = 130;

/**
 * Ctrl-C that arrived as a keystroke rather than a signal — a prompt in raw
 * mode reads it as input. The entry point exits with `INTERRUPTED_STATUS`.
 */
export class InterruptedError extends Error {
  constructor() {
    super('Interrupted');
    this.name = 'InterruptedError';
  }
}

export function onInterrupt(teardown: () => Promise<void>): () => void {
  const handler = () => {
    process.stderr.write('\nCancelling...\n');
    const grace = new Promise<void>((resolve) =>
      setTimeout(resolve, TEARDOWN_GRACE_MS),
    );
    void Promise.race([teardown().catch(() => undefined), grace]).then(() =>
      process.exit(INTERRUPTED_STATUS),
    );
  };
  process.once('SIGINT', handler);
  return () => process.removeListener('SIGINT', handler);
}
