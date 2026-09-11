import { torTest } from './commands/tor-test';

/**
 * The pTransfer command line, on Bun.
 *
 * It runs the web app's own `src/lib` — the same protocol code, the same
 * Tor client — so a change there is a change here by construction. What it
 * adds is the platform seam a process has and a page does not: files, a
 * cache directory, plain HTTP to the Tor directory authorities.
 *
 *   bun run cli <command> [options]
 */

const USAGE = `usage: ptransfer <command> [options]

commands:
  tor-test   bootstrap Tor, publish an onion service, and connect back to it

Run a command with --help for its options.
`;

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  'tor-test': torTest,
};

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  const run = COMMANDS[command];
  if (!run) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  return run(rest);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
