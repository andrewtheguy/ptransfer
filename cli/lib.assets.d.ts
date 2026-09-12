/**
 * A `.wasm` imported `with { type: 'file' }` is Bun's file loader: the import
 * is the path of the file — in `node_modules` when run from source, inside
 * the executable when compiled — not the module's contents.
 */
declare module '*.wasm' {
  const path: string;
  export default path;
}
