import { decodeCode } from '../code/code-input';
import { InterruptedError } from '../interrupt';
import type { Presenter } from '../ui/presenter';
import type { Action, Prompt, TransferStore } from './store';

/**
 * A transfer shown on the terminal UI rather than on standard error.
 *
 * The same `Presenter` the line interface implements, writing into a
 * `TransferStore` the run screen reads. What differs is that nothing shares a
 * line here: the status, the progress and what the person has been handed each
 * have their own place on the screen, and the lines accumulate under them.
 *
 * `done()` is therefore a no-op — there is no line being rewritten to end.
 */

const INCOMPLETE =
  'That is not a complete pTransfer code, or it is more than an hour old. Check it was copied whole.';

export interface TuiPresenterOptions {
  /**
   * A code the screen already took in, which answers the engine's first
   * request for one: the receive screen reads the sender's code to decide
   * which mode this is, and asking for it a second time would be asking the
   * same question twice.
   */
  firstCode?: string;
  /** The same for a PIN, which the receive screen reads the mode off just as it does a code. */
  firstWord?: string;
}

export function createTuiPresenter(
  store: TransferStore,
  options: TuiPresenterOptions = {},
): Presenter {
  let firstCode = options.firstCode ?? null;
  let firstWord = options.firstWord ?? null;

  const setPrompt = (prompt: Prompt | null) => {
    store.update((view) => ({ ...view, prompt }));
  };

  return {
    say(line) {
      // A blank line is the line interface's own spacing around a block it
      // is about to write; on a screen the blocks are already apart.
      if (!line) return;
      store.update((view) => ({ ...view, lines: [...view.lines, line] }));
    },
    status(message) {
      if (!message) return;
      store.update((view) => ({ ...view, status: message }));
    },
    progress(current, total) {
      store.update((view) => ({ ...view, progress: { current, total } }));
    },
    hand(value, label) {
      const handed = { label: label ?? null, value };
      store.update((view) => {
        // A value handed again under a label it has been handed under before
        // takes that place: a rotated PIN is the same thing with a new value,
        // and a screen can show it where the last one was.
        const at =
          label === undefined
            ? -1
            : view.handed.findIndex((item) => item.label === label);
        return {
          ...view,
          handed:
            at < 0
              ? [...view.handed, handed]
              : view.handed.map((item, index) =>
                  index === at ? handed : item,
                ),
        };
      });
    },
    readCode(message, accept) {
      return new Promise((resolve, reject) => {
        let attempt = 0;
        const ask = (error: string | null) => {
          attempt += 1;
          setPrompt({
            kind: 'code',
            message,
            error,
            attempt,
            submit: (text) => void take(text),
          });
        };
        const take = async (text: string) => {
          const container = decodeCode(text);
          if (!container) {
            ask(INCOMPLETE);
            return;
          }
          // Off the screen while the answer is judged: accepting a code can
          // take a moment, and a second Enter must not re-submit it.
          setPrompt(null);
          try {
            resolve(await accept(container));
          } catch (error) {
            if (error instanceof InterruptedError) {
              reject(error);
              return;
            }
            ask(error instanceof Error ? error.message : String(error));
          }
        };
        const pending = firstCode;
        firstCode = null;
        if (pending !== null) {
          void take(pending);
          return;
        }
        ask(null);
      });
    },
    readWord(message, accept) {
      return new Promise((resolve, reject) => {
        let attempt = 0;
        const ask = (error: string | null) => {
          attempt += 1;
          setPrompt({
            kind: 'word',
            message,
            error,
            attempt,
            submit: (text) => void take(text),
          });
        };
        const take = async (text: string) => {
          if (!text.trim()) return;
          // Off the screen while the answer is judged: a claim can take a
          // moment, and a second Enter must not submit the same answer twice.
          setPrompt(null);
          try {
            resolve(await accept(text.trim()));
          } catch (error) {
            if (error instanceof InterruptedError) {
              reject(error);
              return;
            }
            ask(error instanceof Error ? error.message : String(error));
          }
        };
        const pending = firstWord;
        firstWord = null;
        if (pending !== null) {
          void take(pending);
          return;
        }
        ask(null);
      });
    },
    action(key, label, run) {
      const action: Action = { key, label, run };
      store.update((view) => ({ ...view, actions: [...view.actions, action] }));
      return () => {
        store.update((view) => ({
          ...view,
          actions: view.actions.filter((candidate) => candidate !== action),
        }));
      };
    },
    readSecret(message) {
      return new Promise((resolve) => {
        setPrompt({
          kind: 'secret',
          message,
          error: null,
          attempt: 1,
          submit: (text) => {
            setPrompt(null);
            resolve(text);
          },
        });
      });
    },
    done() {},
  };
}
