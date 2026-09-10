/**
 * Shared file-transfer protocol over a bidirectional message link.
 *
 * This module is the single source of truth for moving a payload once a
 * transport is open. Every mode uses it — Code Exchange and PIN Exchange over
 * a WebRTC data channel, and the Tor onion transport over a framed onion
 * stream — so the wire protocol and every per-chunk validation live in exactly
 * one place.
 *
 * The link is duplex, and the protocol uses both directions throughout rather
 * than streaming one way and hoping: the receiver tells the sender what it has
 * stored as it stores it, the sender never runs more than a window ahead of
 * that, completion is a verdict the receiver sends back, and either side can
 * stop the other with a reason instead of leaving it to find out from a
 * timeout.
 *
 * Wire protocol (INTEROP_PROTOCOL.md §7):
 *   - The payload bytes are the source's wire encoding (see
 *     `wireEncodingFor`): a single-file source is deflated on the fly
 *     ('deflate-raw') and restored by the receiver, while a source the
 *     multi-file/folder flow already compressed travels as-is ('identity').
 *     Either way the final wire length is unknown during signaling.
 *   - Binary messages, sender to receiver only, are content chunks produced by
 *     `encryptChunk`:
 *       [2-byte chunk index (big-endian)][12-byte nonce][ciphertext][16-byte tag]
 *     The chunk index is also the AES-GCM additional authenticated data.
 *   - Text messages are control messages, one JSON object each with its type
 *     in `t`:
 *       ack   {chunks}         receiver: this many chunks are stored
 *       end   {chunks, bytes}  sender: the payload is complete
 *       done  {chunks, bytes}  receiver: verified and stored, echoing `end`
 *       abort {reason}         either side: stopping, and why
 *   - The sender keeps at most `TRANSFER_WINDOW_CHUNKS` chunks sent beyond
 *     the receiver's last `ack`, and the receiver enforces it.
 *
 * Neither side materializes the whole file: the sender coalesces a lazy
 * `TransferSource` into `ENCRYPTION_CHUNK_SIZE` pieces, and the receiver
 * appends each decrypted (and, for 'deflate-raw', inflated) chunk to scratch
 * storage in the link's reliable order, finalizing from the `end` byte count.
 *
 * The link must be reliable and ordered: every payload appends in arrival
 * order and only the final chunk may be short, so a transport that reorders
 * or drops messages breaks the transfer rather than degrading it. Text the
 * transfer does not recognize is left to whatever else shares the link.
 */

import {
  AES_NONCE_LENGTH,
  AES_TAG_LENGTH,
  decryptChunk,
  ENCRYPTION_CHUNK_SIZE,
  encryptChunk,
  MAX_MESSAGE_SIZE,
  parseChunkMessage,
} from '@/lib/crypto';
import type { ChannelEndReason, ChannelMessage } from '@/lib/duplex-channel';
import { P2PConnectionError } from '@/lib/errors';
import { type AppendSink, createInflatingAppendSink } from '@/lib/scratch-sink';
import {
  type TransferSource,
  type WireEncoding,
  wireEncodingFor,
} from '@/lib/transfer-source';

/**
 * A reliable, ordered, bidirectional message link: a WebRTC `DuplexChannel`,
 * or a framed Tor stream (`createTorLink`).
 */
export interface TransferLink {
  /**
   * Send one binary message. Resolves once the link has room for more, which
   * is the local half of the backpressure; the window is the other half.
   */
  sendBinary: (data: Uint8Array) => Promise<void>;
  /** Send one text message, in order with every other send. */
  sendText: (text: string) => Promise<void>;
  /**
   * Send one text message at once, ahead of anything queued, where the link
   * can; see `DuplexChannel.sendNow`. Used only for `abort`.
   */
  sendNow?: (text: string) => boolean;
  /** Hand every incoming message to `listener` until unsubscribed. */
  subscribe: (listener: (message: ChannelMessage) => void) => () => void;
  /** Call `listener` once when the link closes or fails. */
  onEnd: (listener: (reason: ChannelEndReason) => void) => () => void;
}

