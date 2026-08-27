/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import type { TorBridge } from '@/lib/tor/client';

export type TransferMode = 'pin' | 'code' | 'tor';

interface SendConfig {
  // Files (loose files and folder selections mixed; folder entries carry
  // webkitRelativePath so archive structure is preserved)
  selectedFiles: File[];

  // Configuration
  transferMode: TransferMode;
  /**
   * Which Snowflake bridge this tab reaches the Tor network through. Read by
   * the Tor mode, and by PIN Exchange when `anonymousSignaling` is on;
   * ignored otherwise, when no Tor client is ever loaded.
   */
  torBridge: TorBridge;
  /**
   * PIN Exchange only: carry the handshake through Tor to onion-service
   * relays, and mint the longer PIN that tells the receiver to do the same.
   */
  anonymousSignaling: boolean;
}

interface SendContextState {
  // Configuration
  config: SendConfig | null;

  // Actions
  setConfig: (config: SendConfig) => void;
  clearConfig: () => void;

  // Computed
  hasConfig: boolean;
  totalFileSize: number;
  fileCount: number;
}

const SendContext = createContext<SendContextState | null>(null);

export function useSend() {
  const context = useContext(SendContext);
  if (!context) {
    throw new Error('useSend must be used within a SendProvider');
  }
  return context;
}

interface SendProviderProps {
  children: ReactNode;
}

export function SendProvider({ children }: SendProviderProps) {
  const [config, setConfig] = useState<SendConfig | null>(null);

  // Stable clearConfig reference for consumers
  const clearConfig = useCallback(() => setConfig(null), []);

  // Memoize context value to prevent unnecessary consumer re-renders
  const value = useMemo<SendContextState>(() => {
    const hasConfig = config !== null;

    const totalFileSize = config
      ? config.selectedFiles.reduce((sum, f) => sum + f.size, 0)
      : 0;

    const fileCount = config ? config.selectedFiles.length : 0;

    return {
      config,
      setConfig,
      clearConfig,
      hasConfig,
      totalFileSize,
      fileCount,
    };
  }, [config, clearConfig]);

  return <SendContext.Provider value={value}>{children}</SendContext.Provider>;
}
