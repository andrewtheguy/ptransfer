import { AlertCircle, Camera, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useQRScanner } from '@/hooks/useQRScanner';
import { useT } from '@/i18n/locale-context';
import {
  computeCrc32,
  isValidPayloadChecksum,
  parseChunk,
  reassembleChunks,
} from '@/lib/chunk-utils';
import { isValidBinaryPayload } from '@/lib/code-signaling';
import type { PinKind } from '@/lib/crypto';
import { classifyReceiveText } from '@/lib/receive-input';
import { isMobileDevice } from '@/lib/utils';

/**
 * 'receive' takes anything a sender can hand a receiver — a PIN link or the
 * chunked offer codes. 'answer' takes the receiver's response back on the
 * sender's screen, which is a single raw PT01 code rather than a URL.
 */
export type ScannerMode = 'receive' | 'answer';

export type ScanResult =
  | { kind: 'pin'; pin: string; pinKind: PinKind }
  | { kind: 'payload'; data: Uint8Array }
  | { kind: 'onion'; address: string };

interface QRScannerProps {
  onScan: (result: ScanResult) => void;
  mode: ScannerMode;
  /**
   * Called only when the camera cannot be started. A code that will not scan
   * is shown in the scanner itself, as a passing failure.
   */
  onError?: (error: string) => void;
  disabled?: boolean;
}