/**
 * Chunks the sender may have sent beyond the receiver's last `ack` — 4 MiB at
 * the 128 KiB chunk size. It bounds what a receiver ever holds unwritten, and
 * it is wide enough that a link's round trip, not the window, sets the pace.
 */
export const TRANSFER_WINDOW_CHUNKS = 32;

/**
 * Idle/stall timeout for an in-flight transfer. This is a per-activity window,
 * not an overall deadline, and each side measures the other's activity: the
 * sender fails when the receiver acknowledges nothing for this long while
 * something is outstanding, and the receiver when no message arrives. So an
 * arbitrarily large but steadily-progressing transfer never trips it, while a
 * peer that goes quiet aborts after this span instead of hanging.
 */
export const STALL_TIMEOUT_MS = 60000;

/** The abort reason for a side that was cancelled by its user. */
export const CANCELLED_REASON = 'cancelled';

/** Longest abort reason taken from the peer; anything past it is cut. */
const MAX_REASON_LENGTH = 200;

/**
 * How long a side that is giving up waits for its `abort` to leave before it
 * lets the caller tear the link down. Telling the peer is a courtesy; it must
 * not hold a failure hostage to a link that has stopped moving.
 */
const ABORT_SEND_GRACE_MS = 1000;

/**
 * The chunk index is a 2-byte big-endian field on the wire, so a transfer can
 * span at most 65536 chunks (indices 0-65535). Totals beyond this cannot be
 * represented and are rejected before any allocation or processing.
 */
const MAX_CHUNKS = 0x10000; // 65536

/** One control message, as it travels in a text message. */
export type ControlMessage =
  | { t: 'ack'; chunks: number }
  | { t: 'end'; chunks: number; bytes: number }
  | { t: 'done'; chunks: number; bytes: number }
  | { t: 'abort'; reason: string };

export function encodeControl(message: ControlMessage): string {
  return JSON.stringify(message);
}

/** A control message the peer sent that breaks the protocol. */
class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function readCount(value: unknown, max: number, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  ) {
    throw new ProtocolError(`Invalid ${field} in a transfer control message`);
  }
  return value;
}

/**
 * Read a text message as a control message. Returns null for text that is not
 * one — not a JSON object, or a type the transfer does not define — which is
 * left to whatever else shares the link. Throws when a transfer message's
 * fields are malformed.
 */
export function parseControl(text: string): ControlMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const m = value as Record<string, unknown>;
  switch (m.t) {
    case 'ack':
      return { t: 'ack', chunks: readCount(m.chunks, MAX_CHUNKS, 'chunks') };
    case 'end':
    case 'done':
      return {
        t: m.t,
        chunks: readCount(m.chunks, MAX_CHUNKS, 'chunks'),
        bytes: readCount(m.bytes, MAX_MESSAGE_SIZE, 'bytes'),
      };
    case 'abort':
      return {
        t: 'abort',
        reason:
          typeof m.reason === 'string'
            ? m.reason.slice(0, MAX_REASON_LENGTH)
            : '',
      };
    default:
      return null;
  }
}

/** The peer stopped the transfer, and said why. */
export class TransferAbortedError extends Error {
  readonly by: 'sender' | 'receiver';
  readonly reason: string;

  constructor(by: 'sender' | 'receiver', reason: string) {
    super(
      reason === CANCELLED_REASON
        ? `The ${by} cancelled the transfer`
        : `The ${by} stopped the transfer${reason ? `: ${reason}` : ''}`,
    );
    this.name = 'TransferAbortedError';
    this.by = by;
    this.reason = reason;
  }
}

/**
 * Coerce a caller-supplied stall timeout to a safe value. A zero, negative,
 * NaN or non-finite window would arm a watchdog that fires immediately (or
 * never), so fall back to the default in those cases.
 */
function resolveStallTimeoutMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : STALL_TIMEOUT_MS;
}

/**
 * Coerce a caller-supplied wire ceiling. A transport may lower the protocol
 * limit but never raise it, and an unusable value falls back to the protocol
 * limit rather than removing the bound.
 */
function resolveMaxWireBytes(value: number | undefined): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value < MAX_MESSAGE_SIZE
    ? value
    : MAX_MESSAGE_SIZE;
}

/** Minimum spacing between intermediate onProgress emissions. */
const PROGRESS_MIN_INTERVAL_MS = 100;

/**
 * Pace an onProgress callback: intermediate updates are capped to one per
 * interval, and the final update (current === total) always fires. Raw
 * chunk-rate emissions (hundreds per second on a fast link) each restart the
 * progress bar's CSS transition, which flickers on iOS Safari and wastes
 * main-thread time on re-renders.
 */
function paceProgress(
  onProgress: ((current: number, total: number) => void) | undefined,
): (current: number, total: number) => void {
  if (!onProgress) return () => {};
  let lastEmit = -Infinity;
  return (current, total) => {
    const now = performance.now();
    if (current !== total && now - lastEmit < PROGRESS_MIN_INTERVAL_MS) return;
    lastEmit = now;
    onProgress(current, total);
  };
}

/**
 * Tell the peer this side is stopping, without letting a stuck link hold the
 * failure up. Best effort: the peer's own watchdog covers a lost `abort`.
 */
async function sendAbort(link: TransferLink, reason: string): Promise<void> {
  const message = encodeControl({
    t: 'abort',
    reason: reason.slice(0, MAX_REASON_LENGTH),
  });
  // Nothing sent after an abort matters, so it need not wait its turn behind
  // chunks stuck on backpressure.
  if (link.sendNow?.(message)) return;
  const sent = link.sendText(message).catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ABORT_SEND_GRACE_MS);
  });
  await Promise.race([sent, grace]);
  clearTimeout(timer);
}

/**
 * Tell the peer this side's user cancelled, before whoever holds the link
 * tears it down. Best effort, and immediate where the link allows it: the
 * caller is about to close the transport, and a peer told why stops at once
 * with that reason instead of reporting a dropped connection. Returns whether
 * the message went out at once.
 */
export function cancelOverLink(link: TransferLink): boolean {
  const message = encodeControl({ t: 'abort', reason: CANCELLED_REASON });
  if (link.sendNow) return link.sendNow(message);
  void link.sendText(message).catch(() => undefined);
  return false;
}

/** What this side tells the peer when `error` ends the transfer here. */
function abortReasonFor(error: unknown): string {
  if (error instanceof Error) {
    return error.message === 'Cancelled' ? CANCELLED_REASON : error.message;
  }
  return 'The transfer failed';
}

export interface SendOptions {
  /**
   * Called with the wire bytes the receiver has confirmed storing, and the
   * total. Driven by the receiver's `ack`s, so it shows what arrived rather
   * than what left this side's buffer.
   */
  onProgress?: (current: number, total: number) => void;
  /**
   * Ceiling on the wire bytes this transport allows, defaulting to
   * MAX_MESSAGE_SIZE. It is the transport's ceiling, not the selection's: the
   * source was already checked against its input size, but a deflated payload
   * or a generated ZIP only reveals its wire length as it is produced. The Tor
   * transport sets a far smaller one.
   */
  maxWireBytes?: number;
  /** Return true to abort the transfer; the receiver is told. */
  isCancelled?: () => boolean;
  /**
   * Idle window in ms: while anything sent is unacknowledged, the receiver
   * must acknowledge progress within this span. Defaults to STALL_TIMEOUT_MS.
   */
  stallTimeoutMs?: number;
  /** Flow-control window in chunks. Defaults to TRANSFER_WINDOW_CHUNKS. */
  windowChunks?: number;
}

