import {
  ArrowLeftRight,
  ChevronRight,
  FileUp,
  FolderUp,
  Info,
  KeyRound,
  Send,
  Shield,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { TransferMode } from '@/contexts/send-context';
import { useSend } from '@/contexts/send-context';
import { MAX_MESSAGE_SIZE } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import { supportsFolderSelection } from '@/lib/folder-utils';
import {
  DEFAULT_TOR_BRIDGE,
  TOR_BRIDGE_LABELS,
  TOR_BRIDGES,
  type TorBridge,
} from '@/lib/tor/client';
import {
  TOR_MAX_TRANSFER_BYTES,
  TOR_MAX_WIRE_BYTES,
  TOR_SUGGESTED_MAX_BYTES,
} from '@/lib/tor/transfer';
import { projectedWireBytesFor } from '@/lib/transfer-source';

// Extend input element to include webkitdirectory attribute
declare module 'react' {
  interface InputHTMLAttributes<T = HTMLInputElement> {
    webkitdirectory?: T extends HTMLInputElement ? string : never;
    directory?: T extends HTMLInputElement ? string : never;
  }
}

// Files picked via folder selection carry a webkitRelativePath whose first
// segment is the selected folder; loose files have an empty path.
function topFolderOf(file: File): string {
  return file.webkitRelativePath ? file.webkitRelativePath.split('/')[0] : '';
}

function selectionKey(file: File): string {
  return `${file.webkitRelativePath || file.name}-${file.size}`;
}

type DisplayEntry =
  | { kind: 'file'; file: File }
  | { kind: 'folder'; name: string; fileCount: number; size: number };

export function SendTab() {
  const navigate = useNavigate();
  const { setConfig } = useSend();

  const [transferMode, setTransferMode] = useState<TransferMode>('pin');
  const [torBridge, setTorBridge] = useState<TorBridge>(DEFAULT_TOR_BRIDGE);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const totalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);
  // The Tor transport's ceiling is far lower than the app's, and it is the
  // receiver's rule too — a CLI receiver refuses a larger offer outright — so
  // it is enforced on the selection rather than discovered mid-transfer.
  const sizeLimit =
    transferMode === 'tor' ? TOR_MAX_TRANSFER_BYTES : MAX_MESSAGE_SIZE;
  const isOverLimit = totalSize > sizeLimit;
  // Well under that ceiling, a Tor transfer is worth a word about — not
  // because it will be slow, but because it might be. Advice either way: the
  // send button does not care.
  const isLargeForTor =
    transferMode === 'tor' &&
    !isOverLimit &&
    totalSize > TOR_SUGGESTED_MAX_BYTES;
  // Anything beyond a single loose file is zipped; folder selections always
  // zip so their structure is preserved.
  const willZip =
    selectedFiles.length > 1 ||
    (selectedFiles.length === 1 && !!selectedFiles[0].webkitRelativePath);
  // A ZIP's headers and entry paths are wire bytes no file size accounts for,
  // and the ceiling the two peers enforce is a fixed constant — so a selection
  // of many tiny files has to be caught here rather than mid-transfer.
  const overWireLimit =
    transferMode === 'tor' &&
    !isOverLimit &&
    projectedWireBytesFor(selectedFiles, willZip) > TOR_MAX_WIRE_BYTES;
  const canSend = selectedFiles.length > 0 && !isOverLimit && !overWireLimit;

  // Collapse folder selections into one row per top-level folder; loose files
  // stay individual rows. Order follows first appearance in the selection.
  const displayEntries = useMemo<DisplayEntry[]>(() => {
    const entries: DisplayEntry[] = [];
    const folderIndex = new Map<string, number>();
    for (const file of selectedFiles) {
      const folder = topFolderOf(file);
      if (!folder) {
        entries.push({ kind: 'file', file });
        continue;
      }
      const index = folderIndex.get(folder);
      if (index === undefined) {
        folderIndex.set(folder, entries.length);
        entries.push({
          kind: 'folder',
          name: folder,
          fileCount: 1,
          size: file.size,
        });
      } else {
        const entry = entries[index] as Extract<
          DisplayEntry,
          { kind: 'folder' }
        >;
        entry.fileCount++;
        entry.size += file.size;
      }
    }
    return entries;
  }, [selectedFiles]);

  const pinModeDescription =
    "Carry a short 12-character PIN — the option when scanning a QR or moving a long code isn't practical: no camera, a blocked clipboard, or devices that aren't side by side. Relays carry the handshake and your PIN authenticates it, then the file goes over direct WebRTC.";
  const pinModeHowItWorksDescription =
    'The handshake travels through relays and is authenticated by a SPAKE2 exchange driven by your PIN. Relays can see routing metadata, but they receive neither plaintext file contents nor the content key. Needs internet on both sides, and there is no data-relay fallback if direct WebRTC fails.';
  const codeModeDescription =
    "Carry the full code, by QR or copy/paste, and bring the receiver's reply back the same way. Nothing about the handshake touches a relay. If the direct connection fails, an eligible encrypted file up to 100 MiB can use the automatic Nostr relay fallback.";
  const torModeDescription =
    'Carry a `.onion` address and a one-time password. Your browser tab publishes a Tor hidden service and the file travels inside the Tor circuit — no pTransfer relay and no direct connection between the two networks, only the Tor bridge and relays it travels through, which see transport metadata and never the file, and nothing published that could be correlated later. Slower, capped at 100 MiB, and best kept small — a circuit is slow and there is no resume.';
  const torModeHowItWorksDescription =
    'This tab generates the service identity, establishes its own introduction points and publishes a signed descriptor, then answers the stream the receiver opens. The address authenticates the service; the password authenticates the receiver through the same SPAKE2 exchange PIN mode uses, and the file is encrypted again inside the circuit. Bootstrapping Tor in a browser takes a while on a first run, and the receiver can be this app or ptransfer-cli.';
  const codeModeHowItWorksDescription =
    'The code is obfuscated, not encrypted, so hand it only to the intended recipient; it authenticates the ECDH exchange. The reply only enters your page when you scan or paste it yourself. With internet, STUN helps find a direct route. Without internet, devices can connect on the same LAN. If no direct route exists and the code named usable relays, public Nostr relays can carry an encrypted file up to 100 MiB; this fallback remains best-effort.';

  const handleSend = () => {
    // Set context with all the configuration
    setConfig({
      selectedFiles,
      transferMode,
      torBridge,
    });
    // Navigate to transfer page
    void navigate('/send/transfer');
  };

  const addFiles = useCallback((files: File[]) => {
    if (files.length > 0) {
      // Add to existing files, avoiding duplicates by path+size
      setSelectedFiles((prev) => {
        const existingKeys = new Set(prev.map(selectionKey));
        const uniqueNew = files.filter(
          (f) => !existingKeys.has(selectionKey(f)),
        );
        return [...prev, ...uniqueNew];
      });
    }
  }, []);

  const removeFile = useCallback((file: File) => {
    setSelectedFiles((prev) => prev.filter((f) => f !== file));
  }, []);

  const removeFolder = useCallback((folder: string) => {
    setSelectedFiles((prev) => prev.filter((f) => topFolderOf(f) !== folder));
  }, []);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Convert FileList to array BEFORE resetting input (FileList is a live reference)
    const files = e.target.files ? Array.from(e.target.files) : [];
    addFiles(files);
    // Reset input so same file can be added again if removed
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFolderInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    addFiles(files);
    // Reset input so the same folder can be added again if removed
    if (folderInputRef.current) folderInputRef.current.value = '';
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragging(false);
      addFiles(Array.from(e.dataTransfer.files));
    },
    [addFiles],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) {
      setIsDragging(true);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  return (
    <div className="space-y-4 pt-4">
      <div className="space-y-2">
        {selectedFiles.length > 0 ? (
          <div className="space-y-2">
            {/* Selection list: loose files and folders mixed */}
            <div className="max-h-[160px] overflow-y-auto space-y-1 border rounded-lg p-2">
              {displayEntries.map((entry) =>
                entry.kind === 'file' ? (
                  <div
                    key={selectionKey(entry.file)}
                    className="flex items-center gap-2 py-1 px-2 rounded hover:bg-muted/50 group"
                  >
                    <FileUp className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span className="flex-1 truncate text-sm">
                      {entry.file.name}
                    </span>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {formatFileSize(entry.file.size)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => removeFile(entry.file)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <div
                    key={`folder-${entry.name}`}
                    className="flex items-center gap-2 py-1 px-2 rounded hover:bg-muted/50 group"
                  >
                    <FolderUp className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span className="flex-1 truncate text-sm">
                      {entry.name}
                    </span>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {entry.fileCount} file{entry.fileCount !== 1 ? 's' : ''}{' '}
                      &bull; {formatFileSize(entry.size)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => removeFolder(entry.name)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ),
              )}
            </div>
            {/* Summary and add more */}
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                {selectedFiles.length} file
                {selectedFiles.length !== 1 ? 's' : ''} •{' '}
                {formatFileSize(totalSize)}
                {willZip && ' • Will be compressed into a ZIP archive'}
              </span>
              <div className="flex gap-2 flex-shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileUp className="h-3.5 w-3.5 mr-1" />
                  Add files
                </Button>
                {supportsFolderSelection && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => folderInputRef.current?.click()}
                  >
                    <FolderUp className="h-3.5 w-3.5 mr-1" />
                    Add folder
                  </Button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDrop={handleDrop}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              className={`
                    w-full min-h-[200px] border-2 border-dashed rounded-lg
                    flex flex-col items-center justify-center gap-3
                    cursor-pointer transition-colors
                    ${isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-muted-foreground/50'}
                  `}
            >
              <Upload className="h-10 w-10 text-muted-foreground" />
              <div className="text-center">
                <p className="font-medium">
                  Drop files here or click to select
                </p>
                <p className="text-sm text-muted-foreground">
                  Multiple files will be compressed into a ZIP archive &bull;
                  Max size: {formatFileSize(sizeLimit)}
                </p>
              </div>
            </button>
            {supportsFolderSelection && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => folderInputRef.current?.click()}
              >
                <FolderUp className="h-4 w-4 mr-2" />
                Select a folder
              </Button>
            )}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileInputChange}
          className="hidden"
        />
        <input
          ref={folderInputRef}
          type="file"
          onChange={handleFolderInputChange}
          className="hidden"
          webkitdirectory=""
          directory=""
        />
        {isOverLimit && (
          <p className="text-xs text-destructive">
            Total size exceeds the {formatFileSize(sizeLimit)} limit
            {transferMode === 'tor' ? ' of the Tor transport' : ''}
          </p>
        )}
        {overWireLimit && (
          <p className="text-xs text-destructive">
            These {selectedFiles.length} files need more than{' '}
            {formatFileSize(TOR_MAX_WIRE_BYTES)} on the wire once archive
            headers are counted. Send fewer files, or zip them yourself first.
          </p>
        )}
        {isLargeForTor && (
          <p className="text-xs text-amber-600">
            Over {formatFileSize(TOR_SUGGESTED_MAX_BYTES)} through a Tor
            circuit. Speed depends on the relays you get — this may be quick or
            may crawl, and a transfer that drops starts over. Send it anyway if
            that trade is fine.
          </p>
        )}
      </div>

      {/* Transfer mode selector */}
      <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">Transfer mode</p>
          <p className="text-xs text-muted-foreground">
            You hand something to the receiver either way. The modes differ in
            what you carry.
          </p>
        </div>
        <RadioGroup
          value={transferMode}
          onValueChange={(value) => setTransferMode(value as TransferMode)}
          className="gap-2"
        >
          <label
            htmlFor="send-mode-pin"
            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
              transferMode === 'pin'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/60'
            }`}
          >
            <RadioGroupItem id="send-mode-pin" value="pin" className="mt-0.5" />
            <div className="space-y-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                <KeyRound className="h-4 w-4" />
                PIN Exchange
              </span>
              <p className="text-xs text-muted-foreground">
                {pinModeDescription}
              </p>
            </div>
          </label>

          <label
            htmlFor="send-mode-code"
            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
              transferMode === 'code'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/60'
            }`}
          >
            <RadioGroupItem
              id="send-mode-code"
              value="code"
              className="mt-0.5"
            />
            <div className="space-y-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                <ArrowLeftRight className="h-4 w-4" />
                Code Exchange
              </span>
              <p className="text-xs text-muted-foreground">
                {codeModeDescription}
              </p>
            </div>
          </label>

          <label
            htmlFor="send-mode-tor"
            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
              transferMode === 'tor'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/60'
            }`}
          >
            <RadioGroupItem id="send-mode-tor" value="tor" className="mt-0.5" />
            <div className="space-y-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Shield className="h-4 w-4" />
                Tor Onion Service
                <span className="rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  Experimental
                </span>
              </span>
              <p className="text-xs text-muted-foreground">
                {torModeDescription}
              </p>
            </div>
          </label>
        </RadioGroup>

        {transferMode === 'tor' && (
          <div className="space-y-2 rounded-md border bg-background/60 p-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">How this tab reaches Tor</p>
              <p className="text-xs text-muted-foreground">
                Every circuit starts at a Snowflake bridge, which is also how
                the tab reaches the network at all.
              </p>
            </div>
            <RadioGroup
              value={torBridge}
              onValueChange={(value) => setTorBridge(value as TorBridge)}
              className="gap-2"
            >
              {TOR_BRIDGES.map((bridge) => (
                <label
                  key={bridge}
                  htmlFor={`send-tor-bridge-${bridge}`}
                  className="flex cursor-pointer items-start gap-3 text-xs"
                >
                  <RadioGroupItem
                    id={`send-tor-bridge-${bridge}`}
                    value={bridge}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">
                      {TOR_BRIDGE_LABELS[bridge]}
                    </span>{' '}
                    <span className="text-muted-foreground">
                      {bridge === 'websocket'
                        ? '— one fixed bridge endpoint, no broker and no STUN. The faster of the two, and the one to try first.'
                        : '— a volunteer proxy brokered over HTTPS, using STUN. Harder to block, and worth switching to if the WebSocket bridge cannot be reached.'}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>
        )}
      </div>

      {/* How it works info box */}
      <div className="rounded-lg bg-gradient-to-br from-primary/5 to-accent/5 border border-primary/10 p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-primary/10 p-2">
            <Info className="h-4 w-4 text-primary" />
          </div>
          <div className="text-sm">
            <p className="font-medium mb-1">How it works</p>
            <p className="text-muted-foreground">
              {transferMode === 'pin' && (
                <>
                  Show the recipient your PIN — as a QR code they scan, or read
                  out — so they can connect and decrypt your files.
                  <br />
                  {pinModeHowItWorksDescription}
                </>
              )}
              {transferMode === 'code' && (
                <>
                  Hand your recipient the connection code — by QR code or
                  copy/paste — to establish the transfer session.
                  <br />
                  {codeModeHowItWorksDescription}
                </>
              )}
              {transferMode === 'tor' && (
                <>
                  Give the recipient the onion address and the one-time password
                  this tab shows, over any trusted channel.
                  <br />
                  {torModeHowItWorksDescription}
                </>
              )}
            </p>
          </div>
        </div>
      </div>

      <Button onClick={handleSend} disabled={!canSend} className="w-full">
        <Send className="mr-2 h-4 w-4" />
        {transferMode === 'code' && 'Start Code Exchange'}
        {transferMode === 'pin' && 'Start PIN Exchange'}
        {transferMode === 'tor' && 'Publish Onion Service'}
        <ChevronRight className="ml-1 h-3 w-3" />
      </Button>
    </div>
  );
}
