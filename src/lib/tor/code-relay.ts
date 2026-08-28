import { uint8ArrayToBase64 } from '@/lib/base64';
import { wipeBufferSource } from '@/lib/crypto/memory';
import { formatFileSize } from '@/lib/file-utils';
import type { TransferMetadata, TransferState } from '@/lib/nostr';
import { generateEphemeralKeys } from '@/lib/nostr/events';
import {
  type ControlChannel,
  deriveControlKey,
  openControlChannel,
} from '@/lib/nostr-file/control';
import type { NostrFilePool } from '@/lib/nostr-file/pool';
import type { RelaySession } from '@/lib/nostr-file/session';
import type { TransferSource } from '@/lib/transfer-source';
import { TorFramedStream } from './framing';
import { runTorClientHandshake, sendReady } from './handshake';
import {
  type OnionAddress,
  parseOnionAddress,
  TOR_DEFAULT_PORT,
} from './onion-address';
import { serveUntilSent } from './serve';
import { receiveFileOverTor, TOR_MAX_TRANSFER_BYTES } from './transfer';
import type { OnionService, WebtorClient } from './webtor';

/**
 * Code Exchange's anonymous relay fallback: the rendezvous that lets two pages
 * meet on an onion service neither of them could name in advance.
 *
 * The Tor transport (`serve.ts`, `handshake.ts`, `transfer.ts`) is used
 * unchanged and unaware — this module only supplies the two values its mode-3
 * caller hands to a person, without a person:
 *
 * - The **password** is derived from the ECDH shared secret the offer/answer
 *   exchange already established, on both sides, and never leaves either
 *   device. `derivePakeSecret` takes an opaque string, so derived key material
 *   drops into the same handshake with nothing about it changed.
 * - The **address** cannot be derived — the Tor client mints an ephemeral
 *   service identity — so it is announced over the encrypted control channel
 *   of the same session, sealed under a key from that same secret.
 *
 * The ordering is the security property, and it is the sender's own act that
 * enforces it: the shared secret needs the receiver's public key, which exists
 * only inside a response the sender scanned or pasted, so nothing is published
 * and no password opens the handshake until then. See docs/CODE_EXCHANGE.md.
 */

/**
 * HKDF info label for the onion password. Distinct from the labels the relay
 * session and the control key use, so the three are independent outputs of the
 * one shared secret.
 */
const ONION_PASSWORD_INFO = 'ptransfer-code-exchange:v1:onion-password';

/**
 * Bytes behind the derived password. It is never read, typed, or compared by
 * a person, so it is sized as key material rather than as something to say
 * out loud: 32 bytes is the SPAKE2 root's own strength, and the online-guess
 * bounds a human-length password needs do not apply to it.
 */
const ONION_PASSWORD_BYTES = 32;

/** The one message this channel carries from the sender. */
const ANNOUNCE_TYPE = 'onion';

/**
 * Sender → receiver, once and only after the response was accepted: where the
 * onion service is. `onion` is the exact `<host>:<port>` string both sides
 * bind the SPAKE2 transcript to. The channel stamps the per-message counter
 * every control message carries, so it is not written here.
 */
interface OnionAnnouncement {
  t: typeof ANNOUNCE_TYPE;
  onion: string;
}

/**
 * The password both sides derive instead of handing one over.
 *
 * Same inputs as `deriveRelaySession`, a different label: whoever holds the
 * shared secret holds the password, and nobody else can arrive at it from
 * anything that travelled.
 */
export async function deriveOnionPassword(
  sharedSecretKey: CryptoKey,
  salt: Uint8Array,
): Promise<string> {
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: salt as BufferSource,
        info: new TextEncoder().encode(ONION_PASSWORD_INFO),
      },
      sharedSecretKey,
      ONION_PASSWORD_BYTES * 8,
    ),
  );
  const password = uint8ArrayToBase64(bits);
  wipeBufferSource(bits);
  return password;
}

/**
 * The address an announcement carries, or null when the message is not one.
 *
 * Sealing already proves the message came from the peer, so this is not
 * standing between the transfer and a stranger; it stands between the Tor
 * client and a malformed or truncated address, which is worth catching before
 * a rendezvous circuit is built for it.
 */
export function parseOnionAnnouncement(value: unknown): OnionAddress | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (message.t !== ANNOUNCE_TYPE) return null;
  if (typeof message.onion !== 'string' || message.onion.length > 100) {
    return null;
  }
  return parseOnionAddress(message.onion);
}

