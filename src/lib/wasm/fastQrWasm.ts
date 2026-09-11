import initFastQrWasm, { generate_qr_svg } from '@andrewtheguy/fast-qr-wasm';
import fastQrWasmUrl from '@andrewtheguy/fast-qr-wasm/fast_qr_wasm_bg.wasm?url';

export type FastQrErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

/**
 * QR encoding mode. `'auto'` picks the most compact mode for the payload;
 * the other values pin a specific encoding (use `'byte'` for arbitrary
 * binary data).
 */
export type FastQrMode = 'auto' | 'numeric' | 'alphanumeric' | 'byte';

export interface FastQrSvgGenerateOptions {
  margin?: number;
  errorCorrectionLevel?: FastQrErrorCorrectionLevel;
  mode?: FastQrMode;
  svgWidth?: number;
  svgHeight?: number;
}

let wasmInitialized = false;
let wasmInitPromise: Promise<void> | null = null;

function normalizeMargin(margin?: number): number {
  const normalizedMargin = Number(margin ?? 1);
  if (
    !Number.isFinite(normalizedMargin) ||
    !Number.isInteger(normalizedMargin) ||
    normalizedMargin < 0
  ) {
    throw new TypeError('Invalid margin: expected a finite integer >= 0');
  }
  return normalizedMargin;
}

function normalizeOptionalDimension(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new TypeError(`Invalid ${name}: expected a finite integer > 0`);
  }
  return n;
}

export async function ensureFastQrWasmInit(): Promise<void> {
  if (wasmInitialized) return;

  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      try {
        await initFastQrWasm({ module_or_path: fastQrWasmUrl });
        wasmInitialized = true;
      } catch (error) {
        wasmInitPromise = null;
        throw error;
      }
    })();
  }

  await wasmInitPromise;
}

export async function generateFastQrSvgString(
  payload: Uint8Array,
  options: FastQrSvgGenerateOptions = {},
): Promise<string> {
  await ensureFastQrWasmInit();

  const normalizedMargin = normalizeMargin(options.margin);
  const errorCorrectionLevel = options.errorCorrectionLevel ?? 'M';
  const mode = options.mode ?? 'auto';
  const svgWidth = normalizeOptionalDimension(options.svgWidth, 'svgWidth');
  const svgHeight = normalizeOptionalDimension(options.svgHeight, 'svgHeight');

  return generate_qr_svg(
    payload,
    normalizedMargin,
    errorCorrectionLevel,
    mode,
    svgWidth,
    svgHeight,
  );
}
