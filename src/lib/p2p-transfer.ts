/**
 * Shared file-transfer protocol over a message link.
 *
 * This module is the single source of truth for moving a payload once a
 * transport is open. Every mode uses it — Code Exchange and PIN Exchange over
 * a WebRTC data channel, and the Tor onion transport over a framed onion
 * stream — so the wire protocol and every per-chunk validation live in exactly
 * one place.
 *
 * The protocol is one-way. Everything on the wire goes from the sender to the
 * receiver, and the receiver sends nothing back. The sender is complete once
 * the last of its bytes has left the transport, and the receiver verifies what
 * arrived on its own: every chunk authenticates individually, and the sender's
 * closing `end` says how much there was to arrive. Whether the file reached the
 * other person is for the two of them to confirm outside the program.
 *
 * Wire protocol (INTEROP_PROTOCOL.md §7):
 *   - The payload bytes are the source's wire encoding (see
 *     `wireEncodingFor`): a single-file source is deflated on the fly
 *     ('deflate-raw') and restored by the receiver, while a source the
 *     multi-file/folder flow already compressed travels as-is ('identity').
 *     Either way the final wire length is unknown during signaling.
 *   - Binary messages are content chunks produced by `encryptChunk`:
 *       [2-byte chunk index (big-endian)][12-byte nonce][ciphertext][16-byte tag]
 *     The chunk index is also the AES-GCM additional authenticated data.
 *   - Text messages are control messages, one JSON object each with its type
 *     in `t`:
 *       end   {chunks, bytes}  the payload is complete
 *       abort {reason}         the sender is stopping, and why
 *   - The receiver closes the transport once it has the file, or when it
 *     gives up. A transport that closes before `end` is a failed transfer;
 *     once `end` has checked out, what the receiver still holds is stored
 *     whatever the transport does next.
 *
 * Neither side materializes the whole file: the sender coalesces a lazy
 * `TransferSource` into `ENCRYPTION_CHUNK_SIZE` pieces, and the receiver
 * appends each decrypted (and, for 'deflate-raw', inflated) chunk to scratch
 * storage in the link's reliable order, finalizing from the `end` byte count.
 * The sender is paced by the transport's backpressure alone, so what the
 * receiver has taken off the link but not yet written waits in memory — up to
 * `RECEIVE_BACKLOG_MAX_BYTES`, past which the receiver gives up.
 *
 * The link must be reliable and ordered: every payload appends in arrival
 * order and only the final chunk may be short, so a transport that reorders
 * or drops messages breaks the transfer rather than degrading it. Text the
 * transfer does not recognize is left to whatever else shares the link.
 */

import { type AppendSink, createInflatingAppendSink } from '@/lib/append-sink';
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
import { P2PConnectionError, SourceError } from '@/lib/errors';
import {
  type TransferSource,
  type WireEncoding,
  wireEncodingFor,
} from '@/lib/transfer-source';

/**
 * A reliable, ordered message link: a WebRTC `DuplexChannel`, or a framed Tor
 * stream (`createTorLink`). The transfer sends on it from one side and
 * listens on it from the other.
 */
export interface TransferLink {
  /**
   * Send one binary message. Resolves once the link has room for more, which
   * is the backpressure that paces the sender.
   */
  sendBinary: (data: Uint8Array) => Promise<void>;
  /** Send one text message, in order with every other send. */
  sendText: (text: string) => Promise<void>;
  /**
   * Send one text message at once, ahead of anything queued, where the link
   * can; see `DuplexChannel.sendNow`. Used only for `abort`.
   */
  sendNow?: (text: string) => boolean;
  /**
   * Resolve once everything handed to the link has left its send buffer, so
   * the caller may let the transport go without cutting off the tail. Rejects
   * if the link ends with something still unsent.
   */
  flush: () => Promise<void>;
  /** Hand every incoming message to `listener` until unsubscribed. */
  subscribe: (listener: (message: ChannelMessage) => void) => () => void;
  /** Call `listener` once when the link closes or fails. */
  onEnd: (listener: (reason: ChannelEndReason) => void) => () => void;
}

/**
 * Idle/stall timeout for an in-flight transfer. This is a per-activity window,
 * not an overall deadline, and each side measures the other's activity: the
 * sender fails when the transport will not take a chunk, or will not drain
 * after `end`, for this long — a receiver that stopped reading — and the
 * receiver when no message arrives before `end` does. So an arbitrarily large
 * but steadily-progressing transfer never trips it, while a peer that goes
 * quiet aborts after this span instead of hanging.
 */
