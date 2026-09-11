import { useCallback, useEffect, useRef, useState } from 'react';
import { isMobileDevice } from '@/lib/utils';
import RxingScannerWorker from '@/workers/rxing-qr-scanner.worker?worker';

// Eager-load worker on module import for offline support
const scannerWorker = new RxingScannerWorker();

function fnv1aHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// Module-level state for per-QR debouncing (shared across hook instances)
const recentScanTimestamps = new Map<string, number>();

// Current callback reference (updated by active hook instance)
let currentOnScan: ((data: Uint8Array) => void) | null = null;
let currentDebounceMs = 500;

// Set up message handler once at module scope
scannerWorker.onmessage = (e: MessageEvent) => {
  if (e.data.type === 'result') {
    if (e.data.data && Array.isArray(e.data.data) && e.data.data.length > 0) {
      const now = Date.now();

      if (recentScanTimestamps.size > 50) {
        const pruneThreshold = now - currentDebounceMs * 2;
        for (const [hash, ts] of recentScanTimestamps) {
          if (ts < pruneThreshold) {
            recentScanTimestamps.delete(hash);
          }
        }
      }

      for (const scannedData of e.data.data) {
        const dataHash = fnv1aHash(scannedData as Uint8Array);

        if (currentDebounceMs > 0) {
          const lastTime = recentScanTimestamps.get(dataHash);
          if (lastTime !== undefined && now - lastTime < currentDebounceMs) {
            continue;
          }
        }

        recentScanTimestamps.set(dataHash, now);

        if (currentOnScan) {
          currentOnScan(scannedData as Uint8Array);
        }
      }
    }
    if (e.data.error) {
      console.error('Worker decode error:', e.data.error);
    }
  }
};

scannerWorker.onerror = (err) => {
  console.error('Worker error:', err);
};

interface UseQRScannerOptions {
  onScan: (data: Uint8Array) => void;
  onError?: (error: string) => void;
  onCameraReady?: () => void;
  isScanning: boolean;
  facingMode?: 'environment' | 'user';
  scanInterval?: number;
  debounceMs?: number;
  preferLowRes?: boolean;
}

function isBenignPlayInterruptionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes(
    'play() request was interrupted by a new load request',
  );
}

