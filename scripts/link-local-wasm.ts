// Points the installed `@andrewtheguy/anonymous-signaling-wasm` at a sibling
// webtor-rs build instead of the released tarball named in `package.json`.
//
// This replaces the installed directory with a symlink rather than running
// `npm install <path>`: an install re-resolves the whole tree, so an unrelated
// dependency would drift to a newer version behind a change that is only meant
// to swap one package. Neither manifest is touched, so the override cannot be
// committed by accident, and `npm run wasm:released` (a plain `npm ci`) puts
// the released package back.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.resolve(root, '../webtor-rs/anonymous-signaling-wasm/pkg');
const link = path.join(
  root,
  'node_modules/@andrewtheguy/anonymous-signaling-wasm',
);

if (!fs.existsSync(path.join(build, 'package.json'))) {
  console.error(
    `No webtor-rs build at ${build}\n` +
      'Check the repository out next to this one and run `npm run build` there.',
  );
  process.exit(1);
}

fs.rmSync(link, { recursive: true, force: true });
fs.mkdirSync(path.dirname(link), { recursive: true });
fs.symlinkSync(path.relative(path.dirname(link), build), link, 'dir');

const { version } = JSON.parse(
  fs.readFileSync(path.join(build, 'package.json'), 'utf8'),
) as { version: string };
console.log(
  `Linked @andrewtheguy/anonymous-signaling-wasm ${version} from ${build}\n` +
    'Run `npm run wasm:released` to restore the released package.',
);
