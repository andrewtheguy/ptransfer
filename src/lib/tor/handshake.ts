import { base64ToUint8Array, uint8ArrayToBase64 } from '@/lib/base64';
import {
  decrypt,
  derivePakeSecret,
  deriveTorSessionKeys,
  encrypt,
  finishPake,
  generateSalt,
  isValidPakeMessage,
  PAKE_MESSAGE_LENGTH,
  SALT_LENGTH,
  startPake,
  type TorSessionKeys,
  torPakeIdentities,
  wipeBufferSource,
} from '@/lib/crypto';
import type { TransferMetadata } from '@/lib/nostr';
import type { WireEncoding } from '@/lib/transfer-source';
import type { TorFramedStream } from './framing';

/**
 * Password-authenticated handshake for the Tor onion transport, the exact
 * protocol ptransfer-cli's `src/tor/handshake.rs` speaks.
 *
 * The connecting side arrives holding exactly two things — the `.onion`
 * address and the password the sending side showed — and the handshake turns
 * those into a mutually authenticated content key. It is the same SPAKE2
 * (RFC 9382) machinery PIN Exchange uses, with the relay-shaped parts removed:
 * there is no rendezvous to look up and no third party to bind identities to,
 * so the address itself is the transfer identity (`torPakeIdentities`).
 *
 * ```text
 * receiver -> sender   hello    { version, pakeMessage: pB }
 * sender   -> receiver offer    { version, pakeMessage: pA, salt }
 * receiver -> sender   claim    { sealed }            <- the client knows the password
 * sender   -> receiver confirm  { sealed(metadata) }  <- the service knows it too
 * receiver -> sender   ready | cancel
 * ```
 *
 * Neither seal can be opened by anyone who did not run this exact SPAKE2
 * session, so opening one *is* the key confirmation: a wrong password produces
 * two different roots and the claim simply fails to open. There is no
 * confirmation code for a human to compare, because there is nothing for one
 * to catch — unlike a PIN, which is short enough to be raced with a live
 * guess, the address and password are only ever handed over as a pair.
 *
 * Tor already authenticates the *service* to the client (the address is its
 * public key) and encrypts the stream end to end. This layer adds what that
 * cannot: proof the connecting client is the intended receiver rather than
 * anyone who came across the address.
 */

/**
 * Version of this handshake. Bumped with any change to the frames below; a
 * mismatch is refused rather than negotiated, and it must move in lockstep
 * with ptransfer-cli's `TOR_HANDSHAKE_VERSION`.
 */
export const TOR_HANDSHAKE_VERSION = 1;

const CLAIM_TYPE = 'claim';
const CONFIRM_TYPE = 'confirm';

type Frame =
  | { type: 'hello'; version: number; pakeMessage: string }
  | { type: 'offer'; version: number; pakeMessage: string; salt: string }
  | { type: 'claim'; sealed: string }
  | { type: 'confirm'; sealed: string }
  | { type: 'ready' }
  | { type: 'cancel' };

/**
 * Plaintext inside the receiver's sealed claim.
 *
 * The seal is the proof; the body only restates what the seal is *about*, so
 * that a payload lifted from one direction or one address cannot be replayed
 * into another even if the keys ever collided.
 */
interface ClaimBody {
  type: string;
  version: number;
  onion: string;
}

/** The same binding, plus what the receiver is about to be handed. */
interface ConfirmBody extends ClaimBody {
  metadata: TransferMetadata;
}

/** How a client's connection to the onion service ended. */
export type ServiceHandshake =
  /** The receiver authenticated and is ready to be sent the file. */
  | { outcome: 'ready'; keys: TorSessionKeys }
  /**
   * The receiver authenticated and then declined. The password is untouched,
   * so the service can keep waiting for it to come back.
   */
  | { outcome: 'cancelled' };

/** What the receiver holds once the service proved it knows the password. */
export interface ClientHandshake {
  keys: TorSessionKeys;
  metadata: TransferMetadata;
}

/**
 * Run the onion service's side: authenticate the client, then tell it what is
 * on offer.
 *
 * Every failure here is one failed authentication from the caller's point of
 * view — a wrong password and a peer speaking gibberish are deliberately not
 * distinguished, because the difference is only ever useful to whoever is
 * guessing.
 */