/**
 * Read a lazy payload in its wire encoding, coalesce it into
 * `ENCRYPTION_CHUNK_SIZE` chunks, and encrypt and send each within the
 * window the receiver's acknowledgments open. Resolves with the wire byte
 * count once the receiver has verified and stored the whole payload.
 */
export async function sendFileOverLink(
  link: TransferLink,
  key: CryptoKey,
  source: TransferSource,
  opts: SendOptions = {},
): Promise<number> {
  const { isCancelled } = opts;
  const reportProgress = paceProgress(opts.onProgress);
  const stallTimeoutMs = resolveStallTimeoutMs(opts.stallTimeoutMs);
  const maxWireBytes = resolveMaxWireBytes(opts.maxWireBytes);
  const windowChunks =
    opts.windowChunks !== undefined &&
    Number.isSafeInteger(opts.windowChunks) &&
    opts.windowChunks > 0
      ? opts.windowChunks
      : TRANSFER_WINDOW_CHUNKS;
  const progressTotal = source.size ?? source.estimatedSize;
  const encoding = wireEncodingFor(source);

  /** Chunks handed to the link. */
  let sent = 0;
  /** Chunks the receiver reports stored. */
  let acked = 0;
  /** Wire bytes handed to the link. */
  let totalBytes = 0;
  /** Whether `end` has gone to the link. */
  let ended = false;
  /** Whether the receiver's `done` has arrived. */
  let finished = false;

  // Everything that ends the transfer early lands here, once. Every wait
  // below races it.
  let failure: Error | null = null;
  /** Whether the link or the peer ended it, so there is nobody to tell. */
  let peerGone = false;
  let rejectFailed!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectFailed = reject;
  });
  failed.catch(() => undefined);
  // Wakes whatever is waiting for the receiver to move.
  let signalProgress: () => void = () => {};

  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStall = () => {
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = null;
  };
  const outstanding = () => sent - acked > 0 || (ended && !finished);
  // (Re)start the idle window while the receiver owes this side something,
  // and stop it when it owes nothing.
  const armStall = () => {
    clearStall();
    if (failure || !outstanding()) return;
    stallTimer = setTimeout(() => {
      fail(
        new P2PConnectionError(
          `Transfer stalled: the receiver acknowledged nothing for ${Math.round(stallTimeoutMs / 1000)}s`,
        ),
      );
    }, stallTimeoutMs);
  };

  const fail = (error: Error, byPeer = false) => {
    if (failure || finished) return;
    failure = error;
    peerGone = byPeer;
    clearStall();
    rejectFailed(error);
  };

  const ackedBytes = () =>
    // Only the final chunk may be short, so every acknowledged chunk short of
    // the last one sent is a full one.
    Math.min(acked * ENCRYPTION_CHUNK_SIZE, totalBytes);

  const unsubscribe = link.subscribe((message) => {
    // Content only ever flows the other way.
    if (typeof message !== 'string' || failure || finished) return;
    let control: ControlMessage | null;
    try {
      control = parseControl(message);
    } catch (error) {
      fail(
        error instanceof Error ? error : new Error('Invalid control message'),
      );
      return;
    }
    if (!control) return;
    switch (control.t) {
      case 'ack':
        if (control.chunks > sent) {
          fail(
            new ProtocolError('The receiver acknowledged chunks never sent'),
          );
        } else if (control.chunks > acked) {
          acked = control.chunks;
          armStall();
          reportProgress(ackedBytes(), progressTotal);
          signalProgress();
        }
        break;
      case 'done':
        if (!ended) {
          fail(
            new ProtocolError(
              'The receiver reported completion before the transfer ended',
            ),
          );
        } else if (control.chunks !== sent || control.bytes !== totalBytes) {
          fail(
            new ProtocolError(
              'The receiver verified a different payload than was sent',
            ),
          );
        } else {
          finished = true;
          acked = sent;
          clearStall();
          signalProgress();
        }
        break;
      case 'abort':
        fail(new TransferAbortedError('receiver', control.reason), true);
        break;
      // `end` is this side's to send; a receiver has no use for it.
    }
  });
  const unwatchEnd = link.onEnd((reason) => {
    fail(
      new P2PConnectionError(
        reason === 'error'
          ? 'The connection failed before the receiver confirmed the file'
          : 'The connection closed before the receiver confirmed the file',
      ),
      true,
    );
  });
  // Waits on the window and on `done` notice a cancel without a chunk to
  // check it at.
  const cancelPoll = setInterval(() => {
    if (isCancelled?.()) fail(new Error('Cancelled'));
  }, 250);

  /** Wait until `ready()` holds, or the transfer fails. */
  const waitUntil = async (ready: () => boolean) => {
    while (!ready()) {
      if (failure) throw failure;
      await Promise.race([
        new Promise<void>((resolve) => {
          signalProgress = resolve;
        }),
        failed,
      ]);
    }
    if (failure) throw failure;
  };

  const reader = (
    encoding === 'deflate-raw'
      ? source.stream().pipeThrough(
          // lib.dom types the deflater's writable as BufferSource, which the
          // invariant pipeThrough signature rejects even though every chunk
          // (a Uint8Array) is one.
          new CompressionStream(
            'deflate-raw',
          ) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
        )
      : source.stream()
  ).getReader();
  const plainChunk = new Uint8Array(ENCRYPTION_CHUNK_SIZE);
  let plainChunkLength = 0;

  const sendChunk = async (chunk: Uint8Array) => {
    if (isCancelled?.()) throw new Error('Cancelled');
    if (sent >= MAX_CHUNKS) {
      throw new Error('File too large for the transfer chunk-index range');
    }
    if (totalBytes + chunk.length > maxWireBytes) {
      throw new Error('Generated payload exceeds the transfer size limit');
    }
    // Flow control: never more than the window ahead of what the receiver
    // has stored.
    await waitUntil(() => sent - acked < windowChunks);

    const encryptedChunk = await encryptChunk(key, chunk, sent);
    if (failure) throw failure;
    const handedOff = link.sendBinary(encryptedChunk);
    // Counted as sent from the moment the link has it, so an `ack` for it
    // can never look like one for a chunk that was not sent.
    const wasIdle = !outstanding();
    sent++;
    totalBytes += chunk.length;
    if (wasIdle) armStall();
    await Promise.race([handedOff, failed]);
  };

  let completed = false;
  try {
    while (true) {
      if (isCancelled?.()) throw new Error('Cancelled');
      if (failure) throw failure;
      // A source can take its time — a ZIP entry being compressed — and a
      // receiver that gives up meanwhile must not wait on it.
      const { done, value } = await Promise.race([reader.read(), failed]);
      if (done) break;

      let offset = 0;
      while (offset < value.length) {
        const copied = Math.min(
          ENCRYPTION_CHUNK_SIZE - plainChunkLength,
          value.length - offset,
        );
        plainChunk.set(
          value.subarray(offset, offset + copied),
          plainChunkLength,
        );
        plainChunkLength += copied;
        offset += copied;
        if (plainChunkLength === ENCRYPTION_CHUNK_SIZE) {
          await sendChunk(plainChunk);
          plainChunkLength = 0;
        }
      }
    }

    if (plainChunkLength > 0) {
      await sendChunk(plainChunk.slice(0, plainChunkLength));
    }
    // A deflated wire stream has no size to check against; the source's own
    // length only binds when the bytes travel as-is.
    if (
      encoding === 'identity' &&
      source.size !== null &&
      totalBytes !== source.size
    ) {
      throw new Error(
        `Transfer source size changed: expected ${source.size} bytes, got ${totalBytes}`,
      );
    }
    completed = true;
    reader.releaseLock();

    // The counts authenticate the final wire length, which was not known
    // during signaling. From here the receiver owes a verdict, and the idle
    // window covers it like any acknowledgment.
    ended = true;
    armStall();
    await Promise.race([
      link.sendText(
        encodeControl({ t: 'end', chunks: sent, bytes: totalBytes }),
      ),
      failed,
    ]);
    await waitUntil(() => finished);
    reportProgress(totalBytes, totalBytes);
    return totalBytes;
  } catch (error) {
    if (!completed) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    // The peer is told, unless it is the one that ended things.
    if (!peerGone) await sendAbort(link, abortReasonFor(failure ?? error));
    throw failure ?? error;
  } finally {
    clearStall();
    clearInterval(cancelPoll);
    unsubscribe();
    unwatchEnd();
  }
}

