import {
  ArrowLeftRight,
  ChevronRight,
  FileUp,
  FolderUp,
  Info,
  KeyRound,
  Send,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useSend } from '@/contexts/send-context';
import { MAX_MESSAGE_SIZE } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import { supportsFolderSelection } from '@/lib/folder-utils';

type MethodChoice = 'online' | 'offline';

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

  const [methodChoice, setMethodChoice] = useState<MethodChoice>('online');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const totalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);
  const isOverLimit = totalSize > MAX_MESSAGE_SIZE;
  const canSend = selectedFiles.length > 0 && !isOverLimit;
  // Anything beyond a single loose file is zipped; folder selections always
  // zip so their structure is preserved.
  const willZip =
    selectedFiles.length > 1 ||
    (selectedFiles.length === 1 && !!selectedFiles[0].webkitRelativePath);

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
    'Most reliable option. Sets up the connection automatically through relays using a short PIN you share; the same end-to-end encrypted transfer, without the manual handoff.';
  const pinModeHowItWorksDescription =
    'Same direct, end-to-end encrypted transfer as Manual Exchange — the difference is the handshake is exchanged automatically through relays, matched by your PIN, instead of by hand. Relays coordinate signaling and can see routing metadata, but they do not receive plaintext file contents or your decryption key.';
  const manualModeDescription =
    'You and the recipient directly exchange a short signaling payload — by QR code or copy/paste — to establish the transfer. No third-party coordination servers; STUN may be used when internet is available. File data stays encrypted.';
  const manualModeHowItWorksDescription =
    'You and the recipient directly exchange a short signaling payload, either by scanning QR codes or by copy/paste. The signaling payload is obfuscated, not encrypted, so exchange it only with the intended recipient. If internet is available, STUN is used for connection setup metadata such as IP address and port; it does not receive your file contents or encryption keys. It also works without internet when the devices can reach each other over a network path, such as the same LAN/Wi-Fi.';

  const handleSend = () => {
    // Set context with all the configuration
    setConfig({
      selectedFiles,
      methodChoice,
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
                {willZip && ' • Will package as ZIP'}
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
                  Multiple files are packaged as ZIP &bull; Max size:{' '}
                  {formatFileSize(MAX_MESSAGE_SIZE)}
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
            Total size exceeds {formatFileSize(MAX_MESSAGE_SIZE)} limit
          </p>
        )}
      </div>

      {/* Transfer mode selector */}
      <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
        <p className="text-sm font-medium">Transfer mode</p>
        <RadioGroup
          value={methodChoice}
          onValueChange={(value) => setMethodChoice(value as MethodChoice)}
          className="gap-2"
        >
          <label
            htmlFor="send-mode-pin"
            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
              methodChoice === 'online'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/60'
            }`}
          >
            <RadioGroupItem
              id="send-mode-pin"
              value="online"
              className="mt-0.5"
            />
            <div className="space-y-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                <KeyRound className="h-4 w-4" />
                Auto Exchange mode
              </span>
              <p className="text-xs text-muted-foreground">
                {pinModeDescription}
              </p>
            </div>
          </label>

          <label
            htmlFor="send-mode-qr"
            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
              methodChoice === 'offline'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/60'
            }`}
          >
            <RadioGroupItem
              id="send-mode-qr"
              value="offline"
              className="mt-0.5"
            />
            <div className="space-y-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                <ArrowLeftRight className="h-4 w-4" />
                Manual Exchange mode
              </span>
              <p className="text-xs text-muted-foreground">
                {manualModeDescription}
              </p>
            </div>
          </label>
        </RadioGroup>
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
              {methodChoice === 'online' ? (
                <>
                  Share your PIN with the recipient so they can connect and
                  decrypt your files.
                  <br />
                  {pinModeHowItWorksDescription}
                </>
              ) : (
                <>
                  Exchange signaling data with your recipient — by QR code or
                  copy/paste — to establish the transfer session.
                  <br />
                  {manualModeHowItWorksDescription}
                </>
              )}
            </p>
          </div>
        </div>
      </div>

      <Button onClick={handleSend} disabled={!canSend} className="w-full">
        <Send className="mr-2 h-4 w-4" />
        {methodChoice === 'offline'
          ? 'Start Manual Exchange'
          : 'Start Auto Exchange'}
        <ChevronRight className="ml-1 h-3 w-3" />
      </Button>
    </div>
  );
}
