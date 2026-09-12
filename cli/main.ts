import { PROTOCOL_VERSION } from '@/lib/protocol-version';
import { receive } from './commands/receive';
import { send } from './commands/send';
import { torTest } from './commands/tor-test';
import { routeDiagnostics } from './diagnostics';
import { INTERRUPTED_STATUS, InterruptedError } from './interrupt';
import { UsageError } from './usage';
import { CLI_VERSION } from './version';

/**
 * The pTransfer command line, on Bun.
 *
 * It runs the web app's own `src/lib` — the same protocol code, the same
 * Tor client — so a change there is a change here by construction. What it
 * adds is the platform seam a process has and a page does not: files, a
 * cache directory, plain HTTP to the Tor directory authorities.
 *
 * It is a Unix program — Linux and macOS — and leans on that: signals,
 * atomic rename, the XDG cache directory, `/` as the only path separator.
 * Windows is refused up front rather than half-supported.
 *
 *   bun run cli <command> [options]
 */

const USAGE = `usage: ptransfer [command] [options]

With no command, at a terminal, ptransfer opens its terminal UI: pick what to
send and how to carry it, or paste what a sender gave you.

commands:
  send       send files and folders, by PIN Exchange, Code Exchange, or a
             Tor onion service
  receive    receive what a sender is sending
  tor-test   bootstrap Tor, publish an onion service, and connect back to it

A command is the line interface: results on standard output, everything else
on standard error, which is what a script and a pipe want. Run one with --help
for its options, or ptransfer --version for the release and the protocol
version; a peer needs the same protocol version.
`;

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  send,
  receive,
  'tor-test': torTest,
};

async function main(argv: string[]): Promise<number> {
  if (process.platform === 'win32') {
    process.stderr.write(
      'The pTransfer CLI runs on Linux and macOS; on Windows, use WSL or the web app.\n',
    );
    return 1;
  }
  // Quiet until a command has read its own --verbose.
  routeDiagnostics(false);
  const [command, ...rest] = argv;
  if (!command) {
    // Loaded only now: the terminal UI pulls in React and OpenTUI's native
    // core, which a piped `ptransfer send` has no use for.
    const { runTui } = await import('./tui/start');
    return await runTui();
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === '--version') {
    process.stdout.write(
      `ptransfer ${CLI_VERSION} (protocol ${PROTOCOL_VERSION})\n`,
    );
    return 0;
  }
  const run = COMMANDS[command];
  if (!run) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  return await run(rest);
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (error: unknown) {
  if (error instanceof InterruptedError) process.exit(INTERRUPTED_STATUS);
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
