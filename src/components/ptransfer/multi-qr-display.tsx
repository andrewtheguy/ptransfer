import { AlertCircle, Check, ChevronDown, Copy, Loader2 } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/textarea';
import { buildChunkUrl, chunkPayload } from '@/lib/chunk-utils';
import { generateMutualClipboardData } from '@/lib/manual-signaling';
import { generateTextQRCode } from '@/lib/qr-utils';

// The Clipboard API is unavailable in insecure contexts and some in-app
// browsers. Fall back to a read-only text box for manual selection there.
const clipboardWriteSupported =
  typeof navigator !== 'undefined' &&
  typeof navigator.clipboard?.writeText === 'function';

interface MultiQRDisplayProps {
  data: Uint8Array;
  clipboardData?: string;
  showCopyButton?: boolean;
}

interface ChunkInfo {
  url: string;
  index: number;
  total: number;
}

const MIN_QR_SIZE = 150;

export function MultiQRDisplay({
  data,
  clipboardData,
  showCopyButton = true,
}: MultiQRDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [qrImageUrls, setQrImageUrls] = useState<Map<number, string>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  // Reveal the read-only text box when the browser can't copy, or on request.
  const [showText, setShowText] = useState(!clipboardWriteSupported);
  const containerRef = useRef<HTMLDivElement>(null);

  // The exact payload the receiver needs, matching what Copy Data writes.
  const copyPayload = useMemo(() => {
    if (!data || data.length === 0) return '';
    return clipboardData || generateMutualClipboardData(data);
  }, [clipboardData, data]);

  const chunkInfos = useMemo((): ChunkInfo[] => {
    if (!data || data.length === 0) return [];
    const baseUrl = window.location.origin;
    const chunks = chunkPayload(data);
    return chunks.map((chunk, i) => ({
      url: buildChunkUrl(baseUrl, chunk),
      index: i,
      total: chunks.length,
    }));
  }, [data]);

  useEffect(() => {
    if (chunkInfos.length === 0) {
      setQrImageUrls(new Map());
      setError(null);
      return;
    }

    let active = true;

    const measuredWidth = containerRef.current?.clientWidth ?? 0;
    const qrWidth = Math.max(measuredWidth, MIN_QR_SIZE);

    setError(null);
    setQrImageUrls(new Map());

    Promise.allSettled(
      chunkInfos.map(async (info) => {
        const imageUrl = await generateTextQRCode(info.url, {
          width: qrWidth,
          errorCorrectionLevel: 'M',
        });
        return { index: info.index, imageUrl };
      }),
    )
      .then((results) => {
        if (!active) return;

        const urls = new Map<number, string>();
        let firstError: unknown = null;

        for (const result of results) {
          if (result.status === 'fulfilled') {
            urls.set(result.value.index, result.value.imageUrl);
          } else if (firstError === null) {
            firstError = result.reason;
          }
        }

        if (firstError !== null) {
          console.error('Failed to generate QR codes:', firstError);
          setError('Failed to generate QR codes');
          setQrImageUrls(new Map());
          return;
        }

        setQrImageUrls(urls);
      })
      .catch((err) => {
        if (!active) return;
        console.error('Failed to generate QR codes:', err);
        setError('Failed to generate QR codes');
        setQrImageUrls(new Map());
      });

    return () => {
      active = false;
    };
  }, [chunkInfos]);

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

  if (error) {
    return (
      <div className="flex items-center justify-center text-destructive text-sm py-8">
        <AlertCircle className="h-4 w-4 mr-2" />
        {error}
      </div>
    );
  }

  if (chunkInfos.length === 0) return null;

  return (
    <div className="flex flex-col items-center space-y-4">
      <div className="text-xs text-muted-foreground">
        {data.length.toLocaleString()} bytes &bull; {chunkInfos.length} QR code
        {chunkInfos.length !== 1 ? 's' : ''}
      </div>

      <div
        className={`grid gap-4 ${chunkInfos.length === 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'} w-full max-w-[600px]`}
      >
        {chunkInfos.map((info, i) => (
          <div key={info.index} className="flex flex-col items-center gap-1">
            <div className="p-2 bg-white rounded-lg w-full">
              <div
                ref={i === 0 ? containerRef : undefined}
                className="flex items-center justify-center w-full"
              >
                {qrImageUrls.has(info.index) ? (
                  <img
                    src={qrImageUrls.get(info.index)}
                    alt={`QR Code ${info.index + 1} of ${info.total}`}
                    className="block w-full h-auto"
                  />
                ) : (
                  <div className="aspect-square w-full flex items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                )}
              </div>
            </div>
            {info.total > 1 && (
              <p className="text-xs text-muted-foreground font-medium">
                {info.index + 1} of {info.total}
              </p>
            )}
          </div>
        ))}
      </div>

      {showCopyButton && copyPayload && (
        <div className="flex flex-col items-center gap-2 w-full max-w-[600px]">
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
              <ChevronDown
                className={`h-3 w-3 transition-transform ${showText ? 'rotate-180' : ''}`}
              />
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
                aria-label="Connection data to copy"
                className="w-full font-mono text-xs break-all resize-none"
              />
              <p className="text-xs text-muted-foreground text-center">
                Select all the text above, copy it, and send it back to the
                receiver.
              </p>
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
    </div>
  );
}
