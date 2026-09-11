/**
 * A transfer stopped from outside: Ctrl-C at the terminal (SIGINT), `kill`
 * or a service manager (SIGTERM), or the terminal going away (SIGHUP). Each
 * takes the circuits and the service down and removes a part file, then
 * leaves with the status a shell gives a process that signal ended — 128
 * plus its number. A teardown that hangs — a client still bootstrapping has
 * nothing to close — is not waited on for long.
 */

const TEARDOWN_GRACE_MS = 3000;

const STOP_SIGNALS = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
} as const satisfies Partial<Record<NodeJS.Signals, number>>;

export const INTERRUPTED_STATUS = STOP_SIGNALS.SIGINT;

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

/**
 * Run `teardown` on the first stop signal and exit with that signal's
 * status. `teardown` is handed the status, so a command whose own path ends
 * first can return the same one. Only the first signal is caught: a second,
 * of any kind, ends the process at once.
 */
export function onInterrupt(
  teardown: (status: number) => Promise<void>,
): () => void {
  const installed: [NodeJS.Signals, () => void][] = [];
  const uninstall = () => {
    for (const [signal, handler] of installed) {
      process.removeListener(signal, handler);
    }
  };
  for (const [signal, status] of Object.entries(STOP_SIGNALS) as [
    NodeJS.Signals,
    number,
  ][]) {
    const handler = () => {
      uninstall();
      if (signal === 'SIGHUP') {
        // The terminal is gone and every write to it fails; those failures
        // must not end the teardown before the part file is removed.
        process.stdout.on('error', () => {});
        process.stderr.on('error', () => {});
      } else {
        process.stderr.write('\nCancelling...\n');
      }
      const grace = new Promise<void>((resolve) =>
        setTimeout(resolve, TEARDOWN_GRACE_MS),
      );
      void (async () => {
        await Promise.race([teardown(status).catch(() => undefined), grace]);
        process.exit(status);
      })();
    };
    installed.push([signal, handler]);
    process.on(signal, handler);
  }
  return uninstall;
}
