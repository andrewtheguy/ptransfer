#!/usr/bin/env bun
/**
 * Point the Tor client dependency at a local webtor-rs build, or back at a
 * published release.
 *
 * `@andrewtheguy/webtor-wasm` is normally installed from a release tarball
 * (see package.json), which is the only form that may be committed: a
 * `file:` dependency builds on nobody's machine but this one. Testing an
 * unreleased change to webtor-rs means pointing at its `pkg/` directory for a
 * while, and this switches between the two without hand-editing package.json
 * and bun.lock.
 *
 * Bun links the local package file by file, so a rebuild in webtor-rs is
 * picked up with no reinstall here. Re-run `local` only if the build adds a
 * file the previous one did not have.
 *
 * Usage: bun scripts/webtor-source.ts status
 *    or: bun scripts/webtor-source.ts local
 *    or: bun scripts/webtor-source.ts released [version]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = '@andrewtheguy/webtor-wasm';
/** Where webtor-rs sits next to this repository, and what it builds into. */
const LOCAL_PACKAGE = '../webtor-rs/webtor-wasm/pkg';
const LOCAL_MANIFEST = '../webtor-rs/webtor-wasm/Cargo.toml';
/** What the build has to have produced for the package to be installable. */
const BUILD_OUTPUT = ['package.json', 'webtor_wasm.js', 'webtor_wasm_bg.wasm'];
const BUILD_COMMAND = 'cd ../webtor-rs && bun run build';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function currentSpec(): string {
  const manifest = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  const spec = manifest.dependencies?.[PACKAGE];
  if (!spec) throw new Error(`${PACKAGE} is not a dependency`);
  return spec;
}

function releaseUrl(version: string): string {
  return (
    'https://github.com/andrewtheguy/webtor-rs/releases/download/' +
    `v${version}/andrewtheguy-webtor-wasm-${version}.tgz`
  );
}

/** The version webtor-rs would publish next, for `released` to default to. */
function localVersion(): string | undefined {
  const manifest = join(root, LOCAL_MANIFEST);
  if (!existsSync(manifest)) return undefined;
  return /^version = "(.+)"$/m.exec(readFileSync(manifest, 'utf8'))?.[1];
}

function install(spec: string): void {
  console.log(`${PACKAGE} -> ${spec}\n`);
  const result = spawnSync('bun', ['add', `${PACKAGE}@${spec}`], {
    cwd: root,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

function status(): void {
  const spec = currentSpec();
  const local = spec.startsWith('file:');
  console.log(
    `${PACKAGE} is installed from ${local ? 'a local build' : 'a release'}:`,
  );
  console.log(`  ${spec}`);
  if (local) {
    console.log(
      '\nThis must not be committed. `bun run webtor:released` puts the ' +
        'release back.',
    );
  }
}

function local(): void {
  const built = join(root, LOCAL_PACKAGE);
  const missing = BUILD_OUTPUT.filter((file) => !existsSync(join(built, file)));
  if (missing.length > 0) {
    console.error(
      `${LOCAL_PACKAGE} is missing ${missing.join(', ')}.\n` +
        `Build it first: ${BUILD_COMMAND}`,
    );
    process.exit(1);
  }
  install(`file:${LOCAL_PACKAGE}`);
}

function released(version: string | undefined): void {
  const wanted = version ?? localVersion();
  if (!wanted) {
    console.error(
      'No version given, and webtor-rs is not next to this repository to ' +
        'read one from.\nUsage: bun scripts/webtor-source.ts released <version>',
    );
    process.exit(1);
  }
  install(releaseUrl(wanted));
}

const [, , command, version] = process.argv;
switch (command) {
  case 'status':
  case undefined:
    status();
    break;
  case 'local':
    local();
    break;
  case 'released':
    released(version);
    break;
  default:
    console.error(`Unknown command "${command}".`);
    console.error(
      'Usage: bun scripts/webtor-source.ts status|local|released [version]',
    );
    process.exit(1);
}
