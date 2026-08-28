import { AlertCircle, Check, Copy, Loader2 } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/textarea';
import { generateMutualClipboardData } from '@/lib/code-signaling';
import { generateBinaryQRCode } from '@/lib/qr-utils';

// The Clipboard API is unavailable in insecure contexts and some in-app
// browsers. Fall back to a read-only text box for manual selection there.
const clipboardWriteSupported =
  typeof navigator !== 'undefined' &&
  typeof navigator.clipboard?.writeText === 'function';

interface QRDisplayProps {
  data: Uint8Array; // Binary data for QR code (PT01 obfuscated payload)
  label?: string;
  showCopyButton?: boolean;
  showSize?: boolean;
}

const MIN_QR_SIZE = 150;

export function QRDisplay({
  data,
  label,
  showCopyButton = true,
  showSize = true,
}: QRDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reveal the read-only text box when the browser can't copy, or on request.
  const [showText, setShowText] = useState(!clipboardWriteSupported);
  const containerRef = useRef<HTMLDivElement>(null);

  // The exact payload the sender needs, matching what Copy Data writes.
  const copyPayload = useMemo(() => {
    if (!data || data.length === 0) return '';
    return generateMutualClipboardData(data);
  }, [data]);

  useEffect(() => {
    if (!data || data.length === 0) {
      setQrImageUrl(null); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }

    const measuredWidth = containerRef.current?.clientWidth ?? 0;
    const qrWidth = Math.max(measuredWidth, MIN_QR_SIZE);

    setIsGenerating(true);
    setError(null);

    generateBinaryQRCode(data, {
      width: qrWidth,
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        setQrImageUrl(url);
      })
      .catch((err) => {
        console.error('Failed to generate QR code:', err);
        setError('Failed to generate QR code');
        setQrImageUrl(null);
      })
      .finally(() => setIsGenerating(false));
  }, [data]);

  // Copy signaling payload as base64 for paste flow.
  const handleCopy = useCallback(async () => {
    if (!copyPayload) return;
    try {
      await navigator.clipboard.writeText(copyPayload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      // Copy failed at runtime — reveal the manual-copy fallback instead.
      setShowText(true);
    }
  }, [copyPayload]);

  // Select the whole payload so the user can copy it with a keyboard shortcut.
  const handleTextSelect = useCallback(
    (
      e:
        | React.FocusEvent<HTMLTextAreaElement>
        | React.MouseEvent<HTMLTextAreaElement>,
    ) => {
      e.currentTarget.select();
    },
    [],
  );

  return (
    <div className="flex flex-col items-center space-y-3">
      {label && (
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
      )}

      <div className="p-4 bg-white rounded-lg w-full">
        <div
          ref={containerRef}
          className="flex items-center justify-center w-full"
        >
          {isGenerating ? (
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          ) : error ? (
            <div className="text-destructive text-sm flex items-center">
              <AlertCircle className="h-4 w-4 mr-2" />
              {error}
            </div>
          ) : qrImageUrl ? (
            <img
              src={qrImageUrl}
              alt="QR Code"
              className="block w-full h-auto"
            />
          ) : null}
        </div>
      </div>

      {showSize && (
        <div className="text-xs text-muted-foreground">
          {data.length.toLocaleString()} bytes (compressed)
        </div>
      )}

      {showCopyButton && copyPayload && (
        <div className="flex flex-col items-center gap-2 w-full">
          {clipboardWriteSupported && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopy}
              className="text-xs"
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3 mr-1 text-green-500" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3 mr-1" />
                  Copy Data
                </>
              )}
            </Button>
          )}

          <Collapsible
            open={showText}
            onOpenChange={setShowText}
            className="w-full flex flex-col items-center gap-2"
          >
            <CollapsibleTrigger className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
              {clipboardWriteSupported
                ? "Can't copy? Show text to copy manually"
                : 'Show text to copy manually'}
            </CollapsibleTrigger>
            <CollapsibleContent className="w-full space-y-1">
              <Textarea
                readOnly
                value={copyPayload}
                onFocus={handleTextSelect}
                onClick={handleTextSelect}
                rows={4}
                spellCheck={false}
                aria-label="Response data to copy"
                className="w-full font-mono text-xs break-all resize-none"
              />
              <p className="text-xs text-muted-foreground text-center">
                Select all the text above, copy it, and send it back to the
                sender.
              </p>
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
    </div>
  );
}
