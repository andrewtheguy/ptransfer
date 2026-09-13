import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { routeDiagnostics } from '../diagnostics';
import { UsageError } from '../usage';
import { App } from './app';

/**
 * Starting the terminal UI: `ptransfer` with nothing after it.
 *
 * It needs a terminal on both ends — it draws on one and reads keys from the
 * other — so a pipe gets the usage error rather than a half-drawn screen. A
 * script wanting a transfer has the line interface, which is what every test
 * drives and what `ptransfer send` and `ptransfer receive` still are.
 *
 * Diagnostics are silenced whatever `--verbose` would have done: shared code
 * logs its asides with `console.log`, and a line written behind the renderer's
 * back lands in the middle of the screen.
 *
 * The mouse is left to the terminal: with mouse reporting on, a drag goes to
 * the app instead of selecting, and selecting a value to paste elsewhere is
 * how a code leaves a terminal the clipboard copy does not reach.
 */
export async function runTui(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UsageError(
      'The terminal UI needs a terminal. Use ptransfer send or ptransfer receive from a script or a pipe.',
    );
  }
  routeDiagnostics(false);
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    useMouse: false,
  });
  // A transfer's own signal handler leaves with `process.exit`, which unwinds
  // nothing here, so the terminal is put back from the exit itself rather than
  // from the end of this function.
  const restore = () => renderer.destroy();
  process.on('exit', restore);
  try {
    return await new Promise<number>((resolve) => {
      createRoot(renderer).render(<App onExit={resolve} />);
    });
  } finally {
    process.off('exit', restore);
    renderer.destroy();
  }
}
