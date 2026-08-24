import {
  AlertCircle,
  Camera,
  Download,
  FileDown,
  Loader2,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnswerReturn } from '@/components/ptransfer/answer-return';
import { TransferStatus } from '@/components/ptransfer/transfer-status';
import { Button } from '@/components/ui/button';
import { useChunkCollector } from '@/hooks/use-chunk-collector';
import { useManualReceive } from '@/hooks/use-manual-receive';
import { useQRScanner } from '@/hooks/useQRScanner';
import { extractChunkParam } from '@/lib/chunk-utils';
import {
  downloadFile,
  formatFileSize,
  getMimeTypeDescription,
} from '@/lib/file-utils';
import { isMobileDevice } from '@/lib/utils';

type PageStep = 'collecting' | 'transferring';

export function ReceiveChunkedPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<PageStep>('collecting');
  const [scanError, setScanError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>(
    isMobileDevice() ? 'environment' : 'user',
  );

  const { state: chunkState, addChunk } = useChunkCollector();
  const {
    state: receiveState,
    receivedContent,
    startReceive,
    submitOffer,
    cancel,
    reset,
  } = useManualReceive();

  const initialChunkFed = useRef(false);

  // Feed the initial chunk from URL fragment on mount
  useEffect(() => {
    if (initialChunkFed.current) return;
    initialChunkFed.current = true;
    const d = extractChunkParam(window.location.href);
    if (d) {
      addChunk(d);
    }
  }, [addChunk]);

  // When all chunks collected, start the receive flow
  useEffect(() => {
    if (
      chunkState.isComplete &&
      chunkState.assembledPayload &&
      step === 'collecting'
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: transition page step when chunk collection completes
      setStep('transferring');
      startReceive();
    }
  }, [chunkState.isComplete, chunkState.assembledPayload, step, startReceive]);

  // Submit the assembled offer once the hook is waiting for it
  useEffect(() => {
    if (
      step === 'transferring' &&
      receiveState.status === 'waiting_for_offer' &&
      chunkState.assembledPayload
    ) {
      submitOffer(chunkState.assembledPayload);
    }
  }, [step, receiveState.status, chunkState.assembledPayload, submitOffer]);

  // Handle scanned QR data — scanner returns raw bytes, URL QRs decode to ASCII
  const handleScan = useCallback(
    (binaryData: Uint8Array) => {
      const text = new TextDecoder().decode(binaryData);
      // Try to extract chunk param from URL
      const param = extractChunkParam(text);
      if (param) {
        setScanError(null);
        addChunk(param);
      }
      // If not a valid chunk URL, silently ignore (could be unrelated QR)
    },
    [addChunk],
  );

  const handleScanError = useCallback((err: string) => {
    if (err.includes('denied') || err.includes('unavailable')) {
      setScanError(err);
    }
  }, []);

  const handleCameraReady = useCallback(() => {
    setCameraReady(true);
    setScanError(null);
  }, []);

  // Only scan while collecting remaining chunks
  const needsMoreChunks = step === 'collecting' && !chunkState.isComplete;
  const { videoRef, canvasRef, availableCameras } = useQRScanner({
    onScan: handleScan,
    onError: handleScanError,
    onCameraReady: handleCameraReady,
    isScanning: needsMoreChunks,
    facingMode,
    debounceMs: 300,
  });

  const handleSwitchCamera = useCallback(() => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
  }, []);

  const handleDownload = useCallback(() => {
    if (receivedContent) {
      downloadFile(
        receivedContent.data,
        receivedContent.fileName,
        receivedContent.mimeType,
      );
    }
  }, [receivedContent]);

  const handleCancel = useCallback(() => {
    cancel();
    void navigate('/receive');
  }, [cancel, navigate]);

  const handleReset = useCallback(() => {
    reset();
    void navigate('/receive');
  }, [reset, navigate]);

  // --- Collecting chunks ---
  if (step === 'collecting') {
    const total = chunkState.totalChunks;
    const collected = chunkState.collectedCount;
    const collectedPercent =
      total !== null && total > 0 ? Math.round((collected / total) * 100) : 0;

    return (
      <div className="flex w-full justify-center">
        <div className="w-full max-w-md space-y-4 pt-4">
          <h2 className="text-lg font-semibold text-center">Receiving File</h2>

          {total !== null ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground text-center">
                Collected {collected} of {total} QR code{total !== 1 ? 's' : ''}{' '}
                ({collectedPercent}%)
              </p>
              {total > 1 && (
                <>
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {Array.from({ length: total }, (_, i) => {
                      const received = chunkState.collectedIndices.has(i);
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
                    QR codes can be scanned in any order, but all QR codes must
                    be scanned.
                  </p>
                </>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center">
              Reading first QR code...
            </p>
          )}

          {chunkState.error && (
            <div className="text-sm text-destructive text-center space-y-1">
              <p>{chunkState.error}</p>
              <p>Please rescan the sender QR codes.</p>
            </div>
          )}

          {/* Scanner for remaining chunks */}
          {needsMoreChunks && (
            <div className="space-y-3">
              <p className="text-sm text-center font-medium">
                Scan the remaining QR codes from the sender
              </p>

              <div className="relative bg-black rounded-lg overflow-hidden aspect-square max-w-[300px] mx-auto">
                {!cameraReady && !scanError && (
                  <div className="absolute inset-0 flex items-center justify-center bg-muted">
                    <div className="text-center">
                      <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
                      <p className="text-sm text-muted-foreground mt-2">
                        Starting camera...
                      </p>
                    </div>
                  </div>
                )}

                {scanError && (
                  <div className="absolute inset-0 flex items-center justify-center bg-muted p-4">
                    <div className="text-center">
                      <Camera className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                      <p className="text-sm text-destructive flex items-center justify-center">
                        <AlertCircle className="h-4 w-4 mr-1" />
                        {scanError}
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

                {cameraReady && !scanError && (
                  <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute inset-[15%] border-2 border-white/50 rounded-lg" />
                  </div>
                )}
              </div>

              {scanError?.includes('denied') && (
                <p className="text-xs text-muted-foreground text-center">
                  Please allow camera access in your browser settings and reload
                  the page.
                </p>
              )}

              {availableCameras.length > 1 && (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSwitchCamera}
                    disabled={!cameraReady}
                    className="text-xs"
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Switch Camera
                  </Button>
                </div>
              )}

              <p className="text-xs text-muted-foreground text-center">
                Point your camera at each sender QR code
              </p>
            </div>
          )}

          {chunkState.isComplete && (
            <div className="flex items-center justify-center gap-2 py-4">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">
                All chunks received, starting transfer...
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- Transferring ---
  const answerData = receiveState.answerData;
  const clipboardData = receiveState.clipboardData;
  const showQRDisplay =
    receiveState.status === 'showing_answer' &&
    answerData instanceof Uint8Array;

  return (
    <div className="flex w-full justify-center">
      <div className="w-full max-w-md space-y-4 pt-4">
        <h2 className="text-lg font-semibold text-center">Receiving File</h2>

        {/* Transfer status (connecting, receiving progress, etc.) */}
        {receiveState.status !== 'waiting_for_offer' && (
          <TransferStatus state={receiveState} />
        )}

        {/* The receiver's answer step: relayed, or carried back by hand */}
        {showQRDisplay && answerData && (
          <AnswerReturn
            answerData={answerData}
            clipboardData={clipboardData}
            answerRelayStatus={receiveState.answerRelayStatus}
          />
        )}

        {/* Download completed file */}
        {receiveState.status === 'complete' && receivedContent && (
          <div className="space-y-4">
            <div className="p-6 border rounded-lg bg-muted/50 text-center space-y-3">
              <FileDown className="h-12 w-12 mx-auto text-muted-foreground" />
              <div>
                <p className="font-medium truncate max-w-[300px] mx-auto">
                  {receivedContent.fileName}
                </p>
                <p className="text-sm text-muted-foreground">
                  {formatFileSize(receivedContent.fileSize)} &bull;{' '}
                  {getMimeTypeDescription(receivedContent.mimeType)}
                </p>
              </div>
              <Button
                onClick={handleDownload}
                className="w-full max-w-[200px] bg-cyan-600 hover:bg-cyan-700 dark:bg-cyan-600 dark:hover:bg-cyan-700"
              >
                <Download className="mr-2 h-4 w-4" />
                Download File
              </Button>
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2">
          {receiveState.status !== 'complete' &&
            receiveState.status !== 'error' && (
              <Button
                variant="outline"
                onClick={handleCancel}
                className="flex-1"
              >
                <X className="mr-2 h-4 w-4" />
                Cancel
              </Button>
            )}

          {(receiveState.status === 'complete' ||
            receiveState.status === 'error') && (
            <Button variant="outline" onClick={handleReset} className="flex-1">
              <RotateCcw className="mr-2 h-4 w-4" />
              Receive Another
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
