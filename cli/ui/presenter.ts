/**
 * What a transfer shows, and what it asks for, without saying where.
 *
 * A transfer needs four things from its surroundings: lines to read, a step
 * that ticks, a byte count that moves, and the one string the other side has
 * to be handed. It also needs three answers back — a Code Exchange code, a
 * password, and a short word typed from something read out loud — and one way
 * to offer something the person may do while it runs. Behind this interface
 * those are standard error and standard input (`line.ts`), or the terminal UI
 * (`../tui/presenter.ts`); the transfer code itself knows neither.
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
   *
   * Handing a value under a label that has been handed under before replaces
   * it: a PIN that has rotated is the same thing with a new value, not a
   * second one. On the line each is written as it comes, since what was
   * printed cannot be unprinted.
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
  /**
   * Read one short answer — a PIN, a confirmation code — and hand it to
   * `accept`, which says what it is or throws with why it will not do. A
   * refusal is shown and the answer asked for again.
   */
  readWord<T>(
    prompt: string,
    accept: (text: string) => T | Promise<T>,
  ): Promise<T>;
  /**
   * Offer something the person may do while the transfer runs — minting a
   * fresh PIN is the only one there is — until the returned function
   * withdraws it. `key` is what the screen binds it to; the line interface
   * has nothing to bind, since standard input is where a piped answer comes
   * from, and ignores it.
   */
  action(key: string, label: string, run: () => void): () => void;
  /** End whatever line is being rewritten. */
  done(): void;
}