export function QRScanner({ onScan, mode, onError, disabled }: QRScannerProps) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [cameraFailed, setCameraFailed] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>(
    isMobileDevice() ? 'environment' : 'user',
  );
  const [collectedCount, setCollectedCount] = useState(0);
  const [collectedIndices, setCollectedIndices] = useState<Set<number>>(
    new Set(),
  );
  const [totalChunks, setTotalChunks] = useState<number | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const chunksRef = useRef<Map<number, Uint8Array>>(new Map());
  const totalChunksRef = useRef<number | null>(null);
  const checksumRef = useRef<number | null>(null);

  const showWarning = useCallback((msg: string) => {
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    setWarning(msg);
    warningTimerRef.current = setTimeout(() => setWarning(null), 3000);
  }, []);

  // Clear warning timer on unmount
  useEffect(() => {
    return () => {
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    };
  }, []);

  const clearChunkRefs = useCallback(() => {
    chunksRef.current.clear();
    totalChunksRef.current = null;
    checksumRef.current = null;
  }, []);

  const clearChunkProgressState = useCallback(() => {
    setCollectedCount(0);
    setCollectedIndices(new Set());
    setTotalChunks(null);
  }, []);

  const handleInvalidPayload = useCallback(
    (msg: string) => {
      setError(msg);
      clearChunkRefs();
      clearChunkProgressState();
    },
    [clearChunkRefs, clearChunkProgressState],
  );

  // Clear chunk state on unmount
  useEffect(() => {
    return clearChunkRefs;
  }, [clearChunkRefs]);

  // Clear chunk state when disabled
  useEffect(() => {
    if (disabled) {
      clearChunkRefs();
    }
  }, [disabled, clearChunkRefs]);

  const handleScan = useCallback(
    (binaryData: Uint8Array) => {
      const invalidPayload = t({
        en: 'Invalid QR payload. Please start scanning again.',
        es: 'Contenido QR no válido. Vuelve a empezar a escanear.',
      });
      if (mode === 'receive') {
        const text = new TextDecoder().decode(binaryData);
        const input = classifyReceiveText(text);
        if (!input) {
          console.debug('QRScanner: unrecognized QR text', text);
          showWarning(
            t({
              en: 'Unrecognized QR code, keep scanning...',
              es: 'Código QR no reconocido, sigue escaneando...',
            }),
          );
          return;
        }

        // A PIN link and a whole copied offer each arrive complete in one code.
        if (input.kind === 'pin') {
          setError(null);
          setWarning(null);
          onScan({ kind: 'pin', pin: input.pin, pinKind: input.pinKind });
          return;
        }
        if (input.kind === 'offer') {
          setError(null);
          setWarning(null);
          onScan({ kind: 'payload', data: input.payload });
          return;
        }
        // A Tor address is complete in one code too; its password is asked for
        // separately, so scanning one only fills in the address.
        if (input.kind === 'onion') {
          setError(null);
          setWarning(null);
          onScan({ kind: 'onion', address: input.address });
          return;
        }

        // Chunked offer codes from MultiQRDisplay, collected one at a time.
        const chunk = parseChunk(input.param);
        if (!chunk) {
          console.debug('QRScanner: failed to parse chunk param', input.param);
          setError(
            t({
              en: 'Could not parse QR code data',
              es: 'No se pudieron leer los datos del código QR',
            }),
          );
          return;
        }

        // Reset if total changed (different transfer)
        if (
          totalChunksRef.current !== null &&
          totalChunksRef.current !== chunk.total
        ) {
          clearChunkRefs();
          clearChunkProgressState();
        }

        if (chunk.index === 0) {
          if (typeof chunk.checksum !== 'number') {
            handleInvalidPayload(invalidPayload);
            return;
          }
          if (
            checksumRef.current !== null &&
            checksumRef.current !== chunk.checksum
          ) {
            handleInvalidPayload(invalidPayload);
            return;
          }
          checksumRef.current = chunk.checksum;
        } else if (chunk.checksum !== undefined) {
          handleInvalidPayload(invalidPayload);
          return;
        }

        totalChunksRef.current = chunk.total;
        chunksRef.current.set(chunk.index, chunk.data);
        setTotalChunks(chunk.total);
        setCollectedCount(chunksRef.current.size);
        setCollectedIndices(new Set(chunksRef.current.keys()));
        setError(null);
        setWarning(null);

        if (chunksRef.current.size === chunk.total) {
          const assembled = reassembleChunks(chunksRef.current, chunk.total);
          const expectedChecksum = checksumRef.current;
          clearChunkRefs();
          clearChunkProgressState();
          if (assembled === null) {
            console.error('QRScanner: reassembly failed');
            setError(invalidPayload);
            return;
          }
          if (expectedChecksum === null) {
            console.error('QRScanner: missing checksum');
            setError(invalidPayload);
            return;
          }
          if (!isValidPayloadChecksum(assembled, expectedChecksum)) {
            const actualChecksum = computeCrc32(assembled);
            console.error('QRScanner: checksum mismatch', {
              expectedChecksum,
              actualChecksum,
            });
            setError(invalidPayload);
            return;
          }
          onScan({ kind: 'payload', data: assembled });
        }
      } else {
        // Binary PT01 payload from QRDisplay
        if (!isValidBinaryPayload(binaryData)) {
          setError(
            t({
              en: 'Invalid or unsupported QR payload format',
              es: 'Formato de contenido QR no válido o no compatible',
            }),
          );
          return;
        }

        setError(null);
        onScan({ kind: 'payload', data: binaryData });
      }
    },
    [
      onScan,
      mode,
      clearChunkRefs,
      clearChunkProgressState,
      showWarning,
      handleInvalidPayload,
      t,
    ],
  );

  const handleError = useCallback(
    (err: string) => {
      setError(err);
      setCameraFailed(true);
      onError?.(err);
    },
    [onError],
  );

  const handleCameraReady = useCallback(() => {
    setCameraReady(true);
    setCameraFailed(false);
    setError(null);
  }, []);

  const { videoRef, canvasRef, availableCameras } = useQRScanner({
    onScan: handleScan,
    onError: handleError,
    onCameraReady: handleCameraReady,
    isScanning: !disabled,
    facingMode,
  });

  const handleSwitchCamera = useCallback(() => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
  }, []);

  const needsMoreChunks =
    !disabled &&
    totalChunks !== null &&
    totalChunks > 1 &&
    collectedCount < totalChunks;

  return (
    <div className="space-y-3">
      {/* Multi-chunk progress */}
      {needsMoreChunks && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground text-center">
            {t({
              en: `Collected ${collectedCount} of ${totalChunks} QR codes (${Math.round((collectedCount / totalChunks) * 100)}%)`,
              es: `Leídos ${collectedCount} de ${totalChunks} códigos QR (${Math.round((collectedCount / totalChunks) * 100)}%)`,
            })}
          </p>
          <div className="flex flex-wrap justify-center gap-1.5">
            {Array.from({ length: totalChunks ?? 0 }, (_, i) => i).map((i) => {
              const received = collectedIndices.has(i);
              return (
                <div
                  key={i}
                  className={`w-7 h-7 rounded text-xs font-medium flex items-center justify-center transition-colors ${
                    received
                      ? 'bg-cyan-600 text-white'
                      : 'border border-muted-foreground/30 text-muted-foreground'
                  }`}
                  title={t({
                    en: `QR #${i + 1}: ${received ? 'Received' : 'Missing'}`,
                    es: `QR n.º ${i + 1}: ${received ? 'recibido' : 'pendiente'}`,
                  })}
                >
                  {i + 1}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground text-center">
            {t({
              en: 'QR codes can be scanned in any order, but all QR codes must be scanned.',
              es: 'Los códigos QR se pueden escanear en cualquier orden, pero hay que escanearlos todos.',
            })}
          </p>
        </div>
      )}

      <div className="relative bg-black rounded-lg overflow-hidden aspect-square max-w-[300px] mx-auto">
        {!cameraReady && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted">
            <div className="text-center">
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground mt-2">
                {t({ en: 'Starting camera...', es: 'Iniciando la cámara...' })}
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted p-4">
            <div className="text-center">
              <Camera className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-destructive flex items-center justify-center">
                <AlertCircle className="h-4 w-4 mr-1" />
                {error}
              </p>
            </div>
          </div>
        )}

        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          playsInline
          muted
          autoPlay
        />

        <canvas ref={canvasRef} className="hidden" />

        {/* Auto-dismissing warning banner */}
        {warning && !error && (
          <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-2 py-1.5 pointer-events-none">
            <p className="text-xs text-yellow-300 text-center">{warning}</p>
          </div>
        )}

        {/* Scanning overlay */}
        {cameraReady && !error && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute inset-[15%] border-2 border-white/50 rounded-lg" />
          </div>
        )}
      </div>

      {cameraFailed && error && (
        <p className="text-xs text-muted-foreground text-center">
          {t({
            en: 'Please allow camera access in your browser settings and reload the page.',
            es: 'Permite el acceso a la cámara en la configuración del navegador y recarga la página.',
          })}
        </p>
      )}

      {availableCameras.length > 1 && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSwitchCamera}
            disabled={disabled || !cameraReady}
            className="text-xs"
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            {t({ en: 'Switch Camera', es: 'Cambiar de cámara' })}
          </Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground text-center">
        {mode === 'answer'
          ? needsMoreChunks
            ? t({
                en: "Point your camera at the receiver's response QR codes",
                es: 'Apunta la cámara a los códigos QR de la respuesta del receptor',
              })
            : t({
                en: "Point your camera at the receiver's response QR code",
                es: 'Apunta la cámara al código QR de la respuesta del receptor',
              })
          : needsMoreChunks
            ? t({
                en: "Point your camera at the sender's QR codes",
                es: 'Apunta la cámara a los códigos QR del emisor',
              })
            : t({
                en: "Point your camera at the sender's QR code",
                es: 'Apunta la cámara al código QR del emisor',
              })}
      </p>
    </div>
  );
}