/** What both directions need to open the session's control channel. */
interface ChannelContext {
  pool: NostrFilePool;
  relays: string[];
  /** Control-channel identity and key; the caller keeps ownership of the bytes. */
  session: RelaySession;
  /** unix seconds: the exchange's start, so a backlog message is not missed. */
  since: number;
  /** unix seconds: the exchange's deadline, stamped on published events. */
  expiresAt: number;
}

async function openSessionChannel(
  context: ChannelContext,
  role: 'sender' | 'receiver',
  onMessage: (message: unknown, pubkey: string) => void,
): Promise<{ channel: ControlChannel; publicKey: string }> {
  const key = await deriveControlKey(
    context.session.keyBytes,
    context.session.transferId,
  );
  const { secretKey, publicKey } = generateEphemeralKeys();
  const channel = openControlChannel(context.pool, context.relays, {
    transferId: context.session.transferId,
    key,
    role,
    secretKey,
    since: context.since,
    expiresAt: context.expiresAt,
    onMessage,
  });
  return { channel, publicKey };
}

export interface AnonymousRelaySendOptions extends ChannelContext {
  /** Bootstrapped Tor client; the caller owns and closes it. */
  client: WebtorClient;
  password: string;
  content: TransferSource;
  metadata: TransferMetadata;
  fileMetadata: { fileName: string; fileSize: number; mimeType: string };
  isCancelled: () => boolean;
  /** Progress that has no byte count behind it yet. */
  onStatus: (message: string) => void;
  onProgress: (current: number, total: number, message: string) => void;
}

/**
 * Publish the onion service, tell the receiver where it is, and serve the file.
 *
 * Nothing before this call has published anything: the service is established
 * here, after the sender accepted a response and after the direct route was
 * found dead, which is what makes "the service is unreachable until the sender
 * takes the response in" true rather than merely intended.
 */
export async function serveOverAnonymousRelay(
  options: AnonymousRelaySendOptions,
): Promise<void> {
  const { client, isCancelled, onStatus, onProgress } = options;

  onStatus('Publishing a Tor onion service for the file...');
  const service: OnionService = await client.publishOnionService();
  let channel: ControlChannel | null = null;
  try {
    // Two strings out of one address, as everywhere else in this transport:
    // the handshake binds `<host>:<port>`, and nothing here is ever shown.
    const onion = `${service.onionAddress}:${TOR_DEFAULT_PORT}`;
    if (isCancelled()) throw new Error('Cancelled');

    onStatus('Telling the receiver where to find it...');
    channel = (await openSessionChannel(options, 'sender', () => {})).channel;
    await channel.send({
      t: ANNOUNCE_TYPE,
      onion,
    } satisfies OnionAnnouncement);
    if (isCancelled()) throw new Error('Cancelled');

    await serveUntilSent({
      service,
      onion,
      password: options.password,
      metadata: options.metadata,
      content: options.content,
      fileMetadata: options.fileMetadata,
      isCancelled,
      // The Tor transport reports itself as a `TransferState`; this transfer
      // has a state shape of its own, so the two useful facts are forwarded
      // and the shape is left to the caller.
      setState: (state: TransferState) => {
        if (state.progress) {
          onProgress(
            state.progress.current,
            state.progress.total,
            state.message ?? '',
          );
        } else if (state.message) {
          onStatus(state.message);
        }
      },
    });
  } finally {
    channel?.close();
    try {
      await service.close();
    } catch (error) {
      console.info('[tor] Failed to withdraw the onion service:', error);
    }
  }
}

export interface AnonymousRelayReceiveOptions extends ChannelContext {
  /** Bootstrapped Tor client; the caller owns and closes it. */
  client: WebtorClient;
  password: string;
  isCancelled: () => boolean;
  onStatus: (message: string) => void;
  onProgress: (current: number, total: number) => void;
  /**
   * The sender has announced its service. Everything before this is a page
   * waiting for a sender who may not even have seen the response yet; a caller
   * that says so on screen needs the moment that stops being true.
   */
  onAnnounced?: () => void;
  /**
   * What the offer said was coming. The handshake says it again, and two
   * descriptions of different files mean one of them is not this transfer.
   */
  expected: TransferMetadata;
}

/**
 * The first thing the handshake's metadata says that the offer did not, or
 * null when the two describe the same file.
 *
 * Whoever completed the handshake is the sender — the password came out of the
 * ECDH secret, so no one else could have — which is exactly why this is worth
 * checking: the receiver agreed to take the file the offer described, saw only
 * that description, and has no way to notice it being handed another one.
 */
