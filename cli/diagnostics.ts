import { format } from 'node:util';

/**
 * Where the diagnostics shared code reports go.
 *
 * `src/lib` logs its asides — a stream that ended, a cache it ignored — with
 * `console.log`, `console.info` and `console.debug`, which a browser keeps in
 * devtools. Bun writes those to stdout, which here carries only a command's
 * result, so they go to stderr under `--verbose` and nowhere otherwise.
 * `console.warn` and `console.error` already write to stderr and are left
 * alone.
 */
export function routeDiagnostics(verbose: boolean): void {
  const report = verbose
    ? (...args: unknown[]) => {
        process.stderr.write(`${format(...args)}\n`);
      }
    : () => {};
  console.log = report;
  console.info = report;
  console.debug = report;
}
