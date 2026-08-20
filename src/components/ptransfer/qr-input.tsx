import { AlertCircle, Camera, ClipboardPaste } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  isValidBinaryPayload,
  parseClipboardPayload,
} from '@/lib/manual-signaling';
import { isMobileDevice } from '@/lib/utils';
import { QRScanner } from './qr-scanner';

interface QRInputProps {
  onSubmit: (payload: Uint8Array) => void;
  expectedType: 'offer' | 'answer';
  label?: string;
  disabled?: boolean;
}

export function QRInput({
  onSubmit,
  expectedType,
  label,
  disabled,
}: QRInputProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<'scan' | 'paste'>('scan');
  // Receiver scans the offer — start the camera immediately. Sender scans the
  // answer behind a click gate so the camera isn't running prematurely.
  const autoStartScan = expectedType === 'offer';
  const [scanStarted, setScanStarted] = useState(autoStartScan);
  const scanActionVerb = isMobileDevice() ? 'Tap' : 'Click';

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setValue(text);
      setError(null);
    } catch (err) {
      console.error('Failed to paste:', err);
      setError('Failed to read clipboard');
    }
  }, []);

  // Paste tab handles base64-encoded binary payload
  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Please paste the data');
      return;
    }

    // Parse as base64 binary payload
    const binary = parseClipboardPayload(trimmed);
    if (!binary) {
      setError('Invalid format. Make sure you copied the complete text.');
      return;
    }

    if (!isValidBinaryPayload(binary)) {
      setError('Invalid or unsupported payload format');
      return;
    }

    setError(null);
    onSubmit(binary);
  }, [value, onSubmit]);

  const handleScanSuccess = useCallback(
    (binary: Uint8Array) => {
      setError(null);
      onSubmit(binary);
    },
    [onSubmit],
  );

  const handleScanError = useCallback((err: string) => {
    // Only show persistent errors, not transient scan failures
    if (err.includes('denied') || err.includes('unavailable')) {
      setError(err);
    }
  }, []);

  const handleStartScan = useCallback(() => {
    setError(null);
    setScanStarted(true);
  }, []);

  const handleInputModeChange = useCallback(
    (mode: 'scan' | 'paste') => {
      setError(null);
      setInputMode(mode);
      if (mode !== 'scan') {
        setScanStarted(autoStartScan);
      }
    },
    [autoStartScan],
  );

  return (
    <div className="space-y-3">
      {label && <p className="text-sm font-medium">{label}</p>}

      <Tabs
        value={inputMode}
        onValueChange={(v) => handleInputModeChange(v as 'scan' | 'paste')}
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="scan" disabled={disabled}>
            <Camera className="h-4 w-4 mr-2" />
            Scan
          </TabsTrigger>
          <TabsTrigger value="paste" disabled={disabled}>
            <ClipboardPaste className="h-4 w-4 mr-2" />
            Paste
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scan" className="mt-3">
          {scanStarted ? (
            <QRScanner
              expectedType={expectedType}
              onScan={handleScanSuccess}
              onError={handleScanError}
              disabled={disabled}
            />
          ) : (
            <button
              type="button"
              onClick={handleStartScan}
              disabled={disabled}
              className="w-full rounded-lg border border-dashed p-6 text-center cursor-pointer transition-colors hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Camera className="h-6 w-6 mx-auto mb-2" />
              <p className="text-base font-medium">Start scanning</p>
              <p className="text-sm text-muted-foreground mt-1">
                {`${scanActionVerb} anywhere in this area to start the camera scanner.`}
              </p>
            </button>
          )}
        </TabsContent>

        <TabsContent value="paste" className="mt-3">
          <div className="space-y-2">
            <Textarea
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              placeholder={`Paste the ${expectedType} data here...`}
              className="min-h-[100px] font-mono text-xs"
              disabled={disabled}
            />

            {error && (
              <p className="text-xs text-destructive flex items-center">
                <AlertCircle className="h-3 w-3 mr-1" />
                {error}
              </p>
            )}
          </div>

          <div className="flex gap-2 mt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePaste}
              disabled={disabled}
              className="flex-1"
            >
              <ClipboardPaste className="h-4 w-4 mr-2" />
              Paste from Clipboard
            </Button>

            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={disabled || !value.trim()}
              className="flex-1"
            >
              Submit
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      {inputMode === 'scan' && error && (
        <p className="text-xs text-destructive flex items-center">
          <AlertCircle className="h-3 w-3 mr-1" />
          {error}
        </p>
      )}
    </div>
  );
}
