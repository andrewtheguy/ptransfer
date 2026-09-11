import { ENCRYPTED_CHUNK_OVERHEAD, ENCRYPTION_CHUNK_SIZE } from '@/lib/crypto';
import type { OnionStream } from './webtor';

/**
 * Message framing over a Tor stream.
 *
 * A Tor stream is a byte stream, and the transfer choreography needs discrete
 * messages that keep the binary/text distinction a WebRTC data channel gives
 * for free. Each message travels as
 *
 * ```text
 * [1-byte kind][4-byte big-endian payload length][payload]
 * ```
 *
 * with kind 0 for a binary content chunk and 1 for a control string. The
 * length is capped at one full encrypted chunk, so a peer cannot make this
 * side allocate more than the transfer itself would.
 *
 * This is the framing docs/TOR_TRANSPORT.md specifies for a raw onion stream;
 * both ends of a transfer speak it byte for byte.
 */

const HEADER_LENGTH = 5;
const KIND_BINARY = 0;
const KIND_TEXT = 1;

/**
 * Largest payload one frame may carry: exactly one encrypted content chunk.
 * Handshake frames are orders of magnitude smaller.
 */
export const MAX_FRAME_BYTES = ENCRYPTION_CHUNK_SIZE + ENCRYPTED_CHUNK_OVERHEAD;

/**
 * How long a sender that has written its last frame waits for the receiver
 * to hang up before closing the stream itself; see `createTorLink`'s
 * `waitForPeerClose`.
 */
export const LINGER_TIMEOUT_MS = 30_000;

/** One framed message: an encrypted chunk, or a control string. */
export interface TorMessage {
  isString: boolean;
  data: Uint8Array;
}

/**
 * Framed message transport over one Tor stream.
 *
 * Reads and writes run independently, as the two directions of a stream do:
 * the handshake takes turns, and the transfer above then flows one way while
 * the other side only watches for the close. Writes are serialized here so
 * two senders can never interleave one frame's bytes into another's; reads
 * have one reader at a time by construction — the handshake's turn-taking,
 * then the transfer link's single read loop.
 */
export class TorFramedStream {
  private readonly stream: OnionStream;
  /** Bytes read off the stream that have not been consumed by a frame yet. */
  private buffered: Uint8Array[] = [];
  private bufferedLength = 0;
  private ended = false;
  private closed = false;
  /** Every frame write, in call order. */
  private sendChain: Promise<void> = Promise.resolve();

  constructor(stream: OnionStream) {
    this.stream = stream;
  }

  /** Send one control string as a text frame. */
  sendText(text: string): Promise<void> {
    return this.sendFrame(KIND_TEXT, new TextEncoder().encode(text));
  }

  /** Send one binary message. */
  sendBinary(data: Uint8Array): Promise<void> {
    return this.sendFrame(KIND_BINARY, data);
  }

  /**
   * Read the next frame, or null when the peer closed the stream *between*
   * frames, which is a clean end of the conversation.
   */
  async receive(): Promise<TorMessage | null> {
    const header = await this.readHeader();
    if (header === null) return null;

    const kind = header[0];
    const length =
      (header[1] << 24) | (header[2] << 16) | (header[3] << 8) | header[4];
    // A 32-bit length whose top bit is set arrives negative from the shifts
    // above; either way it is over the limit and refused before allocating.
    if (length < 0 || length > MAX_FRAME_BYTES) {
      throw new Error(
        `The peer announced a ${length >>> 0}-byte frame, over the ${MAX_FRAME_BYTES}-byte limit`,
      );
    }
    if (kind !== KIND_BINARY && kind !== KIND_TEXT) {
      throw new Error(`Unknown frame kind ${kind}`);
    }

    const payload = await this.readExactly(length);
    if (payload === null) {
      throw new Error('The peer closed the connection mid-frame');
    }
    return { isString: kind === KIND_TEXT, data: payload };
  }

  /**
   * Read the next frame, requiring it to be a text frame.
   *
   * The handshake speaks only text frames, and a peer that sends anything else
   * there is not running this protocol.
   */
  async receiveText(): Promise<string> {
    const message = await this.receive();
    if (message === null) {
      throw new Error('The peer closed the connection during the handshake');
    }
    if (!message.isString) {
      throw new Error('Expected a handshake message, got a binary frame');
    }
    return new TextDecoder(undefined, { fatal: true }).decode(message.data);
  }

  /** Close this side of the stream. Idempotent, and never throws. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.stream.close();
    } catch (error) {
      console.info('[tor] Failed to close an onion stream:', error);
    }
  }

  private async sendFrame(kind: number, payload: Uint8Array): Promise<void> {
    if (payload.length > MAX_FRAME_BYTES) {
      throw new Error(
        `A frame of ${payload.length} bytes exceeds the ${MAX_FRAME_BYTES}-byte limit`,
      );
    }

    // One write for header and payload together: a Tor stream pays for every
    // flush, and a 5-byte write of its own would ride in its own cell.
    const frame = new Uint8Array(HEADER_LENGTH + payload.length);
    frame[0] = kind;
    new DataView(frame.buffer).setUint32(1, payload.length, false);
    frame.set(payload, HEADER_LENGTH);
    const sent = this.sendChain.then(async () => {
      await this.stream.sendBytes(frame);
    });
    // A failed write does not stall the ones behind it; each still reports
    // its own outcome.
    this.sendChain = sent.catch(() => undefined);
    await sent;
  }

  /**
   * Read a frame header, distinguishing a close *between* frames (null, a
   * clean end) from one in the middle of a header (an error).
   */
  private async readHeader(): Promise<Uint8Array | null> {
    if (this.bufferedLength === 0 && !(await this.fill())) return null;
    const header = await this.readExactly(HEADER_LENGTH);
    if (header === null) {
      throw new Error('The peer closed the connection mid-frame');
    }
    return header;
  }

  /** Take exactly `length` bytes, or null if the stream ended first. */
  private async readExactly(length: number): Promise<Uint8Array | null> {
    while (this.bufferedLength < length) {
      if (!(await this.fill())) return null;
    }

    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const head = this.buffered[0];
      const take = Math.min(head.length, length - offset);
      out.set(head.subarray(0, take), offset);
      offset += take;
      if (take === head.length) this.buffered.shift();
      else this.buffered[0] = head.subarray(take);
    }
    this.bufferedLength -= length;
    return out;
  }

  /**
   * Pull one read's worth of bytes; false once the stream has ended.
   *
   * A Tor stream rarely ends with a plain end-of-stream. The far side sends an
   * END cell, and a peer that has already torn its circuit down by the time
   * this side reads produces a read *failure* instead — "Stream not connected"
   * — which is the same event reported differently. So any read failure is
   * taken as the end of the conversation; what that end means is the
   * caller's to decide, and
   * every caller here already distinguishes a close between frames from one in
   * the middle of a transfer.
   */
  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    let chunk: Uint8Array | null;
    try {
      chunk = await this.stream.receive();
    } catch (error) {
      console.info('[tor] The onion stream ended:', error);
      this.ended = true;
      return false;
    }
    if (chunk === null || chunk.length === 0) {
      this.ended = true;
      return false;
    }
    this.buffered.push(chunk);
    this.bufferedLength += chunk.length;
    return true;
  }
}