export function useQRScanner(options: UseQRScannerOptions) {
  const {
    onScan,
    onError,
    onCameraReady,
    isScanning,
    facingMode = 'environment',
    scanInterval = 125, // ms between scan attempts (~8fps); static QR codes don't need high frame rates and the maximized-detection reader options are expensive

    debounceMs = 500,
    preferLowRes = true, // Default true for QR scanning
  } = options;

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scanLoopRef = useRef<number | null>(null);
  const isScanningRef = useRef<boolean>(false);
  const isScanningRequestedRef = useRef<boolean>(isScanning);
  const startAttemptRef = useRef(0);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker>(scannerWorker);
  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>(
    [],
  );

  const enumerateCameras = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(
        (device) => device.kind === 'videoinput',
      );
      setAvailableCameras(videoDevices);
    } catch (err) {
      console.error('Failed to enumerate cameras:', err);
    }
  }, []);

  // Update module-level callback refs when hook options change
  useEffect(() => {
    currentOnScan = onScan;
    currentDebounceMs = debounceMs;
  }, [onScan, debounceMs]);

  const scanVideoFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current || !workerRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (video.readyState !== video.HAVE_ENOUGH_DATA) {
      return;
    }

    try {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      if (canvas.width === 0 || canvas.height === 0) {
        return;
      }

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      workerRef.current.postMessage(
        {
          type: 'scan',
          imageData,
        },
        [imageData.data.buffer],
      );
    } catch (err) {
      console.error('Error scanning frame:', err);
    }
  }, []);

  const startScanLoop = useCallback(() => {
    let lastScanTime = 0;

    const scanFrame = () => {
      if (!isScanningRef.current) {
        return;
      }

      const now = Date.now();
      if (now - lastScanTime >= scanInterval) {
        scanVideoFrame();
        lastScanTime = now;
      }

      if (isScanningRef.current) {
        scanLoopRef.current = requestAnimationFrame(scanFrame);
      }
    };

    isScanningRef.current = true;
    scanFrame();
  }, [scanInterval, scanVideoFrame]);

  const stopCameraScanning = useCallback(() => {
    startAttemptRef.current += 1; // Cancel any pending async start attempt.
    isScanningRequestedRef.current = false;
    isScanningRef.current = false;

    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => {
        track.stop();
      });
      cameraStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }

    if (scanLoopRef.current !== null) {
      cancelAnimationFrame(scanLoopRef.current);
      scanLoopRef.current = null;
    }
  }, []);

  const startCameraScanning = useCallback(async () => {
    const attemptId = ++startAttemptRef.current;
    const shouldAbortStart = () =>
      attemptId !== startAttemptRef.current || !isScanningRequestedRef.current;

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (shouldAbortStart()) return;

      if (!videoRef.current) {
        throw new Error('Video element not available');
      }

      const isMobile = isMobileDevice();
      const constraints: MediaStreamConstraints = {
        video: isMobile
          ? {
              facingMode: facingMode,
              width: { ideal: preferLowRes ? 640 : 1280 },
              height: { ideal: preferLowRes ? 480 : 720 },
            }
          : {
              facingMode: facingMode,
            },
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (shouldAbortStart()) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }

      cameraStreamRef.current = stream;
      videoRef.current.srcObject = stream;

      await videoRef.current.play();
      if (shouldAbortStart()) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        cameraStreamRef.current = null;
        if (videoRef.current) {
          videoRef.current.pause();
          videoRef.current.srcObject = null;
        }
        return;
      }

      await enumerateCameras();

      if (onCameraReady) {
        onCameraReady();
      }

      startScanLoop();
    } catch (err) {
      if (isBenignPlayInterruptionError(err) || shouldAbortStart()) {
        return;
      }
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to access camera';
      if (onError) {
        onError(`Camera access denied or unavailable. ${errorMessage}`);
      }
      isScanningRef.current = false;
    }
  }, [
    facingMode,
    preferLowRes,
    enumerateCameras,
    onCameraReady,
    onError,
    startScanLoop,
  ]);

  const switchCamera = useCallback(async () => {
    startAttemptRef.current += 1; // Cancel current async start attempt before switching.
    isScanningRef.current = false;

    if (scanLoopRef.current !== null) {
      cancelAnimationFrame(scanLoopRef.current);
      scanLoopRef.current = null;
    }

    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => {
        track.stop();
      });
      cameraStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    await startCameraScanning();
  }, [startCameraScanning]);

  // Start/stop scanning based on isScanning prop
  useEffect(() => {
    isScanningRequestedRef.current = isScanning;

    if (isScanning && !isScanningRef.current) {
      void startCameraScanning();
    } else if (!isScanning) {
      stopCameraScanning();
    }
  }, [isScanning, startCameraScanning, stopCameraScanning]);

  // Restart camera when facingMode or preferLowRes changes
  const facingModeRef = useRef(facingMode);
  const preferLowResRef = useRef(preferLowRes);
  // The refs make it a no-op when only switchCamera's identity changed.
  useEffect(() => {
    const facingModeChanged = facingModeRef.current !== facingMode;
    const preferLowResChanged = preferLowResRef.current !== preferLowRes;

    if (
      (facingModeChanged || preferLowResChanged) &&
      isScanningRequestedRef.current
    ) {
      void switchCamera();
    }

    facingModeRef.current = facingMode;
    preferLowResRef.current = preferLowRes;
  }, [facingMode, preferLowRes, switchCamera]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopCameraScanning();
    };
  }, [stopCameraScanning]);

  return {
    videoRef,
    canvasRef,
    switchCamera,
    availableCameras,
  };
}
