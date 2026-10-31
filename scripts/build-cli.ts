/// <reference types="bun" />
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/**
 * Builds the CLI as one executable with `bun build --compile`.
 *
 *   bun scripts/build-cli.ts [--target <target>] [--outfile <path>]
 *
 * The target defaults to the machine the script runs on, and the executable
 * to `dist/cli/ptransfer`, `dist/cli/ptransfer.exe` for Windows. Three native pieces have to end up inside it, and
 * each needs the build machine to hold the target's copy:
 *
 * - The Tor client's wasm, which `cli/tor/webtor.ts` imports `with { type:
 *   'file' }`, so the bundler embeds it on its own.
 * - OpenTUI's native core, `@opentui/core-<os>-<arch>`, which OpenTUI's own
 *   loader imports by a literal name per platform; the bundler follows the
 *   ones it can find and leaves the rest out, so the target's package has to
 *   be installed or the binary fails on opening the terminal UI. The Linux
 *   targets are glibc, which `OPENTUI_LIBC` pins at build time.
 * - node-datachannel's addon, which its loader picks by a name computed at
 *   run time; the bundler cannot follow that, so a plugin swaps the loader
 *   for a static import of the target's `node_datachannel.node`.
 *
 * `bun install` installs only the host's optional packages, which is why a
 * release builds each target on its own machine.
 */

const TARGETS = {
  'bun-linux-x64': {
    addon: '@node-datachannel/linux-x64-gnu',
    tui: '@opentui/core-linux-x64',
  },
  'bun-linux-arm64': {
    addon: '@node-datachannel/linux-arm64-gnu',
    tui: '@opentui/core-linux-arm64',
  },
  'bun-darwin-arm64': {
    addon: '@node-datachannel/darwin-arm64',
    tui: '@opentui/core-darwin-arm64',
  },
  'bun-windows-x64': {
    addon: '@node-datachannel/win32-x64-msvc',
    tui: '@opentui/core-win32-x64',
  },
} as const;

type Target = keyof typeof TARGETS;

const ROOT = resolve(import.meta.dirname, '..');

// node-datachannel's ESM loader, the module the plugin stands in for. The
// path is the system's own, so `\` separates it on Windows: a pattern with
// `/` alone matches nothing there, and the executable ships without the addon.
const ADDON_LOADER =
  /node-datachannel[\\/]dist[\\/]esm[\\/]lib[\\/]node-datachannel\.mjs$/;

function hostTarget(): Target {
  // Bun names Windows targets `windows`, where Node's platform is `win32`.
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const target = `bun-${os}-${process.arch}`;
  if (!(target in TARGETS)) {
    throw new Error(`No release target for this machine: ${target}`);
  }
  return target as Target;
}

function resolvePackage(name: string, target: Target): string {
  try {
    return Bun.resolveSync(name, ROOT);
  } catch {
    throw new Error(
      `${name} is not installed, and the ${target} binary needs it. Build on a ${target} machine, or install that target's packages first.`,
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      outfile: { type: 'string', default: 'dist/cli/ptransfer' },
    },
  });
  const target = (values.target ?? hostTarget()) as Target;
  if (!(target in TARGETS)) {
    throw new Error(
      `Unknown target ${target}; one of ${Object.keys(TARGETS).join(', ')}`,
    );
  }
  // Bun adds `.exe` for a Windows target on its own; named here, the path
  // printed is the one written.
  const named = resolve(ROOT, values.outfile);
  const outfile =
    target.startsWith('bun-windows-') && !named.endsWith('.exe')
      ? `${named}.exe`
      : named;
  const addon = resolvePackage(TARGETS[target].addon, target);
  resolvePackage(TARGETS[target].tui, target);

  await mkdir(dirname(outfile), { recursive: true });
  // Whether the plugin met the loader it replaces. If it did not, the build
  // still succeeds, and the executable fails only when a WebRTC connection is
  // first made — which no smoke test of `--version` reaches.
  let swapped = false;
  const result = await Bun.build({
    entrypoints: [resolve(ROOT, 'cli/main.ts')],
    root: ROOT,
    compile: { target, outfile },
    sourcemap: 'none',
    define: target.startsWith('bun-linux-')
      ? { 'process.env.OPENTUI_LIBC': JSON.stringify('glibc') }
      : {},
    plugins: [
      {
        name: 'node-datachannel-static-addon',
        setup(build) {
          build.onLoad({ filter: ADDON_LOADER }, () => {
            swapped = true;
            return {
              loader: 'js',
              contents: `export { default } from ${JSON.stringify(addon)};\n`,
            };
          });
        },
      },
    ],
  });
  for (const log of result.logs) {
    process.stderr.write(`${log}\n`);
  }
  if (!result.success) {
    throw new Error('Build failed');
  }
  if (!swapped) {
    throw new Error(
      "node-datachannel's addon loader was never bundled, so the addon is not in the executable; check ADDON_LOADER against its path",
    );
  }
  process.stdout.write(`${outfile}\n`);
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