function firstMismatch(
  expected: TransferMetadata,
  offered: TransferMetadata,
): string | null {
  if (offered.fileName !== expected.fileName) return 'name';
  if (offered.fileSize !== expected.fileSize) return 'size';
  if (offered.mimeType !== expected.mimeType) return 'type';
  if (offered.contentEncoding !== expected.contentEncoding) return 'encoding';
  if (offered.contentType !== expected.contentType) return 'content type';
  return null;
}

export interface AnonymousRelayReceipt {
  payload: Blob;
  metadata: TransferMetadata;
}

/**
 * Check in on the control channel, wait for the sender's address, and take the
 * file over Tor.
 *
 * The `hello` is what tells the sender to stop waiting on the direct route —
 * the same signal the clearnet fallback sends, read by the same watch — so it
 * goes out before there is anything to wait for.
 */
export async function receiveOverAnonymousRelay(
  options: AnonymousRelayReceiveOptions,
): Promise<AnonymousRelayReceipt> {
  const { client, isCancelled, onStatus, onProgress } = options;

  let resolveAddress: (address: OnionAddress) => void = () => {};
  const announced = new Promise<OnionAddress>((resolve) => {
    resolveAddress = resolve;
  });

  onStatus('No direct connection — asking the sender to relay through Tor...');
  const { channel, publicKey } = await openSessionChannel(
    options,
    'receiver',
    (message, pubkey) => {
      if (pubkey === publicKey) return;
      const address = parseOnionAnnouncement(message);
      if (address) resolveAddress(address);
    },
  );

  let framed: TorFramedStream | null = null;
  try {
    // The same `hello` the clearnet fallback sends, read by the same watch on
    // the sender: it is what ends the direct attempt over there.
    await channel.send({ t: 'hello' });
    onStatus('Waiting for the sender to publish its onion service...');

    const address = await untilDeadline(
      announced,
      options.expiresAt * 1000 - Date.now(),
      'The sender never published an onion service. Start a new transfer.',
      isCancelled,
    );
    if (isCancelled()) throw new Error('Cancelled');
    options.onAnnounced?.();

    onStatus(`Building a circuit to ${address.host}...`);
    framed = new TorFramedStream(
      await client.connectStream(address.host, address.port),
    );
    if (isCancelled()) throw new Error('Cancelled');

    onStatus('Authenticating with the sender...');
    const { keys, metadata } = await runTorClientHandshake(
      framed,
      options.password,
      address.onion,
    );
    // The offer said what was coming and this says it again; a disagreement
    // is not worth a transfer, and the ceiling is the receiver's rule too.
    const mismatch = firstMismatch(options.expected, metadata);
    if (mismatch) {
      throw new Error(
        `The sender is offering a file with a different ${mismatch} than the code said. Start a new transfer.`,
      );
    }
    if (metadata.fileSize > TOR_MAX_TRANSFER_BYTES) {
      throw new Error(
        `The sender is offering ${formatFileSize(metadata.fileSize)}, over the ${formatFileSize(TOR_MAX_TRANSFER_BYTES)} limit of the Tor transport.`,
      );
    }

    onStatus('Receiving the file over Tor...');
    await sendReady(framed);
    const payload = await receiveFileOverTor(
      framed,
      keys.contentKey,
      metadata.contentEncoding,
      {
        estimatedBytes: metadata.fileSize,
        isCancelled,
        onProgress,
      },
    );

    // The sender is waiting on this side's `ACK`; its close is the receipt
    // that it landed. A file already written and verified does not become
    // unreceived because the receipt went missing.
    try {
      await framed.waitForClose();
    } catch (error) {
      console.warn('[tor] The sender never acknowledged receipt:', error);
    }

    return { payload, metadata };
  } finally {
    channel.close();
    await framed?.close();
  }
}

/**
 * Wait for `pending`, giving up at the deadline or once the transfer is
 * abandoned. The cancellation poll is what keeps a cancelled page from sitting
 * inside an hour-long wait for a sender that is never coming.
 */
function untilDeadline<T>(
  pending: Promise<T>,
  ms: number,
  message: string,
  isCancelled: () => boolean,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const ended = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(1, ms));
    poll = setInterval(() => {
      if (isCancelled()) reject(new Error('Cancelled'));
    }, 500);
  });
  return Promise.race([pending, ended]).finally(() => {
    clearTimeout(timer);
    clearInterval(poll);
  });
}
