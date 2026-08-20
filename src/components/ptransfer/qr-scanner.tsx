import { AlertCircle, Camera, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useQRScanner } from '@/hooks/useQRScanner';
import {
  computeCrc32,
  extractChunkParam,
  isValidPayloadChecksum,
  parseChunk,
  reassembleChunks,
} from '@/lib/chunk-utils';
import { isValidBinaryPayload } from '@/lib/manual-signaling';
import { isMobileDevice } from '@/lib/utils';

interface QRScannerProps {
  onScan: (binary: Uint8Array) => void;
  expectedType: 'offer' | 'answer';
  onError?: (error: string) => void;
  disabled?: boolean;
}

export function QRScanner({
  onScan,
  expectedType,
  onError,
  disabled,
}: QRScannerProps) {
  const [error, setError] = useState<string | null>(null);
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
      onError?.(msg);
      clearChunkRefs();
      clearChunkProgressState();
    },
    [clearChunkRefs, onError, clearChunkProgressState],
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
      if (expectedType === 'offer') {
        // URL-based QR codes from MultiQRDisplay
        const text = new TextDecoder().decode(binaryData);
        const param = extractChunkParam(text);
        if (!param) {
          console.debug('QRScanner: no chunk param found in QR text', text);
          showWarning('Unrecognized QR code, keep scanning...');
          return;
        }

        const chunk = parseChunk(param);
        if (!chunk) {
          console.debug('QRScanner: failed to parse chunk param', param);
          setError('Could not parse QR code data');
          onError?.('Could not parse QR code data');
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
            const msg = 'Invalid QR payload. Please start scanning again.';
            handleInvalidPayload(msg);
            return;
          }
          if (
            checksumRef.current !== null &&
            checksumRef.current !== chunk.checksum
          ) {
            const msg = 'Invalid QR payload. Please start scanning again.';
            handleInvalidPayload(msg);
            return;
          }
          checksumRef.current = chunk.checksum;
        } else if (chunk.checksum !== undefined) {
          const msg = 'Invalid QR payload. Please start scanning again.';
          handleInvalidPayload(msg);
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
            const msg = 'Invalid QR payload. Please start scanning again.';
            setError(msg);
            onError?.(msg);
            return;
          }
          if (expectedChecksum === null) {
            console.error('QRScanner: missing checksum');
            const msg = 'Invalid QR payload. Please start scanning again.';
            setError(msg);
            onError?.(msg);
            return;
          }
          if (!isValidPayloadChecksum(assembled, expectedChecksum)) {
            const actualChecksum = computeCrc32(assembled);
            console.error('QRScanner: checksum mismatch', {
              expectedChecksum,
              actualChecksum,
            });
            const msg = 'Invalid QR payload. Please start scanning again.';
            setError(msg);
            onError?.(msg);
            return;
          }
          onScan(assembled);
        }
      } else {
        // Binary PT01 payload from QRDisplay
        if (!isValidBinaryPayload(binaryData)) {
          setError('Invalid or unsupported QR payload format');
          onError?.('Invalid or unsupported QR payload format');
          return;
        }

        setError(null);
        onScan(binaryData);
      }
    },
    [
      onScan,
      onError,
      expectedType,
      clearChunkRefs,
      clearChunkProgressState,
      showWarning,
      handleInvalidPayload,
    ],
  );

  const handleError = useCallback(
    (err: string) => {
      setError(err);
      onError?.(err);
    },
    [onError],
  );

  const handleCameraReady = useCallback(() => {
    setCameraReady(true);
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
            Collected {collectedCount} of {totalChunks} QR codes (
            {Math.round((collectedCount / totalChunks) * 100)}%)
          </p>
          <div className="flex flex-wrap justify-center gap-1.5">
            {Array.from({ length: totalChunks ?? 0 }, (_, i) => {
              const received = collectedIndices.has(i);
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed-position chunk grid; index IS the identity
                  key={i}
                  className={`w-7 h-7 rounded text-xs font-medium flex items-center justify-center transition-colors ${
                    received
                      ? 'bg-cyan-600 text-white'
                      : 'border border-muted-foreground/30 text-muted-foreground'
                  }`}
                  title={`QR #${i + 1}: ${received ? 'Received' : 'Missing'}`}
                >
                  {i + 1}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground text-center">
            QR codes can be scanned in any order, but all QR codes must be
            scanned.
          </p>
        </div>
      )}

      <div className="relative bg-black rounded-lg overflow-hidden aspect-square max-w-[300px] mx-auto">
        {!cameraReady && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted">
            <div className="text-center">
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground mt-2">
                Starting camera...
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

      {error?.includes('denied') && (
        <p className="text-xs text-muted-foreground text-center">
          Please allow camera access in your browser settings and reload the
          page.
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
            Switch Camera
          </Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground text-center">
        Point your camera at the {expectedType} QR code
        {needsMoreChunks ? 's' : ''}
      </p>
    </div>
  );
}