export const STALL_TIMEOUT_MS = 60000;

/**
 * Ceiling on what a receiver holds between taking a chunk off the link and
 * finishing its write. The sender is paced by the transport alone, so a
 * receiver whose storage is slower than the link accumulates the difference
 * in memory, and a browser cannot refuse a data channel message: past this
 * much the receiver gives up, a clean failure where holding on would be a
 * crashed tab.
 */
export const RECEIVE_BACKLOG_MAX_BYTES = 256 * 1024 * 1024;

/** The abort reason a sender gives when its user cancelled. */
export const CANCELLED_REASON = 'cancelled';

/** Longest abort reason taken from the sender; anything past it is cut. */
const MAX_REASON_LENGTH = 200;

/**
 * How long a sender that is giving up waits for its `abort` to leave before it
 * lets the caller tear the link down. Telling the receiver is a courtesy; it
 * must not hold a failure hostage to a link that has stopped moving.
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
  | { t: 'end'; chunks: number; bytes: number }
  | { t: 'abort'; reason: string };

export function encodeControl(message: ControlMessage): string {
  return JSON.stringify(message);
}

/** A control message the sender sent that breaks the protocol. */
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
    case 'end':
      return {
        t: 'end',
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

/** The sender stopped the transfer, and said why. */
export class TransferAbortedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(
      reason === CANCELLED_REASON
        ? 'The sender cancelled the transfer'
        : `The sender stopped the transfer${reason ? `: ${reason}` : ''}`,
    );
    this.name = 'TransferAbortedError';
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
 * Tell the receiver this side is stopping, without letting a stuck link hold
 * the failure up. Best effort: the receiver's own watchdog covers a lost
 * `abort`.
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
 * Tell the receiver this side's user cancelled, before whoever holds the link
 * tears it down. Best effort, and immediate where the link allows it: the
 * caller is about to close the transport, and a receiver told why stops at
 * once with that reason instead of reporting a dropped connection. Returns
 * whether the message went out at once.
 *
 * For a sender only. A receiver that cancels just closes the link; nothing it
 * could say travels the other way.
 */
export function cancelOverLink(link: TransferLink): boolean {
  const message = encodeControl({ t: 'abort', reason: CANCELLED_REASON });
  if (link.sendNow) return link.sendNow(message);
  void link.sendText(message).catch(() => undefined);
  return false;
}

/** What this side tells the receiver when `error` ends the transfer here. */
function abortReasonFor(error: unknown): string {
  // Its message may name the sender's local paths.
  if (error instanceof SourceError) return error.peerReason;
  if (error instanceof Error) {
    return error.message === 'Cancelled' ? CANCELLED_REASON : error.message;
  }
  return 'The transfer failed';
}

export interface SendOptions {
  /**
   * Called with the wire bytes handed to the transport, and the total. The
   * transport's backpressure is what admits them, so this tracks what the
   * link has accepted, not what this side has produced.
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
   * Idle window in ms: the transport must take each chunk, and drain after
   * `end`, within this span. Defaults to STALL_TIMEOUT_MS.
   */
  stallTimeoutMs?: number;
}

/**
 * Read a lazy payload in its wire encoding, coalesce it into
 * `ENCRYPTION_CHUNK_SIZE` chunks, and encrypt and send each as the transport
 * takes it. Resolves with the wire byte count once `end` has followed the
 * last chunk and all of it has left this side's send buffer.
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
  const progressTotal = source.size ?? source.estimatedSize;
  const encoding = wireEncodingFor(source);

  /** Chunks handed to the link. */
  let sent = 0;
  /** Wire bytes handed to the link. */
  let totalBytes = 0;
  /** Whether `end` is out and the send buffer is being drained. */
  let flushing = false;

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

  const fail = (error: Error, byPeer = false) => {
    if (failure) return;
    failure = error;
    peerGone = byPeer;
    rejectFailed(error);
  };

  // Every wait on the link is bounded by the idle window: a link that will
  // not take the next chunk, or will not drain, is a receiver that stopped
  // reading.
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const awaitLink = async <T>(pending: Promise<T>, stalled: string) => {
    stallTimer = setTimeout(() => {
      fail(
        new P2PConnectionError(
          `Transfer stalled: ${stalled} for ${Math.round(stallTimeoutMs / 1000)}s`,
        ),
      );
    }, stallTimeoutMs);
    try {
      return await Promise.race([pending, failed]);
    } finally {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };
  const STALLED_TAKING = 'the receiver stopped taking data';

  const unwatchEnd = link.onEnd((reason) => {
    // Once `end` is out, the flush decides: a receiver hangs up as soon as it
    // has the file, which can be before this side has noticed its buffer
    // empty, and only a close that strands unsent bytes is a failure.
    if (flushing) return;
    fail(
      new P2PConnectionError(
        reason === 'error'
          ? 'The connection failed before the file was delivered'
          : 'The connection closed before the file was delivered',
      ),
      true,
    );
  });
  // A wait on the link notices a cancel without a chunk to check it at.
  const cancelPoll = setInterval(() => {
    if (isCancelled?.()) fail(new Error('Cancelled'));
  }, 250);

  const openReader = () =>
    (encoding === 'deflate-raw'
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
  // Opened inside the cleanup scope below: a source that fails to open still
  // releases the link and tells the receiver.
  let openedReader: ReturnType<typeof openReader> | null = null;
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
    const encryptedChunk = await encryptChunk(key, chunk, sent);
    if (failure) throw failure;
    // Resolves once the link has room for more, which is what paces this
    // side.
    await awaitLink(link.sendBinary(encryptedChunk), STALLED_TAKING);
    sent++;
    totalBytes += chunk.length;
    reportProgress(totalBytes, progressTotal);
  };

  let completed = false;
  try {
    const reader = openReader();
    openedReader = reader;
    while (true) {
      if (isCancelled?.()) throw new Error('Cancelled');
      if (failure) throw failure;
      // A source can take its time — a ZIP entry being compressed — and a
      // link that ends meanwhile must not wait on it.
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
    // during signaling.
    await awaitLink(
      link.sendText(
        encodeControl({ t: 'end', chunks: sent, bytes: totalBytes }),
      ),
      STALLED_TAKING,
    );
    // Complete once the last message has left this side's buffer: the
    // transport delivers from there, and the receiver hangs up when it has
    // the file.
    flushing = true;
    try {
      await awaitLink(
        link.flush(),
        'the receiver stopped draining the connection',
      );
    } catch (error) {
      if (!failure) {
        fail(
          new P2PConnectionError(
            'The connection closed before the file was delivered',
          ),
          true,
        );
      }
      throw failure ?? error;
    }
    reportProgress(totalBytes, totalBytes);
    return totalBytes;
  } catch (error) {
    if (!completed && openedReader) {
      await openedReader.cancel().catch(() => {});
      openedReader.releaseLock();
    }
    // The receiver is told, unless the link is already gone.
    if (!peerGone) await sendAbort(link, abortReasonFor(failure ?? error));
    throw failure ?? error;
  } finally {
    if (stallTimer !== null) clearTimeout(stallTimer);
    clearInterval(cancelPoll);
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
   * arrives within this span. Every message resets it, and it stops once
   * `end` has checked out: storing what is in hand is this side's own work,
   * not the sender's. Defaults to STALL_TIMEOUT_MS.
   */
  stallTimeoutMs?: number;
  /**
   * Most wire bytes held between arrival and the end of their write before
   * the transfer gives up as storage that cannot keep up. Defaults to
   * RECEIVE_BACKLOG_MAX_BYTES.
   */
  maxBacklogBytes?: number;
}

export interface TransferReceiver {
  /**
   * Take the link over: from now on its messages drive the transfer, and the
   * stall watchdog is armed. Call once the link is open, before any message
   * can arrive — from a data channel's open callback.
   */
  attach: (link: TransferLink) => void;
  /**
   * Resolves with the sealed plaintext payload from the sink (disk-backed for
   * an OPFS-backed sink) once `end` has checked out against everything
   * stored, or rejects on any error. The caller then closes the link; the
   * sender hears nothing else. Once `end` has checked out, only `dispose()`
   * can still fail it: the link is let go, so the sender's hang-up or a late
   * `abort` cannot undo a file that has wholly arrived.
   */
  done: Promise<Blob>;
  /**
   * Abandon the transfer: stop the watchdog and make the receiver inert.
   * Nothing is sent — the caller closes the link, which is how the sender
   * learns. Call from a hook's own cancel path so nothing outlives an
   * abandoned transfer.
   */
  dispose: () => void;
}

/**
 * Create a streaming receiver for a payload of unknown wire size. Chunks must
 * arrive in the link's reliable order and are appended to `sink` as they
 * authenticate; for a 'deflate-raw' wire encoding they are inflated in
 * between, so the sealed Blob is the original file. `end` supplies the final
 * authenticated chunk count and wire byte count, and the sink is sealed once
 * everything before it has been stored and checks out.
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
  const maxBacklogBytes =
    typeof opts.maxBacklogBytes === 'number' &&
    Number.isFinite(opts.maxBacklogBytes) &&
    opts.maxBacklogBytes > 0
      ? opts.maxBacklogBytes
      : RECEIVE_BACKLOG_MAX_BYTES;
  const progressTotal = opts.estimatedBytes ?? 0;
  // The size cap on the inflated output is the decompression-bomb guard: the
  // in-band `end` byte count only covers the compressed wire bytes.
  const target =
    encoding === 'deflate-raw'
      ? createInflatingAppendSink(sink, maxWireBytes)
      : sink;

  let attached = false;
  const detach: (() => void)[] = [];
  const pending = new Set<Promise<void>>();
  let receivedChunks = 0;
  let claimedWireBytes = 0;
  let totalDecryptedBytes = 0;
  let previousChunkLength: number | null = null;
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

  /** End the transfer here. The sender learns when the caller closes the link. */
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    release();
    rejectDone(error);
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

  const handleChunk = (data: ArrayBuffer) => {
    let chunkIndex: number;
    let encryptedData: Uint8Array;
    let expectedPlaintextLength: number;

    try {
      ({ chunkIndex, encryptedData } = parseChunkMessage(data));
      // The link is reliable and ordered. Requiring that order lets the
      // receiver append without holding or seeking chunks, and rejects
      // duplicates in the same stroke.
      if (chunkIndex !== receivedChunks || chunkIndex >= MAX_CHUNKS) {
        throw new Error(`Unexpected streamed chunk index: ${chunkIndex}`);
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
      // What has come off the link but is not yet written is this side's
      // memory, and nothing here can slow the sender down.
      if (
        claimedWireBytes - totalDecryptedBytes + expectedPlaintextLength >
        maxBacklogBytes
      ) {
        throw new Error('Storage could not keep up with the connection');
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
      // Once the transfer has failed, what is still queued behind the write in
      // progress is dropped unread rather than decrypted for nothing.
      if (settled) return;
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
      reportProgress(totalDecryptedBytes, progressTotal);
    };

    // Appends must follow wire order even if Web Crypto resolves operations
    // at different times.
    appendChain = appendChain.then(processChunk);
    const appended = appendChain;
    const promise = (async () => {
      try {
        await appended;
      } catch (error: unknown) {
        fail(
          error instanceof Error ? error : new Error('Failed to receive chunk'),
        );
      }
    })();
    pending.add(promise);
    void (async () => {
      await promise;
      pending.delete(promise);
    })();
  };

  const handleEnd = async (count: number, finalBytes: number) => {
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
    // Everything is in hand; the rest is storing it, which the link has no
    // part in. Let the link go now, so the sender's hang-up after its linger,
    // the `abort` it sends when its user moves on, and the idle watchdog
    // cannot fail a file that has wholly arrived. Only dispose() still can.
    // Nothing after the end is read, so a stray message there is not a
    // violation to catch either.
    release();

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
        if (control.bytes > maxWireBytes) {
          fail(new Error('Invalid end message values'));
          return;
        }
        void handleEnd(control.chunks, control.bytes);
        break;
      case 'abort':
        fail(new TransferAbortedError(control.reason));
        break;
    }
  };

  const attach = (link: TransferLink) => {
    if (attached || settled) return;
    attached = true;
    detach.push(link.subscribe(onMessage));
    detach.push(
      link.onEnd((reason) =>
        fail(
          new P2PConnectionError(
            reason === 'error'
              ? 'The connection failed before the transfer completed'
              : 'The connection closed before the transfer completed',
          ),
        ),
      ),
    );
    armStallTimer();
  };

  const dispose = () => {
    if (!settled) fail(new Error('Cancelled'));
    settled = true;
    release();
  };
  // dispose() on a running receiver rejects `done`; a caller that stopped
  // listening must not see that as an unhandled rejection.
  done.catch(() => undefined);

  return { attach, done, dispose };
}
