/**
 * What a running transfer looks like, outside React.
 *
 * The transfer engine is not a component: it calls into a `Presenter` from
 * whatever task it is running in, at whatever moment. This is the one place
 * that lives in, and the run screen reads it through `useSyncExternalStore`,
 * so a status message or a byte count arriving mid-await redraws the screen
 * without the engine knowing there is one.
 *
 * Every change replaces the snapshot rather than mutating it, which is what
 * `useSyncExternalStore` needs to see a change at all.
 */

/** A question the transfer is waiting on an answer to. */
export interface Prompt {
  /** A code is pasted and echoed; a secret is typed and never shown. */
  kind: 'code' | 'secret';
  message: string;
  /** Why the last answer was refused, to show above the field. */
  error: string | null;
  /** Which time of asking this is, counting from one. A field empties when it changes. */
  attempt: number;
  /** Take an answer. A refused one leaves the prompt up with a new `error`. */
  submit(text: string): void;
}

/** Something the person must carry to the other side, or take away. */
export interface Handed {
  label: string | null;
  value: string;
}

export interface TransferView {
  /** The lines a person reads, oldest first. */
  lines: string[];
  /** The step the engine is on, which supersedes the one before it. */
  status: string | null;
  progress: { current: number; total: number } | null;
  handed: Handed[];
  prompt: Prompt | null;
  /** Set once the transfer has ended: its exit status and, on a failure, why. */
  outcome: { status: number; error: string | null } | null;
}

const EMPTY: TransferView = {
  lines: [],
  status: null,
  progress: null,
  handed: [],
  prompt: null,
  outcome: null,
};

export interface TransferStore {
  subscribe(listener: () => void): () => void;
  snapshot(): TransferView;
  update(change: (view: TransferView) => TransferView): void;
}

export function createTransferStore(): TransferStore {
  let view = EMPTY;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => view,
    update(change) {
      view = change(view);
      for (const listener of listeners) listener();
    },
  };
}