export async function runTorServiceHandshake(
  framed: TorFramedStream,
  password: string,
  onion: string,
  metadata: TransferMetadata,
): Promise<ServiceHandshake> {
  const hello = await receiveFrame(framed);
  if (hello.type !== 'hello') throw new Error('Expected a hello frame');
  checkVersion(hello.version);
  const peerMessage = decodePakeMessage(hello.pakeMessage);

  const pakeSecret = await derivePakeSecret(password);
  let keys: TorSessionKeys;
  try {
    const run = startPake('sender', pakeSecret);
    const salt = generateSalt();
    await sendFrame(framed, {
      type: 'offer',
      version: TOR_HANDSHAKE_VERSION,
      pakeMessage: uint8ArrayToBase64(run.message),
      salt: uint8ArrayToBase64(salt),
    });

    const root = await finishPake(
      'sender',
      run.secret,
      pakeSecret,
      run.message,
      peerMessage,
      torPakeIdentities(onion),
    );
    keys = await deriveTorSessionKeys(root, salt);
  } finally {
    wipeBufferSource(pakeSecret);
  }

  // Opening the claim is the whole authentication: only a peer that ran this
  // SPAKE2 session against the same password holds the key that sealed it.
  const claimFrame = await receiveFrame(framed);
  if (claimFrame.type !== 'claim') throw new Error('Expected a claim frame');
  const claim = await openSealed<ClaimBody>(
    keys.claimKey,
    claimFrame.sealed,
    'The receiver could not be authenticated: wrong password, or a different onion service',
  );
  if (claim.type !== CLAIM_TYPE || claim.version !== TOR_HANDSHAKE_VERSION) {
    throw new Error('The receiver sent an unexpected claim body');
  }
  if (claim.onion !== onion) {
    throw new Error('The receiver authenticated against a different address');
  }

  await sendFrame(framed, {
    type: 'confirm',
    sealed: await seal(keys.confirmKey, {
      type: CONFIRM_TYPE,
      version: TOR_HANDSHAKE_VERSION,
      onion,
      metadata,
    } satisfies ConfirmBody),
  });

  const answer = await receiveFrame(framed);
  if (answer.type === 'ready') return { outcome: 'ready', keys };
  if (answer.type === 'cancel') return { outcome: 'cancelled' };
  throw new Error('Expected the receiver to answer ready or cancel');
}

/**
 * Run the connecting receiver's side, up to the point where it knows what it
 * is being offered. The caller then answers with `sendReady` or `sendCancel`.
 */
export async function runTorClientHandshake(
  framed: TorFramedStream,
  password: string,
  onion: string,
): Promise<ClientHandshake> {
  const pakeSecret = await derivePakeSecret(password);
  let keys: TorSessionKeys;
  try {
    const run = startPake('receiver', pakeSecret);
    await sendFrame(framed, {
      type: 'hello',
      version: TOR_HANDSHAKE_VERSION,
      pakeMessage: uint8ArrayToBase64(run.message),
    });

    const offer = await receiveFrame(framed);
    if (offer.type !== 'offer') throw new Error('Expected an offer frame');
    checkVersion(offer.version);
    const peerMessage = decodePakeMessage(offer.pakeMessage);
    const salt = base64ToUint8Array(offer.salt);
    if (salt.length !== SALT_LENGTH) {
      throw new Error(`The sender sent a ${salt.length}-byte salt`);
    }

    const root = await finishPake(
      'receiver',
      run.secret,
      pakeSecret,
      run.message,
      peerMessage,
      torPakeIdentities(onion),
    );
    keys = await deriveTorSessionKeys(root, salt);
  } finally {
    wipeBufferSource(pakeSecret);
  }

  await sendFrame(framed, {
    type: 'claim',
    sealed: await seal(keys.claimKey, {
      type: CLAIM_TYPE,
      version: TOR_HANDSHAKE_VERSION,
      onion,
    } satisfies ClaimBody),
  });

  // A wrong password fails here, at the sender's confirm: the sender could not
  // open our claim, so it hangs up rather than answering, and this side sees a
  // closed stream rather than a rejection. Nothing comes back that would tell
  // a guesser which of the two it was.
  let confirmFrame: Frame;
  try {
    confirmFrame = await receiveFrame(framed);
  } catch {
    throw new Error(
      'The sender stopped answering after the claim; check the password',
    );
  }
  if (confirmFrame.type !== 'confirm') {
    throw new Error('Expected a confirm frame');
  }
  const confirm = await openSealed<ConfirmBody>(
    keys.confirmKey,
    confirmFrame.sealed,
    'The sender could not be authenticated: check the password',
  );
  if (
    confirm.type !== CONFIRM_TYPE ||
    confirm.version !== TOR_HANDSHAKE_VERSION
  ) {
    throw new Error('The sender sent an unexpected confirm body');
  }
  if (confirm.onion !== onion) {
    throw new Error('The sender authenticated against a different address');
  }

  return { keys, metadata: parseMetadata(confirm.metadata) };
}

