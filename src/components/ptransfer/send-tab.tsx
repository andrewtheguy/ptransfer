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
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import type { TransferMode } from '@/contexts/send-context';
import { useSend } from '@/contexts/send-context';
import { useLocaleNavigate, useT } from '@/i18n/locale-context';
import { MAX_MESSAGE_SIZE } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import {
  projectedWireBytesFor,
  supportsFolderSelection,
} from '@/lib/picked-files';
import { DEFAULT_TOR_BRIDGE, type TorBridge } from '@/lib/tor/bridge';
import {
  TOR_MAX_TRANSFER_BYTES,
  TOR_MAX_WIRE_BYTES,
  TOR_SUGGESTED_MAX_BYTES,
} from '@/lib/tor/transfer';
import { TorBridgeChoice } from './tor-bridge-choice';

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
  const t = useT();
  const navigate = useLocaleNavigate();
  const { setConfig } = useSend();

  const [transferMode, setTransferMode] = useState<TransferMode>('pin');
  const [torBridge, setTorBridge] = useState<TorBridge>(DEFAULT_TOR_BRIDGE);
  const [anonymousSignaling, setAnonymousSignaling] = useState(false);
  const [anonymousRelay, setAnonymousRelay] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const totalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);
  // The option belongs to PIN Exchange alone, and the switch is only rendered
  // there — but the mode can be changed after it was turned on, so what the
  // rest of this component reads is the conjunction, never the switch.
  const anonymousSignalingActive = transferMode === 'pin' && anonymousSignaling;
  // Same rule for the Code Exchange option: rendered only in that mode, read
  // only as the conjunction, so switching mode never carries it along.
  const anonymousRelayActive = transferMode === 'code' && anonymousRelay;
  // Two ways to end up sending file bytes through Tor: the transport itself,
  // and the fallback a Code Exchange sender selects. The ceiling is the
  // transport's either way.
  const usesTorTransport = transferMode === 'tor' || anonymousRelayActive;
  // The Tor transport's ceiling is far lower than the app's, and it is the
  // receiver's rule too — the receiver refuses a larger offer outright — so
  // it is enforced on the selection rather than discovered mid-transfer. For
  // the anonymous fallback that means before a code is handed over: a sender
  // that only found out afterwards would have spent the whole exchange to
  // learn its selected fallback cannot carry the file.
  const sizeLimit = usesTorTransport
    ? TOR_MAX_TRANSFER_BYTES
    : MAX_MESSAGE_SIZE;
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
    usesTorTransport &&
    !isOverLimit &&
    projectedWireBytesFor(selectedFiles, willZip) > TOR_MAX_WIRE_BYTES;
  const canSend = selectedFiles.length > 0 && !isOverLimit && !overWireLimit;
  // Whichever of the two is on, this tab loads a Tor client, so the bridge
  // question is the same question.
  const usesTorBridge = anonymousSignalingActive || anonymousRelayActive;

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

  const pinModeDescription = t({
    en: "Carry a short 12-character PIN — the option when scanning a QR or moving a long code isn't practical: no camera, a blocked clipboard, or devices that aren't side by side. Relays carry the handshake and your PIN authenticates it, then they carry the connection code for you: the file goes over direct WebRTC, with the same automatic relay fallback as Code Exchange for an eligible file up to 100 MiB.",
    es: 'Lleva un PIN corto de 12 caracteres: la opción cuando escanear un QR o mover un código largo no es práctico, ya sea porque no hay cámara, el portapapeles está bloqueado o los dispositivos no están uno al lado del otro. Los relays llevan la negociación y tu PIN la autentica; después llevan el código de conexión por ti: el archivo va por WebRTC directo, con el mismo respaldo automático por relays que el Intercambio por código para un archivo apto de hasta 100 MiB.',
  });
  const pinModeHowItWorksDescription = t({
    en: "The handshake travels through relays and is authenticated by a SPAKE2 exchange driven by your PIN. Once you type the receiver's confirmation code, it carries a Code Exchange offer and answer sealed under that exchange, so if direct WebRTC fails, an eligible encrypted file up to 100 MiB can use the same automatic Nostr relay fallback. Relays can see routing metadata, but they receive neither plaintext file contents nor the content key. Needs internet on both sides.",
    es: 'La negociación viaja por relays y se autentica con un intercambio SPAKE2 basado en tu PIN. Cuando escribes el código de confirmación del receptor, lleva una oferta y una respuesta del Intercambio por código selladas bajo ese intercambio, así que si falla el WebRTC directo, un archivo cifrado apto de hasta 100 MiB puede usar el mismo respaldo automático por relays de Nostr. Los relays pueden ver metadatos de enrutamiento, pero no reciben ni el contenido del archivo en claro ni la clave del contenido. Requiere internet en ambos lados.',
  });
  const codeModeDescription = t({
    en: "Carry the full code, by QR or copy/paste, and bring the receiver's reply back the same way. Nothing about the handshake touches a relay. If the direct connection fails, an eligible encrypted file up to 100 MiB can use the automatic Nostr relay fallback.",
    es: 'Lleva el código completo, por QR o copiando y pegando, y trae la respuesta del receptor de la misma forma. Ninguna parte de la negociación pasa por un relay. Si falla la conexión directa, un archivo cifrado apto de hasta 100 MiB puede usar el respaldo automático por relays de Nostr.',
  });
  const torModeDescription = t({
    en: 'Carry a `.onion` address and a one-time password. Your browser tab publishes a Tor hidden service and the file travels inside Tor — no pTransfer relay and no direct connection between the two networks. Tor infrastructure sees only its slice of transport metadata, not file plaintext or the content key; the descriptor remains retrievable by anyone holding the address until it expires. Slower, capped at 100 MiB, and best kept small — a circuit is slow and there is no resume.',
    es: 'Lleva una dirección `.onion` y una contraseña de un solo uso. La pestaña del navegador publica un servicio oculto de Tor y el archivo viaja dentro de Tor: sin relay de pTransfer y sin conexión directa entre las dos redes. La infraestructura de Tor solo ve su parte de los metadatos de transporte, no el archivo en claro ni la clave del contenido; el descriptor sigue disponible para cualquiera que tenga la dirección hasta que caduca. Más lento, limitado a 100 MiB y mejor para archivos pequeños: un circuito es lento y no se puede reanudar.',
  });
  const torModeHowItWorksDescription = t({
    en: 'This tab generates the service identity, establishes its own introduction points and publishes a signed descriptor, then answers the stream the receiver opens. The address authenticates the service; the password authenticates the receiver through the same SPAKE2 exchange PIN mode uses, and the file is encrypted again inside the circuit. Bootstrapping Tor in a browser takes a while on a first run, and the receiver can be this app or ptransfer on the command line.',
    es: 'Esta pestaña genera la identidad del servicio, establece sus propios puntos de introducción y publica un descriptor firmado; después responde al flujo que abre el receptor. La dirección autentica el servicio; la contraseña autentica al receptor mediante el mismo intercambio SPAKE2 que usa el modo PIN, y el archivo se cifra de nuevo dentro del circuito. Iniciar Tor en un navegador tarda un rato la primera vez, y el receptor puede ser esta aplicación o ptransfer en la línea de comandos.',
  });
  const anonymousSignalingHowItWorksDescription = t({
    en: 'The handshake travels through Tor to onion-service relays, so no Nostr relay learns your IP address, and it is authenticated by the same SPAKE2 exchange your PIN drives. Bootstrapping Tor in the browser takes a while on a first run, and the onion relay pool is small and unmonitored, so this fails more often than ordinary PIN Exchange. File data still goes over a direct encrypted WebRTC connection when one can be made, which Tor does not cover; if none can, an encrypted file up to 100 MiB goes through a Tor onion service this tab publishes rather than public relays.',
    es: 'La negociación viaja por Tor hasta relays que funcionan como servicios onion, así que ningún relay de Nostr conoce tu dirección IP, y se autentica con el mismo intercambio SPAKE2 basado en tu PIN. Iniciar Tor en el navegador tarda un rato la primera vez, y el conjunto de relays onion es pequeño y no está supervisado, así que esto falla más a menudo que el Intercambio por PIN normal. Los datos del archivo siguen yendo por una conexión WebRTC directa y cifrada cuando se puede establecer, y Tor no la cubre; si no se puede, un archivo cifrado de hasta 100 MiB pasa por un servicio onion de Tor que publica esta pestaña en lugar de por relays públicos.',
  });
  const anonymousRelayHowItWorksDescription = t({
    en: 'The code is obfuscated, not encrypted, so hand it only to the intended recipient; it authenticates the ECDH exchange, and the reply only enters your page when you scan or paste it yourself. A direct WebRTC connection is still tried first, exactly as always. If none can be made, both devices reach Tor rather than the clearnet: they coordinate over Nostr relays run as onion services, and this tab publishes a Tor onion service that carries the encrypted file, up to 100 MiB. Both devices need internet for that, and the recipient starts bootstrapping Tor the moment they take your code in — so this is not the offline, same-network case ordinary Code Exchange covers. Bootstrapping Tor in a browser takes a while on a first run, and this fails more often than the ordinary relay fallback.',
    es: 'El código está ofuscado, no cifrado, así que dáselo solo al receptor previsto; autentica el intercambio ECDH, y la respuesta solo entra en tu página cuando tú mismo la escaneas o la pegas. Primero se sigue intentando una conexión WebRTC directa, como siempre. Si no se puede establecer, ambos dispositivos acceden a Tor en lugar de a la red abierta: se coordinan mediante relays de Nostr que funcionan como servicios onion, y esta pestaña publica un servicio onion de Tor que lleva el archivo cifrado, de hasta 100 MiB. Para eso ambos dispositivos necesitan internet, y el receptor empieza a iniciar Tor en cuanto recibe tu código; así que este no es el caso sin conexión y en la misma red que cubre el Intercambio por código normal. Iniciar Tor en un navegador tarda un rato la primera vez, y esto falla más a menudo que el respaldo por relays normal.',
  });
  const codeModeHowItWorksDescription = t({
    en: 'The code is obfuscated, not encrypted, so hand it only to the intended recipient; it authenticates the ECDH exchange. The reply only enters your page when you scan or paste it yourself. With internet, STUN helps find a direct route. Without internet, devices can connect on the same LAN. If no direct route exists and the code named usable relays, public Nostr relays can carry an encrypted file up to 100 MiB; this fallback remains best-effort.',
    es: 'El código está ofuscado, no cifrado, así que dáselo solo al receptor previsto; autentica el intercambio ECDH. La respuesta solo entra en tu página cuando tú mismo la escaneas o la pegas. Con internet, STUN ayuda a encontrar una ruta directa. Sin internet, los dispositivos pueden conectarse en la misma red local. Si no hay ruta directa y el código indicaba relays utilizables, los relays públicos de Nostr pueden llevar un archivo cifrado de hasta 100 MiB; este respaldo funciona sin garantías.',
  });

  const handleSend = () => {
    // Set context with all the configuration
    setConfig({
      selectedFiles,
      transferMode,
      torBridge,
      anonymousSignaling: anonymousSignalingActive,
      anonymousRelay: anonymousRelayActive,
    });
    // Navigate to transfer page
    navigate('/send/transfer');
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
                      {t({
                        en: `${entry.fileCount} file${entry.fileCount !== 1 ? 's' : ''}`,
                        es: `${entry.fileCount} ${entry.fileCount !== 1 ? 'archivos' : 'archivo'}`,
                      })}{' '}
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
                {t({
                  en: `${selectedFiles.length} file${selectedFiles.length !== 1 ? 's' : ''}`,
                  es: `${selectedFiles.length} ${selectedFiles.length !== 1 ? 'archivos' : 'archivo'}`,
                })}{' '}
                • {formatFileSize(totalSize)}
                {willZip &&
                  t({
                    en: ' • Will be packaged as a ZIP archive',
                    es: ' • Se empaquetará como un archivo ZIP',
                  })}
              </span>
              <div className="flex gap-2 flex-shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileUp className="h-3.5 w-3.5 mr-1" />
                  {t({ en: 'Add files', es: 'Añadir archivos' })}
                </Button>
                {supportsFolderSelection && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => folderInputRef.current?.click()}
                  >
                    <FolderUp className="h-3.5 w-3.5 mr-1" />
                    {t({ en: 'Add folder', es: 'Añadir carpeta' })}
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
                  {t({
                    en: 'Drop files here or click to select',
                    es: 'Suelta archivos aquí o haz clic para elegirlos',
                  })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t({
                    en: `Multiple files will be packaged as a ZIP archive • Max size: ${formatFileSize(sizeLimit)}`,
                    es: `Varios archivos se empaquetarán como un archivo ZIP • Tamaño máximo: ${formatFileSize(sizeLimit)}`,
                  })}
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
                {t({ en: 'Select a folder', es: 'Elegir una carpeta' })}
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
            {usesTorTransport
              ? transferMode === 'tor'
                ? t({
                    en: `Total size exceeds the ${formatFileSize(sizeLimit)} limit of the Tor transport`,
                    es: `El tamaño total supera el límite de ${formatFileSize(sizeLimit)} del transporte por Tor`,
                  })
                : t({
                    en: `Total size exceeds the ${formatFileSize(sizeLimit)} limit of the anonymous fallback's Tor transport`,
                    es: `El tamaño total supera el límite de ${formatFileSize(sizeLimit)} del transporte por Tor del respaldo anónimo`,
                  })
              : t({
                  en: `Total size exceeds the ${formatFileSize(sizeLimit)} limit`,
                  es: `El tamaño total supera el límite de ${formatFileSize(sizeLimit)}`,
                })}
          </p>
        )}
        {overWireLimit && (
          <p className="text-xs text-destructive">
            {t({
              en: `These ${selectedFiles.length} files need more than ${formatFileSize(TOR_MAX_WIRE_BYTES)} on the wire once archive headers are counted. Send fewer files, or zip them yourself first.`,
              es: `Estos ${selectedFiles.length} archivos ocupan más de ${formatFileSize(TOR_MAX_WIRE_BYTES)} en la transmisión al contar las cabeceras del archivo comprimido. Envía menos archivos o comprímelos tú mismo antes.`,
            })}
          </p>
        )}
        {isLargeForTor && (
          <p className="text-xs text-amber-600">
            {t({
              en: `Over ${formatFileSize(TOR_SUGGESTED_MAX_BYTES)} through a Tor circuit. Speed depends on the relays you get — this may be quick or may crawl, and a transfer that drops starts over. Send it anyway if that trade is fine.`,
              es: `Más de ${formatFileSize(TOR_SUGGESTED_MAX_BYTES)} por un circuito de Tor. La velocidad depende de los relays que te toquen: puede ir rápido o muy lento, y una transferencia que se corta empieza de nuevo. Envíalo de todos modos si te parece bien.`,
            })}
          </p>
        )}
      </div>

      {/* Transfer mode selector */}
      <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {t({ en: 'Transfer mode', es: 'Modo de transferencia' })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t({
              en: 'You hand something to the receiver either way. The modes differ in what you carry.',
              es: 'En cualquier caso le pasas algo al receptor. Los modos se diferencian en lo que llevas.',
            })}
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
                {t({ en: 'PIN Exchange', es: 'Intercambio por PIN' })}
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
                {t({ en: 'Code Exchange', es: 'Intercambio por código' })}
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
                {t({ en: 'Tor Onion Service', es: 'Servicio onion de Tor' })}
                <span className="rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  {t({ en: 'Experimental', es: 'Experimental' })}
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
              <p className="text-sm font-medium">
                {t({
                  en: 'How this tab reaches Tor',
                  es: 'Cómo llega esta pestaña a Tor',
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t({
                  en: 'Every circuit starts at a Snowflake bridge, which is also how the tab reaches the network at all.',
                  es: 'Cada circuito empieza en un puente Snowflake, que es también la forma en que la pestaña llega a la red.',
                })}
              </p>
            </div>
            <TorBridgeChoice
              value={torBridge}
              onChange={setTorBridge}
              idPrefix="send-tor-bridge"
            />
          </div>
        )}
      </div>

      {/* Advanced options: PIN and Code Exchange have one experimental option
          each, and the section is closed by default. */}
      {(transferMode === 'pin' || transferMode === 'code') && (
        <Collapsible
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          className="rounded-lg border bg-muted/30 p-3"
        >
          <CollapsibleTrigger className="flex w-full items-center gap-1 text-sm font-medium">
            {t({ en: 'Advanced options', es: 'Opciones avanzadas' })}
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-3">
            {transferMode === 'pin' ? (
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <label
                    htmlFor="send-anonymous-signaling"
                    className="flex items-center gap-2 text-sm font-medium cursor-pointer"
                  >
                    {t({
                      en: 'Anonymous signaling',
                      es: 'Señalización anónima',
                    })}
                    <span className="rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                      {t({ en: 'Experimental', es: 'Experimental' })}
                    </span>
                  </label>
                  <p className="text-xs text-muted-foreground">
                    {t({
                      en: "Routes the handshake through Tor inside your browser to relays run as onion services, so no Nostr relay sees your IP address. Your PIN comes out longer, and that length is how the recipient's page knows to look on the same relays — they do not have to turn anything on, or even know this exists. It starts much more slowly and is less reliable. It does not anonymize a direct file transfer: that is still a WebRTC connection, so your recipient and the STUN services see the same network metadata as always. If no direct connection can be made, the file goes through Tor rather than public relays.",
                      es: 'Envía la negociación por Tor, dentro de tu navegador, a relays que funcionan como servicios onion, así que ningún relay de Nostr ve tu dirección IP. Tu PIN sale más largo, y esa longitud es lo que indica a la página del receptor que busque en los mismos relays: no tiene que activar nada, ni siquiera saber que esto existe. Arranca mucho más despacio y es menos fiable. No anonimiza una transferencia directa del archivo: sigue siendo una conexión WebRTC, así que el receptor y los servicios STUN ven los mismos metadatos de red de siempre. Si no se puede establecer una conexión directa, el archivo pasa por Tor en lugar de por relays públicos.',
                    })}
                  </p>
                </div>
                <Switch
                  id="send-anonymous-signaling"
                  checked={anonymousSignaling}
                  onCheckedChange={setAnonymousSignaling}
                  className="mt-0.5"
                />
              </div>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <label
                    htmlFor="send-anonymous-relay"
                    className="flex items-center gap-2 text-sm font-medium cursor-pointer"
                  >
                    {t({
                      en: 'Anonymous signaling and relay',
                      es: 'Señalización y relay anónimos',
                    })}
                    <span className="rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                      {t({ en: 'Experimental', es: 'Experimental' })}
                    </span>
                  </label>
                  <p className="text-xs text-muted-foreground">
                    {t({
                      en: "Keeps the fallback off the clearnet. Your code is carried by hand either way, so the exchange itself is unchanged — what moves is what happens when no direct connection can be made: the two pages coordinate over Nostr relays run as onion services, reached through Tor, and the file travels through a Tor onion service this tab publishes instead of public Nostr storage relays. The code says which kind it is, so the recipient's page follows it without turning anything on, and starts bootstrapping Tor the moment they take the code in — that is the slow part. There is no second address or password for you to pass on: both come out of the code you already handed over. Both devices need internet to reach Tor at all, so unlike ordinary Code Exchange this is not something two devices can do on a network with none. Expect it to be slower and to fail more often. It does not anonymize a direct connection: that is still WebRTC, so your recipient and the STUN services see the same network metadata as always.",
                      es: 'Mantiene el respaldo fuera de la red abierta. Tu código se lleva a mano en cualquier caso, así que el intercambio en sí no cambia; lo que cambia es lo que ocurre cuando no se puede establecer una conexión directa: las dos páginas se coordinan mediante relays de Nostr que funcionan como servicios onion, a los que se llega por Tor, y el archivo viaja por un servicio onion de Tor que publica esta pestaña en lugar de por relays públicos de almacenamiento de Nostr. El código indica de qué tipo es, así que la página del receptor lo sigue sin activar nada, y empieza a iniciar Tor en cuanto recibe el código: esa es la parte lenta. No hay una segunda dirección ni contraseña que tengas que pasar: ambas salen del código que ya entregaste. Ambos dispositivos necesitan internet para llegar a Tor, así que, a diferencia del Intercambio por código normal, esto no se puede hacer entre dos dispositivos en una red sin internet. Espera que sea más lento y que falle más a menudo. No anonimiza una conexión directa: sigue siendo WebRTC, así que el receptor y los servicios STUN ven los mismos metadatos de red de siempre.',
                    })}
                  </p>
                </div>
                <Switch
                  id="send-anonymous-relay"
                  checked={anonymousRelay}
                  onCheckedChange={setAnonymousRelay}
                  className="mt-0.5"
                />
              </div>
            )}
            {usesTorBridge && (
              <div className="space-y-2 rounded-md border bg-background/60 p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {t({
                      en: 'How this tab reaches Tor',
                      es: 'Cómo llega esta pestaña a Tor',
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t({
                      en: 'Every circuit starts at a Snowflake bridge. Your recipient picks this for their own device; the two choices are independent.',
                      es: 'Cada circuito empieza en un puente Snowflake. El receptor elige esto para su propio dispositivo; las dos elecciones son independientes.',
                    })}
                  </p>
                </div>
                <TorBridgeChoice
                  value={torBridge}
                  onChange={setTorBridge}
                  idPrefix="send-anonymous-bridge"
                />
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* How it works info box */}
      <div className="rounded-lg bg-gradient-to-br from-primary/5 to-accent/5 border border-primary/10 p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-primary/10 p-2">
            <Info className="h-4 w-4 text-primary" />
          </div>
          <div className="text-sm">
            <p className="font-medium mb-1">
              {t({ en: 'How it works', es: 'Cómo funciona' })}
            </p>
            <p className="text-muted-foreground">
              {transferMode === 'pin' && (
                <>
                  {t({
                    en: 'Show the recipient your PIN — as a QR code they scan, or read out — so they can connect and decrypt your files.',
                    es: 'Muestra tu PIN al receptor (como un código QR que escanea, o en voz alta) para que pueda conectarse y descifrar tus archivos.',
                  })}
                  <br />
                  {anonymousSignalingActive
                    ? anonymousSignalingHowItWorksDescription
                    : pinModeHowItWorksDescription}
                </>
              )}
              {transferMode === 'code' && (
                <>
                  {t({
                    en: 'Hand your recipient the connection code — by QR code or copy/paste — to establish the transfer session.',
                    es: 'Pasa al receptor el código de conexión (por código QR o copiando y pegando) para establecer la sesión de transferencia.',
                  })}
                  <br />
                  {anonymousRelayActive
                    ? anonymousRelayHowItWorksDescription
                    : codeModeHowItWorksDescription}
                </>
              )}
              {transferMode === 'tor' && (
                <>
                  {t({
                    en: 'Give the recipient the onion address and the one-time password this tab shows, over any trusted channel.',
                    es: 'Da al receptor la dirección onion y la contraseña de un solo uso que muestra esta pestaña, por cualquier canal de confianza.',
                  })}
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
        {transferMode === 'code' &&
          t({
            en: 'Start Code Exchange',
            es: 'Iniciar Intercambio por código',
          })}
        {transferMode === 'pin' &&
          t({ en: 'Start PIN Exchange', es: 'Iniciar Intercambio por PIN' })}
        {transferMode === 'tor' &&
          t({ en: 'Publish Onion Service', es: 'Publicar servicio onion' })}
        <ChevronRight className="ml-1 h-3 w-3" />
      </Button>
    </div>
  );
}
