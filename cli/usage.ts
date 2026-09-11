/**
 * A command was invoked wrongly: a flag missing or contradictory, an
 * argument that is not what it should be. `main` prints the message and
 * exits 2, the conventional usage-error status, so a script can tell it from
 * a transfer that failed.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
