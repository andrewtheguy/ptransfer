/**
 * What a transfer shows, and what it asks for, without saying where.
 *
 * A transfer needs four things from its surroundings: lines to read, a step
 * that ticks, a byte count that moves, and the one string the other side has
 * to be handed. It also needs two answers back — a Code Exchange code, and a
 * password. Behind this interface those are standard error and standard
 * input (`line.ts`), or the terminal UI (`../tui/presenter.ts`); the transfer
 * code itself knows neither.
 */
export interface Presenter {
  /** A line that is always shown whole: an instruction, a result. */
  say(line: string): void;
  /**
   * What the engine says it is doing. A message that only differs from the
   * last in its numbers is the same step moving on, and supersedes it.
   */
  status(message: string): void;
  progress(current: number, total: number): void;
  /**
   * Something the person must carry to the other side, or the path a script
   * takes away: a code, an onion address, a password, a saved file. On the
   * line it is standard output — `label: value` when there is a label, so a
   * script can split it, and the value alone when there is not.
   */
  hand(value: string, label?: string): void;
  /**
   * Read one Code Exchange code and hand its container to `accept`, which
   * says what it is or throws with why this side will not take it. A refusal
   * is shown and the code asked for again.
   */
  readCode<T>(
    prompt: string,
    accept: (container: Uint8Array) => Promise<T>,
  ): Promise<T>;
  /** Read a password, never echoed. */
  readSecret(prompt: string): Promise<string>;
  /** End whatever line is being rewritten. */
  done(): void;
}