export interface ReceiverOptions {
  /** Called after each chunk with cumulative decrypted wire bytes and the total. */
  onProgress?: (current: number, total: number) => void;
  /** Progress hint; the payload's final wire size is never known up front. */
  estimatedBytes?: number;
  /**
   * Ceiling on both the wire bytes accepted and the inflated output,
   * defaulting to MAX_MESSAGE_SIZE. The inflated bound is the
   * decompression-bomb guard: the in-band `end` byte count only covers the
   * compressed wire bytes.
   */
  maxWireBytes?: number;
  /**
   * Idle window in ms: once attached, the transfer aborts if no message
   * arrives within this span. Every message resets it. Defaults to
   * STALL_TIMEOUT_MS.
   */
  stallTimeoutMs?: number;
  /** Flow-control window in chunks. Defaults to TRANSFER_WINDOW_CHUNKS. */
  windowChunks?: number;
}

export interface TransferReceiver {
  /**
   * Take the link over: from now on its messages drive the transfer and this
   * side's replies go back on it, and the stall watchdog is armed. Call once
   * the link is open, before any message can arrive — from a data channel's
   * open callback.
   */
  attach: (link: TransferLink) => void;
  /**
   * Resolves with the sealed plaintext payload from the sink (disk-backed for
   * an OPFS-backed sink) once it is verified and the sender has been told, or
   * rejects on any error.
   */
  done: Promise<Blob>;
  /**
   * Abandon the transfer: stop the watchdog, make the receiver inert, and —
   * when attached and still running — tell the sender it was cancelled. Call
   * from a hook's own cancel path so nothing outlives an abandoned transfer.
   */
  dispose: () => void;
}

