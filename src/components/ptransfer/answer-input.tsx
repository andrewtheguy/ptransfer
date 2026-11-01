import { AlertCircle, Camera, ClipboardPaste } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n/locale-context';
import {
  isValidBinaryPayload,
  parseClipboardPayload,
} from '@/lib/code-signaling';
import { isMobileDevice } from '@/lib/utils';
import { QRScanner, type ScanResult } from './qr-scanner';

interface AnswerInputProps {
  onSubmit: (payload: Uint8Array) => void;
  disabled?: boolean;
}

/**
 * The sender's side of a Code Exchange: take back the receiver's response,
 * scanned or pasted.
 */
export function AnswerInput({ onSubmit, disabled }: AnswerInputProps) {
  const t = useT();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<'scan' | 'paste'>('scan');
  // Behind a click gate so the camera isn't running before the receiver has
  // anything to show.
  const [scanStarted, setScanStarted] = useState(false);
  const scanHint = isMobileDevice()
    ? t({
        en: 'Tap anywhere in this area to start the camera scanner.',
        es: 'Toca cualquier parte de esta área para iniciar el escáner de la cámara.',
      })
    : t({
        en: 'Click anywhere in this area to start the camera scanner.',
        es: 'Haz clic en cualquier parte de esta área para iniciar el escáner de la cámara.',
      });

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setValue(text);
      setError(null);
    } catch (err) {
      console.error('Failed to paste:', err);
      setError(
        t({
          en: 'Failed to read clipboard',
          es: 'No se pudo leer el portapapeles',
        }),
      );
    }
  }, [t]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError(t({ en: 'Please paste the data', es: 'Pega los datos' }));
      return;
    }

    const binary = parseClipboardPayload(trimmed);
    if (!binary) {
      setError(
        t({
          en: 'Invalid format. Make sure you copied the complete text.',
          es: 'Formato no válido. Asegúrate de haber copiado el texto completo.',
        }),
      );
      return;
    }

    if (!isValidBinaryPayload(binary)) {
      setError(
        t({
          en: 'Invalid or unsupported payload format',
          es: 'Formato de datos no válido o no compatible',
        }),
      );
      return;
    }

    setError(null);
    onSubmit(binary);
  }, [value, onSubmit, t]);

  const handleScanSuccess = useCallback(
    (result: ScanResult) => {
      // 'answer' mode only ever yields a raw payload.
      if (result.kind !== 'payload') return;
      setError(null);
      onSubmit(result.data);
    },
    [onSubmit],
  );

  // The scanner reports only the camera failing, not transient scan failures.
  const handleScanError = useCallback((err: string) => {
    setError(err);
  }, []);

  const handleStartScan = useCallback(() => {
    setError(null);
    setScanStarted(true);
  }, []);

  const handleInputModeChange = useCallback((next: 'scan' | 'paste') => {
    setError(null);
    setInputMode(next);
    if (next !== 'scan') {
      setScanStarted(false);
    }
  }, []);

  return (
    <div className="space-y-3">
      <Tabs
        value={inputMode}
        onValueChange={(v) => handleInputModeChange(v as 'scan' | 'paste')}
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="scan" disabled={disabled}>
            <Camera className="h-4 w-4 mr-2" />
            {t({ en: 'Scan', es: 'Escanear' })}
          </TabsTrigger>
          <TabsTrigger value="paste" disabled={disabled}>
            <ClipboardPaste className="h-4 w-4 mr-2" />
            {t({ en: 'Paste', es: 'Pegar' })}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scan" className="mt-3">
          {scanStarted ? (
            <QRScanner
              mode="answer"
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
              <p className="text-base font-medium">
                {t({ en: 'Start scanning', es: 'Empezar a escanear' })}
              </p>
              <p className="text-sm text-muted-foreground mt-1">{scanHint}</p>
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
              placeholder={t({
                en: "Paste the receiver's response here...",
                es: 'Pega aquí la respuesta del receptor...',
              })}
              className="min-h-[100px] font-mono text-xs"
              aria-label={t({
                en: "Receiver's response code",
                es: 'Código de respuesta del receptor',
              })}
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
              {t({ en: 'Paste from Clipboard', es: 'Pegar del portapapeles' })}
            </Button>

            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={disabled || !value.trim()}
              className="flex-1"
            >
              {t({ en: 'Submit', es: 'Confirmar' })}
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