/** Tell the sender to start sending. */
export function sendReady(framed: TorFramedStream): Promise<void> {
  return sendFrame(framed, { type: 'ready' });
}

/** Tell the sender the transfer will not go ahead. */
export function sendCancel(framed: TorFramedStream): Promise<void> {
  return sendFrame(framed, { type: 'cancel' });
}

function checkVersion(version: number): void {
  if (version !== TOR_HANDSHAKE_VERSION) {
    throw new Error(
      `The peer speaks Tor transfer version ${version}, this build speaks ${TOR_HANDSHAKE_VERSION}`,
    );
  }
}

function decodePakeMessage(encoded: string): Uint8Array {
  let message: Uint8Array;
  try {
    message = base64ToUint8Array(encoded);
  } catch {
    throw new Error('The peer sent a malformed PAKE element');
  }
  // Screen the element before the scalar multiplication in finishPake.
  if (!isValidPakeMessage(message)) {
    throw new Error(
      `The peer sent a ${PAKE_MESSAGE_LENGTH}-byte PAKE element that is not a curve point`,
    );
  }
  return message;
}

/**
 * Validate the metadata the sender sealed into its confirm. The wire shape is
 * the peer's word, so every field is checked before it reaches a sink, a
 * progress bar, or a file name.
 */
function parseMetadata(metadata: TransferMetadata): TransferMetadata {
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('The sender sent no transfer metadata');
  }
  if (metadata.contentType !== 'file') {
    throw new Error('The sender describes unsupported content');
  }
  if (typeof metadata.fileName !== 'string' || metadata.fileName.length === 0) {
    throw new Error('The sender sent no file name');
  }
  if (
    typeof metadata.fileSize !== 'number' ||
    !Number.isSafeInteger(metadata.fileSize) ||
    metadata.fileSize < 0
  ) {
    throw new Error('The sender sent an invalid file size');
  }
  const encodings: WireEncoding[] = ['deflate-raw', 'identity'];
  if (!encodings.includes(metadata.contentEncoding)) {
    throw new Error(
      `The sender sent an unsupported content encoding: ${String(metadata.contentEncoding)}`,
    );
  }
  if (typeof metadata.mimeType !== 'string') {
    throw new Error('The sender sent an invalid MIME type');
  }
  return metadata;
}

async function seal(key: CryptoKey, body: unknown): Promise<string> {
  const plaintext = new TextEncoder().encode(JSON.stringify(body));
  return uint8ArrayToBase64(await encrypt(key, plaintext));
}

async function openSealed<T>(
  key: CryptoKey,
  sealed: string,
  failureMessage: string,
): Promise<T> {
  try {
    const plaintext = await decrypt(key, base64ToUint8Array(sealed));
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    throw new Error(failureMessage);
  }
}

function sendFrame(framed: TorFramedStream, frame: Frame): Promise<void> {
  return framed.sendText(JSON.stringify(frame));
}

async function receiveFrame(framed: TorFramedStream): Promise<Frame> {
  const text = await framed.receiveText();
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    throw new Error('The peer sent an unrecognized handshake frame');
  }
  if (
    !frame ||
    typeof frame !== 'object' ||
    typeof (frame as { type?: unknown }).type !== 'string'
  ) {
    throw new Error('The peer sent an unrecognized handshake frame');
  }
  return frame as Frame;
}