/**
 * Create a streaming receiver for a payload of unknown wire size. Chunks must
 * arrive in the link's reliable order and are appended to `sink` as they
 * authenticate; for a 'deflate-raw' wire encoding they are inflated in
 * between, so the sealed Blob is the original file. Each stored chunk is
 * acknowledged, and `end` supplies the final authenticated chunk count and
 * wire byte count before the sink is sealed and the sender is told `done`.
 */
export function createTransferReceiver(
  key: CryptoKey,
  encoding: WireEncoding,
  sink: AppendSink,
  opts: ReceiverOptions = {},
): TransferReceiver {
  const reportProgress = paceProgress(opts.onProgress);
  const stallTimeoutMs = resolveStallTimeoutMs(opts.stallTimeoutMs);
  const maxWireBytes = resolveMaxWireBytes(opts.maxWireBytes);
  const windowChunks =
    opts.windowChunks !== undefined &&
    Number.isSafeInteger(opts.windowChunks) &&
    opts.windowChunks > 0
      ? opts.windowChunks
      : TRANSFER_WINDOW_CHUNKS;
  const progressTotal = opts.estimatedBytes ?? 0;
  // The size cap on the inflated output is the decompression-bomb guard: the
  // in-band `end` byte count only covers the compressed wire bytes.
  const target =
    encoding === 'deflate-raw'
      ? createInflatingAppendSink(sink, maxWireBytes)
      : sink;

  let link: TransferLink | null = null;
  const detach: (() => void)[] = [];
  const pending = new Set<Promise<void>>();
  let receivedChunks = 0;
  /** Chunks stored and acknowledged; the sender's window is measured from it. */
  let storedChunks = 0;
  let claimedWireBytes = 0;
  let totalDecryptedBytes = 0;
  let previousChunkLength: number | null = null;
  let ended = false;
  let appendChain = Promise.resolve();
  let settled = false;

  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStallTimer = () => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  let resolveDone!: (value: Blob) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<Blob>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const release = () => {
    clearStallTimer();
    for (const stop of detach.splice(0)) stop();
  };

  /**
   * End the transfer here. The sender is told why, unless it is the one that
   * ended it or the link is already gone.
   */
  const fail = (error: Error, tellSender = true) => {
    if (settled) return;
    settled = true;
    release();
    if (tellSender && link) {
      void sendAbort(link, abortReasonFor(error)).finally(() =>
        rejectDone(error),
      );
    } else {
      rejectDone(error);
    }
  };

  // Arm (or reset) the idle watchdog: no message within the window aborts the
  // transfer. `attach()` and every incoming message call this.
  const armStallTimer = () => {
    if (settled) return;
    clearStallTimer();
    stallTimer = setTimeout(() => {
      fail(
        new P2PConnectionError(
          `Transfer stalled: no data received within ${Math.round(stallTimeoutMs / 1000)}s`,
        ),
      );
    }, stallTimeoutMs);
  };

  const sendControl = (message: ControlMessage) =>
    link?.sendText(encodeControl(message)) ?? Promise.resolve();

  const handleChunk = (data: ArrayBuffer) => {
    let chunkIndex: number;
    let encryptedData: Uint8Array;
    let expectedPlaintextLength: number;

    try {
      if (ended) throw new ProtocolError('Content arrived after the end');
      ({ chunkIndex, encryptedData } = parseChunkMessage(data));
      // The link is reliable and ordered. Requiring that order lets the
      // receiver append without holding or seeking chunks, and rejects
      // duplicates in the same stroke.
      if (chunkIndex !== receivedChunks || chunkIndex >= MAX_CHUNKS) {
        throw new Error(`Unexpected streamed chunk index: ${chunkIndex}`);
      }
      // The sender may only run a window ahead of what this side has
      // acknowledged; one that does not is not respecting the bound on what
      // this side holds unwritten.
      if (chunkIndex >= storedChunks + windowChunks) {
        throw new ProtocolError('The sender overran the flow-control window');
      }
      expectedPlaintextLength =
        encryptedData.length - AES_NONCE_LENGTH - AES_TAG_LENGTH;
      if (
        expectedPlaintextLength <= 0 ||
        expectedPlaintextLength > ENCRYPTION_CHUNK_SIZE
      ) {
        throw new Error(`Invalid streamed chunk ${chunkIndex} length`);
      }
      if (
        previousChunkLength !== null &&
        previousChunkLength !== ENCRYPTION_CHUNK_SIZE
      ) {
        throw new Error('Only the final streamed chunk may be short');
      }
      if (claimedWireBytes + expectedPlaintextLength > maxWireBytes) {
        throw new Error('Transfer exceeds the supported size limit');
      }
      previousChunkLength = expectedPlaintextLength;
      claimedWireBytes += expectedPlaintextLength;

      // Claim the index before decrypting so an in-order `end` cannot race
      // the asynchronous crypto operation.
      receivedChunks++;
    } catch (error) {
      fail(error instanceof Error ? error : new Error('Invalid data chunk'));
      return;
    }

    const processChunk = async () => {
      let decryptedChunk: Uint8Array;
      try {
        decryptedChunk = await decryptChunk(key, encryptedData, chunkIndex);
      } catch {
        throw new Error(`Chunk ${chunkIndex} failed authentication`);
      }
      if (settled) return;
      if (decryptedChunk.length !== expectedPlaintextLength) {
        throw new Error(
          `Invalid chunk ${chunkIndex} length: expected ${expectedPlaintextLength}, got ${decryptedChunk.length}`,
        );
      }

      await target.append(decryptedChunk);
      if (settled) return;
      totalDecryptedBytes += decryptedChunk.length;
      storedChunks = chunkIndex + 1;
      // Stored: the sender may move its window on.
      void sendControl({ t: 'ack', chunks: storedChunks }).catch(() => {
        // A link that can no longer carry an ack reports itself through
        // onEnd; nothing more to do here.
      });

      reportProgress(totalDecryptedBytes, progressTotal);
    };

    // Appends must follow wire order even if Web Crypto resolves operations
    // at different times.
    appendChain = appendChain.then(processChunk);
    const promise = appendChain.catch((error: unknown) => {
      fail(
        error instanceof Error ? error : new Error('Failed to receive chunk'),
      );
    });

    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  };

  const handleEnd = async (count: number, finalBytes: number) => {
    ended = true;
    if (count !== receivedChunks) {
      fail(
        new Error(
          `Invalid end message: received ${receivedChunks} chunks, got ${count}`,
        ),
      );
      return;
    }
    if (finalBytes !== claimedWireBytes) {
      fail(new Error('Invalid end message: final size does not match chunks'));
      return;
    }

    if (pending.size > 0) {
      await Promise.allSettled(Array.from(pending));
    }
    if (settled) return;

    if (receivedChunks !== count || totalDecryptedBytes !== finalBytes) {
      fail(
        new Error(
          `Incomplete transfer: got ${totalDecryptedBytes} bytes, expected ${finalBytes}`,
        ),
      );
      return;
    }

    let payload: Blob;
    try {
      payload = await target.finish();
    } catch (error) {
      fail(
        error instanceof Error
          ? error
          : new Error('Failed to finalize received file'),
      );
      return;
    }
    // A stall timeout or dispose() during the flush already settled `done`.
    if (settled) return;

    settled = true;
    release();
    reportProgress(finalBytes, finalBytes);
    // The verdict the sender is waiting on. The file is whole either way, so a
    // `done` that cannot be sent is the sender's failure to report, not a
    // reason to discard what arrived.
    try {
      await sendControl({ t: 'done', chunks: count, bytes: finalBytes });
    } catch (error) {
      console.error('Failed to send the transfer verdict:', error);
    }
    resolveDone(payload);
  };

  const onMessage = (data: ChannelMessage) => {
    if (settled) return;

    // Any message is activity; reset the idle watchdog before dispatching.
    armStallTimer();

    if (typeof data !== 'string') {
      handleChunk(data);
      return;
    }
    let control: ControlMessage | null;
    try {
      control = parseControl(data);
    } catch (error) {
      fail(
        error instanceof Error ? error : new Error('Invalid control message'),
      );
      return;
    }
    if (!control) return;
    switch (control.t) {
      case 'end':
        if (ended) {
          fail(new ProtocolError('The sender ended the transfer twice'));
          return;
        }
        if (control.bytes > maxWireBytes) {
          fail(new Error('Invalid end message values'));
          return;
        }
        void handleEnd(control.chunks, control.bytes);
        break;
      case 'abort':
        fail(new TransferAbortedError('sender', control.reason), false);
        break;
      // `ack` and `done` are this side's to send.
    }
  };

  const attach = (attached: TransferLink) => {
    if (link || settled) return;
    link = attached;
    detach.push(attached.subscribe(onMessage));
    detach.push(
      attached.onEnd((reason) =>
        fail(
          new P2PConnectionError(
            reason === 'error'
              ? 'The connection failed before the transfer completed'
              : 'The connection closed before the transfer completed',
          ),
          false,
        ),
      ),
    );
    armStallTimer();
  };

  const dispose = () => {
    // A receiver still running is being abandoned by its user, and the sender
    // should hear so rather than stall out.
    if (!settled) fail(new Error('Cancelled'));
    settled = true;
    release();
  };
  // dispose() on a running receiver rejects `done`; a caller that stopped
  // listening must not see that as an unhandled rejection.
  done.catch(() => undefined);

  return { attach, done, dispose };
}
