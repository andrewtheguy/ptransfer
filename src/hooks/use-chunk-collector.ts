import { useCallback, useRef, useState } from 'react';
import {
  extractChunkParam,
  isValidPayloadChecksum,
  parseChunk,
  reassembleChunks,
} from '@/lib/chunk-utils';
import { t } from '@/lib/i18n';

interface ChunkCollectorState {
  totalChunks: number | null;
  collectedCount: number;
  collectedIndices: Set<number>;
  isComplete: boolean;
  assembledPayload: Uint8Array | null;
  error: string | null;
}

export function useChunkCollector() {
  const chunksRef = useRef(new Map<number, Uint8Array>());
  const totalRef = useRef<number | null>(null);
  const checksumRef = useRef<number | null>(null);

  const [state, setState] = useState<ChunkCollectorState>({
    totalChunks: null,
    collectedCount: 0,
    collectedIndices: new Set<number>(),
    isComplete: false,
    assembledPayload: null,
    error: null,
  });

  const resetCollector = useCallback((error: string | null) => {
    chunksRef.current.clear();
    totalRef.current = null;
    checksumRef.current = null;
    setState({
      totalChunks: null,
      collectedCount: 0,
      collectedIndices: new Set<number>(),
      isComplete: false,
      assembledPayload: null,
      error,
    });
  }, []);

  const addChunk = useCallback(
    (encoded: string): boolean => {
      const parsed = parseChunk(encoded);
      if (!parsed) return false;

      // Reject chunks with mismatched total (guards against mixing different offers)
      if (totalRef.current !== null && parsed.total !== totalRef.current) {
        return false;
      }

      if (parsed.index === 0) {
        const parsedChecksum = parsed.checksum;
        if (
          typeof parsedChecksum !== 'number' ||
          !Number.isFinite(parsedChecksum)
        ) {
          return false;
        }
        if (
          checksumRef.current !== null &&
          checksumRef.current !== parsedChecksum
        ) {
          return false;
        }
        checksumRef.current = parsedChecksum;
      } else if (parsed.checksum !== undefined) {
        return false;
      }

      // Ignore duplicates so re-scanning the same QR does not overwrite state.
      if (chunksRef.current.has(parsed.index)) {
        return false;
      }

      totalRef.current = parsed.total;
      chunksRef.current.set(parsed.index, parsed.data);

      const collectedCount = chunksRef.current.size;
      const isComplete = collectedCount === parsed.total;

      const collectedIndices = new Set(chunksRef.current.keys());

      if (isComplete) {
        const assembled = reassembleChunks(chunksRef.current, parsed.total);
        const expectedChecksum = checksumRef.current;
        if (!assembled) {
          resetCollector(
            t({
              en: 'Invalid QR payload',
              es: 'Datos del código QR no válidos',
            }),
          );
          return false;
        }
        if (expectedChecksum === null || !Number.isFinite(expectedChecksum)) {
          resetCollector(
            t({
              en: 'Invalid QR payload',
              es: 'Datos del código QR no válidos',
            }),
          );
          return false;
        }
        if (!isValidPayloadChecksum(assembled, expectedChecksum)) {
          resetCollector(
            t({
              en: 'Invalid QR payload',
              es: 'Datos del código QR no válidos',
            }),
          );
          return false;
        }

        setState({
          totalChunks: parsed.total,
          collectedCount,
          collectedIndices,
          isComplete: true,
          assembledPayload: assembled,
          error: null,
        });
      } else {
        setState({
          totalChunks: parsed.total,
          collectedCount,
          collectedIndices,
          isComplete: false,
          assembledPayload: null,
          error: null,
        });
      }

      return true;
    },
    [resetCollector],
  );

  const addChunkFromUrl = useCallback(
    (url: string): boolean => {
      const param = extractChunkParam(url);
      if (!param) return false;
      return addChunk(param);
    },
    [addChunk],
  );

  return { state, addChunk, addChunkFromUrl };
}
