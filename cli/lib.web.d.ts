/**
 * Web-standard type names the shared code in `src/lib` uses and Bun runs, but
 * which `@types/bun` only names inside its own module rather than globally:
 * without `lib.dom` — which this build leaves out on purpose, since keeping
 * it out is what keeps browser-only code out of the CLI — TypeScript would
 * not find them. Nothing here is a browser API.
 */

type BufferSource = ArrayBufferView | ArrayBuffer;

type BlobPart = Bun.BlobPart;

type BinaryType = 'arraybuffer' | 'blob';

type HkdfParams = import('node:crypto').webcrypto.HkdfParams;
